import { Controller, Get, Patch, Post, Delete, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { UpdateWhatsAppConfigDto } from './organizations.dto';
import { OrganizationsService } from './organizations.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';
import { RolesGuard } from '../common/guards/roles.guard';

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
      outboundOpeningHour?: number | null; outboundClosingHour?: number | null; outboundDays?: number[] | null;
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

  /**
   * Read-only, and OWNER/ADMIN because it is answered with the agency's own
   * stored Meta credential. Returns no credential value — only what Meta says
   * about the numbers on the account.
   */
  /**
   * Whether a citizen's message can actually arrive — asked of Meta, not
   * inferred from what we hold. Read-only, OWNER/ADMIN, no credential value.
   */
  @Roles('OWNER', 'ADMIN')
  @Get('whatsapp-config/readiness')
  async whatsAppReadiness(@Req() req: { user: AuthUser }) {
    return this.orgsService.whatsAppReadiness(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Get('whatsapp-config/numbers')
  async listMetaPhoneNumbers(
    @Req() req: { user: AuthUser },
    /**
     * A wider search, for when the numbers are not on the account we hold a
     * credential for. One Meta business portfolio can own several WhatsApp
     * Business Accounts — a sandbox one from a quickstart and the real one
     * added later — and a number on the second is invisible from the first.
     * `businessId` looks in one portfolio directly; `discover` walks the
     * credential's own. Off by default: several rate-limited Graph calls.
     */
    @Query('discover') discover?: string,
    @Query('businessId') businessId?: string
  ) {
    return this.orgsService.listMetaPhoneNumbers(req.user.organizationId, {
      discover: discover === '1' || discover === 'true',
      businessId: businessId?.trim() || undefined,
    });
  }

  @Roles('OWNER', 'ADMIN')
  @Post('whatsapp-config')
  async updateWhatsAppConfig(
    @Req() req: { user: AuthUser },
    // A CLASS, not an inline type: the ValidationPipe has no metatype for an
    // inline one, so `webhookVerifyToken` was required by TypeScript and
    // enforced by nothing — a request omitting it reached Prisma as undefined
    // and answered 500 "An unexpected error occurred" instead of naming the
    // field. See organizations.dto.ts.
    @Body() body: UpdateWhatsAppConfigDto
  ) {
    return this.orgsService.updateWhatsAppConfig(req.user.organizationId, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('telephony-config')
  async updateTelephonyConfig(
    @Req() req: { user: AuthUser },
    @Body() body: {
      // The voice line being edited — see the WhatsApp note above. An agency
      // can have a Twilio number, a Telnyx number and a carrier-forward line
      // at once, each signing its webhooks differently.
      id?: string;
      provider: any;
      phoneNumber: string;
      accountSid?: string;
      authToken?: string;
      apiKey?: string;
      // Both voice handoff paths refuse with "Set one under Settings →
      // Telephony", so it has to be settable there.
      forwardingNumber?: string | null;
      // A SIP trunk the hosted agent answers instead of Twilio. `sipAddress` is
      // required when provider is SIP_TRUNK; the digest pair is optional,
      // because a carrier may authenticate the trunk by IP instead.
      sipAddress?: string;
      sipTransport?: string;
      sipUsername?: string;
      sipPassword?: string;
    }
  ) {
    return this.orgsService.updateTelephonyConfig(req.user.organizationId, body);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('api-keys/regenerate')
  async regenerateApiKey(@Req() req: { user: AuthUser }) {
    return this.orgsService.regenerateApiKey(req.user.organizationId, actor(req));
  }
}

