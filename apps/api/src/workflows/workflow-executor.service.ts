import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { AceLogger } from '../config/logger';
import { WorkflowActionsService } from './workflow-actions.service';
import {
  MAX_STEPS_PER_RUN,
  WorkflowEdge,
  WorkflowNode,
  evaluateCondition,
  normalizeEdges,
  normalizeNode,
} from './workflow.types';

const log = new AceLogger('WorkflowExecutor');

export interface ExecutionOutcome {
  runId: string;
  status: 'SUCCEEDED' | 'FAILED';
  stepsExecuted: number;
  /** Set when the run stopped early because a DELAY node was reached. */
  pausedUntil?: Date;
  error?: string;
  /**
   * False when another executor already owned this run and this call did nothing.
   * Absent means claimed — only the duplicate-suppression path sets it.
   */
  claimed?: boolean;
}

/**
 * How long a RUNNING row may sit untouched before another executor may take it over.
 * Covers a process that was killed mid-run; short enough that a stuck run recovers on
 * its own, long enough that a slow-but-alive run is never double-executed.
 */
const STALE_RUN_MS = 10 * 60 * 1000;

/**
 * Walks a workflow graph and performs its actions.
 *
 * Semantics:
 *  - Traversal starts at TRIGGER nodes and follows edges breadth-first.
 *  - A CONDITION that evaluates false prunes its `true` branch (and vice versa);
 *    downstream nodes reached only through the pruned branch are recorded SKIPPED,
 *    so the history shows they were considered and why they did not run.
 *  - A failing ACTION fails the run. The queue retries the whole run; actions are
 *    therefore expected to be idempotent-ish, and each attempt is recorded separately.
 *  - MAX_STEPS_PER_RUN bounds cycles and runaway graphs.
 */
@Injectable()
export class WorkflowExecutorService {
  constructor(private readonly actions: WorkflowActionsService) {}

