import { Controller, Get, Post, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { PlatformService } from './platform.service';
import { AuthUser, IndustryType } from '@ace/shared-types';

/**
 * The operating ministry's console.
 *
 * Mounted on its own path so that nothing here is ever reachable through a
 * tenant route by accident, and guarded at the CLASS level so a route added
 * later is protected by default rather than by the author remembering.
 *
 * Guard order is load-bearing. Nest runs guards global → controller → route, so
 * `JwtAuthGuard` MUST come first: `PlatformAdminGuard` reads `request.user`,
 * which does not exist until authentication has run. Listed the other way round
 * it would see no user on every request — and the guard this codebase replaced
 * failed exactly that way, silently waving everything through.
 */
@Controller('api/platform')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  /** State-wide totals and service levels. */
  @Get('overview')
  async overview() {
    return this.platform.overview();
  }

  /** One row per agency, for comparison. */
  @Get('agencies')
  async listAgencies() {
    return this.platform.listAgencies();
  }

  @Get('agencies/:id')
  async getAgency(@Param('id') id: string) {
    return this.platform.getAgency(id);
  }

  /** Bring an agency onto the platform and invite its first owner. */
  @Post('agencies')
  async createAgency(
    @Req() req: { user: AuthUser; ip?: string },
    @Body()
    body: {
      name: string;
      category?: IndustryType;
      ownerEmail: string;
      ownerFullName: string;
      phone?: string;
      defaultLanguage?: string;
      timezone?: string;
    }
  ) {
    return this.platform.createAgency({ userId: req.user.userId, ipAddress: req.ip ?? null }, body);
  }

  /**
   * Take an agency out of service. The agency stops answering citizens on its
   * members' next request, so this is deliberately not a soft flag.
   */
  @Post('agencies/:id/suspend')
  async suspend(
    @Req() req: { user: AuthUser; ip?: string },
    @Param('id') id: string,
    @Body() body: { reason: string }
  ) {
    return this.platform.suspendAgency(
      { userId: req.user.userId, ipAddress: req.ip ?? null },
      id,
      body?.reason
    );
  }

  @Post('agencies/:id/reinstate')
  async reinstate(@Req() req: { user: AuthUser; ip?: string }, @Param('id') id: string) {
    return this.platform.reinstateAgency(
      { userId: req.user.userId, ipAddress: req.ip ?? null },
      id
    );
  }

  /** Cross-agency audit trail. Append-only; this tier cannot edit it. */
  @Get('audit')
  async audit(
    @Query('organizationId') organizationId?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: string
  ) {
    return this.platform.auditTrail({
      organizationId,
      action,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
