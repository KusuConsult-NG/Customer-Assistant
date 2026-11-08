/**
 * Infobip call events: what to do when a citizen rings, and when they hang up.
 *
 * Mirrors the Twilio inbound path step for step, because the guarantees are
 * the same whichever carrier delivered the call:
 *
 *   1. The tenant is the DIALLED number, matched across every stored shape,
 *      and is never guessed. An unrecognised number is hung up, not answered
 *      as "the first agency in the database" — that once served one tenant's
 *      persona and knowledge base to another tenant's caller.
 *   2. The caller becomes a contact the moment the call arrives, so somebody
 *      who rings and hangs up still leaves a record to ring back — with the
 *      agency's own numbers excluded, so a forwarded call is not filed under
 *      the agency itself.
 *   3. The call is recorded idempotently on the carrier's call id, because
 *      carriers redeliver.
 *
 * Then the call is handed to the AI by creating a dialog with the media
 * stream. If that fails the call is hung up and the record says so — a caller
 * left ringing for nothing is worse than a line that ends.
 */
import { Injectable } from '@nestjs/common';
import { CallDirection, CallStatus } from '@ace/shared-types';
import { prisma, ensureContactForPhone, normalizePhoneNumber, phoneNumberVariants } from '@ace/database';
import { AceLogger } from '../../config/logger';
import { WebhookDispatcherService } from '../../webhooks/webhook-dispatcher.service';
import { InfobipVoiceService, collectIds } from './infobip-voice.service';

const log = new AceLogger('InfobipCalls');

