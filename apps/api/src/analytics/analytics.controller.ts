import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '@ace/shared-types';

@Controller('api/analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(private analyticsService: AnalyticsService) {}

  @Get('dashboard')
  async getDashboardMetrics(
    @Req() req: { user: AuthUser },
    @Query('period') period: '7d' | '30d' | '90d' = '7d',
  ) {
    const validPeriods: Array<'7d' | '30d' | '90d'> = ['7d', '30d', '90d'];
    const safePeriod = validPeriods.includes(period) ? period : '7d';
    return this.analyticsService.getDashboardSummary(req.user.organizationId, safePeriod);
  }
}
