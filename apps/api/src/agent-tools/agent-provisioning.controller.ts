/**
 * Staff-facing provisioning for a tenant's hosted agent.
 *
 * Distinct from AgentToolsController in both direction and audience: that one
 * is called BY the agent and authenticated with an agent key; this one is
 * called by a signed-in operator in the dashboard and authenticated with a JWT.
 * They share a module because they share the tenant's configuration, and
 * nothing else.
 *
 * The organization always comes from the token, never from the body — an
 * operator can only ever provision their own tenant's agent.
 */
import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';
import { AgentStatus, ElevenLabsAgentService, SyncReport } from './elevenlabs-agent.service';

// RolesGuard must follow JwtAuthGuard — it reads request.user.
@Controller('api/agent-provisioning')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentProvisioningController {
  constructor(private readonly agents: ElevenLabsAgentService) {}

  /**
   * What the agent customers reach actually looks like, compared to this repo.
   *
   * Readable by any signed-in user: knowing whether the agent has drifted is
   * not a privileged action, and the answer is exactly what a support person
   * needs when a customer says the AI gave them a wrong date.
   */
  @Get('status')
  status(@Req() req: { user: AuthUser }): Promise<AgentStatus> {
    return this.agents.getAgentStatus(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('sync')
  sync(@Req() req: { user: AuthUser }): Promise<SyncReport> {
    return this.agents.syncAgent(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('create')
  create(@Req() req: { user: AuthUser }): Promise<SyncReport> {
    return this.agents.createAgent(req.user.organizationId);
  }

  /**
   * Replace the credential the agent's tools authenticate with.
   *
   * The response carries the new key once. It is stored only as a hash here and
   * lives on in the ElevenLabs workspace secret, so nothing can show it again.
   */
  @Roles('OWNER', 'ADMIN')
  @Post('rotate-key')
  rotateKey(@Req() req: { user: AuthUser }): Promise<{ agentKey: string }> {
    return this.agents.rotateAgentKey(req.user.organizationId);
  }
}
