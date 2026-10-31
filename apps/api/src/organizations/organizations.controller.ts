import { Controller, Get, Patch, Post, Delete, Param, Body, UseGuards, Req } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';

import { RolesGuard } from '../common/guards/roles.guard';
import { Query } from '@nestjs/common';

/**
 * Who is making the change, for the audit record.
 *
 * `ip` is optional in the parameter type and present at runtime — Express
 * populates it — so the existing route signatures satisfy this without every
 * one of them having to redeclare a field it does not otherwise use.
 */
const actor = (req: { user: AuthUser; ip?: string }) => ({
  userId: req.user.userId,
  ipAddress: req.ip ?? null,
});

// Guard order matters: RolesGuard reads request.user, which JwtAuthGuard populates.
@Controller('api/organizations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrganizationsController {
  constructor(private orgsService: OrganizationsService) {}

  /**
   * This agency's own audit trail.
   *
   * OWNER/ADMIN, not every member. The trail names which colleague changed
   * somebody's role or deactivated an account, which is administrative
   * information rather than something an agent needs to do their job.
   *
   * Scoped to the caller's own organization by the service, from the token —
   * there is deliberately no organizationId parameter to pass, so there is
   * nothing for a caller to substitute.
   */
  @Roles('OWNER', 'ADMIN')
  @Get('audit')
  async auditTrail(
    @Req() req: { user: AuthUser },
    @Query('action') action?: string,
    @Query('limit') limit?: string
  ) {
    return this.orgsService.auditTrail(req.user.organizationId, {
      action,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('me')
  async getMyOrganization(@Req() req: { user: AuthUser }) {
    return this.orgsService.getOrganization(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch('settings')
  async updateSettings(
    @Req() req: { user: AuthUser },
    @Body() body: {
      name?: string; aiPersonaPrompt?: string; welcomeMessage?: string; phone?: string;
      logoUrl?: string; webhookUrl?: string; enabledWebhookEvents?: string[];
      payoutBankName?: string; payoutAccountName?: string; payoutAccountNumber?: string; payoutUssdCode?: string;
      defaultLanguage?: string;
      openingHour?: number; closingHour?: number; serviceDays?: number[];
    }
  ) {
    return this.orgsService.updateSettings(req.user.organizationId, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('members')
  async addTeamMember(
    @Req() req: { user: AuthUser },
    @Body() body: { email: string; fullName: string; role: any }
  ) {
    return this.orgsService.addTeamMember(req.user.organizationId, body, actor(req));
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
    return this.orgsService.updateTeamMemberRole(req.user.organizationId, userId, body.role, actor(req));
  }

  @Roles('OWNER', 'ADMIN')
  @Patch('members/:id/status')
  async updateTeamMemberStatus(
    @Req() req: { user: AuthUser },
    @Param('id') userId: string,
    @Body() body: { isActive: boolean }
  ) {
    return this.orgsService.updateTeamMemberStatus(req.user.organizationId, userId, body.isActive, actor(req));
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
    return this.orgsService.removeTeamMember(req.user.organizationId, userId, actor(req));
  }

  @Roles('OWNER', 'ADMIN')
  @Post('whatsapp-config')
  async updateWhatsAppConfig(
    @Req() req: { user: AuthUser },
    @Body() body: { phoneNumberId: string; accessToken: string; webhookVerifyToken: string; whatsappBusinessId?: string; displayPhoneNumber?: string }
  ) {
    return this.orgsService.updateWhatsAppConfig(req.user.organizationId, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('telephony-config')
  async updateTelephonyConfig(
    @Req() req: { user: AuthUser },
    @Body() body: { provider: any; phoneNumber: string; accountSid?: string; authToken?: string; apiKey?: string }
  ) {
    return this.orgsService.updateTelephonyConfig(req.user.organizationId, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('api-keys/regenerate')
  async regenerateApiKey(@Req() req: { user: AuthUser }) {
    return this.orgsService.regenerateApiKey(req.user.organizationId, actor(req));
  }
}

