import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CrmModule } from '../crm/crm.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';
import { AgentProvisioningController } from './agent-provisioning.controller';
import { ElevenLabsAgentService } from './elevenlabs-agent.service';
import { ElevenLabsOutboundService } from './elevenlabs-outbound.service';

/**
 * Everything to do with a hosted conversational agent (ElevenLabs Agents),
 * in both directions:
 *
 *   INBOUND  — AgentToolsController: the agent calls us to do real work.
 *              Authenticated per organization by AgentKeyGuard.
 *   OUTBOUND — ElevenLabsOutboundService: we call ElevenLabs to start a
 *              WhatsApp call or send a template message.
 *   SETUP    — ElevenLabsAgentService + AgentProvisioningController: staff
 *              create, sync and inspect the agent that serves the other two.
 *              Authenticated by JWT, not by an agent key.
 *
 * The module is named for the inbound half because that is the larger surface,
 * but all three live here since they share the same tenant configuration.
 *
 * This is NOT yet the live conversation path. `packages/orchestrator` still
 * serves every channel; nothing has been cut over. See CLAUDE.md — "TWO
 * conversation engines exist right now, and only one is live."
 */
@Module({
  imports: [SchedulingModule, CrmModule, KnowledgeModule],
  controllers: [AgentToolsController, AgentProvisioningController],
  providers: [AgentToolsService, ElevenLabsAgentService, ElevenLabsOutboundService],
  exports: [AgentToolsService, ElevenLabsAgentService, ElevenLabsOutboundService],
})
export class AgentToolsModule {}
