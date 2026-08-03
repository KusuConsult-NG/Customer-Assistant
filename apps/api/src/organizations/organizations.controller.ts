import { Controller, Get, Patch, Post, Body, UseGuards, Req } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '@ace/shared-types';

@Controller('api/organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private orgsService: OrganizationsService) {}

  @Get('me')
  async getMyOrganization(@Req() req: { user: AuthUser }) {
    return this.orgsService.getOrganization(req.user.organizationId);
  }

  @Patch('settings')
  async updateSettings(
    @Req() req: { user: AuthUser },
    @Body() body: { name?: string; aiPersonaPrompt?: string; welcomeMessage?: string; phone?: string }
  ) {
    return this.orgsService.updateSettings(req.user.organizationId, body);
  }

  @Post('members')
  async addTeamMember(
    @Req() req: { user: AuthUser },
    @Body() body: { email: string; fullName: string; role: any }
  ) {
    return this.orgsService.addTeamMember(req.user.organizationId, body);
  }

  @Post('whatsapp-config')
  async updateWhatsAppConfig(
    @Req() req: { user: AuthUser },
    @Body() body: { phoneNumberId: string; accessToken: string; webhookVerifyToken: string; businessAccountId?: string }
  ) {
    return this.orgsService.updateWhatsAppConfig(req.user.organizationId, body);
  }

  @Post('telephony-config')
  async updateTelephonyConfig(
    @Req() req: { user: AuthUser },
    @Body() body: { provider: any; phoneNumber: string; accountSid?: string; authToken?: string; apiKey?: string }
  ) {
    return this.orgsService.updateTelephonyConfig(req.user.organizationId, body);
  }

  @Post('api-keys/regenerate')
  async regenerateApiKey(@Req() req: { user: AuthUser }) {
    return this.orgsService.regenerateApiKey(req.user.organizationId);
  }
}

