import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { metaGraphVersion, metaGraphUrl, interpretMetaRefusal } from '../common/meta-graph';
import { prisma, withWhatsAppCredentials, sealTelephonyCredentials, sealWhatsAppCredentials, decryptSecret, assertUsableServiceHours, assertUsableAgencyName, assertUsableOutboundHours, recordAudit, resolveAuditActors } from '@ace/database';
import { SUPPORTED_LANGUAGES, type Language } from '@ace/orchestrator';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { sendTransactionalEmail } from '../common/mailer';
import { callAnswerReadiness } from '../whatsapp/whatsapp-call-answer.service';

/**
 * Replaces a secret with a non-reversible hint: whether it is set, and its last four
 * characters so an operator can tell two credentials apart without being handed
 * either of them. Returns null (not the string "null") when nothing is configured,
 * so the dashboard can still render an accurate "not connected" state.
 */
function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

/**
 * Mask a credential that is encrypted at rest.
 *
 * Decrypt FIRST, then mask. Masking the stored value would show the last four
 * characters of base64 ciphertext — different every time it is written, and
 * matching nothing an operator can compare against the token in their Meta or
 * Twilio console. The suffix exists so somebody can recognise which credential
 * is configured; a suffix of the ciphertext quietly stops doing that while
 * still looking like it works.
 *
 * An undecryptable value still masks to `••••` rather than throwing: a settings
 * page must render even when the encryption key is wrong, or an operator cannot
 * reach the form that would let them re-enter the credential.
 */
function maskStoredSecret(value: string | null | undefined, label: string): string | null {
  if (!value) return null;
  try {
    return maskSecret(decryptSecret(value, label));
  } catch {
    return '••••';
  }
}

/**
 * Which of these stored credentials cannot be decrypted.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * `maskStoredSecret` returns `••••` for an unreadable value, deliberately, so
 * the settings page still renders — an operator who cannot reach the form
 * cannot re-enter the credential either. But the consequence was that an
 * unreadable credential looked EXACTLY like a working one: `••••` in both
 * cases, on every settings screen, with nothing to tell them apart.
 *
 * So a deployment whose ENCRYPTION_KEY had changed showed a fully configured
 * WhatsApp line, a fully configured carrier and a fully configured agent key
 * — while messages went unanswered, because the inbound path could not read
 * the token it was being shown a mask of. The only visible symptom was a
 * citizen getting no reply.
 *
 * Reported as a LIST of field names, never a value and never a reason that
 * quotes ciphertext. The field name is what says which box to retype.
 */
function unreadableCredentials(row: Record<string, any>, fields: Array<[string, string]>): string[] {
  const broken: string[] = [];
  for (const [field, label] of fields) {
    const value = row?.[field];
    if (!value) continue;
    try {
      decryptSecret(value, label);
    } catch {
      broken.push(field);
    }
  }
  return broken;
}


function maskedTelephonyConfig<T extends Record<string, any>>(c: T) {
  return {
    ...c,
    accountSid: maskSecret(c.accountSid),
    authToken: maskStoredSecret(c.authToken, `TelephonyConfig ${c.id}.authToken`),
    apiKey: maskStoredSecret(c.apiKey, `TelephonyConfig ${c.id}.apiKey`),
    apiSecret: maskStoredSecret(c.apiSecret, `TelephonyConfig ${c.id}.apiSecret`),
    // `sipAddress` and `sipUsername` are deliberately NOT masked: they identify
    // a trunk rather than open it, and an operator comparing our configuration
    // against their carrier's needs to read them. The password is a credential.
    sipPassword: maskStoredSecret(c.sipPassword, `TelephonyConfig ${c.id}.sipPassword`),
    // A carrier credential nothing can read fails every call with an auth
    // error pointing at Twilio, which is the wrong system entirely.
    unreadableCredentials: unreadableCredentials(c, [
      ['authToken', `TelephonyConfig ${c.id}.authToken`],
      ['apiKey', `TelephonyConfig ${c.id}.apiKey`],
      ['apiSecret', `TelephonyConfig ${c.id}.apiSecret`],
      ['sipPassword', `TelephonyConfig ${c.id}.sipPassword`],
    ]),
  };
}

/**
 * SIP signalling transports ElevenLabs accepts (`SipTrunkTransportEnum`).
 *
 * Validated here, at the settings boundary, rather than at import time: a
 * rejected transport discovered during the voice cutover is discovered while a
 * phone line is being moved, which is the worst moment to learn that a form
 * accepted something the provider does not.
 */
const SIP_TRANSPORTS = ['auto', 'udp', 'tcp', 'tls'] as const;

/**
 * Providers `TelephonyConfig.provider` can hold.
 *
 * Kept as a literal list rather than imported from the generated Prisma
 * namespace so the settings endpoint can answer with the valid values in its
 * own error message. A value not in here used to reach Prisma and surface as an
 * unexplained 500.
 */
const TELEPHONY_PROVIDERS = [
  'TWILIO',
  'PLIVO',
  'TELNYX',
  'AFRICAS_TALKING',
  'NIGERIA_CARRIER_FORWARD',
  'MTN_ENTERPRISE_SIP',
  'AIRTEL_BUSINESS_SIP',
  'SIP_TRUNK',
  // A number carried by Infobip — usually the agency's own, brought over SIP.
  // Infobip hands the audio to this platform, so this platform's AI answers.
  'INFOBIP',
] as const;

function maskedWhatsAppConfig<T extends Record<string, any>>(c: T) {
  return {
    ...c,
    accessToken: maskStoredSecret(c.accessToken, `WhatsAppConfig ${c.id}.accessToken`),
    webhookVerifyToken: maskStoredSecret(
      c.webhookVerifyToken,
      `WhatsAppConfig ${c.id}.webhookVerifyToken`
    ),
    // Which of the above are a mask over something nothing can read.
    unreadableCredentials: unreadableCredentials(c, [
      ['accessToken', `WhatsAppConfig ${c.id}.accessToken`],
      ['webhookVerifyToken', `WhatsAppConfig ${c.id}.webhookVerifyToken`],
    ]),
  };
}

/** The signed-in user behind a change, for the audit record. */
export interface Actor {
  userId: string;
  ipAddress?: string | null;
}

/**
 * Which channel-configuration row a settings save is allowed to overwrite.
 *
 * An agency may hold several voice lines and several WhatsApp lines — inbound
 * is resolved by dialled number and by Meta `phoneNumberId`, `isDefault`
 * picks the outbound line, and `GET /api/organizations/me` returns both as
 * arrays. The save paths ignored all of that: each did an unordered
 * `findFirst({ where: { organizationId } })` and updated whatever came back.
 * On an agency with three lines that overwrites an ARBITRARY one, so Twilio
 * credentials could land on the Telnyx row, and the line the officer was
 * looking at on the settings screen was not necessarily the line they
 * changed.
 *
 * So a save must name its target. `id` is what the settings screen now sends:
 * the id of the row it actually rendered. With no id the target is the row the
 * read orders FIRST — the same deterministic line the screen shows when it has
 * not been told otherwise — and an id belonging to another agency is a 404
 * rather than a cross-tenant write.
 */
const TELEPHONY_ROW_ORDER = [{ isDefault: 'desc' as const }, { createdAt: 'asc' as const }];
const WHATSAPP_ROW_ORDER = [{ isActive: 'desc' as const }, { createdAt: 'asc' as const }];

// The Graph version and Meta's three-fault refusal both live in
// apps/api/src/common/meta-graph.ts, because the WhatsApp call-answer path
// needs the same version and a second copy is a second thing that can drift
// out of agreement about which Graph version this deployment speaks.
export { metaGraphVersion, interpretMetaRefusal } from '../common/meta-graph';


/**
 * The webhook URL Meta must be delivering to.
 *
 * Built from the same `API_BASE_URL`/`API_URL` fallback the rest of the
 * platform uses (telephony historically read API_URL), so the URL reported is
 * the URL served rather than a second guess at it.
 */
function whatsAppWebhookUrl(): string {
  const base = (process.env.API_BASE_URL || process.env.API_URL || '').replace(/\/+$/, '');
  return `${base}/api/whatsapp/webhook`;
}

/**
 * One Graph WRITE. Same distinction as `metaGet`: a refusal and an
 * unreachable endpoint are different outcomes and are fixed in different
 * places, so they are never collapsed into "it did not work".
 */
async function metaPost(
  url: string,
  accessToken: string,
  json?: Record<string, unknown>
): Promise<{ reached: boolean; ok: boolean; body: any; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(json ? { 'content-type': 'application/json' } : {}),
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) {
      return { reached: true, ok: false, body, error: body?.error?.message ?? `HTTP ${res.status}` };
    }
    // Meta answers `{"success": true}` here. A 200 carrying anything else is
    // not a success we are willing to report as one.
    if (body && body.success === false) {
      return { reached: true, ok: false, body, error: 'Meta answered 200 with success: false.' };
    }
    return { reached: true, ok: true, body };
  } catch (err: any) {
    return { reached: false, ok: false, body: null, error: err?.message ?? String(err) };
  }
}

/**
 * One read-only Graph call, with "could not reach" kept distinct from
 * "answered and refused". Collapsing the two is what makes a readiness report
 * claim something works when it was never asked.
 */
async function metaGet(
  url: string,
  accessToken: string
): Promise<{ reached: boolean; ok: boolean; body: any; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        reached: true,
        ok: false,
        body,
        // Meta's own words. "It did not work" sends an operator to the wrong system.
        error: body?.error?.message ?? `HTTP ${res.status}`,
      };
    }
    return { reached: true, ok: true, body };
  } catch (err: any) {
    return { reached: false, ok: false, body: null, error: err?.message ?? String(err) };
  }
}

