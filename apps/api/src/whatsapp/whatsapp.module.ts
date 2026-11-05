import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { ConversationClosingService } from './conversation-closing.service';
import { WhatsappController } from './whatsapp.controller';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [WebhooksModule],
  providers: [WhatsappService, ConversationClosingService],
  controllers: [WhatsappController],
  exports: [WhatsappService],
})
export class WhatsappModule {}
