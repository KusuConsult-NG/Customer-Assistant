import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@ace/database';
import { AceLogger } from '../config/logger';
import { WorkflowRunnerService } from './workflow-runner.service';
import { WorkflowTriggerService } from './workflow-trigger.service';
import {
  ACTION_TYPES,
  TRIGGER_ALIASES,
  normalizeEdges,
  normalizeNode,
  normalizeTrigger,
  validateGraph,
} from './workflow.types';

const log = new AceLogger('WorkflowsService');

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly runner: WorkflowRunnerService,
    private readonly trigger: WorkflowTriggerService
  ) {}

  async getWorkflows(organizationId: string) {
    const workflows = await prisma.workflow.findMany({
      where: { organizationId },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { runs: true } },
        runs: {
          orderBy: { queuedAt: 'desc' },
          take: 1,
          select: { id: true, status: true, queuedAt: true, finishedAt: true, error: true },
        },
      },
    });

    // Surface configuration problems in the list so a broken workflow is visible
    // without opening it.
    return workflows.map((w) => {
      const nodes = (Array.isArray(w.nodes) ? w.nodes : []).map(normalizeNode);
      const problems = validateGraph(nodes, normalizeEdges(w.edges));
      return {
        ...w,
        lastRun: w.runs[0] ?? null,
        runCount: w._count.runs,
        problems,
        runnable: problems.length === 0,
      };
    });
  }

  async getWorkflowById(organizationId: string, id: string) {
    const workflow = await prisma.workflow.findFirst({
      where: { id, organizationId },
      include: {
        runs: {
          orderBy: { queuedAt: 'desc' },
          take: 20,
          include: { steps: { orderBy: { startedAt: 'asc' } } },
        },
      },
    });
    if (!workflow) throw new NotFoundException('Workflow not found');

    const nodes = (Array.isArray(workflow.nodes) ? workflow.nodes : []).map(normalizeNode);
    const problems = validateGraph(nodes, normalizeEdges(workflow.edges));
    return { ...workflow, normalizedNodes: nodes, problems, runnable: problems.length === 0 };
  }

  async createWorkflow(organizationId: string, data: {
    name: string;
    description?: string;
    triggerType?: string;
    nodes: any;
    edges: any;
    isActive?: boolean;
  }) {
    const triggerType = this.assertTrigger(data.triggerType);

    return prisma.workflow.create({
      data: {
        organizationId,
        name: data.name,
        description: data.description,
        triggerType,
        nodes: data.nodes ?? [],
        edges: data.edges ?? [],
        // A workflow that cannot run is created inactive rather than pretending to
        // be live. The editor shows `problems` so the operator can fix it.
        isActive: data.isActive !== undefined ? data.isActive : this.isRunnable(data.nodes, data.edges),
      },
    });
  }

  async updateWorkflow(organizationId: string, id: string, data: {
    name?: string;
    description?: string;
    triggerType?: string;
    nodes?: any;
    edges?: any;
    isActive?: boolean;
  }) {
    const existing = await prisma.workflow.findFirst({ where: { id, organizationId } });
    if (!existing) throw new NotFoundException('Workflow not found');

    const triggerType = data.triggerType !== undefined ? this.assertTrigger(data.triggerType) : existing.triggerType;
    const nodes = data.nodes !== undefined ? data.nodes : existing.nodes;
    const edges = data.edges !== undefined ? data.edges : existing.edges;

    // Refuse to ACTIVATE a workflow that cannot run. Saving a draft is fine; going
    // live with unexecutable nodes is the state that produced silent no-ops.
    if (data.isActive === true) {
      const problems = validateGraph(
        (Array.isArray(nodes) ? nodes : []).map(normalizeNode),
        normalizeEdges(edges)
      );
      if (problems.length) {
        throw new BadRequestException(
          `This workflow cannot be activated yet: ${problems.join(' ')}`
        );
      }
    }

    return prisma.workflow.update({
      where: { id },
      data: {
        name: data.name ?? existing.name,
        description: data.description ?? existing.description,
        triggerType,
        nodes,
        edges,
        isActive: data.isActive !== undefined ? data.isActive : existing.isActive,
      },
    });
  }

  async deleteWorkflow(organizationId: string, id: string) {
    const existing = await prisma.workflow.findFirst({ where: { id, organizationId } });
    if (!existing) throw new NotFoundException('Workflow not found');
    return prisma.workflow.delete({ where: { id } });
  }

  /**
   * Runs one workflow immediately against a supplied payload.
   *
   * This is the "Test" button, and it performs REAL actions — the same code path a
   * live trigger takes. It previously returned a count of matching workflows and did
   * nothing, while the UI reported "execution simulated cleanly".
   */
  async executeWorkflowNow(organizationId: string, workflowId: string, payload: Record<string, any>) {
    const workflow = await prisma.workflow.findFirst({ where: { id: workflowId, organizationId } });
    if (!workflow) throw new NotFoundException('Workflow not found');

    const nodes = (Array.isArray(workflow.nodes) ? workflow.nodes : []).map(normalizeNode);
    const problems = validateGraph(nodes, normalizeEdges(workflow.edges));
    if (problems.length) {
      throw new BadRequestException(`This workflow cannot run: ${problems.join(' ')}`);
    }

    const run = await prisma.workflowRun.create({
      data: {
        organizationId,
        workflowId: workflow.id,
        triggerType: normalizeTrigger(workflow.triggerType) ?? workflow.triggerType,
        // Created RUNNING, not QUEUED: this run is executed synchronously below, and
        // a QUEUED row is exactly what the inline sweeper collects.
        status: 'RUNNING',
        startedAt: new Date(),
        payload: { ...payload, organizationId },
        ranInline: true,
      },
    });

    const outcome = await this.runner.runNow(run.id);
    const steps = await prisma.workflowRunStep.findMany({
      where: { runId: run.id },
      orderBy: { startedAt: 'asc' },
    });

    return {
      executed: true,
      runId: run.id,
      status: outcome.pausedUntil ? 'PAUSED' : outcome.status,
      stepsExecuted: outcome.stepsExecuted,
      ...(outcome.pausedUntil ? { resumesAt: outcome.pausedUntil.toISOString() } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      steps: steps.map((s) => ({
        nodeId: s.nodeId,
        kind: s.kind,
        action: s.action,
        status: s.status,
        output: s.output,
        error: s.error,
      })),
    };
  }

  /** Run history for one workflow. */
  async getRuns(organizationId: string, workflowId: string, limit = 25) {
    const workflow = await prisma.workflow.findFirst({ where: { id: workflowId, organizationId }, select: { id: true } });
    if (!workflow) throw new NotFoundException('Workflow not found');

    return prisma.workflowRun.findMany({
      where: { workflowId, organizationId },
      orderBy: { queuedAt: 'desc' },
      take: Math.min(limit, 100),
      include: { steps: { orderBy: { startedAt: 'asc' } } },
    });
  }

  /** Replays a run — used for dead-lettered ones after the cause is fixed. */
  async replayRun(organizationId: string, runId: string) {
    const run = await prisma.workflowRun.findFirst({ where: { id: runId, organizationId } });
    if (!run) throw new NotFoundException('Workflow run not found');

    const replay = await prisma.workflowRun.create({
      data: {
        organizationId,
        workflowId: run.workflowId,
        triggerType: run.triggerType,
        status: 'QUEUED',
        payload: run.payload as any,
      },
    });

    const queued = await this.trigger.requeue(replay.id);
    if (!queued) {
      // RUNNING, not QUEUED — same reason as executeWorkflowNow: a QUEUED row is what
      // the inline sweeper collects, and this one is about to be run synchronously.
      await prisma.workflowRun.update({
        where: { id: replay.id },
        data: { ranInline: true, status: 'RUNNING', startedAt: new Date() },
      });
      const outcome = await this.runner.runNow(replay.id);
      return { runId: replay.id, queued: false, ranInline: true, status: outcome.status };
    }
    return { runId: replay.id, queued: true, ranInline: false, status: 'QUEUED' };
  }

  /** Everything the editor needs to offer real, configurable actions. */
  getCapabilities() {
    return {
      triggers: Array.from(new Set(Object.values(TRIGGER_ALIASES))),
      actions: ACTION_TYPES.map((action) => ({ action, ...ACTION_SCHEMA[action] })),
      operators: ['EQUALS', 'NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS', 'GREATER_THAN', 'LESS_THAN', 'IS_SET', 'IS_EMPTY'],
    };
  }

  private assertTrigger(raw?: string): string {
    const value = raw ?? 'MESSAGE_RECEIVED';
    if (!normalizeTrigger(value)) {
      throw new BadRequestException(
        `Unknown triggerType "${value}". Valid values: ${Object.keys(TRIGGER_ALIASES).join(', ')}.`
      );
    }
    return value;
  }

  private isRunnable(nodes: any, edges: any): boolean {
    return validateGraph((Array.isArray(nodes) ? nodes : []).map(normalizeNode), normalizeEdges(edges)).length === 0;
  }
}

