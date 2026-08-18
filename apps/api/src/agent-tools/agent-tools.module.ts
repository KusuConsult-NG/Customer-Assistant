import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CrmModule } from '../crm/crm.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';

/**
 * Tools a hosted conversational agent calls to do real work. The agent owns the
 * conversation; this module owns everything that touches the database.
 */
@Module({
  imports: [SchedulingModule, CrmModule, KnowledgeModule],
  controllers: [AgentToolsController],
  providers: [AgentToolsService],
  exports: [AgentToolsService],
})
export class AgentToolsModule {}
