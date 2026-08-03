import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@ace/database';

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
    }
  ) {
    return prisma.organization.update({
      where: { id: organizationId },
      data,
    });
  }

  async addTeamMember(
    organizationId: string,
    userData: { email: string; fullName: string; role: any }
  ) {
    const bcrypt = await import('bcryptjs');
    const defaultPasswordHash = await bcrypt.hash('TempPassword123!', 10);

    return prisma.user.create({
      data: {
        organizationId,
        email: userData.email,
        fullName: userData.fullName,
        role: userData.role,
        passwordHash: defaultPasswordHash,
      },
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

