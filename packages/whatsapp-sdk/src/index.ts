import { WhatsAppMessagePayload } from '@ace/shared-types';

export interface WhatsAppClientConfig {
  phoneNumberId: string;
  accessToken: string;
  businessAccountId?: string;
  verifyToken: string;
}

export class WhatsAppCloudClient {
  private apiVersion = 'v20.0';
  private baseUrl = 'https://graph.facebook.com';

  constructor(private config: WhatsAppClientConfig) {}

  async markMessageAsRead(messageId: string): Promise<any> {
    const url = `${this.baseUrl}/${this.apiVersion}/${this.config.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    };
    return this.postRequest(url, payload);
  }

  async getMediaUrl(mediaId: string): Promise<string | null> {
    try {
      const url = `${this.baseUrl}/${this.apiVersion}/${mediaId}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
      });
      if (!response.ok) return null;
      const data: any = await response.json();
      return data?.url || null;
    } catch {
      return null;
    }
  }

  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === this.config.verifyToken) {
      return challenge;
    }
    return null;
  }

  verifySignature(rawBodyBuffer: string | Buffer, signatureHeader: string, appSecret: string): boolean {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
    try {
      const crypto = require('crypto');
      const expectedSignature = signatureHeader.split('sha256=')[1];
      const hmac = crypto.createHmac('sha256', appSecret);
      const computedSignature = hmac.update(rawBodyBuffer).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(expectedSignature, 'utf-8'), Buffer.from(computedSignature, 'utf-8'));
    } catch (e) {
      return false;
    }
  }

  parseWebhookPayload(body: any, organizationId: string): WhatsAppMessagePayload | null {
    try {
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const message = change?.messages?.[0];

      if (!message) return null;

      const fromNumber = message.from;
      const messageId = message.id;
      const timestamp = parseInt(message.timestamp, 10) * 1000;

      if (message.type === 'text') {
        return {
          messageId,
          fromNumber,
          organizationId,
          messageType: 'text',
          textContent: message.text?.body,
          timestamp,
        };
      }

      if (message.type === 'interactive') {
        const buttonReply = message.interactive?.button_reply;
        const listReply = message.interactive?.list_reply;
        const textContent = buttonReply?.title || listReply?.title || message.interactive?.type;
        return {
          messageId,
          fromNumber,
          organizationId,
          messageType: 'interactive',
          textContent,
          timestamp,
        };
      }

      if (message.type === 'audio' || message.type === 'voice') {
        return {
          messageId,
          fromNumber,
          organizationId,
          messageType: 'audio',
          mediaUrl: message.audio?.id || message.voice?.id,
          mediaMimeType: message.audio?.mime_type || message.voice?.mime_type,
          timestamp,
        };
      }

      if (message.type === 'image') {
        return {
          messageId,
          fromNumber,
          organizationId,
          messageType: 'image',
          mediaUrl: message.image?.id,
          mediaMimeType: message.image?.mime_type,
          textContent: message.image?.caption,
          timestamp,
        };
      }

      if (message.type === 'document') {
        return {
          messageId,
          fromNumber,
          organizationId,
          messageType: 'document',
          mediaUrl: message.document?.id,
          mediaMimeType: message.document?.mime_type,
          textContent: message.document?.filename,
          timestamp,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  async sendTextMessage(to: string, text: string): Promise<any> {
    const url = `${this.baseUrl}/${this.apiVersion}/${this.config.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    };

    return this.postRequest(url, payload);
  }

  async sendInteractiveButtons(
    to: string,
    headerText: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<any> {
    const url = `${this.baseUrl}/${this.apiVersion}/${this.config.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: headerText },
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    };

    return this.postRequest(url, payload);
  }

  async sendTemplateMessage(
    to: string,
    templateName: string,
    languageCode: string = 'en_US',
    components: any[] = []
  ): Promise<any> {
    const url = `${this.baseUrl}/${this.apiVersion}/${this.config.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    };

    return this.postRequest(url, payload);
  }

  private async postRequest(url: string, body: any): Promise<any> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`WhatsApp API Error (${response.status}): ${errText}`);
      }

      return await response.json();
    } catch (err: any) {
      // Explicit demo mode: a token containing 'placeholder' returns a synthetic
      // wamid so demos work without Meta credentials — but LOUDLY, so a mock
      // send can never be mistaken for a delivered message in the logs.
      if (this.config.accessToken.includes('placeholder')) {
        console.warn(JSON.stringify({
          level: 'warn',
          service: 'WhatsAppCloudClient',
          event: 'MOCK_SEND_no_message_delivered',
          reason: 'accessToken contains "placeholder" — demo mode, nothing was sent to WhatsApp',
          to: String(body.to ?? '').slice(-4),
        }));
        return { messaging_product: 'whatsapp', contacts: [{ input: body.to }], messages: [{ id: `wamid.mock.${Date.now()}` }] };
      }
      throw err;
    }
  }
}
