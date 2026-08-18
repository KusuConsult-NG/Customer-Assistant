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
import { prisma } from '@ace/database';
import { ElevenLabsApi } from './elevenlabs-client';
import { encryptSecret, isEncrypted, secretFingerprint } from '../common/secret-box';
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
   * Whether a tenant key is set, and enough of it to tell two apart.
   *
   * Never returns the credential. There is no read-back-the-secret endpoint at
   * all — an operator who has lost the key gets a new one from ElevenLabs.
   */
  async getWorkspaceKeyStatus(organizationId: string): Promise<{
    configured: boolean;
    fingerprint: string | null;
    encryptedAtRest: boolean;
    usingSharedWorkspace: boolean;
  }> {
    const config = await prisma.hostedAgentConfig.findUnique({
      where: { organizationId },
      select: { apiKey: true },
    });

    if (!config?.apiKey) {
      return {
        configured: false,
        fingerprint: null,
        encryptedAtRest: false,
        // Stated plainly: with no tenant key, this organization shares a
        // workspace with every other tenant.
        usingSharedWorkspace: Boolean(process.env.ELEVENLABS_API_KEY),
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
    }

    return { configured: true, fingerprint, encryptedAtRest, usingSharedWorkspace: false };
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  /**
   * Bring the ElevenLabs side into line with this repo, creating whatever is
   * missing and updating whatever exists. Safe to run repeatedly.
   */
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
        await client.conversationalAi.agents.update(agentId, {
          name: definition.name,
          conversationConfig: definition.conversationConfig as any,
        });
        steps.push({ target: 'agent', action: 'updated', id: agentId });
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

    if (Array.isArray(prompt.tools) && prompt.tools.length > 0) {
      drift.push(
        'Agent still carries inline `prompt.tools`, which is deprecated. Sync to move it onto tool ids.'
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
