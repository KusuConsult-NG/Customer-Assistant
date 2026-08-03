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

  async executeWorkflowTrigger(organizationId: string, triggerType: string, payload: any) {
    const activeWorkflows = await prisma.workflow.findMany({
      where: { organizationId, triggerType, isActive: true },
    });

    log.info('executing_workflow_trigger', { organizationId, triggerType, count: activeWorkflows.length });

    return {
      triggeredCount: activeWorkflows.length,
      workflowsExecuted: activeWorkflows.map(w => w.name),
      timestamp: new Date().toISOString(),
    };
  }
}