/** Field documentation the editor renders, so config is never guesswork. */
const ACTION_SCHEMA: Record<string, { label: string; fields: Array<{ key: string; label: string; required: boolean; hint?: string }> }> = {
  SEND_WHATSAPP: {
    label: 'Send a WhatsApp message',
    fields: [
      { key: 'to', label: 'Recipient', required: false, hint: 'Defaults to the contact from the trigger. Supports {{ contact.phoneNumber }}.' },
      { key: 'message', label: 'Message', required: true, hint: 'Supports {{ contact.fullName }} and other payload fields.' },
    ],
  },
  CREATE_TICKET: {
    label: 'Create a support ticket',
    fields: [
      { key: 'subject', label: 'Subject', required: true },
      { key: 'description', label: 'Description', required: false },
      { key: 'priority', label: 'Priority', required: false, hint: 'LOW | MEDIUM | HIGH | URGENT' },
      { key: 'contactId', label: 'Contact', required: false, hint: 'Defaults to the contact from the trigger. A ticket must have a contact, so set this explicitly for triggers that carry none.' },
    ],
  },
  UPDATE_LEAD_STATUS: {
    label: 'Update lead status',
    fields: [{ key: 'status', label: 'Status', required: true, hint: 'NEW | CONTACTED | QUALIFIED | UNQUALIFIED | CONVERTED' }],
  },
  UPDATE_DEAL_STAGE: {
    label: 'Update deal stage',
    fields: [{ key: 'stage', label: 'Stage', required: true, hint: 'DISCOVERY | PROPOSAL | NEGOTIATION | CLOSED_WON | CLOSED_LOST' }],
  },
  TAG_CONTACT: {
    label: 'Tag the contact',
    fields: [{ key: 'tags', label: 'Tags', required: true, hint: 'Comma-separated.' }],
  },
  SET_HANDOFF: {
    label: 'Hand the conversation to a human',
    fields: [{ key: 'handoff', label: 'Hand off', required: false, hint: 'Defaults to true. Set false to return it to the AI.' }],
  },
  REQUEST_SELFIE: {
    label: 'Ask the customer for a selfie',
    fields: [
      { key: 'purpose', label: 'Reason shown to the customer', required: false, hint: 'e.g. "account verification". Appears in the message they receive.' },
      { key: 'channel', label: 'Channel', required: false, hint: 'WHATSAPP (default) or VOICE. A voice request always sends a secure upload link, because a call cannot carry an image.' },
      { key: 'expiresInHours', label: 'Link valid for (hours)', required: false, hint: 'Defaults to 24, maximum 72.' },
      { key: 'contactId', label: 'Contact', required: false, hint: 'Defaults to the contact from the trigger.' },
    ],
  },
  HTTP_WEBHOOK: {
    label: 'Call an external webhook',
    fields: [
      { key: 'url', label: 'URL', required: true, hint: 'Must be a public https:// endpoint.' },
      { key: 'method', label: 'Method', required: false, hint: 'Defaults to POST.' },
    ],
  },
};
