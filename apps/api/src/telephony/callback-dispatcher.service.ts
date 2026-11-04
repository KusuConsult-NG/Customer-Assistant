import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  prisma,
  nextAttemptAt,
  nextServiceTime,
  outboundContactHoursFrom,
  mayContactNow,
  callbackReference,
} from '@ace/database';
import { AceLogger } from '../config/logger';
import { TelephonyService } from './telephony.service';
import { WorkflowTriggerService } from '../workflows/workflow-trigger.service';

const log = new AceLogger('CallbackDispatcherService');

/**
 * Keeps the promise to ring a citizen back.
 *
 * ── Why the claim comes before the dial ─────────────────────────────────────
 *
 * Exactly the same reason AppointmentReminderService claims before it sends.
 * Two pods polling the same minute both see the same DUE row; without a claim
 * both dial, and the citizen's phone rings twice about one request while the
 * second officer has no idea the first call already happened. So an atomic
 * `updateMany` flips the row out of DUE and only the caller whose count is 1
 * places the call.
 *
 * A crash between claim and dial loses that one attempt, which is the safer
 * failure: the row is left IN_PROGRESS and surfaces on the console as a
 * promise nobody kept, rather than silently ringing someone twice.
 *
 * ── Why a failure is recorded rather than retried forever ───────────────────
 *
 * `maxAttempts` is on the row. When it is used up the record goes FAILED with
 * the carrier's own reason attached, because the officer who picks it up has
 * to tell the citizen why nobody reached them — "we tried" is not an answer,
 * and an infinitely retried row is one nobody ever looks at.
 *
 * ── Why it refuses rather than pretending ───────────────────────────────────
 *
 * With no telephony configured, `initiateOutboundCall` throws with a reason
 * naming the settings page. That reason is stored and the row is left for a
 * human instead of being marked COMPLETED. A callback marked done that never
 * rang is the exact failure the no-fabrication invariant exists to prevent.
 */
@Injectable()
export class CallbackDispatcherService implements OnModuleInit, OnModuleDestroy {
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** How often the queue is swept. Callback windows are coarse (an hour at
   *  the finest), so a minute of granularity is far inside the promise. */
  private static readonly POLL_MS = 60_000;

  /**
   * How many DUE rows one sweep reads, and how many it will dial.
   *
   * They are different numbers on purpose: a held row costs nothing but used
   * to consume one of the 25 slots the sweep read, so one agency's overnight
   * backlog starved every other agency's queue. See `sweep`.
   */
  private static readonly SCAN_LIMIT = 500;
  private static readonly DIAL_LIMIT = 25;

  /**
   * How long a dialled promise may wait for the carrier to say what happened
   * before it goes back in the queue. Longer than any call plus its status
   * callback, short enough that a lost callback does not look like a promise
   * nobody kept for the rest of the day.
   */
  private static readonly DIAL_GRACE_MS = 15 * 60_000;

  constructor(
    private readonly telephony: TelephonyService,
    private readonly workflows: WorkflowTriggerService,
  ) {}

  onModuleInit() {
    this.sweep().catch((err) => log.error('Initial callback sweep failed', err));
    this.pollTimer = setInterval(
      () => this.sweep().catch((err) => log.error('Callback sweep failed', err)),
      CallbackDispatcherService.POLL_MS,
    );
  }

  onModuleDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * One pass: promote what has fallen due, then place what is due.
   *
   * Promotion is separate from placement so the console can show PENDING and
   * DUE differently — "promised for later" and "we owe this person a call
   * right now" are different things to an officer triaging a queue.
   */
  async sweep(
    now: Date = new Date()
  ): Promise<{ promoted: number; placed: number; failed: number; held: number; reopened: number }> {
    const promoted = await prisma.callbackRequest.updateMany({
      where: { status: 'PENDING', dueAt: { lte: now } },
      data: { status: 'DUE' },
    });

    const reopened = await this.reopenAbandoned(now);

    // ── Why this reads far more rows than it will dial ─────────────────────
    //
    // A held row stays DUE, and the queue is ordered by `dueAt`. With a fixed
    // `take: 25`, one agency holding a nightful of promises outside its own
    // contact window filled every single sweep — and an agency whose window
    // WAS open never got looked at, its citizens waiting on a queue busy
    // skipping somebody else's. So the page is wide enough to see past one
    // agency's held rows, and the DIALS are what is budgeted, not the read.
    const due = await prisma.callbackRequest.findMany({
      where: { status: 'DUE', dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: CallbackDispatcherService.SCAN_LIMIT,
      include: { contact: true },
    });

    let placed = 0;
    let failed = 0;
    let held = 0;

    // Outbound hours are per agency, and a sweep spans several — so they are
    // resolved once each rather than per row.
    const hoursByOrg = new Map<string, Awaited<ReturnType<typeof outboundContactHoursFrom>>>();

    for (const row of due) {
      let hours = hoursByOrg.get(row.organizationId);
      if (!hours) {
        hours = await outboundContactHoursFrom(prisma, row.organizationId);
        hoursByOrg.set(row.organizationId, hours);
      }

      // A promise that fell due at 03:00 waits until the agency may ring.
      // Held rather than rescheduled: the citizen was told a window and the
      // record keeps it, so an officer sees a promise that is late and why,
      // instead of one whose deadline quietly moved to suit us.
      if (!mayContactNow(hours, now)) {
        held++;
        continue;
      }

      // The budget is on dials, so holding costs nothing. Without the break a
      // backlog would dial hundreds of citizens inside one minute's sweep.
      if (placed + failed >= CallbackDispatcherService.DIAL_LIMIT) continue;

      const outcome = await this.placeOne(row.id);
      if (outcome === 'placed') placed++;
      else if (outcome === 'failed') failed++;
    }

    if (held) {
      log.info('callback_held_outside_contact_hours', { held });
    }

    if (promoted.count || placed || failed || held || reopened) {
      log.info('callback_sweep', { promoted: promoted.count, placed, failed, held, reopened });
    }
    return { promoted: promoted.count, placed, failed, held, reopened };
  }

  /**
   * Promises left dialling by something that never came back.
   *
   * ── Why this is needed at all ───────────────────────────────────────────
   *
   * `placeOne` leaves a row IN_PROGRESS once the carrier accepts the dial,
   * because a carrier accepting one is not the citizen answering. The outcome
   * normally arrives as a call-status callback and `reconcileFromCall` settles
   * it. Three things stop that arriving: the callback is lost or refused, the
   * SIP-trunk path reports no per-call outcome at all, and a crash between the
   * claim and the dial leaves exactly the same row.
   *
   * Every one of those used to sit IN_PROGRESS indefinitely — which on the
   * console is indistinguishable from a promise nobody kept, and which counted
   * as an attempt already used. So after a grace period the row goes back in
   * the queue, or fails with the silence named as the reason. It never becomes
   * COMPLETED: nothing here knows the citizen was reached.
   */
  private async reopenAbandoned(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - CallbackDispatcherService.DIAL_GRACE_MS);
    const stale = await prisma.callbackRequest.findMany({
      where: {
        status: 'IN_PROGRESS',
        OR: [{ lastAttemptAt: { lte: cutoff } }, { lastAttemptAt: null }],
      },
      take: CallbackDispatcherService.SCAN_LIMIT,
      select: { id: true, organizationId: true, attempts: true, maxAttempts: true },
    });

    let reopened = 0;
    for (const row of stale) {
      const reason =
        'The carrier never reported what happened to this call, so whether the citizen was ' +
        'reached is unknown.';
      const exhausted = row.attempts >= row.maxAttempts;
      const hours = exhausted ? null : await outboundContactHoursFrom(prisma, row.organizationId);

      // Conditional, like the claim: a status callback arriving while this runs
      // must win rather than be overwritten by it.
      const { count } = await prisma.callbackRequest.updateMany({
        where: { id: row.id, status: 'IN_PROGRESS' },
        data: exhausted
          ? { status: 'FAILED', failureReason: reason }
          : { status: 'PENDING', failureReason: reason, dueAt: nextAttemptAt(row.attempts, hours!, now) },
      });
      if (count === 1) {
        reopened++;
        log.warn('callback_dial_outcome_never_reported', {
          organizationId: row.organizationId,
          reference: callbackReference(row.id),
          attempts: row.attempts,
          resolved: exhausted ? 'FAILED' : 'requeued',
        });
      }
    }
    return reopened;
  }

