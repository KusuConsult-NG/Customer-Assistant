/**
 * Provisioning the ElevenLabs side of a tenant's agent: its tools, its prompt,
 * and the credential the tools authenticate with.
 *
 * The problem this exists to solve is drift. The nine webhook tools live in
 * ElevenLabs' workspace, and their URLs, parameter bindings and auth header all
 * have to agree with the endpoints in this repo. Maintained by hand in a web
 * dashboard, they agree until the first rename — and then a tool posts to a
 * path that no longer exists, mid-conversation, to a customer. `syncAgent`
 * re-derives every definition from agent-tool-catalog.ts and pushes it, so the
 * remote configuration is a function of this repo rather than of whoever last
 * edited the dashboard.
 *
 * ── Three rules the code enforces rather than documents ──────────────────────
 *
 * 1. NEVER SYNC A TOOL SET AT A URL ELEVENLABS CANNOT REACH. A localhost base
 *    URL produces an agent that answers calls and fails every single tool call.
 *    That is worse than an unprovisioned agent, because it looks provisioned.
 *
 * 2. A PARTIAL SYNC IS PERSISTED AS FAR AS IT GOT. Tool ids are written as each
 *    tool succeeds. A sync that dies on tool seven leaves six correct ids
 *    recorded, so the retry updates them instead of creating duplicates and
 *    orphaning the originals.
 *
 * 3. THE AGENT KEY IS NEVER EMBEDDED IN A TOOL. It goes into a workspace secret
 *    and the tools reference it. Our own copy is a SHA-256 hash — deliberately
 *    unrecoverable — so the secret is the only place the live value exists, and
 *    rotation is one update rather than nine.
 *
 * Nothing here is on the live conversation path. `packages/orchestrator` still
 * serves every channel; see CLAUDE.md, "TWO conversation engines exist right
 * now, and only one is live."
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import type { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { Prisma, encryptSecret, isEncrypted, prisma, secretFingerprint } from '@ace/database';
import { ElevenLabsApi } from './elevenlabs-client';
import { AGENT_KEY_PREFIX } from './agent-key.guard';
import {
  agentDefinitionFor,
  agentNameFor,
  agentToolCatalog,
  remoteToolName,
  TOOL_NAMES,
  type AgentOrganization,
  type ToolName,
} from './agent-tool-catalog';
import { fromSecret } from './elevenlabs-contracts';
import {
  sharedWorkspaceAllowed,
  tenantWebhookUrl,
  type WorkspaceMode,
} from './elevenlabs-workspace';

/** One thing a sync did, in the order it did it. */
export interface SyncStep {
  target: string;
  action: 'created' | 'updated' | 'unchanged';
  id?: string;
}

export interface SyncReport {
  organizationId: string;
  agentId: string;
  toolIds: Record<string, string>;
  baseUrl: string;
  steps: SyncStep[];
  /** Printed once and unrecoverable afterwards. Present only when minted. */
  agentKey?: string;
}

export interface AgentStatus {
  configured: boolean;
  agentId: string | null;
  /** Whether the agent still exists in the ElevenLabs workspace. */
  remoteAgentFound: boolean;
  /** Everything that disagrees between this repo and the remote configuration. */
  drift: string[];
  toolCount: number;
  expectedToolCount: number;
}

type ToolIdMap = Partial<Record<ToolName, string>>;

@Injectable()
export class ElevenLabsAgentService {
  private readonly log = new Logger('ElevenLabsAgent');

  constructor(private readonly api: ElevenLabsApi) {}

  // ── Environment ────────────────────────────────────────────────────────────

  /**
   * The base URL ElevenLabs will call our tools at.
   *
   * Preserves the historical API_URL fallback (see CLAUDE.md invariant 4).
   */
  private baseUrl(): string {
    return (process.env.API_BASE_URL || process.env.API_URL || 'http://localhost:4000').replace(
      /\/+$/,
      ''
    );
  }

  /**
   * Refuse to provision against an address ElevenLabs cannot resolve.
   *
   * The failure mode this prevents is quiet: the agent picks up, greets the
   * caller, and then every tool call times out. The transcript shows a working
   * agent that could not answer a single question.
   */
  private assertReachable(baseUrl: string): void {
    const host = (() => {
      try {
        return new URL(baseUrl).hostname;
      } catch {
        throw new BadRequestException(`API_BASE_URL is not a valid URL: ${baseUrl}`);
      }
    })();

    const unreachable =
      host === 'localhost' ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);

