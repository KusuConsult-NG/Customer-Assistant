import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { prisma } from '@ace/database';
import { AceLogger } from '../config/logger';
import { TRIGGER_ALIASES, TriggerEvent, normalizeTrigger } from './workflow.types';

const log = new AceLogger('WorkflowTrigger');

export const WORKFLOW_QUEUE_NAME = 'workflow-execution';

/** Attempts before a run is parked in DEAD_LETTER for manual inspection. */
export const WORKFLOW_MAX_ATTEMPTS = 3;

let queue: Queue | null = null;
let queueUnavailableSince: number | null = null;

/**
 * Lazily constructs the BullMQ queue.
 *
 * Returns null when Redis is not configured or unreachable, so callers can fall back
 * to inline execution instead of dropping the trigger. Failures are remembered for a
 * short window so every trigger does not pay a connection timeout.
 */
function getQueue(): Queue | null {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  if (queueUnavailableSince && Date.now() - queueUnavailableSince < 30_000) return null;

  if (!queue) {
    try {
      queue = new Queue(WORKFLOW_QUEUE_NAME, {
        connection: { url: redisUrl },
        defaultJobOptions: {
          attempts: WORKFLOW_MAX_ATTEMPTS,
          backoff: { type: 'exponential', delay: 5_000 }, // 5s, 10s, 20s
          removeOnComplete: { count: 500 },
          // Failed jobs are RETAINED. They are the dead-letter queue: a job that
          // exhausted its attempts stays inspectable and replayable rather than
          // vanishing.
          removeOnFail: { count: 5_000 },
        },
      });
      queue.on('error', () => { queueUnavailableSince = Date.now(); });
    } catch {
      queueUnavailableSince = Date.now();
      return null;
    }
  }
  return queue;
}

/**
 * True when the BullMQ queue is configured and has not recently errored.
 *
 * The inline sweeper uses this to stay out of the way: when the queue is healthy it
 * is doing the work, and a 15-second DB poll on top of it is pure contention.
 */
export function isWorkflowQueueHealthy(): boolean {
  // getQueue() constructs lazily and is idempotent, so this reports health correctly
  // from the first call rather than only after some trigger has already fired.
  return getQueue() !== null;
}

export interface TriggerPayload extends Record<string, any> {
  organizationId?: string;
}

/**
 * Entry point that domain code calls when something happens.
 *
 * Deliberately depends on nothing but Prisma and the queue. CRM, WhatsApp,
 * scheduling and telephony all import this; the executor (which needs those same
 * modules to perform actions) lives in WorkflowsModule. Keeping the two apart is what
 * avoids a circular module graph.
 */
@Injectable()
export class WorkflowTriggerService {
  /**
   * Finds active workflows listening for `event` and queues a run for each.
   *
   * Never throws into the caller: a workflow problem must not fail the business
   * operation that triggered it (creating a lead must still succeed if the follow-up
   * automation is misconfigured). Returns what was queued so callers can log it.
   */
  async emit(
    organizationId: string,
    event: TriggerEvent,
    payload: TriggerPayload = {}
  ): Promise<{ queued: number; runIds: string[] }> {
    try {
      // Match on the canonical event AND any legacy alias that maps to it, so
      // workflows saved as WHATSAPP_INBOUND still fire for MESSAGE_RECEIVED.
      const acceptedTriggerNames = Object.entries(TRIGGER_ALIASES)
        .filter(([, canonical]) => canonical === event)
        .map(([raw]) => raw);

      const workflows = await prisma.workflow.findMany({
        where: { organizationId, isActive: true, triggerType: { in: acceptedTriggerNames } },
        select: { id: true, name: true },
      });

      if (workflows.length === 0) return { queued: 0, runIds: [] };

      const runIds: string[] = [];
      for (const wf of workflows) {
        const run = await prisma.workflowRun.create({
          data: {
            organizationId,
            workflowId: wf.id,
            triggerType: event,
            status: 'QUEUED',
            payload: { ...payload, organizationId },
          },
        });
        runIds.push(run.id);

        const q = getQueue();
        if (q) {
          await q.add('run', { runId: run.id }, { jobId: run.id });
        } else {
          // Redis is unavailable. Rather than silently dropping the automation, mark
          // the run so it is visible, and let the caller-side inline runner pick it
          // up. Recorded on the run itself so history shows it did not go through
          // the queue.
          await prisma.workflowRun.update({ where: { id: run.id }, data: { ranInline: true } });
        }
      }

      log.info('workflow_triggered', { organizationId, event, workflows: workflows.length, queued: runIds.length });
      return { queued: runIds.length, runIds };
    } catch (err: any) {
      // A broken automation must never break the operation that fired it.
      log.error('workflow_trigger_failed', err as Error, { organizationId, event });
      return { queued: 0, runIds: [] };
    }
  }

  /** Fire-and-forget variant for call sites that must not await automation. */
  emitAsync(organizationId: string, event: TriggerEvent, payload: TriggerPayload = {}): void {
    void this.emit(organizationId, event, payload);
  }

  /** Queues an existing run again, e.g. replaying a dead-lettered one. */
  async requeue(runId: string, delayMs = 0): Promise<boolean> {
    const q = getQueue();
    if (!q) return false;
    await q.add('run', { runId }, { jobId: `${runId}:${Date.now()}`, delay: delayMs });
    return true;
  }

  static normalizeTrigger = normalizeTrigger;
}
