import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { WorkflowsService } from './workflows.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionGuard } from '../common/guards/subscription.guard';
import { AuthUser } from '@ace/shared-types';

@Controller('api/workflows')
@UseGuards(JwtAuthGuard, SubscriptionGuard)
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get()
  async getWorkflows(@Req() req: { user: AuthUser }) {
    return this.workflowsService.getWorkflows(req.user.organizationId);
  }

  @Get(':id')
  async getWorkflowById(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.workflowsService.getWorkflowById(req.user.organizationId, id);
  }

  @Post()
  async createWorkflow(
    @Req() req: { user: AuthUser },
    @Body() body: {
      name: string;
      description?: string;
      triggerType?: string;
      nodes: any;
      edges: any;
      isActive?: boolean;
    }
  ) {
    if (!body.name) throw new BadRequestException('Workflow name is required');
    return this.workflowsService.createWorkflow(req.user.organizationId, body);
  }

  @Patch(':id')
  async updateWorkflow(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      description?: string;
      triggerType?: string;
      nodes?: any;
      edges?: any;
      isActive?: boolean;
    }
  ) {
    return this.workflowsService.updateWorkflow(req.user.organizationId, id, body);
  }

  @Delete(':id')
  async deleteWorkflow(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.workflowsService.deleteWorkflow(req.user.organizationId, id);
  }

  @Post(':id/execute')
  async executeWorkflow(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { triggerType?: string; payload?: any }
  ) {
    return this.workflowsService.executeWorkflowTrigger(
      req.user.organizationId,
      body.triggerType || 'WHATSAPP_INBOUND',
      body.payload || {}
    );
  }
}