export interface InfobipEvent {
  callId?: string;
  type?: string;
  timestamp?: string;
  properties?: {
    call?: { id?: string; from?: string; to?: string; direction?: string; endpoint?: unknown };
    callLog?: { duration?: number; errorCode?: { name?: string } };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

@Injectable()
export class InfobipCallsService {
  constructor(
    private readonly infobip: InfobipVoiceService,
    private readonly webhookDispatcher: WebhookDispatcherService
  ) {}

  /** Never throws: it runs after the event has been acknowledged. */
  async handle(event: InfobipEvent): Promise<void> {
    try {
      switch (String(event?.type ?? '').toUpperCase()) {
        case 'CALL_RECEIVED':
          await this.callReceived(event);
          return;
        case 'CALL_FINISHED':
        case 'CALL_FAILED':
          await this.callEnded(event);
          return;
        default:
          // Any other event about one of our calls may carry the AI leg's id
          // alongside the citizen's. Recording those as aliases is what lets a
          // media stream that names the AI leg still find its call.
          await this.linkAliases(event);
      }
    } catch (err) {
      log.error('infobip_event_failed', err instanceof Error ? err : new Error(String(err)), {
        type: event?.type,
        callId: event?.callId,
      });
    }
  }

  private async callReceived(event: InfobipEvent): Promise<void> {
    const callId = String(event.callId ?? event.properties?.call?.id ?? '').trim();
    const from = String(event.properties?.call?.from ?? '').trim();
    const to = String(event.properties?.call?.to ?? '').trim();

    if (!callId) {
      log.warn('infobip_call_received_without_id', { keys: Object.keys(event ?? {}).join(',') });
      return;
    }

    // ── 1. Whose line is this? ─────────────────────────────────────────────
    const config = to
      ? await prisma.telephonyConfig.findFirst({
          where: { provider: 'INFOBIP' as any, phoneNumber: { in: phoneNumberVariants(to) } },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          select: { id: true, organizationId: true, phoneNumber: true, forwardingNumber: true },
        })
      : null;

    if (!config) {
      log.warn('infobip_number_not_configured', {
        callId,
        to: to || '(none)',
        hint:
          'An Infobip call arrived for a number no agency holds as an INFOBIP line. Add it under ' +
          'Settings → Voice with provider Infobip. The call was hung up rather than answered as a ' +
          'guessed agency.',
      });
      await this.infobip.hangup(callId);
      return;
    }
    const organizationId = config.organizationId;

    // ── 2. Who is calling? ─────────────────────────────────────────────────
    const agencyNumbers = [
      config.phoneNumber,
      config.forwardingNumber,
      to,
      ...(await prisma.telephonyConfig
        .findMany({ where: { organizationId }, select: { phoneNumber: true, forwardingNumber: true } })
        .then((rows) => rows.flatMap((r) => [r.phoneNumber, r.forwardingNumber]))
        .catch(() => [] as Array<string | null>)),
    ];
    const contact = await ensureContactForPhone(prisma, organizationId, from, undefined, agencyNumbers).catch(
      (err) => {
        log.warn('infobip_contact_create_failed', { callId, error: String((err as any)?.message ?? err) });
        return null;
      }
    );

    const fromNumber = normalizePhoneNumber(from) || from;
    const toNumber = normalizePhoneNumber(to) || to;

    // ── 3. Record it — idempotently, because carriers redeliver ────────────
    const callLog = await prisma.callLog.upsert({
      where: { callSid: callId },
      update: { status: CallStatus.IN_PROGRESS as any, ...(contact ? { contactId: contact.id } : {}) },
      create: {
        organizationId,
        telephonyConfigId: config.id,
        callSid: callId,
        fromNumber,
        toNumber,
        contactId: contact?.id ?? null,
        direction: CallDirection.INBOUND as any,
        status: CallStatus.IN_PROGRESS as any,
        provider: 'INFOBIP' as any,
      },
      select: { id: true },
    });

    await this.infobip.remember({
      parentCallId: callId,
      organizationId,
      fromNumber,
      toNumber,
      callLogId: callLog.id,
      contactId: contact?.id ?? null,
    });

    this.webhookDispatcher
      .dispatch(organizationId, 'call.started', { callSid: callId, direction: 'INBOUND' })
      .catch(() => undefined);

    // ── 4. Hand the call to the AI ─────────────────────────────────────────
    const dialog = await this.infobip.connectToAi(callId);
    if (!dialog.ok) {
      log.error('infobip_ai_connect_failed', new Error(dialog.error), {
        callId,
        organizationId,
        hint:
          'Check INFOBIP_MEDIA_STREAM_CONFIG_ID names a WEBSOCKET_ENDPOINT config pointing at this ' +
          'platform, and that the API key has the calls:traffic:send scope.',
      });
      await prisma.callLog
        .update({
          where: { id: callLog.id },
          data: {
            status: CallStatus.FAILED as any,
            endedAt: new Date(),
            summary: `The call could not be connected to the AI: ${dialog.error}`.slice(0, 1000),
          },
        })
        .catch(() => undefined);
      await this.infobip.hangup(callId);
      await this.infobip.forget(callId);
      return;
    }

    // Every id the dialog response carries becomes an alias for this call, so
    // a stream naming the AI leg rather than the citizen's still finds it.
    const aliases = await this.infobip.aliasAll(dialog.body, callId);
    log.info('infobip_call_connected_to_ai', {
      callId,
      organizationId,
      aliasesRecorded: aliases,
      dialogKeys: Object.keys(dialog.body ?? {}).join(','),
    });
  }

  private async callEnded(event: InfobipEvent): Promise<void> {
    const callId = String(event.callId ?? event.properties?.call?.id ?? '').trim();
    if (!callId) return;

    // Only the CITIZEN's call ending is the call ending. The AI leg ends too,
    // and its id resolves — through the alias recorded for exactly this
    // purpose — to the citizen's call. Without this check that would tell the
    // agency's webhook subscribers `call.ended` while the citizen was still on
    // the line.
    //
    // (It would NOT close the call record, and an earlier version of this
    // comment said it would: the update below keys on the event's own call id,
    // and the AI leg has no row of its own. Mutation testing showed the record
    // stayed open with this guard removed — the webhook is what it protects.)
    if (!(await this.infobip.isParent(callId))) {
      await this.linkAliases(event);
      return;
    }

    // Read BEFORE the record is forgotten below, and never dispatched without
    // one: a webhook sent to an empty organization id is a delivery to
    // nobody, and the tenant who should have had it never learns the call
    // ended.
    const context = await this.infobip.resolve(callId);
    const failed = String(event.type).toUpperCase() === 'CALL_FAILED';
    const rawDuration = Number(event.properties?.callLog?.duration);
    await prisma.callLog
      .update({
        where: { callSid: callId },
        data: {
          status: (failed ? CallStatus.FAILED : CallStatus.COMPLETED) as any,
          endedAt: new Date(),
          ...(Number.isFinite(rawDuration) && rawDuration > 0
            ? { durationSeconds: Math.floor(rawDuration) }
            : {}),
        },
      })
      .catch((err) =>
        log.warn('infobip_call_close_failed', { callId, error: String((err as any)?.message ?? err) })
      );

    if (context?.organizationId) {
      this.webhookDispatcher
        .dispatch(context.organizationId, 'call.ended', {
          callSid: callId,
          outcome: failed ? 'failed' : 'completed',
        })
        .catch(() => undefined);
    }

    await this.infobip.forget(callId);
    log.info('infobip_call_ended', {
      callId,
      outcome: failed ? 'FAILED' : 'COMPLETED',
      errorCode: event.properties?.callLog?.errorCode?.name,
    });
  }

  /**
   * If an event mentions one of our calls, alias the event's own call id to it.
   *
   * Bounded and cheap: at most a few dozen lookups, each a single key.
   */
  private async linkAliases(event: InfobipEvent): Promise<void> {
    const own = String(event?.callId ?? '').trim();
    if (!own || (await this.infobip.isParent(own))) return;
    for (const id of collectIds(event)) {
      if (id === own) continue;
      if (await this.infobip.isParent(id)) {
        await this.infobip.alias(own, id);
        return;
      }
    }
  }
}
