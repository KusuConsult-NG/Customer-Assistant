import { Module } from '@nestjs/common';
import { WorkflowsService } from './workflows.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowActionsService } from './workflow-actions.service';
import { WorkflowExecutorService } from './workflow-executor.service';
import { WorkflowRunnerService } from './workflow-runner.service';

/**
 * The execution half of the workflow engine.
 *
 * Note it imports no domain modules: WorkflowActionsService talks to Prisma and the
 * WhatsApp SDK directly rather than through CrmService/WhatsappService. That keeps
 * the module graph acyclic (those modules import WorkflowTriggerModule to fire
 * events) and keeps an action's failure contained to the action.
 */
@Module({
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