  /**
   * @param opts.exclusive  Set by callers that just created the run row and have not
   *   published its id anywhere, so no other executor can possibly hold it. Skips the
   *   contended claim rather than pretending to compete with itself.
   */
  async run(runId: string, opts: { exclusive?: boolean } = {}): Promise<ExecutionOutcome> {
    const run = await prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { workflow: true },
    });
    if (!run) throw new Error(`Workflow run ${runId} not found.`);

    // ── Claim the run atomically ──────────────────────────────────────────────
    //
    // Two things can reach the same run at once: the BullMQ worker and the inline
    // sweeper (and, for the Test button, runNow racing the sweeper on a run that is
    // still QUEUED). An unconditional "set RUNNING" let both proceed, so every step
    // ran twice — two tickets from one ticket node, two messages to the customer.
    //
    // The conditional updateMany is the lock: whoever flips the row out of a
    // claimable state wins, everyone else sees count 0 and stops.
    //
    // RUNNING is reclaimable only after STALE_RUN_MS, so a process that died
    // mid-run does not strand the row forever.
    const claim = opts.exclusive
      ? { count: 1 }
      : await prisma.workflowRun.updateMany({
          where: {
            id: runId,
            OR: [
              { status: 'QUEUED' },
              { status: 'FAILED' }, // a retry of a failed attempt
              { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } },
            ],
          },
          data: { status: 'RUNNING', startedAt: new Date(), attempt: { increment: 1 } },
        });

    if (opts.exclusive) {
      await prisma.workflowRun.update({
        where: { id: runId },
        data: { status: 'RUNNING', startedAt: new Date(), attempt: { increment: 1 } },
      });
    }

    if (claim.count === 0) {
      log.debug('workflow_run_already_claimed', { runId, status: run.status });
      return { runId, status: run.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED', stepsExecuted: 0, claimed: false };
    }

    const nodes: WorkflowNode[] = (Array.isArray(run.workflow.nodes) ? run.workflow.nodes : []).map(normalizeNode);
    const edges: WorkflowEdge[] = normalizeEdges(run.workflow.edges);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const payload = (run.payload ?? {}) as Record<string, any>;

    const ctx = { organizationId: run.organizationId, payload };

    let stepsExecuted = 0;
    let failure: string | undefined;
    let pausedUntil: Date | undefined;

    const visited = new Set<string>();
    const skipped = new Set<string>();

    // Start from every TRIGGER node (normally one).
    const queue: string[] = nodes.filter((n) => n.kind === 'TRIGGER').map((n) => n.id);
    if (queue.length === 0) {
      failure = 'The workflow has no TRIGGER node, so there is nothing to start from.';
    }

    while (queue.length > 0 && !failure && !pausedUntil) {
      if (stepsExecuted >= MAX_STEPS_PER_RUN) {
        failure = `Stopped after ${MAX_STEPS_PER_RUN} steps — the graph may contain a cycle.`;
        break;
      }

      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = byId.get(nodeId);
      if (!node) continue;

      // Reached only via a pruned branch.
      if (skipped.has(nodeId)) {
        await this.recordStep(runId, node, 'SKIPPED', null, { reason: 'Upstream condition did not match.' });
        this.enqueueNext(queue, edges, nodeId, undefined, skipped, true);
        continue;
      }

      if (node.kind === 'TRIGGER') {
        this.enqueueNext(queue, edges, nodeId, undefined, skipped, false);
        continue;
      }

      if (node.kind === 'UNCONFIGURED') {
        failure = `Node "${node.label ?? node.id}" is not configured: ${node.unconfiguredReason}`;
        await this.recordStep(runId, node, 'FAILED', null, null, failure);
        break;
      }

      if (node.kind === 'CONDITION') {
        const matched = evaluateCondition(node, payload);
        stepsExecuted++;
        await this.recordStep(
          runId, node, 'SUCCEEDED',
          { field: node.field, operator: node.operator, value: node.value },
          { matched, actual: node.field }
        );
        // Follow the matching branch; mark the other one's descendants skipped.
        this.enqueueNext(queue, edges, nodeId, matched ? 'true' : 'false', skipped, false);
        this.markBranchSkipped(edges, nodeId, matched ? 'false' : 'true', skipped);
        continue;
      }

      if (node.kind === 'DELAY') {
        // Park the run. The caller re-enqueues with this delay; remaining nodes run
        // in the next attempt. Recorded so the history shows why it paused.
        pausedUntil = new Date(Date.now() + (node.delaySeconds ?? 0) * 1000);
        stepsExecuted++;
        await this.recordStep(runId, node, 'SUCCEEDED', { delaySeconds: node.delaySeconds }, { resumeAt: pausedUntil.toISOString() });
        break;
      }

      if (node.kind === 'ACTION') {
        const startedAt = new Date();
        try {
          const result = await this.actions.execute(node, ctx);
          stepsExecuted++;
          await this.recordStep(runId, node, 'SUCCEEDED', node.config ?? {}, result.output, undefined, startedAt);
          this.enqueueNext(queue, edges, nodeId, undefined, skipped, false);
        } catch (err: any) {
          failure = `${node.action} failed: ${err?.message ?? err}`;
          await this.recordStep(runId, node, 'FAILED', node.config ?? {}, null, failure, startedAt);
          break;
        }
      }
    }

    const status = failure ? 'FAILED' : 'SUCCEEDED';
    await prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status,
        error: failure ?? null,
        // A paused run is not finished; the delay job will resume it.
        finishedAt: pausedUntil ? null : new Date(),
        ...(pausedUntil ? { status: 'QUEUED' as const } : {}),
      },
    });

    log.info('workflow_run_complete', {
      organizationId: run.organizationId,
      runId,
      workflowId: run.workflowId,
      status: pausedUntil ? 'PAUSED' : status,
      stepsExecuted,
      ...(failure ? { error: failure } : {}),
    });

    return { runId, status, stepsExecuted, pausedUntil, error: failure };
  }

  // ── Traversal helpers ─────────────────────────────────────────────────────

  private enqueueNext(
    queue: string[],
    edges: WorkflowEdge[],
    from: string,
    branch: 'true' | 'false' | undefined,
    skipped: Set<string>,
    propagateSkip: boolean
  ) {
    for (const e of edges.filter((x) => x.from === from)) {
      // Downstream of a CONDITION, an edge with no explicit branch is the TRUE path.
      //
      // Treating it as "always follow" would make every condition a no-op: the linear
      // chain the editor produces has unbranded edges, so a condition that evaluated
      // false would still run the actions it was supposed to gate.
      if (branch && (e.branch ?? 'true') !== branch) continue;
      if (propagateSkip) skipped.add(e.to);
      queue.push(e.to);
    }
  }

  /** Marks everything reachable only through `branch` as skipped. */
  private markBranchSkipped(edges: WorkflowEdge[], from: string, branch: 'true' | 'false', skipped: Set<string>) {
    // Same defaulting rule as enqueueNext: unbranded == TRUE path.
    const stack = edges.filter((e) => e.from === from && (e.branch ?? 'true') === branch).map((e) => e.to);
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      skipped.add(id);
      edges.filter((e) => e.from === id).forEach((e) => stack.push(e.to));
    }
  }

  private async recordStep(
    runId: string,
    node: WorkflowNode,
    status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED',
    input: any,
    output: any,
    error?: string,
    startedAt?: Date
  ) {
    await prisma.workflowRunStep.create({
      data: {
        runId,
        nodeId: node.id,
        kind: node.kind,
        action: node.action ?? null,
        status,
        input: input ?? undefined,
        output: output ?? undefined,
        error: error ?? null,
        startedAt: startedAt ?? new Date(),
        finishedAt: new Date(),
      },
    }).catch((err) => {
      // Never let history-writing failure mask the actual execution result.
      log.error('workflow_step_record_failed', err as Error, { runId, nodeId: node.id });
    });
  }
}
