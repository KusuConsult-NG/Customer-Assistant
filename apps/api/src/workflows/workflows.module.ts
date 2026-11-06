import { Module } from '@nestjs/common';
import { WorkflowsService } from './workflows.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowActionsService } from './workflow-actions.service';
import { WorkflowExecutorService } from './workflow-executor.service';
import { WorkflowRunnerService } from './workflow-runner.service';
import { WebhooksModule } from '../webhooks/webhooks.module';

/**
 * The execution half of the workflow engine.
 *
 * Note it imports no domain modules: WorkflowActionsService talks to Prisma and the
 * WhatsApp SDK directly rather than through CrmService/WhatsappService. That keeps
 * the module graph acyclic (those modules import WorkflowTriggerModule to fire
 * events) and keeps an action's failure contained to the action.
 */
@Module({
  // WebhooksModule is the one exception to the note above, and not a domain
  // module: it is a leaf with a single provider over Prisma, so it introduces no
  // cycle. SET_HANDOFF needs it to dispatch `handover.requested`, which the
  // other four handoff sites also dispatch — an automated handover that told
  // nobody would be the gap this event exists to close.
  imports: [WebhooksModule],
  controllers: [WorkflowsController],
  providers: [
    WorkflowsService,
    WorkflowActionsService,
    WorkflowExecutorService,
    WorkflowRunnerService,
  ],
  exports: [WorkflowsService, WorkflowRunnerService],
})
export class WorkflowsModule {}
