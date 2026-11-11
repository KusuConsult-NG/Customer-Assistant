import { Module } from '@nestjs/common';
import { CrmService } from './crm.service';
import { CrmTimelineService } from './crm-timeline.service';
import { DataRightsService } from './data-rights.service';
import { CrmController } from './crm.controller';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [WebhooksModule],
  // CrmTimelineService was fully implemented but never registered in any module and
  // never referenced by a controller — the unified customer timeline and health score
  // it builds were unreachable. It is now provided and exposed at
  // GET /api/crm/contacts/:id/timeline.
  providers: [CrmService, CrmTimelineService, DataRightsService],
  controllers: [CrmController],
  exports: [CrmService, CrmTimelineService],
})
export class CrmModule {}
