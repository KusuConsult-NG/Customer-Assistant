import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { ConversationClosingService } from './conversation-closing.service';
import { WhatsAppCallAnswerService } from './whatsapp-call-answer.service';
import { WhatsappController } from './whatsapp.controller';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [WebhooksModule],
  providers: [WhatsappService, ConversationClosingService, WhatsAppCallAnswerService],
  controllers: [WhatsappController],
  exports: [WhatsappService, WhatsAppCallAnswerService],
})
export class WhatsappModule {}