    if (unreachable) {
      throw new BadRequestException(
        `API_BASE_URL points at ${host}, which ElevenLabs cannot reach. The agent would answer calls and fail every tool call. Expose the API publicly (or via a tunnel) and set API_BASE_URL before syncing.`
      );
    }
  }

  private client(apiKey: string): ElevenLabsClient {
    return this.api.for(apiKey);
  }

  private fail(what: string, err: unknown): never {
    return this.api.fail(what, err);
  }

  private isNotFound(err: unknown): boolean {
    return this.api.isNotFound(err);
  }

  // ── Tenant state ───────────────────────────────────────────────────────────

  private async tenant(organizationId: string) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        welcomeMessage: true,
        aiPersonaPrompt: true,
      },
    });
    if (!org) throw new NotFoundException('Organization not found.');

    const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId } });
    // Decrypts the tenant's stored key, or falls back to the shared one. See
    // ElevenLabsApi.keyFor — the ciphertext must never reach the SDK.
    const apiKey = this.api.keyFor(organizationId, config?.apiKey);

    return { org: org as AgentOrganization & { id: string }, config, apiKey };
  }

  private storedToolIds(raw: unknown): ToolIdMap {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: ToolIdMap = {};
    for (const name of TOOL_NAMES) {
      const value = (raw as Record<string, unknown>)[name];
      if (typeof value === 'string' && value) out[name] = value;
    }
    return out;
  }

  /**
   * Persist what we know so far.
   *
   * Called after every remote write rather than once at the end: a sync that
   * fails halfway must leave behind the ids it did create, or the retry creates
   * a second copy of each and the first set becomes untracked garbage in the
   * workspace.
   */
  private async persist(
    organizationId: string,
    data: {
      agentId?: string;
      toolIds?: ToolIdMap;
      agentKeySecretId?: string;
    }
  ): Promise<void> {
    await prisma.hostedAgentConfig.upsert({
      where: { organizationId },
      create: {
        organizationId,
        agentId: data.agentId ?? null,
        toolIds: (data.toolIds ?? {}) as any,
        agentKeySecretId: data.agentKeySecretId ?? null,
      },
      update: {
        ...(data.agentId !== undefined ? { agentId: data.agentId } : {}),
        ...(data.toolIds !== undefined ? { toolIds: data.toolIds as any } : {}),
        ...(data.agentKeySecretId !== undefined
          ? { agentKeySecretId: data.agentKeySecretId }
          : {}),
      },
    });
  }

  // ── The agent key, and the secret that holds it ────────────────────────────

  /** Mint an agent key for this org. Returns the plaintext, which is shown once. */
  private async mintAgentKey(organizationId: string): Promise<string> {
    const key = `${AGENT_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.create({
      data: {
        organizationId,
        keyName: 'Hosted agent key',
        keyHash: createHash('sha256').update(key).digest('hex'),
        keyPrefix: key.slice(0, 20),
      },
    });
    return key;
  }

  /**
   * Ensure the workspace holds a secret carrying this tenant's agent key, and
   * return its id.
   *
   * When one already exists it is reused untouched — the stored value is the
   * only live copy, and re-minting on every sync would invalidate a credential
   * that in-flight tool calls are using.
   */
  private async ensureAgentKeySecret(
    client: ElevenLabsClient,
    org: AgentOrganization & { id: string },
    existingSecretId: string | null | undefined
  ): Promise<{ secretId: string; mintedKey?: string; step: SyncStep }> {
    if (existingSecretId) {
      return {
        secretId: existingSecretId,
        step: { target: 'agent key secret', action: 'unchanged', id: existingSecretId },
      };
    }

    const key = await this.mintAgentKey(org.id);
    let secret;
    try {
      secret = await client.conversationalAi.secrets.create({
        name: `ace-agent-key-${org.slug}`,
        // The guard expects a bearer header, so the secret carries the whole
        // header value rather than the bare key.
        value: `Bearer ${key}`,
      });
    } catch (err) {
      this.fail('the agent key secret', err);
    }

    await this.persist(org.id, { agentKeySecretId: secret.secretId });
    return {
      secretId: secret.secretId,
      mintedKey: key,
      step: { target: 'agent key secret', action: 'created', id: secret.secretId },
    };
  }

  /**
   * Replace this tenant's agent key.
   *
   * Order matters and is the whole point: the new key is written into the
   * workspace secret BEFORE the old one is revoked, so there is no window in
   * which the agent's tools authenticate with a credential that no longer
   * works. A call in progress keeps working across the rotation.
   */
  async rotateAgentKey(organizationId: string): Promise<{ agentKey: string }> {
    const { org, config, apiKey } = await this.tenant(organizationId);
    if (!config?.agentKeySecretId) {
      throw new BadRequestException(
        'This organization has no agent key secret yet — run a sync first, which mints one.'
      );
    }

    const client = this.client(apiKey);
    const key = await this.mintAgentKey(org.id);

    try {
      await client.conversationalAi.secrets.update(config.agentKeySecretId, {
        name: `ace-agent-key-${org.slug}`,
        value: `Bearer ${key}`,
      });
    } catch (err) {
      // The new key exists in our database but nothing uses it. Remove it, so a
      // failed rotation does not leave a second valid credential lying around.
      await prisma.apiKey
        .deleteMany({
          where: { organizationId, keyHash: createHash('sha256').update(key).digest('hex') },
        })
        .catch(() => {});
      this.fail('the agent key rotation', err);
    }

    const revoked = await prisma.apiKey.deleteMany({
      where: {
        organizationId,
        keyPrefix: { startsWith: AGENT_KEY_PREFIX },
        keyHash: { not: createHash('sha256').update(key).digest('hex') },
      },
    });
    this.log.log(`agent_key_rotated org=${organizationId} revoked=${revoked.count}`);

    return { agentKey: key };
  }

  // ── The tenant's own workspace credentials ─────────────────────────────────

  /**
   * Store this organization's ElevenLabs workspace key, encrypted.
   *
   * Until a tenant has one, everything here runs against the shared
   * ELEVENLABS_API_KEY workspace, which holds every other tenant's numbers and
   * WhatsApp lines. Setting a per-tenant key is what turns that shared space
   * into a real boundary, so this is a security control rather than a
   * convenience — which is also why there was no way to set it before: it could
   * only be written by hand in SQL, and a credential nobody can rotate without
   * a database console does not get rotated.
   */
  async setWorkspaceKey(
    organizationId: string,
    apiKey: string
  ): Promise<{ configured: true; fingerprint: string }> {
    const key = apiKey?.trim();
    if (!key) throw new BadRequestException('An ElevenLabs API key is required.');

    // Throws when ENCRYPTION_KEY is unset rather than storing plaintext. The
    // caller gets told to set it; nothing is written in the clear.
    const sealed = encryptSecret(key);

    await prisma.hostedAgentConfig.upsert({
      where: { organizationId },
      create: { organizationId, apiKey: sealed },
      update: { apiKey: sealed },
    });

    this.log.log(`workspace_key_stored org=${organizationId}`);
    return { configured: true, fingerprint: secretFingerprint(key) };
  }

  /**
   * Store the signing secret for this organization's OWN workspace webhook.
   *
   * A workspace signs its post-call deliveries with a secret of its own, so a
   * platform with one ELEVENLABS_WEBHOOK_SECRET can only verify deliveries from
   * one workspace. Moving a tenant into its own workspace without this leaves
   * every one of its transcripts arriving with a signature nothing can check —
   * and the only honest response to a signature we cannot check is to reject it,
   * so the transcripts are simply lost.
   *
   * The URL to paste into the ElevenLabs dashboard comes back with it, because
   * the per-tenant path is the other half of the same configuration step and an
   * operator who sets one without the other is no better off.
   */
  async setWebhookSecret(
    organizationId: string,
    webhookSecret: string
  ): Promise<{ configured: true; fingerprint: string; webhookUrl: string }> {
    const secret = webhookSecret?.trim();
    if (!secret) throw new BadRequestException('An ElevenLabs webhook signing secret is required.');

    const sealed = encryptSecret(secret);

    await prisma.hostedAgentConfig.upsert({
      where: { organizationId },
      create: { organizationId, webhookSecret: sealed },
      update: { webhookSecret: sealed },
    });

    this.log.log(`workspace_webhook_secret_stored org=${organizationId}`);
    return {
      configured: true,
      fingerprint: secretFingerprint(secret),
      webhookUrl: tenantWebhookUrl(organizationId),
    };
  }

  /**
   * Which workspace this tenant is operating in, and what is still missing.
   *
   * Never returns a credential — only a fingerprint, which is enough to tell two
   * keys apart and useless to anyone who steals it. There is no
   * read-back-the-secret endpoint at all; an operator who has lost the key gets
   * a new one from ElevenLabs.
   *
   * `warnings` exists because "configured" is not the same as "working". A
   * tenant with its own API key but no webhook secret looks fully set up in
   * every listing and silently drops every transcript, and that half-migrated
   * state is the one this whole change makes possible.
   */
  async getWorkspaceKeyStatus(organizationId: string): Promise<{
    mode: WorkspaceMode;
    configured: boolean;
    fingerprint: string | null;
    encryptedAtRest: boolean;
    usingSharedWorkspace: boolean;
    sharedWorkspaceAllowed: boolean;
    webhookSecretConfigured: boolean;
    webhookUrl: string;
    warnings: string[];
  }> {
    const config = await prisma.hostedAgentConfig.findUnique({
      where: { organizationId },
      select: { apiKey: true, webhookSecret: true },
    });

    const sharedAllowed = sharedWorkspaceAllowed();
    const webhookSecretConfigured = Boolean(config?.webhookSecret);
    const webhookUrl = tenantWebhookUrl(organizationId);
    const warnings: string[] = [];

    if (!config?.apiKey) {
      // Stated plainly: with no tenant key, this organization shares a
      // workspace with every other tenant — or, when sharing is not permitted,
      // cannot act at all.
      const sharedKeyPresent = Boolean(process.env.ELEVENLABS_API_KEY);
      warnings.push(
        sharedKeyPresent && sharedAllowed
          ? 'This organization has no ElevenLabs key of its own and is running in the shared workspace, alongside every other tenant’s numbers, WhatsApp lines and transcripts.'
          : 'This organization has no ElevenLabs key of its own, so agent provisioning, numbers and live conversations will all be refused until one is set.'
      );
      return {
        mode: 'shared',
        configured: false,
        fingerprint: null,
        encryptedAtRest: false,
        usingSharedWorkspace: sharedKeyPresent && sharedAllowed,
        sharedWorkspaceAllowed: sharedAllowed,
        webhookSecretConfigured,
        webhookUrl,
        warnings,
      };
    }

    const encryptedAtRest = isEncrypted(config.apiKey);
    let fingerprint: string | null = null;
    try {
      fingerprint = secretFingerprint(
        this.api.keyFor(organizationId, config.apiKey)
      );
    } catch {
      // An unreadable key is still worth reporting as configured — silently
      // saying "not configured" would send someone to store a second one.
      fingerprint = null;
      warnings.push(
        'The stored key cannot be decrypted with the current ENCRYPTION_KEY. Every ElevenLabs call for this organization will fail until the right key is restored or a new workspace key is stored.'
      );
    }

    if (!webhookSecretConfigured) {
      warnings.push(
        `This organization has its own workspace but no webhook signing secret, so its post-call transcripts cannot be verified and will be rejected. Set one, and point the workspace's post-call webhook at ${webhookUrl}.`
      );
    }

    return {
      mode: 'dedicated',
      configured: true,
      fingerprint,
      encryptedAtRest,
      usingSharedWorkspace: false,
      sharedWorkspaceAllowed: sharedAllowed,
      webhookSecretConfigured,
      webhookUrl,
      warnings,
    };
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  /**
   * Bring the ElevenLabs side into line with this repo, creating whatever is
   * missing and updating whatever exists. Safe to run repeatedly.
   */
  /**
   * Delete the agent and build it again from the catalogue.
   *
   * The LAST resort for drift, and it exists because the gentler route can
   * fail silently. An agent created before tools were first-class carries
   * inline `prompt.tools`; a sync sends an empty list to clear them, and when
   * the workspace does not clear them there is nothing further the API can
   * do — the stale definitions keep the URL and auth they were created with,
   * lack every tool added since, and the agent goes on calling them.
   *
   * WHAT THIS COSTS, and why it is not the default:
   *
   *  - The AGENT ID CHANGES. Anything holding the old one stops matching —
   *    an imported phone number, an attached WhatsApp line, and post-call
   *    webhooks, which identify the tenant by agent id alone.
   *  - A conversation in progress on the old agent ends with it.
   *
   * So the attachments are READ FIRST and restored afterwards, and what could
   * not be restored is named rather than left for the operator to discover.
   * `confirmReplacesAgent` is required and never defaulted, exactly as the
   * voice cutover is.
   */
  async recreateAgent(
    organizationId: string,
    opts: { confirmReplacesAgent?: boolean } = {}
  ): Promise<{
    previousAgentId: string | null;
    agentId: string | null;
    deleted: boolean;
    detail: string;
    restored: string[];
    manualFollowUp: string[];
    sync: SyncReport | null;
  }> {
    if (opts.confirmReplacesAgent !== true) {
      throw new BadRequestException(
        'Recreating replaces the agent and CHANGES ITS ID, so an imported number, an ' +
        'attached WhatsApp line and post-call webhook attribution all stop matching until ' +
        'they are re-pointed. Pass confirmReplacesAgent: true to proceed.'
      );
    }

    const { config, apiKey } = await this.tenant(organizationId);
    const previousAgentId = config?.agentId ?? null;
    if (!previousAgentId) {
      throw new BadRequestException('No agent is provisioned for this agency, so there is nothing to replace.');
    }

    // Read the attachments BEFORE anything is destroyed. Afterwards the ids
    // that referenced the old agent are the only record that they existed.
    const previousWhatsAppId = config?.whatsappPhoneNumberId ?? null;
    const previousPhoneNumberId = config?.phoneNumberId ?? null;

    const client = this.client(apiKey);
    let deleted = false;
    let detail: string;
    try {
      await client.conversationalAi.agents.delete(previousAgentId);
      deleted = true;
      detail = `Deleted agent ${previousAgentId}.`;
    } catch (err: any) {
      // An agent already gone is not a failure — the end state is the same,
      // and refusing here would leave a tenant unable to recover from a
      // deletion made in the dashboard.
      const message = err?.message ?? String(err);
      if (/not.?found|404/i.test(message)) {
        deleted = true;
        detail = `Agent ${previousAgentId} was already absent in the workspace.`;
      } else {
        throw new BadRequestException(`ElevenLabs refused to delete the agent: ${message}`);
      }
    }

    // Clear OUR record before rebuilding, so a sync creates rather than
    // trying to update an id that no longer exists.
    await prisma.hostedAgentConfig.update({
      where: { organizationId },
      data: { agentId: null, toolIds: Prisma.DbNull, phoneNumberId: null },
    });

    const sync = await this.syncAgent(organizationId);

    const restored: string[] = [];
    const manualFollowUp: string[] = [];

    if (previousWhatsAppId) {
      // The LINE still exists in the workspace — only the agent assigned to
      // it was replaced — so re-assigning is a configuration change, not a
      // reconnection.
      try {
        await client.conversationalAi.whatsappAccounts.update(previousWhatsAppId, {
          agentId: sync.agentId,
        } as any);
        restored.push(`WhatsApp line ${previousWhatsAppId} re-assigned to the new agent.`);
      } catch (err: any) {
        manualFollowUp.push(
          `WhatsApp line ${previousWhatsAppId} could NOT be re-assigned (${err?.message ?? err}). ` +
          'Re-attach it with POST /api/agent-provisioning/whatsapp/attach, or it will answer with the deleted agent.'
        );
      }
    }

    if (previousPhoneNumberId) {
      // Not re-imported automatically: importing a number IS the voice
      // cutover, and doing it unasked as a side effect of a repair is
      // exactly the kind of silent decision confirmVoiceCutover exists to
      // prevent.
      manualFollowUp.push(
        `The imported phone number (${previousPhoneNumberId}) no longer points at an agent. ` +
        'Re-import it with POST /api/agent-provisioning/numbers/import and confirmVoiceCutover: true.'
      );
    }

    return {
      previousAgentId,
      agentId: sync.agentId ?? null,
      deleted,
      detail,
      restored,
      manualFollowUp,
      sync,
    };
  }

  async syncAgent(organizationId: string): Promise<SyncReport> {
    const { org, config, apiKey } = await this.tenant(organizationId);
    const baseUrl = this.baseUrl();
    this.assertReachable(baseUrl);

    const client = this.client(apiKey);
    const steps: SyncStep[] = [];

    const secret = await this.ensureAgentKeySecret(client, org, config?.agentKeySecretId);
    steps.push(secret.step);

    // ── Tools ────────────────────────────────────────────────────────────────
    const catalog = agentToolCatalog({
      baseUrl,
      authorization: fromSecret(secret.secretId),
      namePrefix: org.slug,
    });
    const toolIds: ToolIdMap = this.storedToolIds(config?.toolIds);

    for (const name of TOOL_NAMES) {
      const definition = catalog[name];
      const existingId = toolIds[name];

      if (existingId) {
        try {
          await client.conversationalAi.tools.update(existingId, definition);
          steps.push({ target: `tool ${name}`, action: 'updated', id: existingId });
          continue;
        } catch (err) {
          if (!this.isNotFound(err)) this.fail(`tool ${name}`, err);
          // Deleted in the dashboard. Fall through and create it again rather
          // than leaving the agent pointing at an id that resolves to nothing.
          this.log.warn(`tool_missing_recreating org=${organizationId} tool=${name}`);
        }
      }

      let created;
      try {
        created = await client.conversationalAi.tools.create(definition);
      } catch (err) {
        this.fail(`tool ${name}`, err);
      }
      toolIds[name] = created.id;
      // Persisted immediately: see rule 2 at the top of this file.
      await this.persist(organizationId, { toolIds });
      steps.push({ target: `tool ${name}`, action: 'created', id: created.id });
    }

    await this.persist(organizationId, { toolIds });

    // ── Agent ────────────────────────────────────────────────────────────────
    const orderedIds = TOOL_NAMES.map((name) => toolIds[name]).filter(
      (id): id is string => Boolean(id)
    );
    const definition = agentDefinitionFor(org, orderedIds);

    let agentId = config?.agentId ?? null;
    if (agentId) {
      try {
        // ── Clear a deprecated inline `prompt.tools` while we are here ─────
        //
        // This platform never writes definitions into `prompt.tools`, but an
        // agent provisioned before that still carries them, and the update
        // MERGES — so they survived every sync, and the remedy on the console
        // was a dashboard errand. They matter: inline definitions are a
        // snapshot that gains no tool added since and keeps whatever URL and
        // auth it was created with, so an agent holding both can answer a
        // citizen from a definition nobody has updated.
        //
        // An empty array is an instruction to remove them, sent alongside the
        // real tool ids so clearing the copy cannot take the tools with it.
        // Whether the workspace honours it is NOT assumed: `getAgentStatus`
        // re-reads and still reports inline tools if any remain.
        const hasInlineTools = await this.remoteHasInlineTools(client, agentId);
        const payload = hasInlineTools
          ? agentDefinitionFor(org, orderedIds, undefined, { clearInlineTools: true })
          : definition;

        await client.conversationalAi.agents.update(agentId, {
          name: payload.name,
          conversationConfig: payload.conversationConfig as any,
        });
        steps.push({ target: 'agent', action: 'updated', id: agentId });
        if (hasInlineTools) {
          this.log.log(`agent_inline_tools_clear_attempted org=${organizationId} agent=${agentId}`);
        }
      } catch (err) {
        if (!this.isNotFound(err)) this.fail('the agent', err);
        this.log.warn(`agent_missing_recreating org=${organizationId} agent=${agentId}`);
        agentId = null;
      }
    }

    if (!agentId) {
      let created;
      try {
        created = await client.conversationalAi.agents.create({
          name: definition.name,
          conversationConfig: definition.conversationConfig as any,
        });
      } catch (err) {
        this.fail('the agent', err);
      }
      agentId = created.agentId;
      steps.push({ target: 'agent', action: 'created', id: agentId });
    }

    await this.persist(organizationId, { agentId, toolIds });
    this.log.log(
      `agent_synced org=${organizationId} agent=${agentId} tools=${orderedIds.length}`
    );

    return {
      organizationId,
      agentId,
      toolIds: toolIds as Record<string, string>,
      baseUrl,
      steps,
      ...(secret.mintedKey ? { agentKey: secret.mintedKey } : {}),
    };
  }

  /**
   * Does the remote agent still carry deprecated inline `prompt.tools`?
   *
   * Read before the update so the sync only sends the clearing payload when
   * there is something to clear — and so a workspace that cannot be read does
   * not turn into a silent no-op.
   */
  private async remoteHasInlineTools(client: any, agentId: string): Promise<boolean> {
    try {
      const agent = await client.conversationalAi.agents.get(agentId);
      const tools: any[] = (agent?.conversationConfig as any)?.agent?.prompt?.tools ?? [];
      // ElevenLabs echoes tool_ids-referenced tools back inside prompt.tools on
      // GET responses, but those echoed entries carry no URL — they are live
      // references, not stale snapshots. Only flag entries that bake in their
      // own URL (the hallmark of old inline definitions).
      return tools.some((t) => Boolean(t?.api?.url));
    } catch {
      // A read failure is not evidence of anything. The ordinary payload is
      // sent and the status check reports whatever is really there.
      return false;
    }
  }

  /**
   * Provision a tenant's agent for the first time.
   *
   * Refuses when one already exists. Creating a second agent would leave the
   * number pointed at the first, so the operator would be editing a copy that
   * no customer ever reaches — and every change would appear to do nothing.
   */
  async createAgent(organizationId: string): Promise<SyncReport> {
    const config = await prisma.hostedAgentConfig.findUnique({
      where: { organizationId },
      select: { agentId: true },
    });
    if (config?.agentId) {
      throw new BadRequestException(
        `This organization already has agent ${config.agentId}. Use sync to update it.`
      );
    }
    return this.syncAgent(organizationId);
  }

  /** Push the current prompt, greeting, timezone and tool set to an existing agent. */
  async updateAgent(organizationId: string): Promise<SyncReport> {
    const config = await prisma.hostedAgentConfig.findUnique({
      where: { organizationId },
      select: { agentId: true },
    });
    if (!config?.agentId) {
      throw new BadRequestException(
        'This organization has no provisioned agent yet — create one first.'
      );
    }
    return this.syncAgent(organizationId);
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  /**
   * Read-only comparison of the remote configuration against this repo.
   *
   * Writes nothing. The point is to be able to answer "is the thing customers
   * are talking to the thing we think it is?" without changing it first —
   * because a sync that silently repairs drift also destroys the evidence of
   * how the drift happened.
   */
  async getAgentStatus(organizationId: string): Promise<AgentStatus> {
    const { org, config, apiKey } = await this.tenant(organizationId);
    const baseUrl = this.baseUrl();
    const drift: string[] = [];

    if (!config?.agentId) {
      return {
        configured: false,
        agentId: null,
        remoteAgentFound: false,
        drift: ['No agent has been provisioned for this organization.'],
        toolCount: 0,
        expectedToolCount: TOOL_NAMES.length,
      };
    }

    const client = this.client(apiKey);
    let agent;
    try {
      agent = await client.conversationalAi.agents.get(config.agentId);
    } catch (err) {
      if (this.isNotFound(err)) {
        return {
          configured: true,
          agentId: config.agentId,
          remoteAgentFound: false,
          drift: [
            `Agent ${config.agentId} no longer exists in the ElevenLabs workspace. Anything pointed at it is answering nothing.`,
          ],
          toolCount: 0,
          expectedToolCount: TOOL_NAMES.length,
        };
      }
      this.fail('the agent status', err);
    }

    const prompt: any = (agent.conversationConfig as any)?.agent?.prompt ?? {};
    const remoteToolIds: string[] = Array.isArray(prompt.toolIds) ? prompt.toolIds : [];
    const stored = this.storedToolIds(config.toolIds);

    if (agent.name !== agentNameFor(org)) {
      drift.push(`Agent is named "${agent.name}"; this repo would name it "${agentNameFor(org)}".`);
    }

    // The timezone is what lets the agent resolve "next Tuesday". Wrong means
    // bookings on the wrong day; absent means invented ones.
    if (!prompt.timezone) {
      drift.push(
        'Agent has no timezone set — it does not know what day it is and will invent dates for relative bookings.'
      );
    } else if (prompt.timezone !== org.timezone) {
      drift.push(
        `Agent timezone is ${prompt.timezone}; this organization is ${org.timezone}. Relative dates resolve to the wrong day.`
      );
    }

    // ElevenLabs echoes tool_ids-referenced tools back inside prompt.tools on
    // GET responses, but those echoed entries carry no URL — they are live
    // references, not stale snapshots. Only flag entries that bake in their
    // own URL (the hallmark of old inline definitions created before tool_ids).
    const staleInlineTools = Array.isArray(prompt.tools)
      ? (prompt.tools as any[]).filter((t) => Boolean(t?.api?.url))
      : [];
    if (staleInlineTools.length > 0) {
      drift.push(
        'Agent still carries inline `prompt.tools` (' + staleInlineTools.length + '), which is ' +
        'deprecated. A sync sends an empty list to clear them; if this is still reported after ' +
        'one, the workspace did not clear them. Those inline definitions are a stale snapshot: ' +
        'they lack every tool added since, and keep the URL and auth they were created with. ' +
        'Remove them on the agent in the ElevenLabs dashboard, or delete the agent and sync ' +
        'again to recreate it cleanly.'
      );
    }

    for (const name of TOOL_NAMES) {
      const id = stored[name];
      if (!id) {
        drift.push(`Tool "${name}" has never been created.`);
        continue;
      }
      if (!remoteToolIds.includes(id)) {
        drift.push(`Tool "${name}" (${id}) is not attached to the agent.`);
      }
    }

    const untracked = remoteToolIds.filter((id) => !Object.values(stored).includes(id));
    if (untracked.length > 0) {
      drift.push(
        `Agent has ${untracked.length} tool(s) this platform did not create: ${untracked.join(', ')}. They can call anything.`
      );
    }

    // The catalogue this platform would publish, for comparing what is really
    // out there against it. The authorization is a placeholder: nothing here
    // writes, and the secret id is not part of what is compared.
    const expectedCatalog = agentToolCatalog({
      baseUrl,
      authorization: fromSecret(config.agentKeySecretId ?? 'unknown'),
      namePrefix: org.slug,
    });

    // The URL check is the one that catches a rename. Fetch each tracked tool
    // and compare where it actually posts against where it should.
    for (const name of TOOL_NAMES) {
      const id = stored[name];
      if (!id) continue;
      try {
        const tool = await client.conversationalAi.tools.get(id);
        const cfg: any = tool.toolConfig;
        const expectedUrl = `${baseUrl}/api/agent-tools/${name}`;
        if (cfg?.apiSchema?.url && cfg.apiSchema.url !== expectedUrl) {
          drift.push(
            `Tool "${name}" posts to ${cfg.apiSchema.url}; this repo serves it at ${expectedUrl}.`
          );
        }
        const expectedName = remoteToolName(name, org.slug);
        if (cfg?.name && cfg.name !== expectedName) {
          drift.push(`Tool ${id} is named "${cfg.name}"; expected "${expectedName}".`);
        }

        // ── The parameters, which nothing compared ────────────────────────
        //
        // Adding a parameter changes neither the tool COUNT nor its URL, so an
        // agent provisioned before the change looked perfectly healthy while
        // being unable to send the new field. `reference` on cancel-booking is
        // the case that exposed it: a citizen with two appointments is asked
        // which one they mean, and an un-synced agent has no way to answer —
        // the caller loops, and the console says the agent is fine.
        //
        // Unlike inline `prompt.tools`, this one IS fixed by a sync, because a
        // tool update is exactly what the sync writes.
        const remoteParams = Object.keys(cfg?.apiSchema?.requestBodySchema?.properties ?? {});
        if (remoteParams.length) {
          const expectedParams = Object.keys(
            (expectedCatalog[name] as any)?.toolConfig?.apiSchema?.requestBodySchema?.properties ??
              {}
          );
          const missing = expectedParams.filter((p) => !remoteParams.includes(p));
          const extra = remoteParams.filter((p) => !expectedParams.includes(p));
          if (missing.length || extra.length) {
            drift.push(
              `Tool "${name}" takes different parameters from this platform's catalogue` +
              (missing.length ? ` — missing ${missing.join(', ')}` : '') +
              (extra.length ? ` — unexpected ${extra.join(', ')}` : '') +
              '. Run a sync to update it.'
            );
          }
        }
      } catch (err) {
        if (this.isNotFound(err)) {
          drift.push(`Tool "${name}" (${id}) has been deleted from the workspace.`);
          continue;
        }
        this.fail(`tool ${name}`, err);
      }
    }

    return {
      configured: true,
      agentId: config.agentId,
      remoteAgentFound: true,
      drift,
      toolCount: remoteToolIds.length,
      expectedToolCount: TOOL_NAMES.length,
    };
  }
}
