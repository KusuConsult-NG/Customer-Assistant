import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CrmModule } from '../crm/crm.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';
import { ElevenLabsOutboundService } from './elevenlabs-outbound.service';

/**
 * Everything to do with a hosted conversational agent (ElevenLabs Agents),
 * in both directions:
 *
 *   INBOUND  — AgentToolsController: the agent calls us to do real work.
 *              Authenticated per organization by AgentKeyGuard.
 *   OUTBOUND — ElevenLabsOutboundService: we call ElevenLabs to start a
 *              WhatsApp call or send a template message.
 *
 * The module is named for the inbound half because that is the larger surface,
 * but both live here since they share the same tenant configuration.
 *
 * This is NOT yet the live conversation path. `packages/orchestrator` still
 * serves every channel; nothing has been cut over. See CLAUDE.md — "TWO
 * conversation engines exist right now, and only one is live."
 */
@Module({
  imports: [SchedulingModule, CrmModule, KnowledgeModule],
  controllers: [AgentToolsController],
  providers: [AgentToolsService, ElevenLabsOutboundService],
  exports: [AgentToolsService, ElevenLabsOutboundService],
})
export class AgentToolsModule {}
