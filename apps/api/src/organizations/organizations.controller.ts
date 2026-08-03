import { Controller, Get, Patch, Post, Delete, Param, Body, UseGuards, Req } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';

import { RolesGuard } from '../common/guards/roles.guard';

@Controller('api/organizations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrganizationsController {
  constructor(private orgsService: OrganizationsService) {}

  @Get('me')
  async getMyOrganization(@Req() req: { user: AuthUser }) {
    return this.orgsService.getOrganization(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch('settings')
  async updateSettings(
    @Req() req: { user: AuthUser },
    @Body() body: { name?: string; aiPersonaPrompt?: string; welcomeMessage?: string; phone?: string; logoUrl?: string; webhookUrl?: string; enabledWebhookEvents?: string[] }
  ) {
    return this.orgsService.updateSettings(req.user.organizationId, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('members')
  async addTeamMember(
    @Req() req: { user: AuthUser },
    @Body() body: { email: string; fullName: string; role: any }
  ) {
    return this.orgsService.addTeamMember(req.user.organizationId, body);
  }

  @Get('members')
  async getTeamMembers(@Req() req: { user: AuthUser }) {
    return this.orgsService.getTeamMembers(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch('members/:id/role')
  async updateTeamMemberRole(
    @Req() req: { user: AuthUser },
    @Param('id') userId: string,
    @Body() body: { role: any }
  ) {
    return this.orgsService.updateTeamMemberRole(req.user.organizationId, userId, body.role);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch('members/:id/status')
  async updateTeamMemberStatus(
    @Req() req: { user: AuthUser },
    @Param('id') userId: string,
    @Body() body: { isActive: boolean }
  ) {
    return this.orgsService.updateTeamMemberStatus(req.user.organizationId, userId, body.isActive);
  }

  @Get('roles/permissions')
  async getPermissionsMatrix() {
    return this.orgsService.getPermissionsMatrix();
  }

  @Roles('OWNER', 'ADMIN')
  @Delete('members/:id')
  async removeTeamMember(
    @Req() req: { user: AuthUser },
    @Param('id') userId: string
  ) {
    return this.orgsService.removeTeamMember(req.user.organizationId, userId);
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

