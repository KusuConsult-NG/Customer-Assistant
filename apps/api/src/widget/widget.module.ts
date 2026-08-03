import { Module } from '@nestjs/common';
import { WidgetController } from './widget.controller';
import { WidgetService } from './widget.service';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [WebhooksModule],
  controllers: [WidgetController],
  providers: [WidgetService],
  exports: [WidgetService],
})
export class WidgetModule {}
