import { ServiceStandardsService } from './service-standards.service';
import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsInsightsService } from './analytics-insights.service';
import { AnalyticsController } from './analytics.controller';

@Module({
  providers: [AnalyticsService, AnalyticsInsightsService, ServiceStandardsService],
  controllers: [AnalyticsController],
  exports: [AnalyticsService, AnalyticsInsightsService],
})
export class AnalyticsModule {}
