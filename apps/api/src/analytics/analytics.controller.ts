import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsInsightsService } from './analytics-insights.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '@ace/shared-types';

@Controller('api/analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(
    private analyticsService: AnalyticsService,
    private insights: AnalyticsInsightsService,
  ) {}

  @Get('dashboard')
  async getDashboardMetrics(
    @Req() req: { user: AuthUser },
    @Query('period') period: '7d' | '30d' | '90d' = '7d',
  ) {
    const validPeriods: Array<'7d' | '30d' | '90d'> = ['7d', '30d', '90d'];
    const safePeriod = validPeriods.includes(period) ? period : '7d';
    return this.analyticsService.getDashboardSummary(req.user.organizationId, safePeriod);
  }

  /**
   * Operational insights — intents, handoff reasons, hourly demand, booking
   * funnel, ticket flow, languages. Readable by every signed-in staff member:
   * knowing what customers ask for is not a privileged action, it is the job.
   */
  @Get('insights')
  async getInsights(
    @Req() req: { user: AuthUser },
    @Query('period') period: '7d' | '30d' | '90d' = '7d',
  ) {
    const validPeriods: Array<'7d' | '30d' | '90d'> = ['7d', '30d', '90d'];
    const safePeriod = validPeriods.includes(period) ? period : '7d';
    return this.insights.getOperationalInsights(req.user.organizationId, safePeriod);
  }
}
