/**
 * Reaching back to a caller the platform could not answer.
 *
 * A failed call is somebody who needed help and got nothing. The call log
 * records that, but a record is for us — this is the part that is for them.
 *
 * ── Why a message and not a call back ───────────────────────────────────────
 *
 * The dominant reason a call fails is that every concurrent conversation slot
 * on the workspace plan was already in use. Calling those people back consumes
 * the very capacity the next inbound caller is failing to get, so an automatic
 * redial makes its own triggering condition worse, at the busiest moment of the
 * day. A WhatsApp message has no such ceiling.
 *
 * It is also the better channel on the merits here: it costs a fraction of a
 * call, it does not interrupt someone sitting in a clinic queue, it waits until
 * they can read it — and it moves the conversation onto the one channel where
 * all five supported languages actually work, instead of back onto the one
 * where Hausa cannot be spoken aloud at all.
 *
 * A voice callback is a reasonable SECOND tier, from a queue an operator can
 * see. It is deliberately not built here, because the version worth having is
 * capacity-gated and attempt-limited, and the version that is easy to write is
 * the redial storm described above.
 *
 * ── Sending immediately, rather than in business hours ──────────────────────
 *
 * No quiet-hours gate, on purpose. The person tried to reach this helpline
 * seconds ago; a reply that arrives while they are still holding their phone is
 * the most useful thing this system can do, and a WhatsApp message at 23:50
 * does not ring anyone out of bed the way the callback would. If a voice tier
 * is ever added, that one needs the gate.
 */
import { Injectable } from '@nestjs/common';
import { prisma, ChannelType, MessageSender } from '@ace/database';
import { AceLogger } from '../config/logger';
import { ElevenLabsOutboundService } from './elevenlabs-outbound.service';

const log = new AceLogger('MissedCallFollowUp');

/**
 * Marks a message as a missed-call follow-up.
 *
 * Doubles as the per-call idempotency key (`<callSid>` + this) and the
 * per-contact cooldown lookup, so one string keeps both guarantees in step.
 */
const FOLLOWUP_SUFFIX = ':missed-call-followup';

/** One follow-up per person per this window, however many times they redial. */
const PER_CONTACT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * If they reached us in this window, the failure is stale and the follow-up
 * would be an apology for something that no longer happened.
 */
const RECENT_SUCCESS_WINDOW_MS = 30 * 60 * 1000;

@Injectable()
export class MissedCallFollowUpService {
  constructor(private readonly outbound: ElevenLabsOutboundService) {}

