/**
 * Taking a live conversation away from the hosted agent.
 *
 * ── What ElevenLabs does not offer ──────────────────────────────────────────
 *
 * There is no API to stop, mute, interrupt or inject into a conversation that
 * is in progress. Their whole mutating surface is `update` on agents, tools,
 * secrets, phone numbers and WhatsApp accounts — configuration, not live calls.
 * `conversations.messages` is search-only. So "tell ElevenLabs to stop
 * responding" is not a thing that can be asked of ElevenLabs at all.
 *
 * What we do control is the CARRIER. ElevenLabs answers a Twilio number using
 * the tenant's own Twilio credentials, which means the call is a Twilio call,
 * and a Twilio call can be redirected out from under it. That is a real
 * takeover: the customer stops hearing the agent and starts hearing a person.
 *
 * ── Which is why voice and WhatsApp differ, and the difference is admitted ───
 *
 * VOICE     — genuinely takeable. Redirect the live call to the organization's
 *             forwarding number, then report what actually happened.
 * WHATSAPP  — NOT takeable per conversation. The only lever ElevenLabs gives is
 *             `enableMessaging` on the whole line, which would silence the agent
 *             for every other customer messaging that number. That is an outage,
 *             not a handoff, so it is refused here and offered separately under
 *             its own name with its own confirmation.
 *
 * ── Act, then announce ──────────────────────────────────────────────────────
 *
 * The redirect happens first and the result is reported from the outcome, never
 * from the intention. This mirrors the rule the orchestrator path already
 * follows: announcing a transfer before it is known to be possible is how a
 * customer ends up holding a promise nothing kept. The difference here is who
 * is listening — a staff member clicked a button and can read a failure, so a
 * failure is returned to them rather than spoken to the customer.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { prisma, withTelephonyCredentials } from '@ace/database';
import { VoiceAiService } from '../telephony/voice-ai.service';
import { ElevenLabsApi } from './elevenlabs-client';

export type TakeoverOutcome =
  | {
      taken: true;
      channel: 'voice';
      /** What the operator should be told, and what is true. */
      message: string;
    }
  | { taken: false; reason: string };

/** Statuses where a conversation is still happening and could be taken over. */
const TAKEABLE = new Set(['initiated', 'in-progress']);

@Injectable()
export class ElevenLabsTakeoverService {
  private readonly log = new Logger('ElevenLabsTakeover');

  constructor(
    private readonly api: ElevenLabsApi,
    private readonly voice: VoiceAiService
  ) {}

