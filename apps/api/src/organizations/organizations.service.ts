import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { prisma, withWhatsAppCredentials, sealTelephonyCredentials, sealWhatsAppCredentials, decryptSecret, assertUsableServiceHours, assertUsableAgencyName, assertUsableOutboundHours, recordAudit, resolveAuditActors } from '@ace/database';
import { SUPPORTED_LANGUAGES, type Language } from '@ace/orchestrator';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { sendTransactionalEmail } from '../common/mailer';

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
] as const;

function maskedWhatsAppConfig<T extends Record<string, any>>(c: T) {
  return {
    ...c,
    accessToken: maskStoredSecret(c.accessToken, `WhatsAppConfig ${c.id}.accessToken`),
    webhookVerifyToken: maskStoredSecret(
      c.webhookVerifyToken,
      `WhatsAppConfig ${c.id}.webhookVerifyToken`
    ),
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
      whatsAppConfigs: org.whatsAppConfigs.map((c) => ({
        ...c,
        accessToken: maskStoredSecret(c.accessToken, `WhatsAppConfig ${c.id}.accessToken`),
        webhookVerifyToken: maskStoredSecret(
          c.webhookVerifyToken,
          `WhatsAppConfig ${c.id}.webhookVerifyToken`
        ),
      })),
    };
  }

  async updateSettings(
    organizationId: string,
    data: {
      name?: string;
      aiPersonaPrompt?: string;
      welcomeMessage?: string;
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

    return prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(cleanName !== undefined && { name: cleanName }),
        ...(data.aiPersonaPrompt !== undefined && { aiPersonaPrompt: data.aiPersonaPrompt }),
        ...(data.welcomeMessage !== undefined && { welcomeMessage: data.welcomeMessage }),
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
    if (!res.ok) {
      // Meta's own words. An expired token and a business ID belonging to
      // another account read identically as "it did not work" otherwise.
      const message = body?.error?.message ?? `HTTP ${res.status}`;
      throw new BadRequestException(`Meta refused to list this account's numbers: ${message}`);
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
  async setWhatsAppCalling(organizationId: string, enabled: boolean) {
    const row = await prisma.whatsAppConfig.findFirst({
      where: { organizationId },
      orderBy: WHATSAPP_ROW_ORDER,
    });
    if (!row) {
      throw new NotFoundException('This agency has no WhatsApp line stored, so there is nothing to enable calling on.');
    }
    const config = withWhatsAppCredentials(row)!;
    if (!config.accessToken) {
      throw new BadRequestException('The stored line has no access token, so Meta cannot be asked.');
    }

    const settingsUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(row.phoneNumberId)}/settings`;

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
      requestDetail: res.ok
        ? 'Meta accepted the request.'
        : res.reached
          ? `Meta refused it — ${res.error}`
          : `Could not reach Meta — ${res.error}`,
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

  /** What Meta currently reports for this line's calling setting. Read-only. */
  async getWhatsAppCalling(organizationId: string) {
    const row = await prisma.whatsAppConfig.findFirst({
      where: { organizationId },
      orderBy: WHATSAPP_ROW_ORDER,
    });
    if (!row) throw new NotFoundException('This agency has no WhatsApp line stored.');
    const config = withWhatsAppCredentials(row)!;
    if (!config.accessToken) {
      throw new BadRequestException('The stored line has no access token, so Meta cannot be asked.');
    }

    const res = await metaGet(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(row.phoneNumberId)}/settings`,
      config.accessToken
    );
    if (!res.ok) {
      return {
        phoneNumberId: row.phoneNumberId,
        displayPhoneNumber: row.displayPhoneNumber,
        callingStatus: null,
        enabled: false,
        // Could not ask is not the same as off.
        error: res.reached ? `Meta refused the read — ${res.error}` : `Could not reach Meta — ${res.error}`,
      };
    }
    const status = res.body?.calling?.status ?? null;
    return {
      phoneNumberId: row.phoneNumberId,
      displayPhoneNumber: row.displayPhoneNumber,
      callingStatus: status,
      enabled: status === 'ENABLED',
      settings: res.body?.calling ?? null,
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
      ok.push('WHATSAPP_APP_SECRET is set, so deliveries can be verified.');
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
          const apps: string[] = (Array.isArray(subs.body?.data) ? subs.body.data : [])
            .map((d: any) => d?.whatsapp_business_api_data?.name || d?.whatsapp_business_api_data?.id)
            .filter(Boolean);
          line.subscribedApps = apps;
          if (apps.length === 0) {
            blocked.push(
              `${label}: no app is subscribed to this business account's webhooks, so Meta ` +
              'delivers nothing. Subscribe the app at Meta → your app → WhatsApp → Configuration.'
            );
          } else {
            ok.push(`${label}: Meta is delivering to a subscribed app (${apps.join(', ')}).`);
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

