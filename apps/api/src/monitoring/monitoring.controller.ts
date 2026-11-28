import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import { AuthUser } from '@ace/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { MonitoringService } from './monitoring.service';
import { recordSystemEvent } from './system-events';

/** The outside monitor's shared token (MONITOR_TOKEN: server.env and the GitHub secret of the same name). */
export function monitorTokenMatches(given: string | undefined, expected = process.env.MONITOR_TOKEN?.trim() ?? ''): boolean {
  if (expected.length < 24 || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Controller()
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  /**
   * For the monitor outside this server: is the phone line answering calls
   * itself? Unauthenticated, so it says only ok / degraded / down / disabled.
   */
  @SkipThrottle()
  @Get('api/health/voice')
  async voice() {
    return { voice: await this.monitoring.publicVoiceState() };
  }

  /** The outside monitor's result of each run, kept for the system health page. */
  @SkipThrottle()
  @Post('api/monitoring/heartbeat')
  @HttpCode(204)
  async heartbeat(@Headers('x-monitor-token') token: string | undefined, @Body() body: any): Promise<void> {
    if (!monitorTokenMatches(token)) throw new ForbiddenException();
    const status = body?.status === 'ok' ? 'ok' : 'failed';
    const checks = typeof body?.checks === 'object' && body.checks ? body.checks : {};
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(checks).slice(0, 12)) clean[String(k).slice(0, 40)] = String(v).slice(0, 120);
    await recordSystemEvent('external_check', status, { summary: String(body?.summary ?? '').slice(0, 300), checks: clean, run: String(body?.run ?? '').slice(0, 200) });
  }

  /** The system health page (OWNER / ADMIN). */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  @Get('api/monitoring/status')
  status(@Req() req: { user: AuthUser }) {
    return this.monitoring.status(req.user.organizationId);
  }
}
