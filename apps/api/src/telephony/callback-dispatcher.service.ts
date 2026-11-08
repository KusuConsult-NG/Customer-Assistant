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
import { isOfficerDialledLine } from './outbound-line';

const log = new AceLogger('CallbackDispatcherService');

/**
 * Written to `callSid` while an officer's browser is dialling a promise.
 *
 * It is what tells the grace sweep this row is a person on a call rather
 * than a dial whose carrier callback went missing. A conversation with a
 * citizen can easily outlast the dialler's fifteen minutes, and reopening it
 * then would put the promise back in the queue mid-call and refuse the
 * officer's report of how it went. No carrier writes this value, so no
 * status callback can match it.
 */
export const BROWSER_DIAL_MARKER = 'infobip-webrtc:dialling';

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

  /**
   * How long an officer's browser call may run before its silence counts.
   * Longer than the browser token lives, so a call still in progress always
   * ends — and reports — before this fires.
   */
  private static readonly BROWSER_GRACE_MS = 2 * 60 * 60_000;

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
  ): Promise<{
    promoted: number;
    placed: number;
    failed: number;
    held: number;
    heldForOfficer: number;
    reopened: number;
  }> {
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
    let heldForOfficer = 0;

    // Outbound hours are per agency, and a sweep spans several — so they are
    // resolved once each rather than per row.
    const hoursByOrg = new Map<string, Awaited<ReturnType<typeof outboundContactHoursFrom>>>();
    const officerDialledByOrg = new Map<string, boolean>();

    for (const row of due) {
      // An Infobip line is dialled by an officer from the Callback Queue;
      // this process places no Infobip calls. Claiming the row anyway would
      // fail the dial and spend one of the citizen's attempts on a call
      // nobody placed — and after `maxAttempts` sweeps, mark a promise FAILED
      // that no one ever tried to keep. Left DUE, it is what the officer sees.
      let officerDialled = officerDialledByOrg.get(row.organizationId);
      if (officerDialled === undefined) {
        officerDialled = await isOfficerDialledLine(row.organizationId);
        officerDialledByOrg.set(row.organizationId, officerDialled);
      }
      if (officerDialled) {
        heldForOfficer++;
        continue;
      }

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

    if (promoted.count || placed || failed || held || heldForOfficer || reopened) {
      log.info('callback_sweep', { promoted: promoted.count, placed, failed, held, heldForOfficer, reopened });
    }
    return { promoted: promoted.count, placed, failed, held, heldForOfficer, reopened };
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
    const browserCutoff = new Date(now.getTime() - CallbackDispatcherService.BROWSER_GRACE_MS);
    const stale = await prisma.callbackRequest.findMany({
      where: {
        status: 'IN_PROGRESS',
        OR: [
          // `not` alone would also drop NULL callSids — SQL never matches a
          // NULL against `<>` — so the dialler's unsettled rows are listed too.
          { callSid: null, lastAttemptAt: { lte: cutoff } },
          { callSid: { not: BROWSER_DIAL_MARKER }, lastAttemptAt: { lte: cutoff } },
          { callSid: BROWSER_DIAL_MARKER, lastAttemptAt: { lte: browserCutoff } },
          { lastAttemptAt: null },
        ],
      },
      take: CallbackDispatcherService.SCAN_LIMIT,
      select: { id: true, organizationId: true, attempts: true, maxAttempts: true, callSid: true },
    });

    let reopened = 0;
    for (const row of stale) {
      const reason =
        row.callSid === BROWSER_DIAL_MARKER
          ? "The officer's browser never reported how this call ended (the tab was closed, or the " +
            'connection dropped), so whether the citizen was reached is unknown.'
          : 'The carrier never reported what happened to this call, so whether the citizen was ' +
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
    // Before the claim, for the reason the sweep checks it: a dial this
    // process will not place must not cost the citizen an attempt.
    const target = await prisma.callbackRequest.findUnique({
      where: { id },
      select: { organizationId: true },
    });
    if (!target || (await isOfficerDialledLine(target.organizationId))) return 'skipped';

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
        undefined,
        // The promise already names the citizen, so the call history does too.
        row.contactId,
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

  // ─── An officer dialling from the browser ─────────────────────────────────

  /**
   * Claim a promise for an officer about to ring it from their browser.
   *
   * The same atomic claim the dialler makes, for the same reason: two
   * officers pressing "Call from browser" on one row would otherwise both
   * ring the citizen, and the second would have no idea the first was
   * already talking to them. Only the caller whose count is 1 dials.
   *
   * Scoped by organization in the WHERE, not checked afterwards — one agency
   * must not be able to claim another's promise by quoting its id.
   */
  async claimForBrowser(
    id: string,
    organizationId: string,
    userId: string
  ): Promise<{ id: string; phoneNumber: string; contactId: string | null } | null> {
    const claimed = await prisma.callbackRequest.updateMany({
      where: { id, organizationId, status: { in: ['PENDING', 'DUE'] } },
      data: {
        status: 'IN_PROGRESS',
        lastAttemptAt: new Date(),
        assignedUserId: userId,
        callSid: BROWSER_DIAL_MARKER,
      },
    });
    if (claimed.count !== 1) return null;
    return prisma.callbackRequest.findUnique({
      where: { id },
      select: { id: true, phoneNumber: true, contactId: true },
    });
  }

  /**
   * Hand a claimed promise back untouched: the browser never placed the call.
   *
   * For a token Infobip refused, an SDK that would not load, a connection that
   * never opened. The citizen's phone did not ring, so no attempt is counted
   * against them — `maxAttempts` exists to stop us pestering a citizen, and
   * our own software failing is not that. It goes back to DUE or PENDING by
   * its own deadline, so a late promise still reads as late.
   *
   * Conditional on the browser marker: only a claim this path made is
   * released, never a row something else has since settled.
   */
  async releaseBrowserClaim(id: string, organizationId: string): Promise<'DUE' | 'PENDING' | null> {
    const row = await prisma.callbackRequest.findFirst({
      where: { id, organizationId, status: 'IN_PROGRESS', callSid: BROWSER_DIAL_MARKER },
      select: { dueAt: true },
    });
    if (!row) return null;
    const previous = row.dueAt.getTime() <= Date.now() ? 'DUE' : 'PENDING';
    const { count } = await prisma.callbackRequest.updateMany({
      where: { id, organizationId, status: 'IN_PROGRESS', callSid: BROWSER_DIAL_MARKER },
      data: { status: previous, callSid: null },
    });
    return count === 1 ? previous : null;
  }

  /**
   * Settle a promise from what the officer's browser call actually did.
   *
   * ── What "answered" is allowed to mean ────────────────────────────────────
   *
   * `answered` is sent only when Infobip's SDK raised ESTABLISHED: the
   * citizen's phone picked up and the officer was connected. That is the same
   * evidence the Twilio path settles on (`completed` from the carrier's status
   * callback), so it is recorded the same way — REACHED. Anything else is an
   * attempt that did not reach them, with Infobip's hangup reason attached,
   * and it goes back in the queue or fails exactly as a dialler attempt does.
   *
   * This IS the browser's report, and the record says so. The officer is
   * authenticated, in this agency, and could already close the promise by
   * hand with "Mark done"; a browser report is no more trust than that, and
   * it carries more detail.
   *
   * Conditional on IN_PROGRESS, so a report posted twice settles once, and a
   * report for a row the grace sweep already reopened changes nothing.
   */
  async recordBrowserAttempt(input: {
    id: string;
    organizationId: string;
    officerName: string;
    fromNumber: string;
    callId: string | null;
    outcome: 'answered' | 'not_answered' | 'failed';
    durationSeconds: number;
    reason: string | null;
  }): Promise<{ status: string; attempts: number; failureReason: string | null; callLogId: string } | null> {
    const row = await prisma.callbackRequest.findFirst({
      where: { id: input.id, organizationId: input.organizationId, status: 'IN_PROGRESS' },
    });
    if (!row) return null;

    const attempts = row.attempts + 1;
    const reached = input.outcome === 'answered';
    const reason = reached
      ? null
      : (input.reason?.trim() ||
          (input.outcome === 'failed'
            ? 'The browser call could not be placed.'
            : 'The citizen did not answer.')
        ).slice(0, 500);
    const exhausted = !reached && attempts >= row.maxAttempts;
    const hours = reached || exhausted ? null : await outboundContactHoursFrom(prisma, row.organizationId);
    const now = new Date();

    // A namespace the carrier callbacks never write, so a browser-reported id
    // cannot collide with — or overwrite — a row some other path recorded.
    const callSid = `infobip-webrtc:${input.callId ?? `${row.id}:${attempts}`}`;

    const settled = await prisma.$transaction(async (tx) => {
      const { count } = await tx.callbackRequest.updateMany({
        where: { id: row.id, organizationId: input.organizationId, status: 'IN_PROGRESS' },
        data: reached
          ? { attempts, status: 'COMPLETED', completedAt: now, failureReason: null, callSid }
          : exhausted
            ? { attempts, status: 'FAILED', failureReason: reason, callSid }
            : { attempts, status: 'PENDING', dueAt: nextAttemptAt(attempts, hours!, now), failureReason: reason, callSid },
      });
      if (count !== 1) return null;

      const durationSeconds = reached ? Math.max(0, Math.round(input.durationSeconds || 0)) : 0;
      const callLog = await tx.callLog.create({
        data: {
          organizationId: input.organizationId,
          contactId: row.contactId,
          callSid,
          fromNumber: input.fromNumber,
          toNumber: row.phoneNumber,
          direction: 'OUTBOUND',
          status: reached ? 'COMPLETED' : input.outcome === 'failed' ? 'FAILED' : 'NO_ANSWER',
          durationSeconds,
          provider: 'INFOBIP',
          startedAt: new Date(now.getTime() - durationSeconds * 1000),
          endedAt: now,
          summary:
            `Callback ${callbackReference(row.id)} placed by ${input.officerName} from the dashboard ` +
            `(Infobip, browser). Outcome as reported by the officer's browser: ` +
            (reached ? `answered, ${durationSeconds}s.` : `not reached — ${reason}`),
        },
      });
      return callLog;
    });
    if (!settled) return null;

    log.info('callback_browser_attempt_recorded', {
      organizationId: input.organizationId,
      reference: callbackReference(row.id),
      outcome: input.outcome,
      attempts,
    });

    if (exhausted) {
      await this.workflows.emitAsync(row.organizationId, 'CALLBACK_FAILED', {
        callbackId: row.id,
        reference: callbackReference(row.id),
        contactId: row.contactId,
        reason,
      });
    }

    return {
      status: reached ? 'COMPLETED' : exhausted ? 'FAILED' : 'PENDING',
      attempts,
      failureReason: reason,
      callLogId: settled.id,
    };
  }
}