  /**
   * Follow up one failed call. Never throws: this runs off the back of a
   * webhook that has already been ACKed, and the call log is written whether or
   * not the message goes out.
   *
   * Returns what it did, so the caller can log a reason rather than silence.
   */
  async followUp(params: {
    organizationId: string;
    contactId: string | null;
    customerNumber: string;
    callSid: string;
    correlationId: string;
  }): Promise<{ sent: boolean; reason: string }> {
    const { organizationId, contactId, customerNumber, callSid, correlationId } = params;

    try {
      if (!customerNumber) return this.skip(correlationId, 'the failed call carried no caller number');
      if (!contactId) return this.skip(correlationId, 'no contact matched the caller number');

      const config = await prisma.hostedAgentConfig.findUnique({
        where: { organizationId },
        select: { missedCallTemplateName: true, missedCallTemplateLanguage: true },
      });
      // Meta rejects a business-initiated message without an approved template,
      // so attempting one would produce a provider error and no message. Saying
      // it was skipped, and why, is the honest outcome.
      if (!config?.missedCallTemplateName) {
        return this.skip(
          correlationId,
          'no missed-call template is configured — Meta requires an approved template for a business-initiated message'
        );
      }

      // Did they get through since? Any answered call, on any route.
      const reachedUs = await prisma.callLog.findFirst({
        where: {
          organizationId,
          contactId,
          status: { in: ['COMPLETED', 'IN_PROGRESS'] },
          startedAt: { gte: new Date(Date.now() - RECENT_SUCCESS_WINDOW_MS) },
        },
        select: { id: true },
      });
      if (reachedUs) return this.skip(correlationId, 'the caller reached us on another attempt');

      const conversation = await this.conversationFor(organizationId, contactId);

      // One per person, not one per failure: somebody who redials four times in
      // two minutes is four rows and one worried human.
      const recent = await prisma.message.findFirst({
        where: {
          conversationId: conversation.id,
          externalId: { endsWith: FOLLOWUP_SUFFIX },
          sentAt: { gte: new Date(Date.now() - PER_CONTACT_COOLDOWN_MS) },
        },
        select: { id: true },
      });
      if (recent) return this.skip(correlationId, 'a follow-up already went out to this caller today');

      // CLAIM, then send — the same ordering the appointment reminders use.
      // The unique externalId is what makes the claim atomic across pods and
      // idempotent across webhook redelivery; a check-then-send would let two
      // in-flight retries both pass the check.
      const externalId = `${callSid}${FOLLOWUP_SUFFIX}`;
      let claimed;
      try {
        claimed = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: MessageSender.SYSTEM,
            content: 'Follow-up to a call we could not connect — sending…',
            externalId,
            metadata: { missedCallSid: callSid, template: config.missedCallTemplateName },
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          return this.skip(correlationId, 'this failed call was already followed up');
        }
        throw err;
      }

      // WhatsApp identifies users by E.164 without the leading "+".
      const whatsappUserId = customerNumber.replace(/^\+/, '');
      const contact = await prisma.contact.findUnique({
        where: { id: contactId },
        select: { fullName: true },
      });
      const firstName = (contact?.fullName ?? '').trim().split(/\s+/)[0] || 'there';

      try {
        await this.outbound.sendWhatsAppTemplate(
          organizationId,
          whatsappUserId,
          config.missedCallTemplateName,
          config.missedCallTemplateLanguage || 'en',
          [firstName]
        );
      } catch (err: any) {
        // The thread must not show a message the customer never received. Record
        // the attempt as an attempt; staff reading the conversation then know a
        // person still needs contacting, rather than believing this was handled.
        await prisma.message.update({
          where: { id: claimed.id },
          data: {
            content: `Follow-up to a call we could not connect FAILED to send (${String(err?.message ?? 'unknown error').slice(0, 200)}). This caller has not been contacted.`,
          },
        }).catch(() => {});
        log.warn('missed_call_followup_send_failed', {
          correlationId, organizationId, callSid, error: err?.message,
        });
        return { sent: false, reason: `send failed: ${err?.message ?? 'unknown error'}` };
      }

      await prisma.message.update({
        where: { id: claimed.id },
        data: { content: 'Sent a WhatsApp follow-up about the call we could not connect.' },
      }).catch(() => {});

      log.info('missed_call_followup_sent', {
        correlationId, organizationId, callSid, template: config.missedCallTemplateName,
      });
      return { sent: true, reason: 'follow-up sent' };
    } catch (err: any) {
      // Never propagate: the call log is the record that matters, and this
      // runs after the webhook has been ACKed.
      log.warn('missed_call_followup_exception', {
        correlationId, organizationId, callSid, error: err?.message,
      });
      return { sent: false, reason: `unexpected error: ${err?.message ?? 'unknown'}` };
    }
  }

  private skip(correlationId: string, reason: string): { sent: boolean; reason: string } {
    log.info('missed_call_followup_skipped', { correlationId, reason });
    return { sent: false, reason };
  }

  /** The customer's WhatsApp thread, created if this is the first message in it. */
  private async conversationFor(organizationId: string, contactId: string) {
    const existing = await prisma.conversation.findFirst({
      where: { organizationId, contactId, channel: ChannelType.WHATSAPP },
    });
    if (existing) return existing;
    return prisma.conversation.create({
      data: { organizationId, contactId, channel: ChannelType.WHATSAPP, lastMessageAt: new Date() },
    });
  }
}
