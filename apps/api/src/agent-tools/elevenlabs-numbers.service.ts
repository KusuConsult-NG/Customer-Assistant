/**
 * Connecting a tenant's real phone number and WhatsApp line to their agent.
 *
 * ── The two halves are not symmetrical, and pretending otherwise would lie ───
 *
 * A TWILIO NUMBER CAN BE IMPORTED over the API: we hold the tenant's account
 * SID and auth token in TelephonyConfig, and ElevenLabs takes both.
 *
 * A WHATSAPP ACCOUNT CANNOT. The SDK has get, list, update and delete — and no
 * create. The connection is made through ElevenLabs' dashboard, which runs
 * Meta's embedded signup: an interactive OAuth flow with a human in it, not
 * something a server can perform on a tenant's behalf. So this service does not
 * offer an `importWhatsApp` that quietly cannot create anything. It lists what
 * the workspace already has, attaches our agent to one, and says plainly that
 * the connection itself happens elsewhere.
 *
 * ── Importing a number IS the voice cutover ─────────────────────────────────
 *
 * ElevenLabs is given the tenant's Twilio credentials so it can answer that
 * number itself. From that point the orchestrator's media-stream path
 * (TwilioMediaStreamHandler) is no longer what picks up — the agent is. That is
 * a change in who talks to customers, so it is not a side effect of a setup
 * button: `confirmVoiceCutover` has to be passed explicitly, and `releaseNumber`
 * exists so the decision is reversible. A cutover nobody can undo is a cutover
 * nobody will risk.
 *
 * ── One workspace, many tenants ─────────────────────────────────────────────
 *
 * When a tenant has its own `HostedAgentConfig.apiKey` the workspace is theirs
 * and a listing shows only their numbers. When they fall back to the shared
 * ELEVENLABS_API_KEY, a raw listing shows EVERY tenant's numbers and WhatsApp
 * lines — and an attach call with someone else's id would hand their WhatsApp
 * traffic to this tenant's agent. Every listing here is therefore filtered to
 * what this tenant may see, and attaching something already assigned to another
 * agent is refused. Per-tenant workspace keys remain the real fix; this is the
 * floor, not the ceiling.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { prisma, withTelephonyCredentials } from '@ace/database';
import { ElevenLabsApi } from './elevenlabs-client';

export interface ImportedNumber {
  phoneNumberId: string;
  phoneNumber: string;
  label: string;
  assignedAgentId: string | null;
  /** True when the agent assigned is this organization's. */
  isOurs: boolean;
}

export interface WhatsAppAccount {
  phoneNumberId: string;
  phoneNumber: string;
  phoneNumberName: string;
  businessAccountName: string;
  assignedAgentId: string | null;
  isOurs: boolean;
  /** Meta's token has expired — WhatsApp has stopped working, quietly. */
  isTokenExpired: boolean;
}

@Injectable()
export class ElevenLabsNumbersService {
  private readonly log = new Logger('ElevenLabsNumbers');

  constructor(private readonly api: ElevenLabsApi) {}

