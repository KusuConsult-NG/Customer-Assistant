import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { WorkflowsService } from './workflows.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SubscriptionGuard } from '../common/guards/subscription.guard';
import { AuthUser } from '@ace/shared-types';

// RolesGuard must follow JwtAuthGuard — it reads request.user.
@Controller('api/workflows')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  /**
   * Action and trigger catalogue for the editor.
   *
   * Declared before `:id` so the literal segment wins the route match.
   */
  @Get('capabilities')
  getCapabilities() {
    return this.workflowsService.getCapabilities();
  }

  @Get()
  async getWorkflows(@Req() req: { user: AuthUser }) {
    return this.workflowsService.getWorkflows(req.user.organizationId);
  }

  @Get(':id/runs')
  async getRuns(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Query('limit') limit?: string
  ) {
    return this.workflowsService.getRuns(req.user.organizationId, id, parseInt(limit ?? '25', 10) || 25);
  }

  @Get(':id')
  async getWorkflowById(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.workflowsService.getWorkflowById(req.user.organizationId, id);
  }

  @Roles('OWNER', 'ADMIN')
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
    if (!body.name?.trim()) throw new BadRequestException('Workflow name is required');
    return this.workflowsService.createWorkflow(req.user.organizationId, body);
  }

  @Roles('OWNER', 'ADMIN')
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

  @Roles('OWNER', 'ADMIN')
  @Delete(':id')
  async deleteWorkflow(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.workflowsService.deleteWorkflow(req.user.organizationId, id);
  }

  /**
   * Runs the workflow now, against the supplied payload.
   *
   * This performs REAL actions — it sends the message, creates the ticket, calls the
   * webhook. Restricted to OWNER/ADMIN for that reason.
   */
  @Roles('OWNER', 'ADMIN')
  @Post(':id/execute')
  async executeWorkflow(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { payload?: Record<string, any> }
  ) {
    return this.workflowsService.executeWorkflowNow(req.user.organizationId, id, body?.payload ?? {});
  }

  /** Replays a run — typically a dead-lettered one, after fixing the cause. */
  @Roles('OWNER', 'ADMIN')
  @Post('runs/:runId/replay')
  async replayRun(@Req() req: { user: AuthUser }, @Param('runId') runId: string) {
    return this.workflowsService.replayRun(req.user.organizationId, runId);
  }
}