  /**
   * Move a live conversation from the agent to a person.
   *
   * Returns a refusal rather than throwing for the cases a well-configured
   * system still hits — a call that ended a second ago, a channel that cannot
   * be taken over — because those are answers, not errors. Genuine
   * misconfiguration and provider failures still throw.
   */
  async takeOverConversation(
    organizationId: string,
    conversationId: string
  ): Promise<TakeoverOutcome> {
    if (!conversationId?.trim()) {
      throw new BadRequestException('A conversation id is required.');
    }

    const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId } });
    if (!config?.agentId) {
      throw new BadRequestException('This organization has no provisioned agent.');
    }
    const client = this.api.for(this.api.keyFor(organizationId, config.apiKey));

    let conversation: any;
    try {
      conversation = await client.conversationalAi.conversations.get(conversationId);
    } catch (err) {
      if (this.api.isNotFound(err)) {
        throw new NotFoundException('That conversation does not exist in this workspace.');
      }
      this.api.fail('the conversation', err);
    }

    // The workspace may hold other tenants' conversations. Without this, an
    // operator could redirect a stranger's live call to their own office by
    // pasting an id.
    const conversationAgent = conversation.agentId ?? conversation.agent_id;
    if (conversationAgent !== config.agentId) {
      throw new NotFoundException('That conversation does not belong to this organization.');
    }

    const status = conversation.status;
    if (!TAKEABLE.has(status)) {
      // Not an error. Calls end while an operator is reaching for the button.
      return {
        taken: false,
        reason:
          status === 'processing'
            ? 'That call has just ended — the transcript is still being finalised.'
            : 'That conversation has already ended.',
      };
    }

    const meta = conversation.metadata ?? {};
    const phone = meta.phoneCall ?? meta.phone_call;

    if (!phone) {
      // Said in full, because the obvious next question is "why not".
      return {
        taken: false,
        reason:
          'Only voice calls can be taken over. The hosted agent owns this WhatsApp line, and ElevenLabs offers no way to stop it answering one conversation without stopping it answering every conversation on that number.',
      };
    }

    // Not defended against being absent, deliberately. Every phone-call variant
    // in the SDK — twilio, exotel and sip_trunk alike — declares callSid as
    // required, and the SDK validates responses against those schemas: a
    // payload without one is rejected in the client before this line runs, with
    // a message that names the missing field. A fallback branch here would be
    // unreachable code that reads like a safety net.
    const callSid = phone.callSid ?? phone.call_sid;

    // Decrypted: the redirect below authenticates to Twilio with these.
    const telephony = withTelephonyCredentials(
      await prisma.telephonyConfig.findFirst({
        where: { organizationId, provider: 'TWILIO' },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      })
    );
    const forwardingNumber = telephony?.forwardingNumber;
    if (!forwardingNumber) {
      // Refused with the fix, not with "failed". The caller is still talking to
      // the agent, which is the status quo rather than a broken call.
      return {
        taken: false,
        reason:
          'No forwarding number is configured, so there is nowhere to send the call. Set one under Settings → Telephony and try again; the caller is still with the agent in the meantime.',
      };
    }

    // Act. Twilio's own TwiML speaks "connecting you" only after the redirect
    // has been accepted, so the caller never hears it for a transfer that did
    // not happen.
    const outcome = await this.voice.transferCallToHuman(
      callSid,
      { accountSid: telephony?.accountSid, authToken: telephony?.authToken },
      forwardingNumber,
      phone.agentNumber ?? phone.agent_number
    );

    if (outcome !== 'TRANSFERRED') {
      this.log.error(
        `takeover_failed org=${organizationId} conversation=${conversationId} call=${callSid}`
      );
      return {
        taken: false,
        reason:
          'The carrier refused the transfer, so the caller is still with the agent. Check the Twilio credentials under Settings → Telephony.',
      };
    }

    this.log.warn(
      `takeover_transferred org=${organizationId} conversation=${conversationId} call=${callSid}`
    );

    // Announce only now, and only what happened. The conversation's transcript
    // still arrives by post-call webhook, so the record survives the takeover.
    return {
      taken: true,
      channel: 'voice',
      message: 'The call has been transferred. The caller is being connected to your team now.',
    };
  }

  /**
   * Stop — or restart — the agent answering an entire WhatsApp line.
   *
   * Deliberately NOT called "takeover". It affects every conversation on that
   * number, including customers nobody is watching, and the confirmation is
   * required so that cannot happen by accident. It exists because it is the
   * only WhatsApp lever ElevenLabs provides, and an operator whose agent is
   * saying something wrong needs some way to stop it.
   */
  async setWhatsAppLinePaused(
    organizationId: string,
    paused: boolean,
    confirmAffectsEveryConversation: boolean
  ): Promise<{ paused: boolean; note: string }> {
    const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId } });
    if (!config?.whatsappPhoneNumberId) {
      throw new BadRequestException('No WhatsApp line is attached to this organization.');
    }
    if (paused && !confirmAffectsEveryConversation) {
      throw new BadRequestException(
        'Pausing stops the agent replying to EVERY customer messaging this number, not just one conversation. Confirm explicitly (confirmAffectsEveryConversation) to proceed.'
      );
    }

    const client = this.api.for(this.api.keyFor(organizationId, config.apiKey));
    try {
      await client.conversationalAi.whatsappAccounts.update(config.whatsappPhoneNumberId, {
        enableMessaging: !paused,
      });
    } catch (err) {
      this.api.fail('the WhatsApp line pause', err);
    }

    this.log.warn(`whatsapp_line_${paused ? 'paused' : 'resumed'} org=${organizationId}`);
    return {
      paused,
      note: paused
        ? 'The agent has stopped replying on this WhatsApp line. Inbound messages still arrive but nothing answers them, so somebody needs to.'
        : 'The agent is answering this WhatsApp line again.',
    };
  }
}
