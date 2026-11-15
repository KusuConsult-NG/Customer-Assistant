import { Module } from '@nestjs/common';
import { BrowserCallingService } from './browser-calling.service';
import { TelephonyService } from './telephony.service';
import { TelephonyController } from './telephony.controller';
import { VoiceStreamGateway } from './voice-stream.gateway';
import { VoiceAiService } from './voice-ai.service';
import { TwilioMediaStreamHandler } from './twilio-media-stream.handler';
import { CallBroadcastService } from './call-broadcast.service';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AuthModule } from '../auth/auth.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { CallbackDispatcherService } from './callback-dispatcher.service';
import { CallbacksController } from './callbacks.controller';
import { SipTrunkOriginationService } from './sip-trunk-origination.service';
import { ElevenLabsApi } from '../agent-tools/elevenlabs-client';
import { VoiceReadinessService } from './voice-readiness.service';

@Module({
  // AuthModule exports JwtService, used by VoiceStreamGateway to authenticate
  // the Socket.IO handshake before an agent may monitor a live call.
  imports: [WebhooksModule, AuthModule, WorkflowsModule],
  providers: [
    // Core telephony logic
    TelephonyService,

    // Answering a citizen's call in the dashboard rather than on a handset.
    // Inert until its Twilio credentials are set: with none, the inbound path
    // is exactly what it was before this existed.
    BrowserCallingService,

    // Voice AI: Deepgram STT + ElevenLabs TTS
    VoiceAiService,

    // Shared broadcast bridge between raw WS handler and Socket.IO gateway
    CallBroadcastService,

    // Raw WebSocket handler for Twilio Media Streams (instantiated in main.ts)
    TwilioMediaStreamHandler,

    // Socket.IO gateway: agent console monitoring + injects server into CallBroadcastService
    VoiceStreamGateway,

    // Keeps the promise to ring a citizen back: claims a due row, then dials.
    CallbackDispatcherService,

    // Dialling out on the agency's own SIP trunk, through the agent that
    // already answers it. `ElevenLabsApi` is listed here rather than imported
    // from AgentToolsModule because that module imports THIS one — a
    // forwardRef would work, but the class is stateless with no constructor
    // dependencies, so a second instance costs nothing and the cycle is
    // avoided rather than worked around.
    ElevenLabsApi,
    SipTrunkOriginationService,

    // Reports whether a call can actually complete. Nothing else answers that
    // question: /api/health is liveness, /api/health/ready covers PostgreSQL
    // and Redis, and every voice prerequisite fails as a call that connects
    // and goes nowhere.
    VoiceReadinessService,
  ],
  controllers: [TelephonyController, CallbacksController],
  exports: [
    BrowserCallingService,
    TelephonyService,
    TwilioMediaStreamHandler,  // Exported so main.ts can retrieve it via app.get()
    CallBroadcastService,

    // Exported for the hosted-agent takeover path. Both engines must redirect a
    // live call the same way — a second implementation of "move the call" is a
    // second thing that can silently stop moving it.
    VoiceAiService,

    // The console's "call now" button goes through the dispatcher's own claim.
    CallbackDispatcherService,
    SipTrunkOriginationService,
  ],
})
export class TelephonyModule {}
