import { Global, Module } from '@nestjs/common';
import { WorkflowTriggerService } from './workflow-trigger.service';

/**
 * Trigger-only module.
 *
 * Split from WorkflowsModule on purpose. Domain code (CRM, WhatsApp, scheduling,
 * telephony) needs to FIRE workflows, while the executor needs those same modules to
 * PERFORM actions — importing one module both ways is a cycle Nest cannot resolve.
 *
 * WorkflowTriggerService depends on nothing but Prisma and the queue, so this module
 * is safe for anyone to import. Marked @Global so call sites do not each have to
 * declare the import.
 */
@Global()
@Module({
  providers: [WorkflowTriggerService],
  exports: [WorkflowTriggerService],
})
export class WorkflowTriggerModule {}
