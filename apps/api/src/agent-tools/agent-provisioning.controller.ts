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
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
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
import { ElevenLabsLiveService, LiveConversation } from './elevenlabs-live.service';
import { ElevenLabsTakeoverService, TakeoverOutcome } from './elevenlabs-takeover.service';

// RolesGuard must follow JwtAuthGuard — it reads request.user.
@Controller('api/agent-provisioning')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentProvisioningController {
  constructor(
    private readonly agents: ElevenLabsAgentService,
    private readonly numbers: ElevenLabsNumbersService,
    private readonly liveConversations: ElevenLabsLiveService,
    private readonly takeover: ElevenLabsTakeoverService
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
   * Which ElevenLabs workspace this organization is in, and what is still
   * missing from it. Never returns a credential — only fingerprints.
   */
  @Get('credentials')
  credentials(@Req() req: { user: AuthUser }) {
    return this.agents.getWorkspaceKeyStatus(req.user.organizationId);
  }

  /**
   * Store this organization's own workspace credentials.
   *
   * A dedicated workspace needs BOTH halves, and they can be set in either
   * order or together: the API key is what makes the tenancy boundary real
   * (without it the tenant shares a workspace with everyone else's numbers and
   * WhatsApp lines), and the webhook secret is what lets that workspace's
   * post-call transcripts be verified once it does. Setting only the key leaves
   * a tenant whose calls are private and whose transcripts are dropped, which is
   * why the status endpoint warns about exactly that.
   */
  @Roles('OWNER', 'ADMIN')
  @Post('credentials')
  async setCredentials(
    @Req() req: { user: AuthUser },
    @Body() body: { apiKey?: string; webhookSecret?: string }
  ) {
    const organizationId = req.user.organizationId;
    const apiKey = body?.apiKey?.trim();
    const webhookSecret = body?.webhookSecret?.trim();

    if (!apiKey && !webhookSecret) {
      throw new BadRequestException(
        'Provide an apiKey, a webhookSecret, or both. A dedicated ElevenLabs workspace needs each: the key to act in it, the secret to verify what it sends back.'
      );
    }

    if (apiKey) await this.agents.setWorkspaceKey(organizationId, apiKey);
    if (webhookSecret) await this.agents.setWebhookSecret(organizationId, webhookSecret);

    // The full status rather than a bare acknowledgement, so a caller that set
    // one half is told immediately that the other is still missing.
    return this.agents.getWorkspaceKeyStatus(organizationId);
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

  // ── Live conversations ─────────────────────────────────────────────────────

  /**
   * What the agent is saying right now.
   *
   * The console also receives these over the `/events` socket every few
   * seconds, but a page that has just loaded should not sit blank for a poll
   * interval. Readable by any signed-in user: watching live conversations is
   * the console's whole purpose, not a privileged action.
   */
  @Get('live')
  live(@Req() req: { user: AuthUser }): Promise<LiveConversation[]> {
    return this.liveConversations.fetchLive(req.user.organizationId);
  }

  /**
   * Take a live call away from the agent and put it through to a person.
   *
   * Any signed-in user, not just an admin: the people watching the console are
   * the ones who need to rescue a call going wrong, and requiring an admin
   * means the customer waits for one.
   *
   * Returns `{ taken: false, reason }` for the cases a working system still
   * hits — a call that ended while the operator was reaching for the button, a
   * WhatsApp thread that cannot be taken over. Those are answers, not errors.
   */
  @Post('live/:conversationId/takeover')
  takeOver(
    @Req() req: { user: AuthUser },
    @Param('conversationId') conversationId: string
  ): Promise<TakeoverOutcome> {
    return this.takeover.takeOverConversation(req.user.organizationId, conversationId);
  }

  /**
   * Stop the agent answering the whole WhatsApp line.
   *
   * Not a takeover, and named so it cannot be mistaken for one — it silences
   * the agent for every customer on that number.
   */
  @Roles('OWNER', 'ADMIN')
  @Post('whatsapp/pause')
  pauseWhatsApp(
    @Req() req: { user: AuthUser },
    @Body() body: { paused?: boolean; confirmAffectsEveryConversation?: boolean }
  ): Promise<{ paused: boolean; note: string }> {
    return this.takeover.setWhatsAppLinePaused(
      req.user.organizationId,
      body?.paused !== false,
      body?.confirmAffectsEveryConversation === true
    );
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
