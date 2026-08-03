import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';
import { prisma } from '@ace/database';

@Injectable()
export class WebhookDispatcherService {
  async dispatch(organizationId: string, eventType: string, payload: Record<string, any>) {
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org?.webhookUrl) return;
    if (!org.enabledWebhookEvents.includes(eventType) && !org.enabledWebhookEvents.includes('*')) return;
    
    const body = JSON.stringify({ event: eventType, data: payload, timestamp: new Date().toISOString() });
    const signature = createHmac('sha256', process.env.WEBHOOK_SECRET ?? 'ace-webhook-secret').update(body).digest('hex');
    
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
