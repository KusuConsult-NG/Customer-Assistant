import { Module } from '@nestjs/common';
import { TelephonyService } from './telephony.service';
import { TelephonyController } from './telephony.controller';
import { VoiceStreamGateway } from './voice-stream.gateway';
import { VoiceAiService } from './voice-ai.service';
import { TwilioMediaStreamHandler } from './twilio-media-stream.handler';
import { CallBroadcastService } from './call-broadcast.service';

@Module({
  providers: [
    // Core telephony logic
    TelephonyService,

    // Voice AI: Deepgram STT + ElevenLabs TTS
    VoiceAiService,

    // Shared broadcast bridge between raw WS handler and Socket.IO gateway
    CallBroadcastService,

    // Raw WebSocket handler for Twilio Media Streams (instantiated in main.ts)
    TwilioMediaStreamHandler,

    // Socket.IO gateway: agent console monitoring + injects server into CallBroadcastService
    VoiceStreamGateway,
  ],
  controllers: [TelephonyController],
  exports: [
    TelephonyService,
    TwilioMediaStreamHandler,  // Exported so main.ts can retrieve it via app.get()
    CallBroadcastService,
  ],
})
export class TelephonyModule {}
