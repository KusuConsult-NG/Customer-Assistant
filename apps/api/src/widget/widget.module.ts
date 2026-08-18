import { Module } from '@nestjs/common';
import { WidgetController } from './widget.controller';

/**
 * The retired web chat channel.
 *
 * Only the controller remains, and it answers 410 to everything. The service
 * that ran the orchestrator for widget visitors, and the DTO it validated, are
 * gone — see widget.controller.ts for why the routes still answer at all
 * rather than being deleted with them.
 */
@Module({
  controllers: [WidgetController],
})
export class WidgetModule {}
