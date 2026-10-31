import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma, sealTelephonyCredentials, sealWhatsAppCredentials, decryptSecret, assertUsableServiceHours, recordAudit, resolveAuditActors } from '@ace/database';
import { SUPPORTED_LANGUAGES, type Language } from '@ace/orchestrator';
import { Resend } from 'resend';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

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
        telephonyConfigs: true,
        whatsAppConfigs: true,
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
    }
  ) {
    if (data.defaultLanguage !== undefined && !SUPPORTED_LANGUAGES.includes(data.defaultLanguage as Language)) {
      throw new BadRequestException(
        `defaultLanguage must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`
      );
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

    return prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
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
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    // Unusable password — user must set a real password via the invite link.
    // We still bcrypt-hash a random string so the DB field is in valid format.
    const unusablePasswordHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);

    const org = await prisma.organization.findUnique({ where: { id: organizationId } });

    const user = await prisma.user.create({
      data: {
        organizationId,
        email: userData.email,
        fullName: userData.fullName,
        role: userData.role,
        passwordHash: unusablePasswordHash,
        passwordResetToken: hashedToken,
        passwordResetExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      try {
        const resend = new Resend(resendKey);
        await resend.emails.send({
          from: process.env.EMAIL_FROM || 'Customer Care Agent <noreply@kusuconsult.com>',
          to: user.email,
          subject: `You've been invited to join ${org?.name || 'Customer Care Agent'}`,
          html: `<p>You have been invited to join ${org?.name || 'Customer Care Agent'} on Customer Care Agent.</p><p><a href="${process.env.WEB_BASE_URL || 'http://localhost:3000'}/setup-account?token=${rawToken}&email=${encodeURIComponent(user.email)}">Click here to set up your account</a></p>`,
        });
      } catch (err) {
        console.error('Failed to send invite email:', err);
      }
    } else {
      console.warn(`RESEND_API_KEY not set. Invite link: ${process.env.WEB_BASE_URL || 'http://localhost:3000'}/setup-account?token=${rawToken}&email=${encodeURIComponent(user.email)}`);
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

    return user;
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
    data: { phoneNumberId: string; accessToken: string; webhookVerifyToken: string; whatsappBusinessId?: string; displayPhoneNumber?: string }
  ) {
    const existing = await prisma.whatsAppConfig.findFirst({ where: { organizationId } });

    // sealWhatsAppCredentials encrypts accessToken and webhookVerifyToken. It
    // THROWS when ENCRYPTION_KEY is unset rather than storing them in the clear
    // — the operator is told to set the key, and nothing is written meanwhile.
    // Both branches return a MASKED view. The stored row now carries ciphertext,
    // which is not a leak but is noise; before encryption this same return
    // handed the caller's own access token straight back in the response body.
    // Neither is what a settings form needs — it needs to know it saved.
    if (existing) {
      const saved = await prisma.whatsAppConfig.update({
        where: { id: existing.id },
        data: sealWhatsAppCredentials({
          phoneNumberId: data.phoneNumberId,
          accessToken: data.accessToken,
          webhookVerifyToken: data.webhookVerifyToken,
          whatsappBusinessId: data.whatsappBusinessId || existing.whatsappBusinessId,
          displayPhoneNumber: data.displayPhoneNumber || existing.displayPhoneNumber,
          isActive: true,
        }),
      });
      return maskedWhatsAppConfig(saved);
    }

    const created = await prisma.whatsAppConfig.create({
      data: sealWhatsAppCredentials({
        organizationId,
        phoneNumberId: data.phoneNumberId,
        accessToken: data.accessToken,
        webhookVerifyToken: data.webhookVerifyToken,
        whatsappBusinessId: data.whatsappBusinessId || `waba_${data.phoneNumberId}`,
        displayPhoneNumber: data.displayPhoneNumber || `+234 WhatsApp`,
        isActive: true,
      }),
    });
    return maskedWhatsAppConfig(created);
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

    const existing = await prisma.telephonyConfig.findFirst({ where: { organizationId } });

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

    const created = await prisma.telephonyConfig.create({
      data: sealTelephonyCredentials({ organizationId, ...common }),
    });
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