  /**
   * The tenant's ElevenLabs credentials and provisioned agent.
   *
   * Every operation here attaches a real phone line to an agent, so an
   * unprovisioned agent is a hard stop rather than something to create on the
   * way past: importing a number against a null agent id produces a live number
   * that answers with nothing.
   */
  private async tenant(organizationId: string) {
    const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId } });
    // Decrypts the tenant's stored key, or falls back to the shared one.
    const apiKey = this.api.keyFor(organizationId, config?.apiKey);
    if (!config?.agentId) {
      throw new BadRequestException(
        'This organization has no provisioned agent yet. Sync one first — a number pointed at no agent rings and answers with nothing.'
      );
    }
    return { config, apiKey, agentId: config.agentId };
  }

  // ── Twilio numbers ─────────────────────────────────────────────────────────

  /**
   * Hand a tenant's Twilio number to ElevenLabs so the agent answers it.
   *
   * Idempotent: a number already imported is re-pointed at the current agent
   * rather than imported again. Two ElevenLabs records for one Twilio number is
   * a coin flip over which configuration wins.
   */
  async importTwilioNumber(
    organizationId: string,
    opts: { confirmVoiceCutover: boolean; enableSms?: boolean; label?: string }
  ): Promise<ImportedNumber> {
    const { config, apiKey, agentId } = await this.tenant(organizationId);

    if (!opts.confirmVoiceCutover) {
      throw new BadRequestException(
        'Importing this number moves its calls from the orchestrator to the ElevenLabs agent. Confirm the cutover explicitly (confirmVoiceCutover) — this is a change in who talks to your customers, not a settings tweak.'
      );
    }

    // Decrypted here: these credentials are handed to ElevenLabs so it can
    // answer the number, and a ciphertext would be rejected as a bad Twilio
    // token — an error pointing at the tenant's Twilio account, not at us.
    const telephony = withTelephonyCredentials(
      await prisma.telephonyConfig.findFirst({
        where: { organizationId, provider: 'TWILIO' },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      })
    );
    if (!telephony) {
      throw new NotFoundException('No Twilio configuration exists for this organization.');
    }
    // Named individually so the operator learns which field to go and fill in,
    // rather than "credentials incomplete".
    const missing = [
      !telephony.accountSid && 'account SID',
      !telephony.authToken && 'auth token',
      !telephony.phoneNumber && 'phone number',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new BadRequestException(
        `The Twilio configuration is missing its ${missing.join(' and ')}. ElevenLabs needs all of them to answer the number.`
      );
    }

    const client = this.api.for(apiKey);
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    const label = opts.label?.trim() || `${org?.name ?? 'Customer Care'} — main line`;

    // Already imported: re-point it rather than creating a second record.
    if (config.phoneNumberId) {
      try {
        await client.conversationalAi.phoneNumbers.update(config.phoneNumberId, {
          agentId,
          label,
        });
        this.log.log(`number_reassigned org=${organizationId} number=${config.phoneNumberId}`);
        return this.describeNumber(await this.fetchNumber(client, config.phoneNumberId), agentId);
      } catch (err) {
        if (!this.api.isNotFound(err)) this.api.fail('the phone number', err);
        // Deleted in the dashboard. Fall through and import it again.
        this.log.warn(`number_missing_reimporting org=${organizationId}`);
      }
    }

    let created;
    try {
      created = await client.conversationalAi.phoneNumbers.create({
        provider: 'twilio',
        phoneNumber: telephony.phoneNumber,
        label,
        sid: telephony.accountSid!,
        token: telephony.authToken!,
        agentId,
        // Defaults to true upstream, which would also route the number's inbound
        // SMS to ElevenLabs. This platform does not consume inbound SMS, so
        // enabling it silently changes a tenant's Twilio configuration for no
        // benefit they asked for. Opt in, don't opt out.
        enableSms: opts.enableSms ?? false,
      });
    } catch (err) {
      this.api.fail('the phone number import', err);
    }

    await prisma.hostedAgentConfig.update({
      where: { organizationId },
      data: { phoneNumberId: created.phoneNumberId },
    });
    this.log.log(
      `number_imported org=${organizationId} number=${created.phoneNumberId} agent=${agentId}`
    );

    return {
      phoneNumberId: created.phoneNumberId,
      phoneNumber: telephony.phoneNumber,
      label,
      assignedAgentId: agentId,
      isOurs: true,
    };
  }

  private async fetchNumber(client: any, phoneNumberId: string) {
    try {
      return await client.conversationalAi.phoneNumbers.get(phoneNumberId);
    } catch (err) {
      this.api.fail('the phone number', err);
    }
  }

  private describeNumber(raw: any, ourAgentId: string): ImportedNumber {
    const assigned = raw?.assignedAgent?.agentId ?? null;
    return {
      phoneNumberId: raw.phoneNumberId,
      phoneNumber: raw.phoneNumber,
      label: raw.label,
      assignedAgentId: assigned,
      isOurs: assigned === ourAgentId,
    };
  }

  /**
   * The numbers this organization may see.
   *
   * Filtered to numbers assigned to this tenant's agent. In a shared workspace
   * an unfiltered listing is one tenant reading another's phone numbers.
   */
  async listNumbers(organizationId: string): Promise<ImportedNumber[]> {
    const { apiKey, agentId } = await this.tenant(organizationId);
    const client = this.api.for(apiKey);

    let numbers;
    try {
      numbers = await client.conversationalAi.phoneNumbers.list();
    } catch (err) {
      this.api.fail('the phone number list', err);
    }

    return (numbers as any[])
      .map((n) => this.describeNumber(n, agentId))
      .filter((n) => n.isOurs);
  }

  /**
   * Give the number back: ElevenLabs stops answering it.
   *
   * This is what makes the cutover a decision rather than a commitment. Note
   * that it removes the number from ElevenLabs — restoring the orchestrator
   * path also means re-pointing the number's voice webhook in Twilio, which
   * this cannot do on the tenant's behalf.
   */
  async releaseNumber(organizationId: string): Promise<{ released: boolean; note: string }> {
    const { config, apiKey } = await this.tenant(organizationId);
    if (!config.phoneNumberId) {
      throw new BadRequestException('No number has been imported for this organization.');
    }

    const client = this.api.for(apiKey);
    try {
      await client.conversationalAi.phoneNumbers.delete(config.phoneNumberId);
    } catch (err) {
      // Already gone upstream is the state we wanted, so clear our record and
      // say so rather than failing on a no-op.
      if (!this.api.isNotFound(err)) this.api.fail('the phone number release', err);
    }

    await prisma.hostedAgentConfig.update({
      where: { organizationId },
      data: { phoneNumberId: null },
    });
    this.log.log(`number_released org=${organizationId} number=${config.phoneNumberId}`);

    return {
      released: true,
      note: 'ElevenLabs no longer answers this number. Re-point its voice webhook in the Twilio console to route calls back to this platform.',
    };
  }

  // ── WhatsApp ───────────────────────────────────────────────────────────────

  private describeWhatsApp(raw: any, ourAgentId: string): WhatsAppAccount {
    const assigned = raw.assignedAgentId ?? null;
    return {
      phoneNumberId: raw.phoneNumberId,
      phoneNumber: raw.phoneNumber,
      phoneNumberName: raw.phoneNumberName,
      businessAccountName: raw.businessAccountName,
      assignedAgentId: assigned,
      isOurs: assigned === ourAgentId,
      isTokenExpired: Boolean(raw.isTokenExpired),
    };
  }

  /**
   * WhatsApp lines this organization may attach to, or has attached.
   *
   * Shows this tenant's own accounts plus any that are unassigned — someone has
   * to be first to claim a newly connected line. Accounts belonging to another
   * agent are not listed at all: in a shared workspace, listing them is both a
   * leak and an invitation to take one.
   */
  async listWhatsAppAccounts(organizationId: string): Promise<WhatsAppAccount[]> {
    const { apiKey, agentId } = await this.tenant(organizationId);
    const client = this.api.for(apiKey);

    let response;
    try {
      response = await client.conversationalAi.whatsappAccounts.list();
    } catch (err) {
      this.api.fail('the WhatsApp account list', err);
    }

    return (response.items ?? [])
      .map((a: any) => this.describeWhatsApp(a, agentId))
      .filter((a: WhatsAppAccount) => a.isOurs || a.assignedAgentId === null);
  }

  /**
   * Point an already-connected WhatsApp line at this organization's agent.
   *
   * The line itself is connected in the ElevenLabs dashboard through Meta's
   * embedded signup — there is no API for that, and this method will not
   * pretend there is. What it does is assign the agent and record the id the
   * outbound service needs.
   */
  async attachWhatsAppAccount(
    organizationId: string,
    phoneNumberId: string
  ): Promise<WhatsAppAccount> {
    const { apiKey, agentId } = await this.tenant(organizationId);
    if (!phoneNumberId?.trim()) {
      throw new BadRequestException('A WhatsApp phone number id is required.');
    }
    const client = this.api.for(apiKey);

    let account;
    try {
      account = await client.conversationalAi.whatsappAccounts.get(phoneNumberId);
    } catch (err) {
      if (this.api.isNotFound(err)) {
        throw new NotFoundException(
          `No WhatsApp account ${phoneNumberId} exists in this workspace. Connect the line in the ElevenLabs dashboard first — Meta's signup flow needs a human, so it cannot be done from here.`
        );
      }
      this.api.fail('the WhatsApp account', err);
    }

    const assigned = account.assignedAgentId ?? null;
    if (assigned && assigned !== agentId) {
      // Taking it would silently redirect another tenant's WhatsApp traffic to
      // this tenant's agent — their customers, answered by someone else's
      // configuration, with no signal that anything changed.
      throw new BadRequestException(
        `That WhatsApp line is already assigned to agent ${assigned}. Reassigning it would move another tenant's conversations onto this agent, so it has to be released deliberately first.`
      );
    }

    if (account.isTokenExpired) {
      // Assigning it would look like success and then answer nothing.
      throw new BadRequestException(
        "That WhatsApp line's Meta access token has expired, so it cannot send or receive. Reconnect it in the ElevenLabs dashboard before attaching an agent."
      );
    }

    try {
      await client.conversationalAi.whatsappAccounts.update(phoneNumberId, {
        assignedAgentId: agentId,
        enableMessaging: true,
      });
    } catch (err) {
      this.api.fail('the WhatsApp account assignment', err);
    }

    await prisma.hostedAgentConfig.update({
      where: { organizationId },
      data: { whatsappPhoneNumberId: phoneNumberId },
    });
    this.log.log(`whatsapp_attached org=${organizationId} number=${phoneNumberId} agent=${agentId}`);

    return { ...this.describeWhatsApp(account, agentId), assignedAgentId: agentId, isOurs: true };
  }

  /** Stop the agent answering this WhatsApp line. The line itself stays connected. */
  async detachWhatsAppAccount(organizationId: string): Promise<{ detached: boolean }> {
    const { config, apiKey, agentId } = await this.tenant(organizationId);
    if (!config.whatsappPhoneNumberId) {
      throw new BadRequestException('No WhatsApp line is attached to this organization.');
    }

    const client = this.api.for(apiKey);
    try {
      await client.conversationalAi.whatsappAccounts.update(config.whatsappPhoneNumberId, {
        enableMessaging: false,
      });
    } catch (err) {
      if (!this.api.isNotFound(err)) this.api.fail('the WhatsApp account detachment', err);
    }

    await prisma.hostedAgentConfig.update({
      where: { organizationId },
      data: { whatsappPhoneNumberId: null },
    });
    this.log.log(`whatsapp_detached org=${organizationId} agent=${agentId}`);
    return { detached: true };
  }
}
