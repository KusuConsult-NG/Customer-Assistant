import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { AceLogger } from '../config/logger';

const log = new AceLogger('WorkflowsService');

@Injectable()
export class WorkflowsService {
  async getWorkflows(organizationId: string) {
    return prisma.workflow.findMany({
      where: { organizationId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getWorkflowById(organizationId: string, id: string) {
    return prisma.workflow.findFirst({
      where: { id, organizationId },
    });
  }

  async createWorkflow(organizationId: string, data: {
    name: string;
    description?: string;
    triggerType?: string;
    nodes: any;
    edges: any;
    isActive?: boolean;
  }) {
    return prisma.workflow.create({
      data: {
        organizationId,
        name: data.name,
        description: data.description,
        triggerType: data.triggerType || 'WHATSAPP_INBOUND',
        nodes: data.nodes ? (data.nodes as any) : [],
        edges: data.edges ? (data.edges as any) : [],
        isActive: data.isActive !== undefined ? data.isActive : true,
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
    const existing = await prisma.workflow.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new Error('Workflow not found');

    return prisma.workflow.update({
      where: { id },
      data: {
        name: data.name ?? existing.name,
        description: data.description ?? existing.description,
        triggerType: data.triggerType ?? existing.triggerType,
        nodes: data.nodes ? (data.nodes as any) : (existing.nodes as any),
        edges: data.edges ? (data.edges as any) : (existing.edges as any),
        isActive: data.isActive !== undefined ? data.isActive : existing.isActive,
      },
    });
  }

  async deleteWorkflow(organizationId: string, id: string) {
    const existing = await prisma.workflow.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new Error('Workflow not found');

    return prisma.workflow.delete({ where: { id } });
  }

  /**
   * Evaluates which workflows a trigger MATCHES. It does not run their actions.
   *
   * There is no action executor in this codebase: nothing sends the WhatsApp
   * message, creates the task, moves the deal stage or calls the webhook that a
   * workflow's nodes describe. There is also no queue, no retry policy and no
   * dead-letter handling.
   *
   * The response used to be `{ triggeredCount, workflowsExecuted: [names] }`, which
   * reads as confirmation that those workflows ran — an operator watching the
   * dashboard would conclude their automation was working. The shape below says what
   * actually happened. `executed: false` is deliberate and load-bearing: the
   * dashboard should surface it rather than rendering a success state.
   *
   * Implementing execution means: an action dispatcher per node type, a BullMQ queue
   * with retry/backoff, a WorkflowRun table for execution history, and a
   * dead-letter path. Until then this endpoint is a dry run.
   */
  async executeWorkflowTrigger(organizationId: string, triggerType: string, payload: any) {
    const activeWorkflows = await prisma.workflow.findMany({
      where: { organizationId, triggerType, isActive: true },
    });

    log.warn('workflow_trigger_matched_but_not_executed', {
      organizationId,
      triggerType,
      matched: activeWorkflows.length,
      reason: 'No action executor is implemented — matching only.',
    });

    return {
      executed: false,
      notice:
        'Workflows were matched but their actions were NOT run. This build has no ' +
        'workflow action executor — no message is sent and no record is changed.',
      matchedCount: activeWorkflows.length,
      matchedWorkflows: activeWorkflows.map((w) => ({ id: w.id, name: w.name })),
      // Retained so existing callers do not break, but it now reports matches.
      triggeredCount: activeWorkflows.length,
      timestamp: new Date().toISOString(),
    };
  }
}
