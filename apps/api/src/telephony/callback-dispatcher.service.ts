import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  prisma,
  nextAttemptAt,
  serviceHoursFrom,
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
  async sweep(now: Date = new Date()): Promise<{ promoted: number; placed: number; failed: number }> {
    const promoted = await prisma.callbackRequest.updateMany({
      where: { status: 'PENDING', dueAt: { lte: now } },
      data: { status: 'DUE' },
    });

    const due = await prisma.callbackRequest.findMany({
      where: { status: 'DUE', dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: 25,
      include: { contact: true },
    });

    let placed = 0;
    let failed = 0;
    for (const row of due) {
      const outcome = await this.placeOne(row.id);
      if (outcome === 'placed') placed++;
      else if (outcome === 'failed') failed++;
    }

    if (promoted.count || placed || failed) {
      log.info('callback_sweep', { promoted: promoted.count, placed, failed });
    }
    return { promoted: promoted.count, placed, failed };
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

      await prisma.callbackRequest.update({
        where: { id },
        data: {
          attempts,
          callSid: call?.callId ?? null,
          status: 'COMPLETED',
          completedAt: new Date(),
          failureReason: null,
        },
      });

      log.info('callback_placed', {
        organizationId: row.organizationId,
        reference: callbackReference(row.id),
        attempts,
      });

      await this.workflows.emitAsync(row.organizationId, 'CALLBACK_PLACED', {
        callbackId: row.id,
        reference: callbackReference(row.id),
        contactId: row.contactId,
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

      const hours = await serviceHoursFrom(prisma, row.organizationId);
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
