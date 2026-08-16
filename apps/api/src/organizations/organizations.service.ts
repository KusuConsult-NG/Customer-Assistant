import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@ace/database';
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

/** Widget appearance values reach a customer's page — accept only known-safe shapes. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const WIDGET_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

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
        accountSid: maskSecret(c.accountSid),
        authToken: maskSecret(c.authToken),
        apiKey: maskSecret(c.apiKey),
        apiSecret: maskSecret(c.apiSecret),
      })),
      whatsAppConfigs: org.whatsAppConfigs.map((c) => ({
        ...c,
        accessToken: maskSecret(c.accessToken),
        webhookVerifyToken: maskSecret(c.webhookVerifyToken),
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
      widgetPrimaryColor?: string;
      widgetSecondaryColor?: string;
      widgetPosition?: string;
    }
  ) {
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
        // Validated, not trusted: these are echoed into the widget's inline
        // styles on the customer's own site, so a stray value must not be able
        // to carry anything but a colour or a known position.
        ...(data.widgetPrimaryColor !== undefined && {
          widgetPrimaryColor: HEX_COLOR.test(data.widgetPrimaryColor) ? data.widgetPrimaryColor : null,
        }),
        ...(data.widgetSecondaryColor !== undefined && {
          widgetSecondaryColor: HEX_COLOR.test(data.widgetSecondaryColor) ? data.widgetSecondaryColor : null,
        }),
        ...(data.widgetPosition !== undefined && {
          widgetPosition: WIDGET_POSITIONS.includes(data.widgetPosition) ? data.widgetPosition : null,
        }),
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
          from: 'ACE Platform <noreply@aceplatform.io>',
          to: user.email,
          subject: `You've been invited to join ${org?.name || 'ACE Platform'}`,
          html: `<p>You have been invited to join ${org?.name || 'ACE Platform'} on ACE Platform.</p><p><a href="${process.env.WEB_BASE_URL || 'http://localhost:3000'}/setup-account?token=${rawToken}&email=${encodeURIComponent(user.email)}">Click here to set up your account</a></p>`,
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

    if (existing) {
      return prisma.whatsAppConfig.update({
        where: { id: existing.id },
        data: {
          phoneNumberId: data.phoneNumberId,
          accessToken: data.accessToken,
          webhookVerifyToken: data.webhookVerifyToken,
          whatsappBusinessId: data.whatsappBusinessId || existing.whatsappBusinessId,
          displayPhoneNumber: data.displayPhoneNumber || existing.displayPhoneNumber,
          isActive: true,
        },
      });
    }

    return prisma.whatsAppConfig.create({
      data: {
        organizationId,
        phoneNumberId: data.phoneNumberId,
        accessToken: data.accessToken,
        webhookVerifyToken: data.webhookVerifyToken,
        whatsappBusinessId: data.whatsappBusinessId || `waba_${data.phoneNumberId}`,
        displayPhoneNumber: data.displayPhoneNumber || `+234 WhatsApp`,
        isActive: true,
      },
    });
  }


  async updateTelephonyConfig(
    organizationId: string,
    data: { provider: any; phoneNumber: string; accountSid?: string; authToken?: string; apiKey?: string }
  ) {
    const existing = await prisma.telephonyConfig.findFirst({ where: { organizationId } });

    if (existing) {
      return prisma.telephonyConfig.update({
        where: { id: existing.id },
        data: {
          provider: data.provider,
          phoneNumber: data.phoneNumber,
          accountSid: data.accountSid,
          authToken: data.authToken,
          apiKey: data.apiKey,
        },
      });
    }

    return prisma.telephonyConfig.create({
      data: {
        organizationId,
        provider: data.provider,
        phoneNumber: data.phoneNumber,
        accountSid: data.accountSid,
        authToken: data.authToken,
        apiKey: data.apiKey,
      },
    });
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

