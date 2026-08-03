import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@ace/database';
import { Resend } from 'resend';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class OrganizationsService {
  async getOrganization(organizationId: string) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        telephonyConfigs: true,
        whatsAppConfigs: true,
        users: { select: { id: true, email: true, fullName: true, role: true } },
      },
    });

    if (!org) throw new NotFoundException('Organization not found');
    return org;
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

