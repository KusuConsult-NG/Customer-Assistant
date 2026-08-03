import { ChannelType } from '@ace/shared-types';

export interface ChannelMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  channel: ChannelType;
  text: string;
  mediaUrl?: string;
  timestamp: number;
}

export interface OmnichannelAdapter {
  channel: ChannelType;
  parseWebhookPayload(rawPayload: any): ChannelMessage | null;
  sendMessage(recipientId: string, text: string, mediaUrl?: string): Promise<boolean>;
}

export class InstagramDMAdapter implements OmnichannelAdapter {
  channel = ChannelType.INSTAGRAM;

  parseWebhookPayload(rawPayload: any): ChannelMessage | null {
    const messaging = rawPayload?.entry?.[0]?.messaging?.[0];
    if (!messaging) return null;

    return {
      messageId: messaging.message?.mid || `ig_${Date.now()}`,
      senderId: messaging.sender?.id,
      channel: this.channel,
      text: messaging.message?.text || '',
      timestamp: messaging.timestamp || Date.now(),
    };
  }

  async sendMessage(recipientId: string, text: string): Promise<boolean> {
    // Meta Instagram Messaging API POST request
    return true;
  }
}

export class FacebookMessengerAdapter implements OmnichannelAdapter {
  channel = ChannelType.WEBCHAT;

  parseWebhookPayload(rawPayload: any): ChannelMessage | null {
    const messaging = rawPayload?.entry?.[0]?.messaging?.[0];
    if (!messaging) return null;

    return {
      messageId: messaging.message?.mid || `fb_${Date.now()}`,
      senderId: messaging.sender?.id,
      channel: this.channel,
      text: messaging.message?.text || '',
      timestamp: messaging.timestamp || Date.now(),
    };
  }

  async sendMessage(recipientId: string, text: string): Promise<boolean> {
    return true;
  }
}

export class TelegramBotAdapter implements OmnichannelAdapter {
  channel = ChannelType.TELEGRAM;

  parseWebhookPayload(rawPayload: any): ChannelMessage | null {
    const message = rawPayload?.message;
    if (!message) return null;

    return {
      messageId: message.message_id?.toString() || `tg_${Date.now()}`,
      senderId: message.from?.id?.toString(),
      senderName: `${message.from?.first_name || ''} ${message.from?.last_name || ''}`.trim(),
      channel: this.channel,
      text: message.text || '',
      timestamp: message.date * 1000,
    };
  }

  async sendMessage(recipientId: string, text: string): Promise<boolean> {
    return true;
  }
}

export class EmailAIAssistantAdapter implements OmnichannelAdapter {
  channel = ChannelType.EMAIL;

  parseWebhookPayload(rawPayload: any): ChannelMessage | null {
    if (!rawPayload.from || !rawPayload.subject) return null;

    return {
      messageId: rawPayload.messageId || `em_${Date.now()}`,
      senderId: rawPayload.from,
      senderName: rawPayload.fromName,
      channel: this.channel,
      text: `Subject: ${rawPayload.subject}\n\n${rawPayload.bodyText || ''}`,
      timestamp: Date.now(),
    };
  }

  async sendMessage(recipientId: string, text: string): Promise<boolean> {
    return true;
  }
}
