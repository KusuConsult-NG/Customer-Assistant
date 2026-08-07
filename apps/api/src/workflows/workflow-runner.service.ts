import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { prisma } from '@ace/database';
import { AceLogger } from '../config/logger';
import { WorkflowExecutorService } from './workflow-executor.service';
import { WORKFLOW_MAX_ATTEMPTS, WORKFLOW_QUEUE_NAME, WorkflowTriggerService, isWorkflowQueueHealthy } from './workflow-trigger.service';

const log = new AceLogger('WorkflowRunner');

const CONCURRENCY = parseInt(process.env.WORKFLOW_WORKER_CONCURRENCY ?? '4', 10);

/** How often the inline fallback sweeps for runs the queue never picked up. */
const INLINE_SWEEP_MS = 15_000;

/**
 * How often to sweep anyway while the queue is healthy.
 *
 * A 15-second poll running alongside a working queue does nothing but consume a
 * database connection — measured as a steady stream of P2024 pool timeouts under load,
 * logged as errors, for work the BullMQ worker had already done. The safety sweep still
 * exists because a run can be marked ranInline during a brief Redis blip and would
 * otherwise sit QUEUED forever.
 */
const SAFETY_SWEEP_MS = 5 * 60 * 1000;

/**
 * Consumes queued workflow runs and executes them.
 *
 * Two paths, both real:
 *
 *  1. BullMQ worker — the normal path. Retries with exponential backoff; a run that
 *     exhausts WORKFLOW_MAX_ATTEMPTS is marked DEAD_LETTER and the BullMQ job is kept
 *     for inspection and replay, rather than disappearing.
 *
 *  2. Inline sweeper — when Redis is unavailable, runs are created with
 *     `ranInline: true` and nothing would ever collect them. The sweeper picks those
 *     up in-process so automation still works on a single-node deployment without
 *     Redis. It only touches runs the queue did not take.
 */
@Injectable()
export class WorkflowRunnerService implements OnModuleInit, OnModuleDestroy {
  private worker: Worker | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly executor: WorkflowExecutorService,
    private readonly trigger: WorkflowTriggerService
  ) {}

  onModuleInit() {
    this.startWorker();
    this.sweepTimer = setInterval(() => void this.sweepInline(), INLINE_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  async onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.worker?.close().catch(() => {});
  }

  private startWorker() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      log.warn('workflow_worker_disabled', {
        reason: 'REDIS_URL is not set — workflows will run inline via the sweeper instead of the queue.',
      });
      return;
    }

    try {
      this.worker = new Worker(
        WORKFLOW_QUEUE_NAME,
        async (job) => {
          const runId = job.data?.runId as string;
          if (!runId) throw new Error('workflow job has no runId');

          const outcome = await this.executor.run(runId);

          if (outcome.pausedUntil) {
            // A DELAY node parked the run; resume it after the delay.
            const delay = Math.max(0, outcome.pausedUntil.getTime() - Date.now());
            await this.trigger.requeue(runId, delay);
            return { paused: true, resumeInMs: delay };
          }

          if (outcome.status === 'FAILED') {
            // Throw so BullMQ retries; the run row already records the failure.
            throw new Error(outcome.error ?? 'workflow run failed');
          }
          return { stepsExecuted: outcome.stepsExecuted };
        },
        { connection: { url: redisUrl }, concurrency: CONCURRENCY }
      );

      this.worker.on('failed', async (job, err) => {
        const runId = job?.data?.runId;
        if (!runId) return;
        const exhausted = (job?.attemptsMade ?? 0) >= WORKFLOW_MAX_ATTEMPTS;
        if (exhausted) {
          // Dead letter: stop retrying, keep everything for inspection and replay.
          await prisma.workflowRun.update({
            where: { id: runId },
            data: { status: 'DEAD_LETTER', error: err?.message ?? 'exhausted retries', finishedAt: new Date() },
          }).catch(() => {});
          log.error('workflow_run_dead_lettered', err as Error, { runId, attempts: job?.attemptsMade });
        }
      });

      this.worker.on('error', (err) => log.error('workflow_worker_error', err as Error));

      log.info('workflow_worker_started', { queue: WORKFLOW_QUEUE_NAME, concurrency: CONCURRENCY });
    } catch (err: any) {
      log.error('workflow_worker_start_failed', err as Error);
    }
  }

  /**
   * Executes runs that were created while Redis was unavailable.
   * Bounded per sweep so a backlog cannot monopolise the process.
   */
  private lastSweepAt = 0;

  private async sweepInline() {
    if (this.sweeping) return;

    if (isWorkflowQueueHealthy() && Date.now() - this.lastSweepAt < SAFETY_SWEEP_MS) return;

    this.sweeping = true;
    this.lastSweepAt = Date.now();
    try {
      const pending = await prisma.workflowRun.findMany({
        where: { status: 'QUEUED', ranInline: true, attempt: { lt: WORKFLOW_MAX_ATTEMPTS } },
        orderBy: { queuedAt: 'asc' },
        take: 10,
        select: { id: true, attempt: true },
      });

      for (const run of pending) {
        try {
          const outcome = await this.executor.run(run.id);
          if (outcome.pausedUntil) {
            // No queue to hold the delay; leave it QUEUED and let a later sweep pick
            // it up once the resume time has passed.
            continue;
          }
        } catch (err: any) {
          log.error('workflow_inline_run_failed', err as Error, { runId: run.id });
        }

        const after = await prisma.workflowRun.findUnique({ where: { id: run.id }, select: { status: true, attempt: true } });
        if (after?.status === 'FAILED' && (after.attempt ?? 0) >= WORKFLOW_MAX_ATTEMPTS) {
          await prisma.workflowRun.update({
            where: { id: run.id },
            data: { status: 'DEAD_LETTER', finishedAt: new Date() },
          }).catch(() => {});
        }
      }
    } catch (err: any) {
      // P2024 is database backpressure, not a workflow fault: the sweep is a poll and
      // the next one will pick up whatever it missed. Logging it at error level buried
      // real failures under transient noise.
      if (err?.code === 'P2024') {
        log.warn('workflow_inline_sweep_deferred', { reason: 'database connection pool exhausted; retrying next sweep' });
      } else {
        log.error('workflow_inline_sweep_failed', err as Error);
      }
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Runs a workflow immediately, bypassing the queue. Used by the "Test" button.
   *
   * The caller creates the run row and calls straight through, so nothing else can be
   * holding it — but the row must not be left QUEUED, or this sweeper would pick the
   * same run up 15 seconds later and execute every action a second time.
   */
  async runNow(runId: string) {
    return this.executor.run(runId, { exclusive: true });
  }
}
