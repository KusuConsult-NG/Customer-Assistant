import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { ConversationClosingService } from './conversation-closing.service';
import { WhatsAppCallAnswerService } from './whatsapp-call-answer.service';
import { WhatsAppCallMediaService } from './whatsapp-call-media.service';
import { TelephonyModule } from '../telephony/telephony.module';
import { WhatsappController } from './whatsapp.controller';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  // TelephonyModule exports VoiceAiService, which owns the one ElevenLabs TTS
  // and Deepgram entry points — a second copy for WhatsApp calls is a second
  // thing that can silently stop working.
  imports: [WebhooksModule, TelephonyModule],
  providers: [WhatsappService, ConversationClosingService, WhatsAppCallAnswerService, WhatsAppCallMediaService],
  controllers: [WhatsappController],
  exports: [WhatsappService, WhatsAppCallAnswerService],
})
export class WhatsappModule {}
