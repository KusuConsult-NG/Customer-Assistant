import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma, sealTelephonyCredentials, sealWhatsAppCredentials, decryptSecret } from '@ace/database';
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
  };
}

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
      telephonyConfigs: org.telephonyConfigs.map((c) => ({
        ...c,
        // accountSid identifies rather than opens, so it is stored in the clear
        // and masked directly. The other three are encrypted at rest.
        accountSid: maskSecret(c.accountSid),
        authToken: maskStoredSecret(c.authToken, `TelephonyConfig ${c.id}.authToken`),
        apiKey: maskStoredSecret(c.apiKey, `TelephonyConfig ${c.id}.apiKey`),
        apiSecret: maskStoredSecret(c.apiSecret, `TelephonyConfig ${c.id}.apiSecret`),
      })),
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
    }
  ) {
    if (data.defaultLanguage !== undefined && !SUPPORTED_LANGUAGES.includes(data.defaultLanguage as Language)) {
      throw new BadRequestException(
        `defaultLanguage must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`
      );
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

  async addTeamMember(
    organizationId: string,
    userData: { email: string; fullName: string; role: any }
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

    return user;
  }

  async removeTeamMember(organizationId: string, userId: string) {
    return prisma.user.delete({
      where: { id: userId, organizationId },
    });
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


  async updateTelephonyConfig(
    organizationId: string,
    data: { provider: any; phoneNumber: string; accountSid?: string; authToken?: string; apiKey?: string }
  ) {
    const existing = await prisma.telephonyConfig.findFirst({ where: { organizationId } });

    if (existing) {
      const saved = await prisma.telephonyConfig.update({
        where: { id: existing.id },
        data: sealTelephonyCredentials({
          provider: data.provider,
          phoneNumber: data.phoneNumber,
          accountSid: data.accountSid,
          authToken: data.authToken,
          apiKey: data.apiKey,
        }),
      });
      return maskedTelephonyConfig(saved);
    }

    const created = await prisma.telephonyConfig.create({
      data: sealTelephonyCredentials({
        organizationId,
        provider: data.provider,
        phoneNumber: data.phoneNumber,
        accountSid: data.accountSid,
        authToken: data.authToken,
        apiKey: data.apiKey,
      }),
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

  async updateTeamMemberRole(organizationId: string, userId: string, newRole: any) {
    const user = await prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user) throw new NotFoundException('User not found');
    return prisma.user.update({
      where: { id: userId },
      data: { role: newRole },
      select: { id: true, email: true, fullName: true, role: true, isActive: true },
    });
  }

  async updateTeamMemberStatus(organizationId: string, userId: string, isActive: boolean) {
    const user = await prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user) throw new NotFoundException('User not found');
    return prisma.user.update({
      where: { id: userId },
      data: { isActive },
      select: { id: true, email: true, fullName: true, role: true, isActive: true },
    });
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
        module: 'Billing & Subscriptions',
        OWNER: 'Full Access',
        ADMIN: 'View Only',
        AGENT: 'No Access',
        VIEWER: 'No Access',
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

  async regenerateApiKey(organizationId: string) {
    const crypto = await import('crypto');
    const rawKey = `ace_live_pk_${crypto.randomBytes(16).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    await prisma.apiKey.create({
      data: {
        organizationId,
        keyName: 'Live Production Key',
        keyHash,
        keyPrefix: rawKey.slice(0, 16),
      },
    });
    return { apiKey: rawKey };
  }
}

