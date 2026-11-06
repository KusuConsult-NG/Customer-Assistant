import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';
import { prisma } from '@ace/database';
import { assertPublicHttpUrl } from '../common/url-safety';
import { isWebhookEventEnabled } from '@ace/shared-types';
import { AceLogger } from '../config/logger';

const log = new AceLogger('WebhookDispatcher');

@Injectable()
export class WebhookDispatcherService {
  /**
   * Is this agency subscribed to this event at all?
   *
   * Checked before the domain helpers below read a booking or a conversation,
   * because almost no tenant configures a webhook URL and reading a row to
   * build a payload nobody receives is work done on every booking in the
   * State. `dispatch` re-reads the organization, which is one redundant read
   * on the rare path where a delivery is actually going out.
   */
  private async isSubscribed(organizationId: string, eventType: string): Promise<boolean> {
    const org = await prisma.organization
      .findUnique({
        where: { id: organizationId },
        select: { webhookUrl: true, enabledWebhookEvents: true },
      })
      .catch(() => null);
    if (!org?.webhookUrl) return false;
    return isWebhookEventEnabled(org.enabledWebhookEvents, eventType);
  }

  /**
   * `appointment.booked` — ONE payload, wherever the booking was made.
   *
   * Three callers write a booking: `SchedulingService.createBooking` (the
   * dashboard and the hosted agent), and the orchestrator's booking flow, whose
   * result both the WhatsApp service and the voice media-stream handler read.
   * The orchestrator writes through its own `prisma.booking.create`, so it
   * cannot share the service's dispatch — which is exactly how a webhook ends
   * up firing for staff bookings and silently not for the channel that serves
   * every citizen today.
   *
   * So the callers pass an id and nothing else, and the payload is built here.
   * Three hand-built payloads would drift, and the drift would be in what a
   * tenant's own system is told about appointments it has to honour.
   *
   * Never throws: a booking is already written and confirmed to the citizen by
   * the time this runs, and a webhook problem must not turn a made appointment
   * into an error.
   */
  async appointmentBooked(organizationId: string, bookingId: string): Promise<void> {
    try {
      if (!(await this.isSubscribed(organizationId, 'appointment.booked'))) return;

      const booking = await prisma.booking.findFirst({
        where: { id: bookingId, organizationId },
        include: { contact: { select: { id: true, fullName: true, phoneNumber: true, email: true } } },
      });
      if (!booking) {
        // Scoped by organizationId, so this is a booking of another agency or
        // one already gone. Either way there is nothing to describe.
        log.warn('appointment_booked_webhook_no_booking', { organizationId, bookingId });
        return;
      }

      await this.dispatch(organizationId, 'appointment.booked', {
        bookingId: booking.id,
        serviceName: booking.serviceName,
        staffName: booking.staffName,
        status: booking.status,
        startTime: booking.startTime.toISOString(),
        endTime: booking.endTime.toISOString(),
        contactId: booking.contactId,
        contactPhone: booking.contact?.phoneNumber ?? null,
        contactName: booking.contact?.fullName ?? null,
      });
    } catch (err: any) {
      log.error('appointment_booked_webhook_failed', err, { organizationId, bookingId });
    }
  }

  /**
   * `handover.requested` — ONE payload, fired on the false→true TRANSITION.
   *
   * Five writes activate a handoff: an officer replying on a thread (two of
   * them, one per channel), the explicit toggle route, the orchestrator
   * returning `shouldHandoff`, and the SET_HANDOFF workflow action. Wiring only
   * the toggle route would have left the AI-initiated handover — the one that
   * actually needs somebody told — sending nothing.
   *
   * The transition is the event, not the state. An officer sending their fourth
   * message to a thread they already hold re-writes `isHumanHandoffActive: true`
   * every time, and a webhook on each of those is noise that trains a receiver
   * to ignore the one that mattered. Callers pass what the row said BEFORE their
   * write, so two officers taking one thread at the same instant can produce two
   * deliveries; that is a duplicate a receiver can collapse on
   * `conversationId`, and the alternative is a second write to claim the
   * transition on a path where the first one has to happen anyway.
   *
   * `releasing` a handoff is deliberately NOT an event here: nothing has been
   * requested, and the catalogue offers no name for it.
   */
  async handoverRequested(
    organizationId: string,
    conversationId: string,
    requestedBy: 'OFFICER' | 'ASSISTANT' | 'WORKFLOW'
  ): Promise<void> {
    try {
      if (!(await this.isSubscribed(organizationId, 'handover.requested'))) return;

      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, organizationId },
        include: {
          contact: { select: { id: true, fullName: true, phoneNumber: true } },
          assignedUser: { select: { id: true, fullName: true } },
        },
      });
      if (!conversation) {
        log.warn('handover_requested_webhook_no_conversation', { organizationId, conversationId });
        return;
      }

      await this.dispatch(organizationId, 'handover.requested', {
        conversationId: conversation.id,
        channel: conversation.channel,
        requestedBy,
        handoffReason: conversation.handoffReason ?? null,
        assignedUserId: conversation.assignedUserId ?? null,
        assignedUserName: conversation.assignedUser?.fullName ?? null,
        contactId: conversation.contactId,
        contactPhone: conversation.contact?.phoneNumber ?? null,
        contactName: conversation.contact?.fullName ?? null,
      });
    } catch (err: any) {
      log.error('handover_requested_webhook_failed', err, { organizationId, conversationId });
    }
  }

  async dispatch(organizationId: string, eventType: string, payload: Record<string, any>) {
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org?.webhookUrl) return;
    // Matched on CANONICAL names, not on the exact string.
    //
    // An exact match is what silently unsubscribed everyone: the dashboard
    // offered `call.ended`, the API dispatched `call.completed`, and a tenant
    // who ticked the box simply never received a call event. `isWebhookEventEnabled`
    // resolves both sides through the alias table in @ace/shared-types, so the
    // old and new spellings are one subscription and no tenant has to re-tick
    // anything after a rename.
    if (!isWebhookEventEnabled(org.enabledWebhookEvents, eventType)) return;

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
