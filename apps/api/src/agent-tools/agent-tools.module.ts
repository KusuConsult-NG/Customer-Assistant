import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CrmModule } from '../crm/crm.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';
import { AgentProvisioningController } from './agent-provisioning.controller';
import { ElevenLabsAgentService } from './elevenlabs-agent.service';
import { ElevenLabsApi } from './elevenlabs-client';
import { ElevenLabsNumbersService } from './elevenlabs-numbers.service';
import { ElevenLabsOutboundService } from './elevenlabs-outbound.service';
import { ElevenLabsWebhookController } from './elevenlabs-webhook.controller';
import { ElevenLabsWebhookService } from './elevenlabs-webhook.service';

/**
 * Everything to do with a hosted conversational agent (ElevenLabs Agents):
 *
 *   INBOUND  — AgentToolsController: the agent calls us to do real work.
 *              Authenticated per organization by AgentKeyGuard.
 *   OUTBOUND — ElevenLabsOutboundService: we call ElevenLabs to start a
 *              WhatsApp call or send a template message.
 *   SETUP    — ElevenLabsAgentService + AgentProvisioningController: staff
 *              create, sync and inspect the agent that serves the others.
 *              Authenticated by JWT, not by an agent key.
 *   AFTER    — ElevenLabsWebhookController: the finished transcript comes back
 *              to us. Authenticated by an HMAC over the raw body.
 *
 * The module is named for the inbound half because that is the larger surface,
 * but all four live here since they share the same tenant configuration.
 *
 * This is NOT yet the live conversation path. `packages/orchestrator` still
 * serves every channel; nothing has been cut over. See CLAUDE.md — "TWO
 * conversation engines exist right now, and only one is live."
 */
@Module({
  imports: [SchedulingModule, CrmModule, KnowledgeModule],
  controllers: [AgentToolsController, AgentProvisioningController, ElevenLabsWebhookController],
  providers: [
    AgentToolsService,
    ElevenLabsApi,
    ElevenLabsAgentService,
    ElevenLabsNumbersService,
    ElevenLabsOutboundService,
    ElevenLabsWebhookService,
  ],
  exports: [
    AgentToolsService,
    ElevenLabsAgentService,
    ElevenLabsNumbersService,
    ElevenLabsOutboundService,
    ElevenLabsWebhookService,
  ],
})
export class AgentToolsModule {}
