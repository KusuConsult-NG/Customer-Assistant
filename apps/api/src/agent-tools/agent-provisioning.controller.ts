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
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';
import { AgentStatus, ElevenLabsAgentService, SyncReport } from './elevenlabs-agent.service';
import {
  ElevenLabsNumbersService,
  ImportedNumber,
  WhatsAppAccount,
} from './elevenlabs-numbers.service';

// RolesGuard must follow JwtAuthGuard — it reads request.user.
@Controller('api/agent-provisioning')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentProvisioningController {
  constructor(
    private readonly agents: ElevenLabsAgentService,
    private readonly numbers: ElevenLabsNumbersService
  ) {}

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

  // ── Workspace credentials ──────────────────────────────────────────────────

  /**
   * Whether this organization has its own ElevenLabs workspace key, and whether
   * it is encrypted at rest. Never returns the key itself.
   */
  @Get('credentials')
  credentials(@Req() req: { user: AuthUser }) {
    return this.agents.getWorkspaceKeyStatus(req.user.organizationId);
  }

  /**
   * Store this organization's own workspace key.
   *
   * Without one, the tenant runs in the shared ELEVENLABS_API_KEY workspace
   * alongside everyone else's numbers and WhatsApp lines. Setting it is the
   * only thing that makes that boundary real.
   */
  @Roles('OWNER', 'ADMIN')
  @Post('credentials')
  setCredentials(@Req() req: { user: AuthUser }, @Body() body: { apiKey: string }) {
    return this.agents.setWorkspaceKey(req.user.organizationId, body?.apiKey ?? '');
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

  // ── Phone numbers ──────────────────────────────────────────────────────────

  @Get('numbers')
  numbersList(@Req() req: { user: AuthUser }): Promise<ImportedNumber[]> {
    return this.numbers.listNumbers(req.user.organizationId);
  }

  /**
   * Hand the tenant's Twilio number to ElevenLabs.
   *
   * `confirmVoiceCutover` is required and deliberately not defaulted: after
   * this, the agent answers the number instead of the orchestrator. That is a
   * change in who talks to customers.
   */
  @Roles('OWNER', 'ADMIN')
  @Post('numbers/import')
  importNumber(
    @Req() req: { user: AuthUser },
    @Body() body: { confirmVoiceCutover?: boolean; enableSms?: boolean; label?: string }
  ): Promise<ImportedNumber> {
    return this.numbers.importTwilioNumber(req.user.organizationId, {
      confirmVoiceCutover: body?.confirmVoiceCutover === true,
      enableSms: body?.enableSms,
      label: body?.label,
    });
  }

  @Roles('OWNER', 'ADMIN')
  @Post('numbers/release')
  releaseNumber(@Req() req: { user: AuthUser }): Promise<{ released: boolean; note: string }> {
    return this.numbers.releaseNumber(req.user.organizationId);
  }

  // ── WhatsApp ───────────────────────────────────────────────────────────────

  @Get('whatsapp')
  whatsappList(@Req() req: { user: AuthUser }): Promise<WhatsAppAccount[]> {
    return this.numbers.listWhatsAppAccounts(req.user.organizationId);
  }

  /**
   * Point an already-connected WhatsApp line at this organization's agent.
   *
   * Connecting the line itself happens in the ElevenLabs dashboard — Meta's
   * embedded signup needs a human, so there is no endpoint that can do it.
   */
  @Roles('OWNER', 'ADMIN')
  @Post('whatsapp/attach')
  attachWhatsApp(
    @Req() req: { user: AuthUser },
    @Body() body: { phoneNumberId: string }
  ): Promise<WhatsAppAccount> {
    return this.numbers.attachWhatsAppAccount(req.user.organizationId, body?.phoneNumberId ?? '');
  }

  @Roles('OWNER', 'ADMIN')
  @Post('whatsapp/detach')
  detachWhatsApp(@Req() req: { user: AuthUser }): Promise<{ detached: boolean }> {
    return this.numbers.detachWhatsAppAccount(req.user.organizationId);
  }
}
