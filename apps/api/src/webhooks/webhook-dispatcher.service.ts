import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';
import { prisma } from '@ace/database';
import { assertPublicHttpUrl } from '../common/url-safety';
import { AceLogger } from '../config/logger';

const log = new AceLogger('WebhookDispatcher');

@Injectable()
export class WebhookDispatcherService {
  async dispatch(organizationId: string, eventType: string, payload: Record<string, any>) {
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org?.webhookUrl) return;
    if (!org.enabledWebhookEvents.includes(eventType) && !org.enabledWebhookEvents.includes('*')) return;

    // Refuse to sign with a fallback secret.
    //
    // This used to fall back to the literal 'ace-webhook-secret', which is published
    // in this repository — so any receiver verifying X-ACE-Signature would accept a
    // forged event from anyone who read the source. An unsigned-but-honest failure
    // is better than a signature that proves nothing.
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) {
      log.error(
        'webhook_secret_not_configured',
        new Error('WEBHOOK_SECRET is not set'),
        { organizationId, eventType }
      );
      return;
    }

    const body = JSON.stringify({ event: eventType, data: payload, timestamp: new Date().toISOString() });
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    // Outbound webhook URLs are attacker-controllable (an org admin sets them), so
    // the same SSRF rules as the crawler apply — otherwise the webhook field becomes
    // a request forgery primitive pointed at internal services.
    try {
      await assertPublicHttpUrl(org.webhookUrl);
    } catch (err: any) {
      log.warn('webhook_target_rejected', {
        organizationId,
        eventType,
        reason: err?.message ?? 'not a public URL',
      });
      return;
    }

    try {
      const res = await fetch(org.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ACE-Signature': signature,
          'X-ACE-Event': eventType,
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
      await prisma.webhookLog.create({
        data: { organizationId, eventType, payload, targetUrl: org.webhookUrl, statusCode: res.status, success: res.ok, deliveredAt: new Date() }
      });
    } catch (err: any) {
      await prisma.webhookLog.create({
        data: { organizationId, eventType, payload, targetUrl: org.webhookUrl, success: false, error: err.message }
      });
    }
  }
}