@Injectable()
export class OrganizationsService {
  /**
   * Returns the caller's organization with integration credentials MASKED.
   *
   * This endpoint is open to every member of the organization, including VIEWER and
   * AGENT. It previously returned `telephonyConfigs` and `whatsAppConfigs` in full —
   * meaning the Meta access token, the WhatsApp webhook verify token, and the Twilio
   * account SID / auth token were handed in plaintext to the lowest-privileged role
   * in the product. Anyone holding those can send WhatsApp messages as the business,
   * place calls billed to its Twilio account, and re-point the webhook.
   *
   * The dashboard only needs to know whether a credential is configured and show a
   * recognisable suffix, so that is all it gets. Values are never re-readable after
   * being written, which is the same rule already applied to API keys.
   */
  async getOrganization(organizationId: string) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        // ORDERED, because the settings screen renders `telephonyConfigs[0]`
        // and `whatsAppConfigs[0]`. Unordered, Postgres is free to return the
        // rows of a multi-line agency in a different sequence on different
        // requests, so the screen showed a different line after a refresh and
        // the officer had no way to tell. The order matches what
        // `getOutboundConfig` prefers — the default line first — so the line
        // the screen shows is the line outbound calls actually use.
        telephonyConfigs: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] },
        whatsAppConfigs: { orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] },
        users: { select: { id: true, email: true, fullName: true, role: true, isActive: true } },
      },
    });

    if (!org) throw new NotFoundException('Organization not found');

    return {
      ...org,
      // One masking function, not a second copy of the field list. The list was
      // duplicated here and in the write path, and a credential column added to
      // one of them is a column returned in the clear from the other: that is
      // exactly what happened to `sipPassword`, which the write path masked and
      // this read handed back as ciphertext.
      telephonyConfigs: org.telephonyConfigs.map((c) => maskedTelephonyConfig(c)),
      // ...and the WhatsApp line was STILL a second copy, directly beneath the
      // comment saying it should not be. The telephony line obeyed it; this one
      // was a hand-written duplicate of the same field list.
      //
      // It cost exactly what the comment predicts. `maskedWhatsAppConfig` was
      // taught to report which credentials cannot be decrypted — the thing
      // that tells an operator which box to retype when ENCRYPTION_KEY has
      // changed — and this path, the one the settings screen actually reads,
      // did not get it. The screen went on showing an unreadable token as
      // `••••`, indistinguishable from a working one.
      whatsAppConfigs: org.whatsAppConfigs.map((c) => maskedWhatsAppConfig(c)),
    };
  }

  async updateSettings(
    organizationId: string,
    data: {
      name?: string;
      aiPersonaPrompt?: string;
      welcomeMessage?: string;
      /** One per line, read verbatim after 112 in the emergency reply (PRD §11). */
      emergencyContacts?: string | null;
      /** Owners/admins must enrol in MFA before getting a session (PRD §17). */
      requireAdminMfa?: boolean;
      /** Sent once to each citizen before the first WhatsApp answer (PRD §18). */
      privacyNotice?: string | null;
      /** New knowledge starts as DRAFT and needs a second person's approval (PRD §12). */
      requireKnowledgeApproval?: boolean;
      /** Keep message text/transcripts this many days (PRD §18). Null keeps them. */
      retentionDays?: number | null;
      phone?: string;
      logoUrl?: string;
      webhookUrl?: string;
      enabledWebhookEvents?: string[];
      // Read out to customers by the AI assistant as payment instructions.
      payoutBankName?: string;
      payoutAccountName?: string;
      payoutAccountNumber?: string;
      payoutUssdCode?: string;
      // The language the AI opens conversations in until the customer's own
      // language is known. Validated against the supported set: silently
      // storing an unknown code would be a selector that saves and changes
      // nothing, because the orchestrator falls back to English on any value
      // it does not recognise.
      defaultLanguage?: string;
      // When this agency serves citizens. Appointment search offers nothing
      // outside these, so a wrong value here is a diary that looks full.
      openingHour?: number;
      closingHour?: number;
      serviceDays?: number[];
      // When the platform may RING or TEXT a citizen, as opposed to when an
      // appointment may be offered. Null clears it back to "same as serving
      // hours".
      outboundOpeningHour?: number | null;
      outboundClosingHour?: number | null;
      outboundDays?: number[] | null;
    }
  ) {
    if (data.defaultLanguage !== undefined && !SUPPORTED_LANGUAGES.includes(data.defaultLanguage as Language)) {
      throw new BadRequestException(
        `defaultLanguage must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`
      );
    }

    // Refused rather than stored, for the same reason the boot check refuses
    // an env value containing "placeholder". An agency was once renamed to the
    // literal string "NEW AGENCY NAME" from an unfilled command, and this
    // endpoint accepted it — so the assistant greeted citizens with it and it
    // printed on their identity cards. The trimmed name is what gets written:
    // a trailing space is invisible in a form and audible in a greeting.
    let cleanName: string | undefined;
    if (data.name !== undefined) {
      try {
        cleanName = assertUsableAgencyName(data.name);
      } catch (e: any) {
        throw new BadRequestException(e?.message ?? 'That agency name cannot be used.');
      }
    }
    // Validated here rather than trusted, because availability search throws
    // on hours that cannot produce a slot — and a 500 from the booking flow is
    // a citizen told nothing is free, days after somebody saved the form.
    const hoursTouched =
      data.openingHour !== undefined ||
      data.closingHour !== undefined ||
      data.serviceDays !== undefined;

    if (hoursTouched) {
      const current = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { openingHour: true, closingHour: true, serviceDays: true },
      });
      if (!current) throw new NotFoundException('Organization not found');

      try {
        assertUsableServiceHours({
          openHour: data.openingHour ?? current.openingHour,
          closeHour: data.closingHour ?? current.closingHour,
          days: data.serviceDays ?? current.serviceDays,
        });
      } catch (e: any) {
        // The message names the actual problem; it is shown in the settings form.
        throw new BadRequestException(e?.message ?? 'Those serving hours cannot produce an appointment.');
      }
    }

    // Validated for the same reason the serving hours are: a window that
    // cannot be satisfied stops every callback and every reminder, silently
    // and forever.
    if (
      data.outboundOpeningHour !== undefined ||
      data.outboundClosingHour !== undefined ||
      data.outboundDays !== undefined
    ) {
      try {
        assertUsableOutboundHours({
          outboundOpeningHour: data.outboundOpeningHour,
          outboundClosingHour: data.outboundClosingHour,
          outboundDays: data.outboundDays,
        });
      } catch (e: any) {
        throw new BadRequestException(
          e?.message ?? 'Those contact hours cannot be used.'
        );
      }
    }

    if (data.retentionDays !== undefined && data.retentionDays !== null) {
      const d = Number(data.retentionDays);
      // Under 30 days would erase citizens' words before most cases close.
      if (!Number.isInteger(d) || d < 30 || d > 3650) {
        throw new BadRequestException('Retention must be a whole number of days between 30 and 3650, or empty to keep everything.');
      }
      data.retentionDays = d;
    }
    return prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(cleanName !== undefined && { name: cleanName }),
        ...(data.aiPersonaPrompt !== undefined && { aiPersonaPrompt: data.aiPersonaPrompt }),
        ...(data.welcomeMessage !== undefined && { welcomeMessage: data.welcomeMessage }),
        ...(typeof data.requireAdminMfa === 'boolean' && { requireAdminMfa: data.requireAdminMfa }),
        ...(typeof data.requireKnowledgeApproval === 'boolean' && { requireKnowledgeApproval: data.requireKnowledgeApproval }),
        ...(data.retentionDays !== undefined && { retentionDays: data.retentionDays }),
        ...(data.privacyNotice !== undefined && { privacyNotice: (data.privacyNotice ?? '').trim().slice(0, 1500) || null }),
        ...(data.emergencyContacts !== undefined && {
          emergencyContacts: (data.emergencyContacts ?? '').trim().slice(0, 2000) || null,
        }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl }),
        ...(data.webhookUrl !== undefined && { webhookUrl: data.webhookUrl }),
        ...(data.enabledWebhookEvents !== undefined && { enabledWebhookEvents: data.enabledWebhookEvents }),
        ...(data.payoutBankName !== undefined && { payoutBankName: data.payoutBankName || null }),
        ...(data.payoutAccountName !== undefined && { payoutAccountName: data.payoutAccountName || null }),
        ...(data.payoutAccountNumber !== undefined && { payoutAccountNumber: data.payoutAccountNumber || null }),
        ...(data.payoutUssdCode !== undefined && { payoutUssdCode: data.payoutUssdCode || null }),
        ...(data.defaultLanguage !== undefined && { defaultLanguage: data.defaultLanguage }),
        ...(data.openingHour !== undefined && { openingHour: data.openingHour }),
        ...(data.closingHour !== undefined && { closingHour: data.closingHour }),
        ...(data.serviceDays !== undefined && { serviceDays: data.serviceDays }),
        ...(data.outboundOpeningHour !== undefined && { outboundOpeningHour: data.outboundOpeningHour }),
        ...(data.outboundClosingHour !== undefined && { outboundClosingHour: data.outboundClosingHour }),
        ...(data.outboundDays !== undefined && { outboundDays: data.outboundDays ?? [] }),
        // The widgetPrimaryColor / widgetSecondaryColor / widgetPosition
        // columns still exist but are no longer writable: the embedded chat
        // channel was retired, so there is nothing left for them to style.
        // Accepting them would be a settings form that appears to save and
        // changes nothing anywhere. The columns are kept rather than dropped
        // because removing them needs `db push --accept-data-loss`, and that
        // flag does not belong in this deploy path for three dead colour fields.
      },
    });
  }

  /**
   * Who is making a change, carried from the controller's `req.user`.
   *
   * The write methods below took only an organizationId, which is enough to
   * scope a change and not enough to account for one. Every audited action
   * needs this, so it is a parameter rather than something the service digs
   * out of a request it should not know about.
   */
  private async auditAgency(
    actor: Actor,
    organizationId: string,
    entry: { action: string; targetType: string; targetId: string; previousValue?: unknown; newValue?: unknown }
  ) {
    await recordAudit({
      actor: actor.userId,
      organizationId,
      ipAddress: actor.ipAddress ?? null,
      ...entry,
    });
  }

  async addTeamMember(
    organizationId: string,
    userData: { email: string; fullName: string; role: any },
    actor: Actor
  ) {
    /**
     * The address is NORMALISED here, because every reader lowercases it.
     *
     * `AuthService` looks a user up with `email.trim().toLowerCase()` — on
     * login, on forgot-password, on resend-verification — and `register`
     * lowercases before it writes. This path wrote `userData.email` exactly as
     * an administrator typed it. So inviting "Jane.Doe@Plateau.gov.ng" stored
     * a row that no lookup can ever find:
     *
     *   - the invite link still worked, because `setupAccount` matches on the
     *     TOKEN, so the officer set a password and was signed straight in and
     *     everything looked correct;
     *   - the next time she signed in, `findUnique({ email: lowercased })`
     *     found nothing and she was told "Invalid email or password
     *     credentials";
     *   - forgot-password lowercases too, so it found nothing and returned its
     *     deliberately vague "if an account exists" message while sending
     *     nothing. The account did exist.
     *
     * She was locked out permanently, with no path back through the product,
     * and nothing in any log said why. `User.email` is `@unique`, so this also
     * let "Jane@x.gov.ng" and "jane@x.gov.ng" exist as two different officers.
     */
    const email = userData.email?.trim().toLowerCase();
    if (!email) throw new BadRequestException('A team member needs an email address.');

    // Checked before the invite is written so the caller gets a clear reason
    // rather than a P2002. The lookup is on the normalised address, which is
    // also what makes a differently-cased duplicate impossible.
    const clash = await prisma.user.findUnique({ where: { email } });
    if (clash) {
      throw new BadRequestException(
        clash.organizationId === organizationId
          ? 'Somebody with that email address is already a member of this agency.'
          : 'That email address already belongs to a user on this platform.'
      );
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    // Unusable password — user must set a real password via the invite link.
    // We still bcrypt-hash a random string so the DB field is in valid format.
    const unusablePasswordHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);

    const org = await prisma.organization.findUnique({ where: { id: organizationId } });

    const user = await prisma.user.create({
      data: {
        organizationId,
        email,
        fullName: userData.fullName?.trim() || email,
        role: userData.role,
        passwordHash: unusablePasswordHash,
        passwordResetToken: hashedToken,
        passwordResetExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    /**
     * The invite link is the ONLY way this account ever signs in — it was
     * created with a bcrypt hash of random bytes, so no password reaches it —
     * and the token is stored only as a SHA-256 hash, so after this function
     * returns the raw link exists nowhere.
     *
     * Delivery depends on `RESEND_API_KEY`, which `env.validation.ts` declares
     * OPTIONAL: the API boots fine without it. When it was unset, or when
     * Resend refused, this logged and returned SUCCESS anyway — so an
     * administrator was told the officer had been invited, the officer never
     * received anything, and the link needed to repair it was gone. Every
     * other route back in (forgot-password, resend-verification) is also an
     * email, so there was no way out inside the product.
     *
     * So delivery is REPORTED, and when it fails the setup link is handed to
     * the administrator who just created the account. That is not a widening
     * of access: they are OWNER or ADMIN, they created this user a moment ago
     * in their own agency, and they can delete and re-invite at will. An
     * officer who can never sign in is the worse outcome by a long way.
     */
    const inviteUrl =
      `${process.env.WEB_BASE_URL || 'http://localhost:3000'}/setup-account` +
      `?token=${rawToken}&email=${encodeURIComponent(user.email)}`;

    let emailDelivered = false;
    let deliveryProblem: string | null = null;

    // Any configured provider, over HTTPS — see common/mailer.ts. SMTP is not
    // an option on this host (Render blocks outbound 25/465/587), and hard-
    // coding one vendor meant a rejected key could only be replaced by a
    // deploy.
    const sent = await sendTransactionalEmail({
      to: user.email,
      subject: `You've been invited to join ${org?.name || 'Customer Care Agent'}`,
      html:
        `<p>You have been invited to join ${org?.name || 'Customer Care Agent'} on Customer Care Agent.</p>` +
        `<p><a href="${inviteUrl}">Click here to set up your account</a></p>`,
    });

    if (sent.ok) {
      emailDelivered = true;
    } else {
      deliveryProblem = sent.error ?? 'The invitation email was not sent.';
      console.error('[Organizations] invite email not sent:', deliveryProblem);
    }

    // The role is the point of the record: an invitation is how somebody
    // acquires access. The invite token is NOT recorded — it is a working
    // credential until it is used, and the trail is readable by every admin.
    await this.auditAgency(actor, organizationId, {
      action: 'agency.member.invited',
      targetType: 'User',
      targetId: user.id,
      newValue: { email: user.email, fullName: user.fullName, role: user.role },
    });

    return {
      ...user,
      /** Whether the invitation actually went out. */
      emailDelivered,
      /** Why it did not, when it did not. Safe to show an administrator. */
      deliveryProblem,
      /**
       * Only present when delivery FAILED. The officer cannot sign in without
       * it and nothing can regenerate it, so withholding it on a failed send
       * strands the account. Never returned on success: there is no reason for
       * a working credential to sit in a response body as well as a mailbox.
       */
      inviteUrl: emailDelivered ? undefined : inviteUrl,
    };
  }

  async removeTeamMember(organizationId: string, userId: string, actor: Actor) {
    const user = await prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { id: true, email: true, fullName: true, role: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const removed = await prisma.user.delete({ where: { id: userId, organizationId } });

    // Recorded AFTER the delete and with the row's own details, because once
    // the user is gone there is nothing left to resolve the id against — an
    // audit row naming only a uuid would describe a person nobody can name.
    await this.auditAgency(actor, organizationId, {
      action: 'agency.member.removed',
      targetType: 'User',
      targetId: user.id,
      previousValue: { email: user.email, fullName: user.fullName, role: user.role },
    });

    return removed;
  }

  async updateWhatsAppConfig(
    organizationId: string,
    data: {
      /** The line being edited. Omitted means the first one the read returns. */
      id?: string;
      phoneNumberId: string;
      /** Omitted on an update means UNCHANGED. Required to create. */
      accessToken?: string;
      /** Omitted on an update means UNCHANGED. Required to create. */
      webhookVerifyToken?: string;
      whatsappBusinessId?: string;
      displayPhoneNumber?: string;
    }
  ) {
    // The row this save is allowed to overwrite — named by the caller, or the
    // one the read orders first. NOT "whichever row findFirst returned": see
    // the note on WHATSAPP_ROW_ORDER.
    const existing = data.id
      ? await prisma.whatsAppConfig.findFirst({ where: { id: data.id, organizationId } })
      : await prisma.whatsAppConfig.findFirst({ where: { organizationId }, orderBy: WHATSAPP_ROW_ORDER });
    if (data.id && !existing) {
      // Either the row was deleted or it belongs to another agency. Both are a
      // 404 here; writing a new row instead would silently turn an edit of a
      // line that no longer exists into a second line.
      throw new NotFoundException('That WhatsApp line no longer exists for this agency.');
    }

    // sealWhatsAppCredentials encrypts accessToken and webhookVerifyToken. It
    // THROWS when ENCRYPTION_KEY is unset rather than storing them in the clear
    // — the operator is told to set the key, and nothing is written meanwhile.
    // Both branches return a MASKED view. The stored row now carries ciphertext,
    // which is not a leak but is noise; before encryption this same return
    // handed the caller's own access token straight back in the response body.
    // Neither is what a settings form needs — it needs to know it saved.
    if (existing) {
      // CHANGING THE LINE MUST NOT REQUIRE RE-ENTERING THE TOKEN.
      //
      // Both credentials were required on every save, so switching a line to
      // a different `phoneNumberId` — moving from a test number to the real
      // one, the single most likely edit this form will ever see — meant
      // fetching the Meta token out of Business Manager again. The form even
      // said otherwise, placeholding the masked value with "enter new to
      // replace", so it read as optional and refused as required.
      //
      // Omitted now means UNCHANGED: the field is left out of the update
      // entirely rather than passed through, because the stored value is
      // ciphertext and sealing it a second time would encrypt the encryption
      // and lock the credential away behind a value nothing can read.
      const changes: Record<string, unknown> = {
        phoneNumberId: data.phoneNumberId,
        whatsappBusinessId: data.whatsappBusinessId || existing.whatsappBusinessId,
        displayPhoneNumber: data.displayPhoneNumber || existing.displayPhoneNumber,
        isActive: true,
      };
      if (data.accessToken?.trim()) changes.accessToken = data.accessToken;
      if (data.webhookVerifyToken?.trim()) changes.webhookVerifyToken = data.webhookVerifyToken;

      const saved = await prisma.whatsAppConfig.update({
        where: { id: existing.id },
        data: sealWhatsAppCredentials(changes as any),
      });
      return maskedWhatsAppConfig(saved);
    }

    // A NEW line still needs both: there is nothing stored to fall back on,
    // and a row without a token is a line that reaches nobody.
    if (!data.accessToken?.trim() || !data.webhookVerifyToken?.trim()) {
      throw new BadRequestException(
        'A new WhatsApp line needs both an accessToken and a webhookVerifyToken. ' +
        'They may be omitted only when updating a line that already stores them.'
      );
    }

    const payload = sealWhatsAppCredentials({
      phoneNumberId: data.phoneNumberId,
      accessToken: data.accessToken,
      webhookVerifyToken: data.webhookVerifyToken,
      whatsappBusinessId: data.whatsappBusinessId || `waba_${data.phoneNumberId}`,
      displayPhoneNumber: data.displayPhoneNumber || `+234 WhatsApp`,
      isActive: true,
    });
    const created = await prisma.whatsAppConfig.create({ data: { organizationId, ...payload } });
    return maskedWhatsAppConfig(created);
  }


  /**
   * Which WhatsApp lines does Meta actually hold for this agency?
   *
   * Connecting a line needs a `phoneNumberId`, and nothing in this product
   * could tell an operator what theirs is — the id is not the phone number,
   * it is not shown next to it in most of Meta's UI, and getting it wrong is
   * silent: the row saves, the dashboard shows the line as connected, and the
   * number that actually rings belongs to somebody else's test account.
   *
   * That is how this deployment ended up storing Meta's generic sandbox
   * number, `+1 555-671-9884` / "Test Number", while the line the agency
   * recognised as its own was a different id on the same business account.
   *
   * So this ASKS Meta, with the credential already stored and decrypted here —
   * the operator never handles the token to find out. Read-only: it lists
   * numbers and sends nothing.
   *
   * Returns the WABA's numbers with `isConnectedHere` marking the one this
   * agency has stored, so choosing is a comparison rather than a guess.
   */
  async listMetaPhoneNumbers(organizationId: string, opts: { discover?: boolean; businessId?: string } = {}) {
    const row = await prisma.whatsAppConfig.findFirst({
      where: { organizationId },
      orderBy: WHATSAPP_ROW_ORDER,
    });
    if (!row) {
      throw new NotFoundException(
        'This agency has no WhatsApp line stored, so there is no credential to ask Meta with. ' +
        'Save a line first at Settings → WhatsApp.'
      );
    }

    const config = withWhatsAppCredentials(row)!;
    const businessId = config.whatsappBusinessId;
    if (!config.accessToken || !businessId) {
      throw new BadRequestException(
        'The stored line is missing ' +
        [!config.accessToken && 'an access token', !businessId && 'a WhatsApp business ID']
          .filter(Boolean)
          .join(' and ') +
        ', which are what Meta needs to list the account\'s numbers.'
      );
    }

    const url =
      `https://graph.facebook.com/v21.0/${encodeURIComponent(businessId)}/phone_numbers` +
      `?fields=id,display_phone_number,verified_name,code_verification_status,quality_rating,platform_type`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: any) {
      // Could not ask is not the same as holds nothing, and reporting an empty
      // list here would read as an account with no numbers on it.
      throw new ServiceUnavailableException(
        `Could not reach Meta to list this account's numbers: ${err?.message ?? err}`
      );
    }

    const body: any = await res.json().catch(() => null);
    // Meta's own words. An expired token and a business ID belonging to
    // another account read identically as "it did not work" otherwise.
    const primaryError = res.ok ? null : (body?.error?.message ?? `HTTP ${res.status}`);

    // A failed primary listing is only fatal when there is nothing else to
    // try. The WIDER SEARCH below does not use the stored
    // `whatsappBusinessId` — it walks the credential's own businesses — so it
    // can still answer when that stored id is the thing that is wrong.
    //
    // And that is the LIKELIEST reason to need it. The stored business id
    // pointing at an account the token cannot see is exactly the case the
    // wider search was written for, and throwing here made it unreachable
    // from the one situation it was for: the operator asked which accounts
    // the credential can see and was told, instead, that one account refused.
    if (primaryError && !opts.discover && !opts.businessId) {
      throw new BadRequestException(
        `Meta refused to list this account's numbers: ${primaryError}. ` +
        'Retry with discover=1 to search every account this credential can see.'
      );
    }

    const numbers: any[] = Array.isArray(body?.data) ? body.data : [];

    // Optional WIDER SEARCH, because the numbers are not always on the
    // account we hold a credential for.
    //
    // A WhatsApp Business Account is not the business, and one Meta business
    // portfolio can own several WABAs — a sandbox one created by a quickstart
    // and the real one created later. A number added to the second is
    // invisible from the first, so the operator sees "no numbers" and
    // reasonably concludes the verification did not take. Asking which
    // accounts this credential can see at all turns that dead end into the
    // answer.
    //
    // Off by default: it is several Graph calls, all of them subject to
    // Meta's business-use-case rate limits, and the common case needs one.
    const discovered = opts.discover || opts.businessId
      ? await this.discoverWhatsAppAccounts(config.accessToken, opts.businessId, row.phoneNumberId)
      : null;

    return {
      whatsappBusinessId: businessId,
      connectedPhoneNumberId: row.phoneNumberId,
      // Present only when the stored account refused. `numbers` is then an
      // empty list because nothing was read from it — NOT because it holds
      // none — and this is what stops the screen rendering that as an empty
      // account.
      ...(primaryError ? { primaryError } : {}),
      ...(discovered ? { discovered } : {}),
      numbers: numbers.map((n) => ({
        phoneNumberId: n?.id ?? null,
        displayPhoneNumber: n?.display_phone_number ?? null,
        verifiedName: n?.verified_name ?? null,
        codeVerificationStatus: n?.code_verification_status ?? null,
        qualityRating: n?.quality_rating ?? null,
        platformType: n?.platform_type ?? null,
        isConnectedHere: !!n?.id && n.id === row.phoneNumberId,
        // Meta's sandbox numbers live in the +1 555 range and only exchange
        // messages with a handful of recipients added by hand, so one is
        // proof the stack works and is never a number to publish. Saying so
        // here is cheaper than finding out after it is announced.
        isMetaTestNumber:
          typeof n?.display_phone_number === 'string' &&
          /^\+1\s*555/.test(n.display_phone_number),
      })),
    };
  }

  /**
   * Which WhatsApp Business Accounts can this credential see, and what
   * numbers are on each?
   *
   * `businessId` narrows it to one portfolio when the operator knows which —
   * otherwise the token's own businesses are walked. Every step is read-only
   * and every failure is reported rather than thrown: a System User token
   * without `business_management` cannot list businesses at all, and that is
   * not the same as there being none.
   *
   * Bounded on purpose. These calls carry Meta's business-use-case rate
   * limits, so the fan-out is capped and says when it truncated rather than
   * quietly returning part of the picture as if it were all of it.
   */
  private async discoverWhatsAppAccounts(
    accessToken: string,
    businessId: string | undefined,
    connectedPhoneNumberId: string
  ) {
    const MAX_BUSINESSES = 5;
    const MAX_ACCOUNTS = 10;
    const notes: string[] = [];

    const who = await metaGet('https://graph.facebook.com/v21.0/me?fields=id,name', accessToken);
    const identity = who.ok ? { id: who.body?.id ?? null, name: who.body?.name ?? null } : null;
    if (!who.ok) notes.push(`Could not identify the credential — ${who.error}`);

    let businesses: Array<{ id: string; name?: string }> = [];
    if (businessId) {
      businesses = [{ id: businessId }];
    } else {
      const mine = await metaGet(
        'https://graph.facebook.com/v21.0/me/businesses?fields=id,name&limit=25',
        accessToken
      );
      if (mine.ok) {
        businesses = (Array.isArray(mine.body?.data) ? mine.body.data : []).map((b: any) => ({
          id: b?.id,
          name: b?.name,
        })).filter((b: any) => b.id);
        if (businesses.length === 0) {
          notes.push('This credential reports no Meta business portfolios. Pass a businessId to look in one directly.');
        }
      } else {
        notes.push(
          `Could not list this credential's businesses — ${mine.error}. A System User token ` +
          'without business_management cannot, which is not the same as there being none. ' +
          'Pass a businessId to look in one directly.'
        );
      }
    }

    if (businesses.length > MAX_BUSINESSES) {
      notes.push(`${businesses.length} businesses found; only the first ${MAX_BUSINESSES} were searched.`);
      businesses = businesses.slice(0, MAX_BUSINESSES);
    }

    const accounts: any[] = [];
    for (const business of businesses) {
      const found: Array<{ id: string; name?: string; relation: string }> = [];

      // Owned and shared accounts are different edges, and a line can sit on
      // either, so both are asked and a failure on one does not hide the other.
      for (const [edge, relation] of [
        ['owned_whatsapp_business_accounts', 'owned'],
        ['client_whatsapp_business_accounts', 'shared'],
      ] as const) {
        const res = await metaGet(
          `https://graph.facebook.com/v21.0/${encodeURIComponent(business.id)}/${edge}?fields=id,name&limit=25`,
          accessToken
        );
        if (res.ok) {
          for (const w of Array.isArray(res.body?.data) ? res.body.data : []) {
            if (w?.id) found.push({ id: w.id, name: w.name, relation });
          }
        } else {
          notes.push(`${business.name || business.id}: could not list ${relation} accounts — ${res.error}`);
        }
      }

      for (const waba of found.slice(0, MAX_ACCOUNTS)) {
        const nums = await metaGet(
          `https://graph.facebook.com/v21.0/${encodeURIComponent(waba.id)}/phone_numbers` +
          '?fields=id,display_phone_number,verified_name,code_verification_status,platform_type&limit=25',
          accessToken
        );
        accounts.push({
          businessId: business.id,
          businessName: business.name ?? null,
          whatsappBusinessId: waba.id,
          whatsappBusinessName: waba.name ?? null,
          relation: waba.relation,
          // `null` means NOT READ, never "holds none".
          numbers: nums.ok
            ? (Array.isArray(nums.body?.data) ? nums.body.data : []).map((n: any) => ({
                phoneNumberId: n?.id ?? null,
                displayPhoneNumber: n?.display_phone_number ?? null,
                verifiedName: n?.verified_name ?? null,
                codeVerificationStatus: n?.code_verification_status ?? null,
                platformType: n?.platform_type ?? null,
                isConnectedHere: !!n?.id && n.id === connectedPhoneNumberId,
                isMetaTestNumber:
                  typeof n?.display_phone_number === 'string' &&
                  /^\+1\s*555/.test(n.display_phone_number),
              }))
            : null,
          ...(nums.ok ? {} : { numbersError: nums.error }),
        });
      }
      if (found.length > MAX_ACCOUNTS) {
        notes.push(
          `${business.name || business.id} holds ${found.length} WhatsApp accounts; only the first ${MAX_ACCOUNTS} were searched.`
        );
      }
    }

    return { identity, accounts, notes };
  }

  /**
   * Subscribe this deployment to Meta's webhooks for the agency's line.
   *
   * A valid token, a correct callback URL and a connected number are not
   * enough: Meta accepts a citizen's message and delivers it NOWHERE unless
   * TWO separate subscriptions exist, and neither is visible from the other.
   *
   *  1. THE APP → THE ACCOUNT. The Meta app must be subscribed to that
   *     specific WhatsApp Business Account (`/{waba}/subscribed_apps`). A
   *     portfolio with several accounts subscribes them one at a time, so
   *     adding the real line to a second account leaves it unsubscribed while
   *     the first still works.
   *  2. THE APP → THE `messages` FIELD, with our callback URL registered
   *     (`/{app-id}/subscriptions`). Without it there is nowhere to deliver
   *     even a subscribed account's messages. This call needs an APP access
   *     token — `{META_APP_ID}|{WHATSAPP_APP_SECRET}` — not the tenant's.
   *
   * Both are attempted, independently: one failing must not hide whether the
   * other worked, because they fail for different reasons and are fixed in
   * different places.
   *
   * ACT, THEN ANNOUNCE. The outcome is read back from `subscribed_apps`
   * afterwards and reported from THAT, never from the fact that a request
   * returned 200. Reporting the request as the outcome is the fabrication this
   * codebase exists to keep out.
   */
  async subscribeWhatsAppWebhooks(organizationId: string) {
    const row = await prisma.whatsAppConfig.findFirst({
      where: { organizationId },
      orderBy: WHATSAPP_ROW_ORDER,
    });
    if (!row) {
      throw new NotFoundException('This agency has no WhatsApp line stored, so there is nothing to subscribe.');
    }
    const config = withWhatsAppCredentials(row)!;
    if (!config.accessToken || !config.whatsappBusinessId) {
      throw new BadRequestException(
        'The stored line needs both an access token and a WhatsApp business ID before Meta can be asked to subscribe.'
      );
    }

    const callbackUrl = whatsAppWebhookUrl();
    const steps: Array<{ step: string; ok: boolean; detail: string }> = [];

    // 1. The app → this account.
    const sub = await metaPost(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(config.whatsappBusinessId)}/subscribed_apps`,
      config.accessToken
    );
    steps.push({
      step: `Subscribe the app to account ${config.whatsappBusinessId}`,
      ok: sub.ok,
      detail: sub.ok
        ? 'Meta accepted the request.'
        : sub.reached
          ? `Meta refused it — ${sub.error}`
          : `Could not reach Meta — ${sub.error}`,
    });

    // 2. The app → the `messages` field, with our callback URL.
    const appId = process.env.META_APP_ID?.trim();
    const appSecret = process.env.WHATSAPP_APP_SECRET?.trim();
    const verifyToken = (process.env.WHATSAPP_VERIFY_TOKEN?.trim() || config.webhookVerifyToken || '').trim();
    if (!appId || !appSecret) {
      steps.push({
        step: 'Register the callback URL and the `messages` and `calls` fields',
        ok: false,
        detail:
          'Needs ' + [!appId && 'META_APP_ID', !appSecret && 'WHATSAPP_APP_SECRET'].filter(Boolean).join(' and ') +
          '. Meta requires an APP access token for this call, which is the app id and secret together — ' +
          'the tenant\'s own token cannot make it.',
      });
    } else if (!verifyToken) {
      steps.push({
        step: 'Register the callback URL and the `messages` and `calls` fields',
        ok: false,
        detail:
          'No verify token available. Meta calls the callback URL back with it before accepting the ' +
          'registration, so there is nothing for the handshake to match.',
      });
    } else {
      // `calls` as well as `messages`, so a citizen phoning the agency from
      // inside WhatsApp is delivered at all. Calling can be switched on for a
      // line (see setWhatsAppCalling) while this subscription covers only
      // `messages`, and the result is the worst of both: Meta rings the
      // business, nothing is ever delivered, and no log anywhere records that
      // somebody tried.
      //
      // Asked for TOGETHER, then SEPARATELY on a refusal. One `subscriptions`
      // call carries both field names, so an app that may not subscribe to
      // `calls` — the permission is not granted to every app — would have had
      // its `messages` subscription refused along with it, breaking the one
      // channel that was working in order to add one that was not. The retry
      // keeps `messages` whatever Meta thinks of `calls`, and the gap is
      // reported rather than hidden.
      const subscribe = (fields: string) =>
        metaPost(
          `https://graph.facebook.com/v21.0/${encodeURIComponent(appId)}/subscriptions` +
          `?object=whatsapp_business_account&callback_url=${encodeURIComponent(callbackUrl)}` +
          `&verify_token=${encodeURIComponent(verifyToken)}&fields=${encodeURIComponent(fields)}`,
          // The APP access token. Never logged, never returned.
          `${appId}|${appSecret}`
        );

      const both = await subscribe('messages,calls');
      if (both.ok) {
        steps.push({
          step: 'Register the callback URL and the `messages` and `calls` fields',
          ok: true,
          detail: `Meta accepted ${callbackUrl} for the \`messages\` and \`calls\` fields.`,
        });
      } else {
        const messagesOnly = await subscribe('messages');
        steps.push({
          step: 'Register the callback URL and the `messages` field',
          ok: messagesOnly.ok,
          detail: messagesOnly.ok
            ? `Meta accepted ${callbackUrl} for the \`messages\` field.`
            : messagesOnly.reached
              ? `Meta refused it — ${messagesOnly.error}`
              : `Could not reach Meta — ${messagesOnly.error}`,
        });
        steps.push({
          step: 'Register the `calls` field (a citizen phoning from inside WhatsApp)',
          ok: false,
          detail:
            (both.reached ? `Meta refused it — ${both.error}` : `Could not reach Meta — ${both.error}`) +
            ' Messaging is unaffected. Until this is accepted, a WhatsApp call to this line is never ' +
            'delivered here, so turning calling on would ring the business and reach nobody.',
        });
      }
    }

    // What is TRUE now, read back rather than inferred from the calls above.
    const after = await metaGet(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(config.whatsappBusinessId)}/subscribed_apps`,
      config.accessToken
    );
    const subscribedApps = after.ok
      ? (Array.isArray(after.body?.data) ? after.body.data : [])
          .map((d: any) => d?.whatsapp_business_api_data?.name || d?.whatsapp_business_api_data?.id)
          .filter(Boolean)
      : null;

    return {
      whatsappBusinessId: config.whatsappBusinessId,
      callbackUrl,
      steps,
      // `null` means the read-back failed, NOT that nothing is subscribed.
      subscribedApps,
      ...(after.ok ? {} : { verificationError: after.error }),
      confirmed: Array.isArray(subscribedApps) && subscribedApps.length > 0,
      nextStep:
        Array.isArray(subscribedApps) && subscribedApps.length > 0
          ? 'Meta now reports an app subscribed to this account. Send a message to the line to confirm end to end.'
          : after.ok
            ? 'Meta still reports no app subscribed to this account. The steps above say why.'
            : 'The subscription could not be read back, so whether it took is unknown — not confirmed.',
    };
  }

  /**
   * Move a verified number OUT OF SANDBOX by registering it for Cloud API.
   *
   * This is the step with no button anywhere. Meta's own documentation is
   * explicit that a business phone number can be registered ONLY through the
   * API — not through WhatsApp Manager and not through the App Dashboard — so
   * a number can be verified, display-name approved, sitting in the account,
   * and still unusable, with nothing in any Meta screen offering to finish
   * it. It reads as `platformType: NOT_APPLICABLE`, which looks like a
   * property of the number rather than a step nobody has taken.
   *
   * That is exactly the position of this deployment's real Nigerian line
   * while the sandbox `+1 555` number is the only one the platform can use.
   *
   * ── The PIN ─────────────────────────────────────────────────────────────
   *
   * Meta reuses one field for two meanings. If the number ALREADY has
   * two-step verification, the pin must MATCH the existing one or the call is
   * refused. If it does not, whatever is sent BECOMES the number's two-step
   * PIN from then on. So it is never defaulted or generated here: a guessed
   * value either fails or silently sets a credential the operator does not
   * know.
   *
   * ── Why it is not retried ───────────────────────────────────────────────
   *
   * Meta limits this endpoint to 10 requests per business number in a rolling
   * 72-hour window. A retry loop on a wrong PIN would burn a day's budget and
   * leave the number unregisterable until the window moved, so one attempt is
   * made and the refusal is reported verbatim.
   */
  async registerNumberForCloudApi(
    organizationId: string,
    args: { phoneNumberId: string; pin: string }
  ) {
    const pin = args.pin?.trim() ?? '';
    if (!/^[0-9]{6}$/.test(pin)) {
      throw new BadRequestException(
        'The PIN must be exactly 6 digits. If this number already has two-step verification, ' +
        'it must be the existing PIN; otherwise it becomes the number\'s two-step PIN.'
      );
    }
    const phoneNumberId = args.phoneNumberId?.trim();
    if (!phoneNumberId) throw new BadRequestException('phoneNumberId is required.');

    const row = await prisma.whatsAppConfig.findFirst({
      where: { organizationId },
      orderBy: WHATSAPP_ROW_ORDER,
    });
    if (!row) {
      throw new NotFoundException(
        'This agency has no WhatsApp line stored, so there is no credential to register with.'
      );
    }
    const config = withWhatsAppCredentials(row)!;
    if (!config.accessToken) {
      throw new BadRequestException('The stored line has no access token, so Meta cannot be asked.');
    }

    // Read BEFORE, so "already registered" is distinguishable from "we did it".
    const before = await metaGet(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}` +
      '?fields=display_phone_number,verified_name,code_verification_status,platform_type',
      config.accessToken
    );
    if (before.reached && !before.ok) {
      throw new BadRequestException(`Meta refused to read that number: ${before.error}`);
    }
    const wasAlready = before.ok && before.body?.platform_type === 'CLOUD_API';

    const res = await metaPost(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/register`,
      config.accessToken,
      { messaging_product: 'whatsapp', pin }
    );

    // ACT, THEN ANNOUNCE. `platform_type` read back from Meta is the outcome;
    // the request returning 200 is not. Reporting the request as the result is
    // the fabrication this codebase exists to keep out.
    const after = await metaGet(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}` +
      '?fields=display_phone_number,verified_name,code_verification_status,platform_type',
      config.accessToken
    );

    const platformType = after.ok ? (after.body?.platform_type ?? null) : null;
    const registered = platformType === 'CLOUD_API';

    return {
      phoneNumberId,
      displayPhoneNumber: after.ok ? (after.body?.display_phone_number ?? null) : null,
      verifiedName: after.ok ? (after.body?.verified_name ?? null) : null,
      codeVerificationStatus: after.ok ? (after.body?.code_verification_status ?? null) : null,
      // `null` means the read-back failed — NOT that it is unregistered.
      platformType,
      wasAlreadyRegistered: wasAlready,
      accepted: res.ok,
      requestDetail: res.ok
        ? 'Meta accepted the registration request.'
        : res.reached
          ? `Meta refused it — ${res.error}`
          : `Could not reach Meta — ${res.error}`,
      ...(after.ok ? {} : { verificationError: after.error }),
      registered,
      nextStep: registered
        ? wasAlready
          ? 'This number was already on Cloud API. Point the line at it and subscribe the webhooks.'
          : 'Meta now reports this number on CLOUD_API. Point the line at it, subscribe the webhooks, and any WhatsApp user can message it.'
        : after.ok
          ? `Meta still reports platform_type ${platformType ?? 'unknown'}, so the number is not on Cloud API. The request detail above says why. Meta allows 10 registration attempts per number per 72 hours, so check the PIN before trying again.`
          : 'The result could not be read back, so whether the number is now on Cloud API is unknown — not confirmed.',
    };
  }

  /**
   * WhatsApp CALLING: let a citizen phone the agency from inside WhatsApp.
   *
   * This is the only route by which someone in Plateau reaches a voice agent
   * on a NIGERIAN number without a carrier being involved at all. No Twilio
   * number to buy, no international leg, no toll-free that is only free in
   * another country, and nothing for the citizen to pay beyond data.
   *
   * Calling is OFF by default on every business number, and there is no way
   * to turn it on from the WhatsApp Manager screens an operator would think
   * to look at — `POST /{phone-number-id}/settings` is the switch.
   *
   * Eligibility is Meta's, not ours, and the refusals are worth reading
   * rather than retrying: the number must be registered on Cloud API (see
   * registerNumberForCloudApi — a number at platform_type NOT_APPLICABLE
   * cannot have calling enabled), and published guidance says a messaging
   * limit of 2,000 is required, which a newly registered number does not
   * start with. So Meta's own words are reported verbatim.
   */
  /**
   * The WhatsApp line a calling request means, by id when the screen names one.
   *
   * `updateWhatsAppConfig` already works this way, and the calling pair did
   * not — they both took `findFirst` ordered by `isActive desc, createdAt asc`
   * and acted on whichever row that returned. On an agency holding one line
   * that is the same row either way. On an agency holding two it is the OLDER
   * one, whatever the operator has on screen.
   *
   * That is not theoretical: enabling calling on a newly added Meta test
   * number asked Meta about the agency's original Nigerian number instead, and
   * the refusal came back naming a number the operator had not touched. It is
   * the same defect CLAUDE.md records for the settings save paths, which were
   * fixed and left these two behind.
   *
   * An id belonging to another agency is a 404 rather than a fallthrough to
   * the default row: silently acting on a different line is how this started.
   */
  private async whatsAppLineFor(organizationId: string, configId?: string) {
    const row = configId
      ? await prisma.whatsAppConfig.findFirst({ where: { id: configId, organizationId } })
      : await prisma.whatsAppConfig.findFirst({ where: { organizationId }, orderBy: WHATSAPP_ROW_ORDER });
    if (!row) {
      throw new NotFoundException(
        configId
          ? 'That WhatsApp line no longer exists for this agency.'
          : 'This agency has no WhatsApp line stored.'
      );
    }
    const config = withWhatsAppCredentials(row)!;
    if (!config.accessToken) {
      throw new BadRequestException('The stored line has no access token, so Meta cannot be asked.');
    }
    return { row, config };
  }

  async setWhatsAppCalling(organizationId: string, enabled: boolean, configId?: string) {
    const { row, config } = await this.whatsAppLineFor(organizationId, configId);

    const graphVersion = metaGraphVersion();
    const settingsUrl = metaGraphUrl(`${encodeURIComponent(row.phoneNumberId)}/settings`);

    const res = await metaPost(settingsUrl, config.accessToken, {
      calling: { status: enabled ? 'ENABLED' : 'DISABLED' },
    });

    // ACT, THEN ANNOUNCE. The verdict comes from reading the setting back,
    // never from the request returning 200.
    const after = await metaGet(settingsUrl, config.accessToken);
    const status = after.ok ? (after.body?.calling?.status ?? null) : null;

    return {
      phoneNumberId: row.phoneNumberId,
      displayPhoneNumber: row.displayPhoneNumber,
      requested: enabled ? 'ENABLED' : 'DISABLED',
      accepted: res.ok,
      // The version is reported because it is one of the three things that
      // can cause the refusal below, and the only one invisible from Meta's
      // own wording.
      graphVersion,
      requestDetail: res.ok
        ? 'Meta accepted the request.'
        : res.reached
          ? `Meta refused it — ${res.error}`
          : `Could not reach Meta — ${res.error}`,
      ...(res.ok ? {} : { refusalReading: interpretMetaRefusal(res.error, graphVersion) ?? undefined }),
      // `null` means the read-back failed, NOT that calling is off.
      callingStatus: status,
      ...(after.ok ? {} : { verificationError: after.error }),
      enabled: status === 'ENABLED',
      nextStep:
        status === 'ENABLED'
          ? `Citizens can now call ${row.displayPhoneNumber || row.phoneNumberId} from inside WhatsApp. ` +
            'Point the ElevenLabs agent at this line so the call is answered.'
          : after.ok
            ? `Meta reports calling as ${status ?? 'unset'}. The request detail above says why. Calling needs the ` +
              'number registered on Cloud API, and Meta publishes a messaging-limit requirement a newly ' +
              'registered number does not meet on day one.'
            : 'The setting could not be read back, so whether calling is on is unknown — not confirmed.',
    };
  }

  /**
   * The number's daily messaging limit, which is what decides whether calling
   * can be switched on at all.
   *
   * Meta refuses `calling: ENABLED` with "Calling APIs cannot be enabled for
   * this phone number" when the limit is below 2,000 — error 2593145 from
   * Business Manager's own mutation, 138015 on the Graph API. Nothing in this
   * platform causes that and nothing here fixes it, so the least useful thing
   * to do is quote Meta and stop: the operator is left to find the rule
   * somewhere in Meta's documentation.
   *
   * A SEPARATE request on purpose. `messaging_limit_tier` is deprecated in
   * favour of `whatsapp_business_manager_messaging_limit`, and Graph rejects
   * the WHOLE request when it is asked for a field a version does not carry —
   * so folding this into the numbers listing would turn a working 200 into a
   * 400 and blank the settings screen to report a tier. Both field names are
   * tried, newest first.
   *
   * Returns null for "could not read", never a guess. An unknown limit must
   * not be reported as a low one: that would tell an agency its number is
   * ineligible when the real cause might be the country rule.
   */
  private async messagingLimitFor(phoneNumberId: string, accessToken: string): Promise<string | null> {
    for (const field of ['whatsapp_business_manager_messaging_limit', 'messaging_limit_tier']) {
      const res = await metaGet(
        metaGraphUrl(`${encodeURIComponent(phoneNumberId)}?fields=${field}`),
        accessToken
      );
      if (!res.ok) continue;
      const value = res.body?.[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  /**
   * Does this tier meet Meta's threshold for calling?
   *
   * `true` / `false` / `null` for unknown, and the null matters: "could not
   * read the tier" is not "the tier is too low".
   */
  private callingTierMet(tier: string | null): boolean | null {
    if (!tier) return null;
    // UNLIMITED carries no digits and obviously clears the threshold. Without
    // this it parsed as "unknown", so the highest tier there is would have
    // been reported as "whether calling can be enabled is unknown".
    if (/unlimited/i.test(tier)) return true;
    const digits = tier.match(/(\d+)\s*K?/i);
    if (!digits) return null;
    const raw = Number(digits[1]);
    const scaled = /k/i.test(tier) ? raw * 1000 : raw;
    return Number.isFinite(scaled) ? scaled >= 2000 : null;
  }

  /** What Meta currently reports for this line's calling setting. Read-only. */
  async getWhatsAppCalling(organizationId: string, configId?: string) {
    const { row, config } = await this.whatsAppLineFor(organizationId, configId);

    const graphVersion = metaGraphVersion();
    const res = await metaGet(metaGraphUrl(`${encodeURIComponent(row.phoneNumberId)}/settings`), config.accessToken);
    if (!res.ok) {
      return {
        phoneNumberId: row.phoneNumberId,
        displayPhoneNumber: row.displayPhoneNumber,
        graphVersion,
        callingStatus: null,
        enabled: false,
        // Could not ask is not the same as off.
        error: res.reached ? `Meta refused the read — ${res.error}` : `Could not reach Meta — ${res.error}`,
        ...(res.reached ? { refusalReading: interpretMetaRefusal(res.error, graphVersion) ?? undefined } : {}),
      };
    }
    const status = res.body?.calling?.status ?? null;
    const messagingLimit = await this.messagingLimitFor(row.phoneNumberId, config.accessToken);
    const tierMet = this.callingTierMet(messagingLimit);
    return {
      phoneNumberId: row.phoneNumberId,
      displayPhoneNumber: row.displayPhoneNumber,
      graphVersion,
      callingStatus: status,
      enabled: status === 'ENABLED',
      settings: res.body?.calling ?? null,
      // Meta will not let calling be switched on below 2,000 unique
      // recipients a day. Saying so BEFORE the operator presses the toggle is
      // the difference between an answer and a dead end.
      messagingLimit,
      callingEligibility:
        tierMet === null
          ? "Meta did not report this number's messaging limit, so whether calling can be enabled is unknown."
          : tierMet
            ? `Messaging limit ${messagingLimit} meets Meta's threshold of 2,000 for calling.`
            : `Messaging limit ${messagingLimit} is BELOW Meta's threshold of 2,000, so Meta will refuse to ` +
              'enable calling. The limit rises by completing business verification and sustained use — it ' +
              'cannot be bought.',
    };
  }

  /**
   * Will a citizen's WhatsApp message actually REACH us?
   *
   * Everything else about this channel reports what WE hold. Nothing asked
   * Meta whether it will deliver anything — and the ways it silently will not
   * are the ways that look exactly like a fault in this platform:
   *
   *  - **No app subscribed to the business account.** The line is stored, the
   *    token is valid, every screen is green, and Meta sends nothing. Each
   *    message a citizen writes is dropped before it reaches us, and the only
   *    symptom is silence.
   *  - **The number's webhook override points somewhere else.** A line moved
   *    between apps or providers keeps the old override, so deliveries go to
   *    whoever had it before.
   *  - **`WHATSAPP_APP_SECRET` unset.** The POST route cannot verify a
   *    signature and answers 500, deliberately, so Meta retries the same
   *    message indefinitely and nothing is ever processed.
   *
   * Same three states as the voice report, and for the same reason: `blocked`
   * means a message cannot arrive, `degraded` means reduced service or we
   * could not check — unknown stays unknown, because treating "could not
   * check" as "works" is how the voice report got it wrong — and `ready` only
   * when Meta itself confirms.
   */
  async whatsAppReadiness(organizationId: string) {
    const rows = await prisma.whatsAppConfig.findMany({
      where: { organizationId },
      orderBy: WHATSAPP_ROW_ORDER,
    });

    const blocked: string[] = [];
    const degraded: string[] = [];
    const ok: string[] = [];

    if (rows.length === 0) {
      return {
        state: 'blocked' as const,
        blocked: ['This agency has no WhatsApp line stored, so no message can be routed to it.'],
        degraded: [],
        ok: [],
        webhookUrl: whatsAppWebhookUrl(),
        lines: [],
        nextStep: 'Store a line at Settings → WhatsApp.',
      };
    }

    // The URL Meta must be sending to. Printed from the same expression the
    // route is served on, so what is shown is what will be compared — the
    // voice report earned that rule by printing a URL it had built differently.
    const expectedWebhook = whatsAppWebhookUrl();

    if (!process.env.WHATSAPP_APP_SECRET?.trim()) {
      blocked.push(
        'WHATSAPP_APP_SECRET is not set, so the webhook cannot verify Meta\'s signature and ' +
        'answers 500 on every delivery. Meta then retries the same message forever and nothing ' +
        'is processed.'
      );
    } else {
      // "Set" is all this line can honestly claim. Whether the secret belongs
      // to a SUBSCRIBED app is checked per line below, against Meta's own
      // list — this used to say "so deliveries can be verified", which is a
      // statement about a variable being non-empty dressed up as a statement
      // about Meta.
      ok.push('WHATSAPP_APP_SECRET is set. Whether it is the right app\u2019s secret is checked per line below.');
    }

    const lines: any[] = [];
    for (const row of rows) {
      const config = withWhatsAppCredentials(row)!;
      const label = row.displayPhoneNumber || row.phoneNumberId;
      const line: any = {
        phoneNumberId: row.phoneNumberId,
        displayPhoneNumber: row.displayPhoneNumber,
        isActive: row.isActive,
        tokenAccepted: null as boolean | null,
        subscribedApps: null as string[] | null,
        numberWebhook: null as string | null,
      };

      if (!config.accessToken) {
        blocked.push(`${label}: no stored access token, so Meta cannot be asked or answered.`);
        lines.push(line);
        continue;
      }

      // 1. Does Meta still accept the token, and where does this number send?
      const number = await metaGet(
        `https://graph.facebook.com/v21.0/${encodeURIComponent(row.phoneNumberId)}` +
        `?fields=display_phone_number,verified_name,webhook_configuration`,
        config.accessToken
      );
      if (number.reached && number.ok) {
        line.tokenAccepted = true;
        ok.push(`${label}: Meta accepted the stored token.`);

        const override = number.body?.webhook_configuration?.application ?? null;
        line.numberWebhook = override;
        if (override && override.replace(/\/+$/, '') !== expectedWebhook.replace(/\/+$/, '')) {
          blocked.push(
            `${label}: this number's webhook points at ${override}, not ${expectedWebhook}, ` +
            'so its messages are delivered somewhere else.'
          );
        }
        // No override is NORMAL — the app-level webhook applies — so its
        // absence is not reported as a problem.

        if (/^\+1\s*555/.test(number.body?.display_phone_number ?? '')) {
          degraded.push(
            `${label}: a Meta test number. It only exchanges messages with recipients added by ` +
            'hand in Meta → WhatsApp → API Setup, so it proves the stack and cannot serve the public.'
          );
        }
      } else if (number.reached) {
        line.tokenAccepted = false;
        blocked.push(`${label}: Meta refused the stored token — ${number.error}`);
        lines.push(line);
        continue;
      } else {
        degraded.push(`${label}: could not reach Meta to check the token — ${number.error}`);
        lines.push(line);
        continue;
      }

      // 2. Is ANY app subscribed to this business account's webhooks? With
      //    none, Meta delivers nothing and there is no other symptom.
      if (!config.whatsappBusinessId) {
        degraded.push(
          `${label}: no WhatsApp business ID stored, so whether any app is subscribed to its ` +
          'webhooks could not be checked.'
        );
      } else {
        const subs = await metaGet(
          `https://graph.facebook.com/v21.0/${encodeURIComponent(config.whatsappBusinessId)}/subscribed_apps`,
          config.accessToken
        );
        if (subs.reached && subs.ok) {
          // Keep the ID as well as the name. The name is for a human; the ID
          // is the only thing that can be COMPARED against META_APP_ID, and
          // discarding it is what made the check below impossible.
          const rawApps: Array<{ id?: string; name?: string }> = (
            Array.isArray(subs.body?.data) ? subs.body.data : []
          )
            .map((d: any) => ({
              id: d?.whatsapp_business_api_data?.id ? String(d.whatsapp_business_api_data.id) : undefined,
              name: d?.whatsapp_business_api_data?.name ? String(d.whatsapp_business_api_data.name) : undefined,
            }))
            .filter((a: any) => a.id || a.name);
          const apps: string[] = rawApps.map((a) => a.name || a.id!).filter(Boolean);
          line.subscribedApps = apps;
          line.subscribedAppIds = rawApps.map((a) => a.id).filter(Boolean);

          if (apps.length === 0) {
            blocked.push(
              `${label}: no app is subscribed to this business account's webhooks, so Meta ` +
              'delivers nothing. Subscribe the app at Meta → your app → WhatsApp → Configuration.'
            );
          } else {
            ok.push(`${label}: Meta is delivering to a subscribed app (${apps.join(', ')}).`);

            // ── DOES OUR SECRET BELONG TO A SUBSCRIBED APP? ─────────────────
            //
            // This is the check that was missing, and the fault it catches
            // took a live line down for a day.
            //
            // `WHATSAPP_APP_SECRET` is the signing secret of ONE Meta app.
            // Meta signs each delivery with the secret of the app it is
            // delivering to. If the configured secret belongs to an app that
            // is not subscribed here, every delivery is refused with a 403 —
            // and from the outside that is indistinguishable from Meta not
            // delivering at all, which is where the search goes instead.
            //
            // Readiness had BOTH halves of this and never compared them: it
            // listed the subscribed apps, and separately said "the secret is
            // set, so deliveries can be verified" on the strength of a
            // variable being non-empty. That is the "configured is not an
            // answer" failure this codebase exists to avoid, committed by the
            // readiness surface itself.
            const configuredAppId = process.env.META_APP_ID?.trim();
            const subscribedIds = rawApps.map((a) => a.id).filter(Boolean) as string[];
            if (!configuredAppId) {
              degraded.push(
                `${label}: META_APP_ID is not set, so whether WHATSAPP_APP_SECRET belongs to one of ` +
                'these subscribed apps could not be checked. A secret from a different app means ' +
                'every delivery is rejected as an invalid signature.'
              );
            } else if (subscribedIds.length === 0) {
              degraded.push(
                `${label}: Meta named the subscribed apps but gave no ids, so they could not be ` +
                'compared against META_APP_ID.'
              );
            } else if (!subscribedIds.includes(configuredAppId)) {
              blocked.push(
                `${label}: the app this deployment is configured as (META_APP_ID ${configuredAppId}) ` +
                `is NOT among the apps subscribed to this account (${subscribedIds.join(', ')}). ` +
                'WHATSAPP_APP_SECRET is therefore the secret of a different app, so every message ' +
                'Meta delivers is rejected as an invalid signature and the citizen gets no reply. ' +
                'Either subscribe that app, or set META_APP_ID and WHATSAPP_APP_SECRET to one that ' +
                'is subscribed.'
              );
            } else {
              ok.push(
                `${label}: META_APP_ID matches a subscribed app, so Meta's signature will verify.`
              );
            }
          }
        } else if (subs.reached) {
          // A token without whatsapp_business_management cannot read this, and
          // that does not mean nothing is subscribed.
          degraded.push(
            `${label}: could not read the webhook subscriptions — ${subs.error}. ` +
            'That is not the same as nothing being subscribed.'
          );
        } else {
          degraded.push(`${label}: could not reach Meta for the webhook subscriptions — ${subs.error}`);
        }
      }

      if (!row.isActive) {
        degraded.push(`${label}: stored but marked inactive, so it is not used for sending.`);
      }

      lines.push(line);
    }

    // ── Can this deployment ANSWER a call, not merely receive messages? ─────
    //
    // Everything above is about a message arriving. Calling is a separate
    // capability with separate requirements, and nothing here reported it — so
    // an operator could switch calling on at Meta, see it come back ENABLED,
    // and have every call go unanswered because WHATSAPP_CALL_ANSWER was unset
    // or no TURN relay existed, with the screen showing nothing wrong.
    //
    // Not answering is the deliberate DEFAULT and is not a fault: the call is
    // recorded and the citizen gets a message explaining it. So the default is
    // reported as a fact under `ok`, naming what switching it on takes.
    //
    // The flag set WITHOUT a relay is different, and it is BLOCKED. That is
    // the combination the answer path refuses outright, because answering with
    // no relay consumes the call, has the carrier report it completed, and
    // skips the message fallback — worse for the citizen than never answering.
    const answering = callAnswerReadiness();
    if (answering.enabled) {
      ok.push(answering.detail);
    } else if (process.env.WHATSAPP_CALL_ANSWER === '1') {
      blocked.push(
        `Answering inbound WhatsApp calls is switched ON but cannot work: ${answering.blocked.join(' ')}`
      );
    } else {
      ok.push(
        'Inbound WhatsApp calls are recorded and answered with a message, not in voice. To answer them in ' +
          'voice, set WHATSAPP_CALL_ANSWER=1 and a TURN relay (TURN_URL/TURN_USERNAME/TURN_CREDENTIAL, or ' +
          "TURN_PROVIDER=twilio to use the deployment's Twilio account). No real call has been carried over " +
          'that path yet, on this deployment or any other.'
      );
    }

    const state = blocked.length > 0 ? ('blocked' as const)
      : degraded.length > 0 ? ('degraded' as const)
      : ('ready' as const);

    return {
      state,
      blocked,
      degraded,
      ok,
      webhookUrl: expectedWebhook,
      lines,
      nextStep:
        state === 'blocked'
          ? 'A citizen\'s message cannot arrive until the blocked items are resolved.'
          : state === 'degraded'
            ? 'A message can arrive. The degraded items are reduced service, or checks that could not be made.'
            : 'Meta confirms it will deliver to this platform. Send a message to the line to test it end to end.',
    };
  }

  /**
   * Remove a voice line the agency no longer holds.
   *
   * There was no way to do this. A line could be added and edited and never
   * taken away, so a number an agency had given up stayed on the settings
   * screen and in `voice-readiness` — which reports a number the carrier does
   * not route as BLOCKED, correctly. A blocker nobody can clear trains an
   * operator to read the whole report as noise, which is the one thing that
   * report cannot afford.
   *
   * CALL HISTORY SURVIVES. `CallLog.telephonyConfigId` is optional with
   * `onDelete: SetNull`, so the records of calls this line carried keep their
   * numbers, transcripts and outcomes and simply stop pointing at a line that
   * is gone. The count is returned, because "deleted" without saying what
   * happened to the history invites somebody to check the hard way.
   *
   * An id belonging to another agency is a 404, exactly as the edit path
   * treats one: scoping the delete in the WHERE clause is what makes a
   * mistyped id a refusal rather than another agency's line disappearing.
   */
  async deleteTelephonyConfig(actor: Actor, organizationId: string, id: string) {
    const existing = await prisma.telephonyConfig.findFirst({
      where: { id, organizationId },
      select: { id: true, provider: true, phoneNumber: true, isDefault: true },
    });
    if (!existing) {
      throw new NotFoundException('That voice line does not exist for this agency.');
    }

    // Counted BEFORE the delete: afterwards the link is null and the question
    // can no longer be asked.
    const callsKept = await prisma.callLog.count({ where: { telephonyConfigId: id } });

    await prisma.telephonyConfig.delete({ where: { id } });

    await this.auditAgency(actor, organizationId, {
      action: 'agency.telephony_line.deleted',
      targetType: 'TelephonyConfig',
      targetId: id,
      previousValue: {
        provider: existing.provider,
        phoneNumber: existing.phoneNumber,
        isDefault: existing.isDefault,
      },
    });

    const remaining = await prisma.telephonyConfig.count({ where: { organizationId } });
    return {
      deleted: true,
      phoneNumber: existing.phoneNumber,
      provider: existing.provider,
      callsKept,
      remainingLines: remaining,
      note:
        `${existing.phoneNumber} is no longer a line for this agency. ` +
        (callsKept
          ? `${callsKept} call record(s) are kept and no longer point at it.`
          : 'It had carried no calls.') +
        (remaining === 0
          ? ' This agency now has no voice line, so no call can be routed to it.'
          : ''),
    };
  }

  /**
   * The agency's one voice line.
   *
   * There is a single `TelephonyConfig` row per organization, so saving a
   * different provider REPLACES the arrangement rather than adding to it. Three
   * things follow from that, each of which was a real gap:
   *
   *  - **A SIP trunk is configurable at all.** `POST
   *    /api/agent-provisioning/numbers/import-sip` reads `sipAddress` and the
   *    digest credentials off this row, and nothing could write them — so the
   *    import could only ever answer "No SIP trunk is configured", which is a
   *    button that cannot work.
   *  - **`forwardingNumber` is writable.** Both voice handoff paths refuse with
   *    "Set one under Settings → Telephony and try again", and that was a
   *    pointer to a field no form could reach. A refusal naming a fix the
   *    operator cannot carry out is not an honest refusal.
   *  - **The previous provider's fields are CLEARED.** Prisma ignores
   *    `undefined`, so switching Twilio → SIP left the old `accountSid` and
   *    `authToken` on the row: credentials for an arrangement that no longer
   *    exists, sitting in a column something later reads. Switching is a
   *    replacement, so the fields that do not belong to the new provider go to
   *    null.
   */
  async updateTelephonyConfig(
    organizationId: string,
    data: {
      /** The voice line being edited. Omitted means the first one the read returns. */
      id?: string;
      provider: any;
      phoneNumber: string;
      accountSid?: string;
      authToken?: string;
      apiKey?: string;
      forwardingNumber?: string | null;
      sipAddress?: string;
      sipTransport?: string;
      sipUsername?: string;
      sipPassword?: string;
    }
  ) {
    const provider = String(data.provider ?? '').toUpperCase();
    const isSip = provider === 'SIP_TRUNK';

    // Validated against the enum, because an unknown value reached Prisma and
    // came back as a 500 with no reason — and the dashboard's own provider list
    // carried two values that are not enum members (`AFRICA_TALKING`,
    // `NIGERIAN_CARRIER`), so two of the five options an operator could pick
    // returned "Failed to save" and saved nothing, every time.
    if (!TELEPHONY_PROVIDERS.includes(provider as any)) {
      throw new BadRequestException(
        `"${data.provider}" is not a telephony provider this platform supports. Choose one of: ${TELEPHONY_PROVIDERS.join(', ')}.`
      );
    }

    if (isSip) {
      // Named individually, because "invalid SIP configuration" sends an
      // operator back to their carrier's portal without saying what to copy.
      if (!data.sipAddress?.trim()) {
        throw new BadRequestException(
          'A SIP trunk needs its host address — the hostname or IP your carrier gave you for signalling, e.g. sip.carrier.ng. '
          + 'ElevenLabs cannot route the number without it.'
        );
      }
      if (data.sipTransport && !SIP_TRANSPORTS.includes(data.sipTransport as any)) {
        throw new BadRequestException(
          `sipTransport must be one of ${SIP_TRANSPORTS.join(', ')} — "${data.sipTransport}" is not a transport ElevenLabs accepts.`
        );
      }
    }

    // The line this save is allowed to overwrite. See TELEPHONY_ROW_ORDER: an
    // agency can have several, and the previous unordered findFirst meant a
    // save could rewrite a different line from the one on screen.
    const existing = data.id
      ? await prisma.telephonyConfig.findFirst({ where: { id: data.id, organizationId } })
      : await prisma.telephonyConfig.findFirst({ where: { organizationId }, orderBy: TELEPHONY_ROW_ORDER });
    if (data.id && !existing) {
      throw new NotFoundException('That voice line no longer exists for this agency.');
    }

    // A half-filled pair is not partial authentication, it is none, and the
    // import silently drops it. Saying so here is the difference between a
    // trunk that authenticates and one that is quietly ACL-only.
    //
    // Three states, not two, because the form shows a saved password masked and
    // therefore posts nothing for it:
    //
    //  - username, and no password anywhere → rejected, the pair is incomplete
    //  - password posted with no username   → rejected, an orphan credential
    //  - no username, password on the row   → ALLOWED: the operator is dropping
    //    digest auth, and the write below clears the password with it
    if (isSip) {
      const username = Boolean(data.sipUsername?.trim());
      if (username && !data.sipPassword && !existing?.sipPassword) {
        throw new BadRequestException(
          'SIP digest authentication needs BOTH a username and a password. Supply a password, or clear the username '
          + 'for a trunk your carrier authenticates by IP address.'
        );
      }
      if (!username && data.sipPassword) {
        throw new BadRequestException(
          'SIP digest authentication needs BOTH a username and a password. Supply a username, or omit the password '
          + 'for a trunk your carrier authenticates by IP address.'
        );
      }
    }

    // Explicit nulls, not omissions: this row is being replaced, not amended.
    const sipFields = isSip
      ? {
          sipAddress: data.sipAddress!.trim(),
          sipTransport: data.sipTransport ?? 'udp',
          sipUsername: data.sipUsername?.trim() || null,
          // Left untouched when the form posts nothing, so re-saving a trunk to
          // change its transport does not wipe a password the form only ever
          // showed masked — but cleared outright when the username goes, since
          // the pair is the whole credential and half of one is dead weight in
          // a column.
          ...(data.sipPassword
            ? { sipPassword: data.sipPassword }
            : data.sipUsername?.trim()
              ? {}
              : { sipPassword: null }),
        }
      : { sipAddress: null, sipTransport: null, sipUsername: null, sipPassword: null };

    const carrierFields = isSip
      ? { accountSid: null, authToken: null, apiKey: null, apiSecret: null }
      : {
          accountSid: data.accountSid,
          authToken: data.authToken,
          apiKey: data.apiKey,
        };

    const common = {
      provider: provider as any,
      phoneNumber: data.phoneNumber,
      // `?? undefined` keeps an unsent field untouched while still allowing an
      // explicit null to clear a forwarding number that should no longer be used.
      ...(data.forwardingNumber !== undefined
        ? { forwardingNumber: data.forwardingNumber?.trim() || null }
        : {}),
      ...carrierFields,
      ...sipFields,
    };

    if (existing) {
      const saved = await prisma.telephonyConfig.update({
        where: { id: existing.id },
        data: sealTelephonyCredentials(common),
      });
      return maskedTelephonyConfig(saved);
    }

    const sealed = sealTelephonyCredentials(common);
    const created = await prisma.telephonyConfig.create({ data: { organizationId, ...sealed } });
    return maskedTelephonyConfig(created);
  }

  async getTeamMembers(organizationId: string) {
    return prisma.user.findMany({
      where: { organizationId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        avatarUrl: true,
        createdAt: true,
        mdaName: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateTeamMemberRole(organizationId: string, userId: string, newRole: any, actor: Actor) {
    const user = await prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user) throw new NotFoundException('User not found');
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { role: newRole },
      select: { id: true, email: true, fullName: true, role: true, isActive: true },
    });

    // Both sides of the change. "Who made themselves an admin" is unanswerable
    // from the new value alone.
    await this.auditAgency(actor, organizationId, {
      action: 'agency.member.role_changed',
      targetType: 'User',
      targetId: user.id,
      previousValue: { role: user.role },
      newValue: { role: updated.role, email: updated.email },
    });

    return updated;
  }

  async setTeamMemberMda(organizationId: string, userId: string, mdaName: string | null, actor: Actor) {
    const user = await prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user) throw new NotFoundException('User not found');
    const clean = typeof mdaName === 'string' ? mdaName.trim().slice(0, 200) || null : null;
    if (clean && (user.role === 'OWNER' || user.role === 'ADMIN')) {
      // An administrator scoped to one MDA would lose the agency they administer.
      throw new BadRequestException('An owner or administrator cannot be scoped to one MDA. Change their role first.');
    }
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { mdaName: clean },
      select: { id: true, email: true, fullName: true, role: true, isActive: true, mdaName: true },
    });
    await this.auditAgency(actor, organizationId, {
      action: 'agency.member.mda_scope_changed',
      targetType: 'User',
      targetId: user.id,
      previousValue: { mdaName: user.mdaName },
      newValue: { mdaName: clean },
    });
    return updated;
  }

  async updateTeamMemberStatus(organizationId: string, userId: string, isActive: boolean, actor: Actor) {
    const user = await prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user) throw new NotFoundException('User not found');
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { isActive },
      select: { id: true, email: true, fullName: true, role: true, isActive: true },
    });

    // Two actions rather than one with a boolean: a trail is read by someone
    // scanning for what happened, and "deactivated" is findable in a way
    // `status_changed {isActive: false}` is not.
    await this.auditAgency(actor, organizationId, {
      action: isActive ? 'agency.member.activated' : 'agency.member.deactivated',
      targetType: 'User',
      targetId: user.id,
      previousValue: { isActive: user.isActive },
      newValue: { isActive: updated.isActive, email: updated.email },
    });

    return updated;
  }

  getPermissionsMatrix() {
    return [
      {
        module: 'Dashboard Analytics',
        OWNER: 'Full Access',
        ADMIN: 'Full Access',
        AGENT: 'View Only',
        VIEWER: 'View Only',
      },
      {
        module: 'CRM & Contacts',
        OWNER: 'Full Access',
        ADMIN: 'Full Access',
        AGENT: 'View & Edit',
        VIEWER: 'View Only',
      },
      {
        module: 'Agent Console & Live Handoff',
        OWNER: 'Full Access',
        ADMIN: 'Full Access',
        AGENT: 'Full Access',
        VIEWER: 'View Only',
      },
      {
        module: 'Telephony & Outbound Calls',
        OWNER: 'Full Access',
        ADMIN: 'Full Access',
        AGENT: 'Make Calls Only',
        VIEWER: 'No Access',
      },
      {
        module: 'Knowledge Base',
        OWNER: 'Full Access',
        ADMIN: 'Full Access',
        AGENT: 'View & Search',
        VIEWER: 'View Only',
      },
      {
        module: 'Scheduling & Refund Approvals',
        OWNER: 'Full Access',
        ADMIN: 'Full Access',
        AGENT: 'View & Reschedule',
        VIEWER: 'View Only',
      },
      {
        module: 'Organization & Team Settings',
        OWNER: 'Full Access',
        ADMIN: 'Manage Team',
        AGENT: 'No Access',
        VIEWER: 'No Access',
      },
      {
        module: 'API Keys & Webhooks',
        OWNER: 'Full Access',
        ADMIN: 'Full Access',
        AGENT: 'No Access',
        VIEWER: 'No Access',
      },
    ];
  }

  async regenerateApiKey(organizationId: string, actor: Actor) {
    const crypto = await import('crypto');
    const rawKey = `ace_live_pk_${crypto.randomBytes(16).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const created = await prisma.apiKey.create({
      data: {
        organizationId,
        keyName: 'Live Production Key',
        keyHash,
        keyPrefix: rawKey.slice(0, 16),
      },
    });

    // THE PREFIX, NEVER THE KEY. This method returns a live credential, and
    // the trail is readable by every admin in the agency — recording the key
    // itself would turn the audit log into a place to go and collect one.
    // The prefix is enough to tell which key a row is about.
    await this.auditAgency(actor, organizationId, {
      action: 'agency.api_key.regenerated',
      targetType: 'ApiKey',
      targetId: created.id,
      newValue: { keyName: created.keyName, keyPrefix: created.keyPrefix },
    });

    return { apiKey: rawKey };
  }

  // ── The agency's own trail ─────────────────────────────────────────────────

  /**
   * What has been done to this agency, and by whom.
   *
   * Until now the only read of `AuditLog` was `/api/platform/audit`, which is
   * platform-operators-only — so an agency owner asking "who changed this"
   * had no answer about their own tenancy, including no answer about what the
   * ministry had done to them. That is the opposite of what the record is for.
   *
   * Two rules:
   *
   *   - SCOPED BY organizationId, and null is NOT a match. Rows with no
   *     organization belong to no single agency (granting platform status, for
   *     one) and are nobody's tenancy to read.
   *   - THE ACTOR IS RESOLVED WITHOUT CROSSING THE BOUNDARY. This agency's own
   *     staff are named; anybody else is described by their role. The agency
   *     learns that the ministry acted — the accountable fact — without
   *     learning which official it was.
   */
  async auditTrail(
    organizationId: string,
    filter: { action?: string; limit?: number } = {}
  ) {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);

    const entries = await prisma.auditLog.findMany({
      where: {
        organizationId,
        ...(filter.action ? { action: { startsWith: filter.action } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, actor: true, action: true, targetType: true, targetId: true,
        previousValue: true, newValue: true, createdAt: true,
      },
    });

    const actors = await resolveAuditActors(
      (ids) =>
        prisma.user.findMany({
          // Scoped to this agency on purpose: a user id belonging to another
          // tenancy must not resolve to a name here, and an unscoped lookup
          // would happily return the ministry operator's.
          where: { id: { in: ids }, organizationId },
          select: { id: true, fullName: true, email: true },
        }),
      organizationId,
      entries.map((e) => e.actor)
    );

    return {
      entries: entries.map((e) => {
        const resolved = actors.get(e.actor)!;
        return {
          id: e.id,
          action: e.action,
          // `agency.*` is something this agency did; anything else was done to
          // it. Stated rather than left for the reader to infer from a prefix.
          origin: e.action.startsWith('agency.') ? 'agency' : 'platform',
          actor: resolved.label,
          actorIsOwnStaff: resolved.isOwnStaff,
          targetType: e.targetType,
          targetId: e.targetId,
          previousValue: e.previousValue,
          newValue: e.newValue,
          createdAt: e.createdAt,
        };
      }),
      count: entries.length,
      limit,
    };
  }
}