  /**
   * Settle a promise from what the carrier says actually happened to the call.
   *
   * Called from `TelephonyService.updateCallStatus`, which is where every
   * provider's call-status callback lands. `organizationId` is passed when the
   * caller knows it, and a mismatch is refused rather than resolved: the SID
   * comes from an external callback, and one agency must not be able to close
   * another's promise by quoting a SID.
   *
   * Returns whether a callback row was settled, so the caller can log it.
   */
  async reconcileFromCall(
    callSid: string,
    status: string,
    durationSeconds?: number,
    organizationId?: string
  ): Promise<boolean> {
    if (!callSid) return false;
    const row = await prisma.callbackRequest.findFirst({
      where: { callSid, status: { in: ['IN_PROGRESS', 'DUE', 'PENDING'] } },
    });
    if (!row) return false;
    if (organizationId && row.organizationId !== organizationId) {
      log.warn('callback_reconcile_wrong_tenant', {
        reference: callbackReference(row.id),
        organizationId,
      });
      return false;
    }

    // What the carrier's own vocabulary means for a promise. Only COMPLETED is
    // "the citizen was reached" — that is what the column means, and it is the
    // one value an officer reads as a promise kept.
    if (status === 'COMPLETED') {
      await prisma.callbackRequest.update({
        where: { id: row.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          failureReason: null,
          ...(durationSeconds !== undefined ? {} : {}),
        },
      });
      log.info('callback_kept', {
        organizationId: row.organizationId,
        reference: callbackReference(row.id),
        attempts: row.attempts,
        durationSeconds: durationSeconds ?? null,
      });
      await this.workflows.emitAsync(row.organizationId, 'CALLBACK_PLACED', {
        callbackId: row.id,
        reference: callbackReference(row.id),
        contactId: row.contactId,
        attempts: row.attempts,
      });
      return true;
    }

    const reason =
      status === 'BUSY'
        ? 'The line was engaged (busy) when we rang.'
        : status === 'NO_ANSWER'
          ? 'The citizen did not answer when we rang.'
          : `The carrier reported the call as ${status.toLowerCase()}.`;

    const exhausted = row.attempts >= row.maxAttempts;
    if (exhausted) {
      await prisma.callbackRequest.update({
        where: { id: row.id },
        data: { status: 'FAILED', failureReason: reason },
      });
      log.warn('callback_failed_unreached', {
        organizationId: row.organizationId,
        reference: callbackReference(row.id),
        attempts: row.attempts,
        reason,
      });
      await this.workflows.emitAsync(row.organizationId, 'CALLBACK_FAILED', {
        callbackId: row.id,
        reference: callbackReference(row.id),
        contactId: row.contactId,
        reason,
      });
      return true;
    }

    const hours = await outboundContactHoursFrom(prisma, row.organizationId);
    await prisma.callbackRequest.update({
      where: { id: row.id },
      data: {
        status: 'PENDING',
        failureReason: reason,
        dueAt: nextAttemptAt(row.attempts, hours),
      },
    });
    log.info('callback_unreached_will_retry', {
      organizationId: row.organizationId,
      reference: callbackReference(row.id),
      attempts: row.attempts,
      reason,
    });
    return true;
  }

  /**
   * Claim one row and dial it. Exported for the console's "call now" button,
   * which must go through the same claim so a manual press and the sweeper
   * cannot both dial.
   */
  async placeOne(id: string): Promise<'placed' | 'failed' | 'skipped'> {
    // THE CLAIM. Only the caller whose count is 1 proceeds.
    const claimed = await prisma.callbackRequest.updateMany({
      where: { id, status: { in: ['PENDING', 'DUE'] } },
      data: { status: 'IN_PROGRESS', lastAttemptAt: new Date() },
    });
    if (claimed.count !== 1) return 'skipped';

    const row = await prisma.callbackRequest.findUnique({ where: { id } });
    if (!row) return 'skipped';

    const attempts = row.attempts + 1;

    try {
      const call = await this.telephony.initiateOutboundCall(
        row.organizationId,
        row.phoneNumber,
      );

      // DIALLED, not kept.
      //
      // This used to write COMPLETED and completedAt the moment the carrier
      // accepted the request. The schema says COMPLETED means "the citizen was
      // reached", and a carrier accepting a dial is not that — the phone may be
      // engaged, switched off, or simply ring out. So the console said the
      // promise had been kept, `maxAttempts` was never touched, and nothing
      // retried: a call that never happened, recorded as one, which is the
      // exact failure the claim-before-dial was written to prevent.
      //
      // The row stays IN_PROGRESS with the SID on it. `reconcileFromCall`
      // settles it from the carrier's own status callback, and `reopenAbandoned`
      // puts it back in the queue if that never arrives.
      await prisma.callbackRequest.update({
        where: { id },
        data: {
          attempts,
          callSid: call?.callId ?? null,
          status: 'IN_PROGRESS',
          failureReason: null,
        },
      });

      log.info('callback_dialled', {
        organizationId: row.organizationId,
        reference: callbackReference(row.id),
        callSid: call?.callId ?? null,
        attempts,
      });

      return 'placed';
    } catch (err: any) {
      // The carrier's own words, not a generic apology: this is what the
      // officer reads when they have to explain the missed call.
      const reason = String(err?.message ?? err).slice(0, 500);
      const exhausted = attempts >= row.maxAttempts;

      if (exhausted) {
        await prisma.callbackRequest.update({
          where: { id },
          data: { attempts, status: 'FAILED', failureReason: reason },
        });
        log.error('callback_failed_permanently', err instanceof Error ? err : new Error(reason), {
          organizationId: row.organizationId,
          reference: callbackReference(row.id),
          attempts,
        });
        await this.workflows.emitAsync(row.organizationId, 'CALLBACK_FAILED', {
          callbackId: row.id,
          reference: callbackReference(row.id),
          contactId: row.contactId,
          reason,
        });
        return 'failed';
      }

      const hours = await outboundContactHoursFrom(prisma, row.organizationId);
      await prisma.callbackRequest.update({
        where: { id },
        data: {
          attempts,
          status: 'PENDING',
          dueAt: nextAttemptAt(attempts, hours),
          failureReason: reason,
        },
      });
      log.warn('callback_attempt_failed_will_retry', {
        organizationId: row.organizationId,
        reference: callbackReference(row.id),
        attempts,
        reason,
      });
      return 'failed';
    }
  }
}
