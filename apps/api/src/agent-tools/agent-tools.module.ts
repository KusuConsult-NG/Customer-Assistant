import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CrmModule } from '../crm/crm.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { TelephonyModule } from '../telephony/telephony.module';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';
import { AgentProvisioningController } from './agent-provisioning.controller';
import { ElevenLabsAgentService } from './elevenlabs-agent.service';
import { ElevenLabsApi } from './elevenlabs-client';
import { ElevenLabsLiveService } from './elevenlabs-live.service';
import { ElevenLabsNumbersService } from './elevenlabs-numbers.service';
import { ElevenLabsOutboundService } from './elevenlabs-outbound.service';
import { ElevenLabsTakeoverService } from './elevenlabs-takeover.service';
import { ElevenLabsWebhookController } from './elevenlabs-webhook.controller';
import { MissedCallFollowUpService } from './missed-call-followup.service';
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
import { OnboardingModule } from '../onboarding/onboarding.module';

@Module({
  // TelephonyModule exports VoiceAiService, whose transferCallToHuman is what
  // actually moves a live call — the same one the orchestrator path uses.
  imports: [SchedulingModule, CrmModule, KnowledgeModule, TelephonyModule, OnboardingModule],
  controllers: [AgentToolsController, AgentProvisioningController, ElevenLabsWebhookController],
  providers: [
    AgentToolsService,
    ElevenLabsApi,
    ElevenLabsAgentService,
    ElevenLabsLiveService,
    ElevenLabsNumbersService,
    ElevenLabsOutboundService,
    ElevenLabsTakeoverService,
    ElevenLabsWebhookService,
    MissedCallFollowUpService,
  ],
  exports: [
    AgentToolsService,
    ElevenLabsAgentService,
    ElevenLabsLiveService,
    ElevenLabsNumbersService,
    ElevenLabsOutboundService,
    ElevenLabsTakeoverService,
    ElevenLabsWebhookService,
  ],
})
export class AgentToolsModule {}
