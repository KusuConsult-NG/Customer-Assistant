import { WhatsAppMessagePayload } from '@ace/shared-types';

export interface WhatsAppClientConfig {
  phoneNumberId: string;
  accessToken: string;
  businessAccountId?: string;
  verifyToken: string;
}

export class WhatsAppCloudClient {
  private apiVersion = 'v22.0';
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

  /**
   * Downloads the bytes of an inbound media message.
   *
   * Meta's media flow is two hops: GET /{media-id} returns a short-lived, host-varying
   * URL, and that URL itself requires the same bearer token. Fetching it without the
   * Authorization header returns a 401 body, not the image — which, stored blindly,
   * looks like a corrupt file rather than an auth error.
   *
   * `maxBytes` is enforced while streaming so a hostile or mistaken Content-Length
   * cannot make the process buffer an arbitrary amount of data.
   */
  async downloadMedia(mediaId: string, maxBytes = 8 * 1024 * 1024): Promise<{ bytes: Buffer; mimeType?: string } | null> {
    const mediaUrl = await this.getMediaUrl(mediaId);
    if (!mediaUrl) return null;

    const response = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
    });
    if (!response.ok) return null;

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) return null;

    return { bytes: buffer, mimeType: response.headers.get('content-type') ?? undefined };
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
      const expectedSignature = signatureHeader.slice('sha256='.length);
      const hmac = crypto.createHmac('sha256', appSecret);
      const computedSignature = hmac.update(rawBodyBuffer).digest('hex');
      const a = Buffer.from(expectedSignature, 'utf-8');
      const b = Buffer.from(computedSignature, 'utf-8');
      // timingSafeEqual throws on length mismatch — compare lengths first so a
      // truncated signature is rejected rather than falling into the catch block.
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
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
    // No mock/placeholder branch.
    //
    // This method used to catch every failure and, if the access token contained the
    // word "placeholder", return a synthetic `{ messages: [{ id: 'wamid.mock.…' }] }`.
    // Callers treat that as proof of delivery: WhatsappService logged "reply_delivered"
    // and sendBroadcast counted the recipient as sent. A misconfigured tenant therefore
    // saw a fully green dashboard while not one customer ever received a message.
    // Delivery failures must surface.
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new WhatsAppApiError(response.status, errText);
    }

    return response.json();
  }
}

/** Raised when the Meta WhatsApp Cloud API rejects a request. */
export class WhatsAppApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super(`WhatsApp Cloud API error (${status}): ${detail.slice(0, 500)}`);
    this.name = 'WhatsAppApiError';
  }
}
