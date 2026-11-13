/**
 * Provisioning a tenant's ElevenLabs agent.
 *
 * These run the real SDK against a stubbed transport, which is deliberate: the
 * SDK converts camelCase to the wire's snake_case, and the single most
 * important field in the whole configuration — the binding that stops the model
 * supplying the caller's phone number — only survives that conversion if it was
 * written in the SDK's casing. Asserting on the bytes that would leave the
 * process is the only way to see that.
 *
 * The rest of the suite is about failure. Provisioning is a multi-step remote
 * operation with no transaction around it, so what matters is what a
 * half-finished run leaves behind:
 *
 *   - a sync that dies mid-way must leave the ids it did create recorded, or
 *     the retry creates a second copy of every tool and orphans the first
 *   - a sync at an address ElevenLabs cannot reach must not happen at all: the
 *     result answers calls and fails every tool call, which looks provisioned
 *   - a failed key rotation must not leave a second valid credential behind
 */

import { Test } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { ElevenLabsAgentService } from '../src/agent-tools/elevenlabs-agent.service';
import { TOOL_NAMES } from '../src/agent-tools/agent-tool-catalog';
import { AGENT_KEY_PREFIX } from '../src/agent-tools/agent-key.guard';
import { ElevenLabsApi } from '../src/agent-tools/elevenlabs-client';

interface Captured {
  url: string;
  method: string;
  body: any;
  /** The credential actually presented to ElevenLabs. */
  apiKey?: string;
}

describe('ElevenLabs agent provisioning', () => {
  let service: ElevenLabsAgentService;
  let orgId: string;
  let slug: string;
  let sent: Captured[];

  const realFetch = global.fetch;
  const realBaseUrl = process.env.API_BASE_URL;
  const realApiUrl = process.env.API_URL;
  const realElevenBase = process.env.ELEVENLABS_BASE_URL;
  const realElevenKey = process.env.ELEVENLABS_API_KEY;
  const realSharedFlag = process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE;

  const PUBLIC_URL = 'https://api.example.test';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ElevenLabsAgentService, ElevenLabsApi],
    }).compile();
    service = moduleRef.get(ElevenLabsAgentService);

    slug = `agentsync-${randomBytes(4).toString('hex')}`;
    const org = await prisma.organization.create({
      data: { name: 'Sync Test Clinic', slug, industry: 'OTHER', timezone: 'Africa/Lagos' },
    });
    orgId = org.id;

    process.env.ELEVENLABS_BASE_URL = 'https://elevenlabs.test';
    process.env.ELEVENLABS_API_KEY = 'xi-test-key';
    // These tenants deliberately have no workspace key of their own, so every
    // call here runs through the shared-workspace fallback. That fallback is
    // refused unless a deployment has opted in — see elevenlabs-workspace.ts —
    // so the opt-in is set here rather than the tests quietly proving that a
    // security refusal does not fire.
    process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE = '1';
    process.env.API_BASE_URL = PUBLIC_URL;
    delete process.env.API_URL;
  }, 60_000);

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    global.fetch = realFetch;
    if (realBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = realBaseUrl;
    if (realApiUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = realApiUrl;
    if (realElevenBase === undefined) delete process.env.ELEVENLABS_BASE_URL;
    else process.env.ELEVENLABS_BASE_URL = realElevenBase;
    if (realSharedFlag === undefined) delete process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE;
    else process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE = realSharedFlag;
    if (realElevenKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = realElevenKey;
  });

  beforeEach(async () => {
    sent = [];
    process.env.API_BASE_URL = PUBLIC_URL;
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.apiKey.deleteMany({ where: { organizationId: orgId } });
  });

  /**
   * A stub workspace. `overrides` lets a test make one specific request fail
   * without having to reimplement the rest.
   */
  const stubWorkspace = (
    overrides: (req: Captured) => { status: number; body: any } | undefined = () => undefined
  ) => {
    let toolSeq = 0;

    global.fetch = (async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(init.body) : undefined;
      const headers = new Headers(init?.headers ?? {});
      const req: Captured = {
        url,
        method,
        body,
        apiKey: headers.get('xi-api-key') ?? undefined,
      };
      sent.push(req);

      const override = overrides(req);
      if (override) {
        return new Response(JSON.stringify(override.body), { status: override.status });
      }

      const path = new URL(url).pathname;
      const reply = (status: number, payload: any) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (path === '/v1/convai/secrets' && method === 'POST') {
        return reply(200, { type: 'stored', secret_id: 'secret_1', name: body?.name });
      }
      if (path.startsWith('/v1/convai/secrets/') && method === 'PATCH') {
        return reply(200, { type: 'stored', secret_id: 'secret_1', name: body?.name });
      }
      if (path === '/v1/convai/tools' && method === 'POST') {
        return reply(200, toolResponse(`tool_${++toolSeq}`, body?.tool_config));
      }
      if (path.startsWith('/v1/convai/tools/') && method === 'PATCH') {
        return reply(200, toolResponse(path.split('/').pop()!, body?.tool_config));
      }
      if (path.startsWith('/v1/convai/tools/') && method === 'GET') {
        return reply(200, toolResponse(path.split('/').pop()!, undefined));
      }
      if (path === '/v1/convai/agents/create' && method === 'POST') {
        return reply(200, { agent_id: 'agent_1' });
      }
      if (path.startsWith('/v1/convai/agents/') && method === 'PATCH') {
        return reply(200, agentResponse(path.split('/').pop()!));
      }
      if (path.startsWith('/v1/convai/agents/') && method === 'GET') {
        return reply(200, agentResponse(path.split('/').pop()!));
      }
      return reply(404, { detail: `stub has no route for ${method} ${path}` });
    }) as any;
  };

  const toolResponse = (id: string, toolConfig: any) => ({
    id,
    tool_config: toolConfig ?? {
      type: 'webhook',
      name: 'stub',
      description: 'stub',
      api_schema: { url: `${PUBLIC_URL}/api/agent-tools/handoff`, method: 'POST' },
    },
    access_info: { is_creator: true, creator_name: 't', creator_email: 't@t.test', role: 'admin' },
    usage_stats: { avg_latency_secs: 0, total_calls: 0 },
  });

  const agentResponse = (agentId: string, prompt: any = {}) => ({
    agent_id: agentId,
    name: 'Sync Test Clinic — Customer Care',
    conversation_config: {
      agent: {
        prompt: {
          prompt: 'stub',
          timezone: 'Africa/Lagos',
          tool_ids: TOOL_NAMES.map((_, i) => `tool_${i + 1}`),
          ...prompt,
        },
      },
    },
    // The SDK validates responses against its schemas, so a stub that omits a
    // required field fails as a transport error rather than a bad assertion.
    metadata: { created_at_unix_secs: 0, updated_at_unix_secs: 0 },
  });

  const posts = (pathFragment: string) =>
    sent.filter((r) => r.method === 'POST' && r.url.includes(pathFragment));

  // ── Reachability ───────────────────────────────────────────────────────────

  describe('refusing to provision something unreachable', () => {
    it.each(['http://localhost:4000', 'http://127.0.0.1:4000', 'http://192.168.1.10:4000'])(
      'refuses to sync tools pointed at %s',
      async (base) => {
        process.env.API_BASE_URL = base;
        stubWorkspace();

        await expect(service.syncAgent(orgId)).rejects.toThrow(/cannot reach/i);
        // The point is that nothing was provisioned. An agent whose tools all
        // fail is worse than no agent, because it looks like one.
        expect(sent).toHaveLength(0);
      }
    );
  });

  // ── A first sync ───────────────────────────────────────────────────────────

  describe('the first sync', () => {
    it('creates a secret, every tool, and the agent, and records the ids', async () => {
      stubWorkspace();

      const report = await service.syncAgent(orgId);

      expect(posts('/v1/convai/secrets')).toHaveLength(1);
      expect(posts('/v1/convai/tools')).toHaveLength(TOOL_NAMES.length);
      expect(posts('/v1/convai/agents/create')).toHaveLength(1);
      expect(report.agentId).toBe('agent_1');
      expect(Object.keys(report.toolIds).sort()).toEqual([...TOOL_NAMES].sort());

      const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: orgId } });
      expect(config?.agentId).toBe('agent_1');
      expect(config?.agentKeySecretId).toBe('secret_1');
      expect(Object.keys(config?.toolIds as object)).toHaveLength(TOOL_NAMES.length);
    });

    it('attaches every tool it created to the agent, by id', async () => {
      stubWorkspace();
      const report = await service.syncAgent(orgId);

      const create = posts('/v1/convai/agents/create')[0];
      const toolIds = create.body.conversation_config.agent.prompt.tool_ids;
      expect(toolIds.sort()).toEqual(Object.values(report.toolIds).sort());
      // Deprecated in favour of tool_ids. Sending both is how an agent ends up
      // with a tool set nobody is looking at.
      expect(create.body.conversation_config.agent.prompt.tools).toBeUndefined();
    });

    it('tells the agent what day it is', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);

      const create = posts('/v1/convai/agents/create')[0];
      // Without this the agent resolves "next Tuesday" against nothing and
      // book-appointment writes an invented date into a real calendar.
      expect(create.body.conversation_config.agent.prompt.timezone).toBe('Africa/Lagos');
    });

    it('binds the caller phone number on the wire, in snake_case', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);

      const checkBooking = posts('/v1/convai/tools').find((r) =>
        r.body.tool_config.api_schema.url.endsWith('/check-booking')
      );
      const phone = checkBooking!.body.tool_config.api_schema.request_body_schema.properties
        .phoneNumber;

      // The SDK does the casing conversion. Written as `dynamic_variable` by
      // hand it would have been dropped in transit, and the model would supply
      // the number — which is cancel-booking acting on a stranger's appointment.
      expect(phone.dynamic_variable).toBe('system__caller_id');
      expect(phone.description).toBeUndefined();
    });

    it('never puts the agent key inside a tool definition', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);

      const secretPost = posts('/v1/convai/secrets')[0];
      expect(secretPost.body.value).toMatch(new RegExp(`^Bearer ${AGENT_KEY_PREFIX}`));

      for (const req of posts('/v1/convai/tools')) {
        const serialized = JSON.stringify(req.body);
        // A literal key here is visible to everyone with workspace access, and
        // rotating it means rewriting all nine tools.
        expect(serialized).not.toContain(AGENT_KEY_PREFIX);
        expect(req.body.tool_config.api_schema.request_headers.Authorization).toEqual({
          secret_id: 'secret_1',
        });
      }
    });

    it('stores the minted key only as a hash', async () => {
      stubWorkspace();
      const report = await service.syncAgent(orgId);

      expect(report.agentKey).toMatch(new RegExp(`^${AGENT_KEY_PREFIX}`));
      const keys = await prisma.apiKey.findMany({ where: { organizationId: orgId } });
      expect(keys).toHaveLength(1);
      expect(keys[0].keyHash).not.toContain(report.agentKey!);
    });
  });

  // ── Partial failure ────────────────────────────────────────────────────────

  describe('a sync that does not finish', () => {
    it('keeps the ids of the tools it did create', async () => {
      let created = 0;
      stubWorkspace((req) => {
        if (req.method === 'POST' && req.url.endsWith('/v1/convai/tools')) {
          created += 1;
          if (created > 3) return { status: 500, body: { detail: 'workspace on fire' } };
        }
        return undefined;
      });

      await expect(service.syncAgent(orgId)).rejects.toThrow(/ElevenLabs/i);

      const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: orgId } });
      // Three ids recorded. Without this the retry creates a second copy of
      // each and the first three become untracked tools in the workspace.
      expect(Object.keys((config?.toolIds as object) ?? {})).toHaveLength(3);
      expect(config?.agentId).toBeNull();
    }, 30_000);

    it('updates what it already made rather than creating it twice', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);

      sent = [];
      await service.syncAgent(orgId);

      expect(posts('/v1/convai/tools')).toHaveLength(0);
      expect(sent.filter((r) => r.method === 'PATCH' && r.url.includes('/tools/'))).toHaveLength(
        TOOL_NAMES.length
      );
      expect(posts('/v1/convai/agents/create')).toHaveLength(0);
      expect(posts('/v1/convai/secrets')).toHaveLength(0);
    });

    /**
     * fd15a41 raised the tool timeout from 10 to 25 seconds and rewrote the
     * prompt. Neither reaches a call until a sync sends it: the tools and the
     * agent live in the workspace, not in this API. So this asserts on what a
     * RE-sync puts on the wire — every existing tool updated with 25, and the
     * agent given the new prompt and the agency's own first message.
     */
    it('a re-sync sends the 25-second timeout to every existing tool, and the new prompt and greeting', async () => {
      const greeting =
        'Hello! Welcome to the Sync Test Clinic. My name is Nanpan — how are you doing today?';
      await prisma.organization.update({ where: { id: orgId }, data: { welcomeMessage: greeting } });
      try {
        stubWorkspace();
        await service.syncAgent(orgId);

        sent = [];
        await service.syncAgent(orgId);

        const toolUpdates = sent.filter((r) => r.method === 'PATCH' && r.url.includes('/v1/convai/tools/'));
        expect(toolUpdates).toHaveLength(TOOL_NAMES.length);
        for (const update of toolUpdates) {
          expect(update.body?.tool_config?.response_timeout_secs).toBe(25);
        }

        const agentUpdate = sent.find((r) => r.method === 'PATCH' && r.url.includes('/v1/convai/agents/'));
        expect(agentUpdate).toBeDefined();
        const agentConfig = agentUpdate!.body?.conversation_config?.agent;
        expect(agentConfig?.first_message).toBe(greeting);
        expect(agentConfig?.prompt?.prompt).toContain('## Step 1 of Every Call');
        expect(agentConfig?.prompt?.prompt).toContain('DO NOT SKIP THE 5 QUESTIONS');
      } finally {
        await prisma.organization.update({ where: { id: orgId }, data: { welcomeMessage: null } });
      }
    });

    /**
     * Recognising a returning caller must not depend on the model choosing to
     * call lookup-customer. The sync points ElevenLabs at our conversation-start
     * webhook — authenticated with the same agent-key secret as the tools — and
     * allows its reply to replace the first message. Asserted on create AND on
     * a re-sync, because the agent in production already exists and only a
     * re-sync will reach it.
     */
    it('turns on the conversation-start webhook, with the agent key, on create and on every re-sync', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);
      const created = sent.find((r) => r.method === 'POST' && r.url.includes('/v1/convai/agents/create'));

      sent = [];
      await service.syncAgent(orgId);
      const updated = sent.find((r) => r.method === 'PATCH' && r.url.includes('/v1/convai/agents/'));

      for (const [which, req] of Object.entries({ created, updated })) {
        const platform = req?.body?.platform_settings;
        expect({ which, enabled: platform?.overrides?.enable_conversation_initiation_client_data_from_webhook }).toEqual({
          which,
          enabled: true,
        });
        expect(platform?.overrides?.conversation_config_override?.agent?.first_message).toBe(true);
        const hook = platform?.workspace_overrides?.conversation_initiation_client_data_webhook;
        expect(hook?.url).toBe(`${PUBLIC_URL}/api/agent-tools/conversation-start`);
        // The secret, never the key itself.
        expect(hook?.request_headers?.Authorization).toEqual({ secret_id: 'secret_1' });
        expect(JSON.stringify(req?.body)).not.toContain(AGENT_KEY_PREFIX);
        // And the defaults a conversation without the webhook falls back to.
        expect(req?.body?.conversation_config?.agent?.dynamic_variables?.dynamic_variable_placeholders?.caller_status).toBe(
          'unknown'
        );
      }
    });

    it('reuses the existing key rather than minting one on every sync', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);
      const second = await service.syncAgent(orgId);

      // Re-minting would invalidate the credential a call in progress is using.
      expect(second.agentKey).toBeUndefined();
      expect(await prisma.apiKey.count({ where: { organizationId: orgId } })).toBe(1);
    });

    it('recreates a tool that was deleted from the workspace', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);
      const before = await prisma.hostedAgentConfig.findUnique({
        where: { organizationId: orgId },
      });
      const goneId = (before!.toolIds as any)['handoff'];

      sent = [];
      stubWorkspace((req) => {
        if (req.method === 'PATCH' && req.url.endsWith(`/tools/${goneId}`)) {
          return { status: 404, body: { detail: 'not found' } };
        }
        return undefined;
      });
      await service.syncAgent(orgId);

      // Left alone, the agent would keep an id that resolves to nothing — the
      // handoff tool silently missing, so the agent cannot reach a person.
      expect(posts('/v1/convai/tools')).toHaveLength(1);
      const after = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: orgId } });
      expect((after!.toolIds as any)['handoff']).not.toBe(goneId);
    });
  });

  // ── create vs sync ─────────────────────────────────────────────────────────

  describe('createAgent', () => {
    it('refuses when the organization already has one', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);

      // A second agent would leave the phone number pointed at the first, so
      // every subsequent edit would appear to do nothing.
      await expect(service.createAgent(orgId)).rejects.toThrow(/already has agent/i);
    });

    it('refuses updateAgent before anything is provisioned', async () => {
      await expect(service.updateAgent(orgId)).rejects.toThrow(/no provisioned agent/i);
    });
  });

  // ── The tenant's own workspace credentials ─────────────────────────────────

  describe('the workspace key', () => {
    const KEY = 'sk_tenant_workspace_key_abcd';
    const realEncryptionKey = process.env.ENCRYPTION_KEY;

    beforeEach(() => {
      process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
    });

    afterAll(() => {
      if (realEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = realEncryptionKey;
    });

    it('never stores the key in a form the database reveals', async () => {
      await service.setWorkspaceKey(orgId, KEY);

      const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: orgId } });
      // A database backup, a leaked read replica, or any SQL read must not hand
      // over a credential that can read every transcript in the workspace.
      expect(config!.apiKey).not.toContain(KEY);
      expect(config!.apiKey!.startsWith('v1.')).toBe(true);
    });

    it('presents the decrypted key to ElevenLabs, not the ciphertext', async () => {
      await service.setWorkspaceKey(orgId, KEY);
      stubWorkspace();

      await service.syncAgent(orgId);

      // The ciphertext reaching the xi-api-key header would look like a revoked
      // credential rather than a decryption bug, and cost hours.
      const authenticated = sent.filter((r) => r.apiKey);
      expect(authenticated.length).toBeGreaterThan(0);
      for (const req of authenticated) expect(req.apiKey).toBe(KEY);
    });

    it('refuses to store anything when no encryption key is configured', async () => {
      delete process.env.ENCRYPTION_KEY;

      await expect(service.setWorkspaceKey(orgId, KEY)).rejects.toThrow(/ENCRYPTION_KEY is not set/);

      const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: orgId } });
      // Storing it in the clear "for now" is how a system reports encryption at
      // rest while having none.
      expect(config?.apiKey ?? null).toBeNull();
    });

    it('reports the key without returning it', async () => {
      await service.setWorkspaceKey(orgId, KEY);

      const status = await service.getWorkspaceKeyStatus(orgId);
      expect(status).toMatchObject({ configured: true, encryptedAtRest: true });
      expect(status.fingerprint).toBe('••••abcd');
      expect(JSON.stringify(status)).not.toContain(KEY);
    });

    it('says plainly when a tenant is still sharing the workspace', async () => {
      const status = await service.getWorkspaceKeyStatus(orgId);
      expect(status).toMatchObject({ configured: false, usingSharedWorkspace: true });
    });

    it('still reports a key it cannot decrypt as configured', async () => {
      await service.setWorkspaceKey(orgId, KEY);
      process.env.ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');

      const status = await service.getWorkspaceKeyStatus(orgId);
      // Reporting "not configured" would send an operator to store a second
      // key, on top of one that the right ENCRYPTION_KEY could still read.
      expect(status).toMatchObject({ configured: true, fingerprint: null });
    });
  });

  // ── Status ─────────────────────────────────────────────────────────────────

  describe('getAgentStatus', () => {
    it('says plainly that nothing is provisioned', async () => {
      const status = await service.getAgentStatus(orgId);
      expect(status.configured).toBe(false);
      expect(status.drift.join(' ')).toMatch(/no agent has been provisioned/i);
    });

    it('tells the operator a sync has already tried, and what is left', async () => {
      // This test used to assert the opposite — "NOT cleared by a sync" —
      // because `agentDefinition()` never emitted `prompt.tools` and the
      // remote update merges, so an inline array survived every sync. The
      // sync now sends an empty list alongside the tool ids, so the honest
      // message changed with the behaviour: if they are STILL here, the
      // workspace kept them, and the remaining remedies are named.
      stubWorkspace();
      await service.syncAgent(orgId);

      stubWorkspace((req) => {
        if (req.method === 'GET' && /\/agents\//.test(req.url)) {
          return {
            status: 200,
            body: agentResponse('agent_x', {
              tools: [
                {
                  name: 'legacy-inline-tool',
                  type: 'webhook',
                  description: 'left behind by an older provisioning',
                  api_schema: { url: 'https://old.example.test/x', method: 'POST' },
                },
              ],
            }),
          };
        }
        return undefined;
      });

      const status = await service.getAgentStatus(orgId);
      const inline = status.drift.find((d) => /inline/i.test(d));

      expect(inline).toBeTruthy();
      // It must not claim a sync cannot do this — it tries.
      expect(inline).not.toMatch(/NOT cleared by a sync/i);
      expect(inline).toMatch(/sync sends an empty list|did not clear/i);
      // And it still names something that works when the workspace refuses.
      expect(inline).toMatch(/dashboard|delete the agent/i);
    });

    it('clears inline prompt.tools on a sync, and says so', async () => {
      // The drift message used to end at "remove them in the dashboard, or
      // delete the agent and sync again" — because `agentDefinition()` never
      // emits `prompt.tools` and the remote update merges, so an inline array
      // already there survived every sync. That left an operator with a
      // dashboard errand and an agent that could answer a citizen from a
      // definition nobody had updated.
      //
      // An EMPTY array is not "both kinds of tools": it is an instruction to
      // remove them. The sync now sends one alongside the tool ids.
      stubWorkspace();
      await service.syncAgent(orgId);

      const updates: any[] = [];
      // The SDK validates inline tool entries as well, so the stub carries the
      // shape a real one has.
      const inlineTool = {
        name: 'legacy-inline',
        type: 'webhook',
        description: 'left behind by an older provisioning',
        api_schema: { url: 'https://old.example.test/x', method: 'POST' },
      };
      let remoteInlineTools: any[] = [inlineTool];
      stubWorkspace((req) => {
        if (req.method === 'GET' && /\/agents\//.test(req.url)) {
          return { status: 200, body: agentResponse('agent_x', { tools: remoteInlineTools }) };
        }
        if (req.method === 'PATCH' && /\/agents\//.test(req.url)) {
          updates.push(req.body);
          // The workspace honoured it.
          const sent = req.body?.conversation_config?.agent?.prompt?.tools;
          if (Array.isArray(sent)) remoteInlineTools = sent;
          return { status: 200, body: agentResponse('agent_x') };
        }
        return undefined;
      });

      await service.syncAgent(orgId);

      const toolsSent = updates
        .map((u) => u?.conversation_config?.agent?.prompt?.tools)
        .filter((t) => Array.isArray(t));
      expect(toolsSent.length).toBeGreaterThan(0);
      expect(toolsSent[toolsSent.length - 1]).toEqual([]);

      // And the tool IDS are still sent in the same breath — clearing the
      // inline copy must not take the real tools with it.
      const idsSent = updates
        .map((u) => u?.conversation_config?.agent?.prompt?.tool_ids)
        .filter(Boolean);
      expect(idsSent.length).toBeGreaterThan(0);
      expect(idsSent[idsSent.length - 1].length).toBe(TOOL_NAMES.length);

      // Nothing is claimed about the outcome without re-reading it.
      const status = await service.getAgentStatus(orgId);
      expect(status.drift.some((d) => /inline/i.test(d))).toBe(false);
    });

    it('still reports inline tools when the workspace refuses to clear them', async () => {
      // If ElevenLabs ignores the empty array, the operator must hear that —
      // not a sync that reports success and changes nothing.
      stubWorkspace();
      await service.syncAgent(orgId);

      stubWorkspace((req) => {
        if (req.method === 'GET' && /\/agents\//.test(req.url)) {
          // Unchanged, whatever was sent.
          return {
            status: 200,
            body: agentResponse('agent_x', {
              tools: [
                {
                  name: 'stubborn',
                  type: 'webhook',
                  description: 'the workspace keeps it whatever we send',
                  api_schema: { url: 'https://old.example.test/x', method: 'POST' },
                },
              ],
            }),
          };
        }
        if (req.method === 'PATCH' && /\/agents\//.test(req.url)) {
          return { status: 200, body: agentResponse('agent_x') };
        }
        return undefined;
      });

      await service.syncAgent(orgId);
      const status = await service.getAgentStatus(orgId);
      const inline = status.drift.find((d) => /inline/i.test(d));

      expect(inline).toBeTruthy();
      // It no longer sends the operator to do something a sync just tried.
      expect(inline).toMatch(/did not clear|refused|still/i);
    });

    it('reports a tool whose PARAMETERS no longer match the catalogue', async () => {
      // The gap this closes. Adding a parameter to a tool — `reference` on
      // cancel-booking, so a citizen with two appointments can say which —
      // changes neither the tool count nor the URL, so nothing flagged it. An
      // agent provisioned before the change simply cannot pass the new
      // parameter, and the caller loops on a question the agent has no way to
      // answer, with the console reporting the agent as healthy.
      stubWorkspace();
      await service.syncAgent(orgId);

      stubWorkspace((req) => {
        if (req.method === 'GET' && req.url.includes('/tools/')) {
          const id = req.url.split('/').pop()!;
          return {
            status: 200,
            body: {
              ...toolResponse(id, undefined),
              tool_config: {
                type: 'webhook',
                name: `${slug}__cancel-booking`,
                description: 'x',
                api_schema: {
                  url: `${PUBLIC_URL}/api/agent-tools/cancel-booking`,
                  method: 'POST',
                  // The old shape: phoneNumber and reason, no reference.
                  request_body_schema: {
                    type: 'object',
                    properties: {
                      phoneNumber: { type: 'string' },
                      reason: { type: 'string' },
                    },
                  },
                },
              },
            },
          };
        }
        return undefined;
      });

      const status = await service.getAgentStatus(orgId);
      // The stub answers every tool id with the cancel-booking shape, so the
      // drift list names several tools; the one under test is the entry that
      // notices `reference` is gone.
      const parameterDrift = status.drift.filter((d) => /parameter/i.test(d));
      expect(parameterDrift.length).toBeGreaterThan(0);

      const missingReference = parameterDrift.find((d) => d.includes('reference'));
      expect(missingReference).toBeTruthy();
      expect(missingReference).toMatch(/missing/i);
      // And it names the remedy, which for a parameter change really is a sync.
      expect(missingReference).toMatch(/sync/i);
    });

    it('reports a drifted tool URL without repairing it', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);

      sent = [];
      stubWorkspace((req) => {
        if (req.method === 'GET' && req.url.includes('/tools/')) {
          return {
            status: 200,
            body: {
              ...toolResponse(req.url.split('/').pop()!, undefined),
              tool_config: {
                type: 'webhook',
                name: `${slug}__handoff`,
                description: 'x',
                api_schema: { url: 'https://old.example.test/api/agent-tools/handoff', method: 'POST' },
              },
            },
          };
        }
        return undefined;
      });

      const status = await service.getAgentStatus(orgId);

      expect(status.drift.some((d) => d.includes('old.example.test'))).toBe(true);
      // Read-only on purpose: a sync that silently repairs drift also destroys
      // the evidence of how it happened.
      expect(sent.every((r) => r.method === 'GET')).toBe(true);
    });

    it('reports an agent that no longer exists', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);

      stubWorkspace((req) =>
        req.method === 'GET' && req.url.includes('/agents/')
          ? { status: 404, body: { detail: 'gone' } }
          : undefined
      );

      const status = await service.getAgentStatus(orgId);
      expect(status.remoteAgentFound).toBe(false);
      expect(status.drift.join(' ')).toMatch(/no longer exists/i);
    });

    it('flags tools on the agent that this platform did not create', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);

      stubWorkspace((req) =>
        req.method === 'GET' && req.url.includes('/agents/')
          ? {
              status: 200,
              body: agentResponse('agent_1', {
                tool_ids: [...TOOL_NAMES.map((_, i) => `tool_${i + 1}`), 'tool_stranger'],
              }),
            }
          : undefined
      );

      const status = await service.getAgentStatus(orgId);
      expect(status.drift.join(' ')).toMatch(/tool_stranger/);
    });
  });

  // ── Rotation ───────────────────────────────────────────────────────────────

  describe('rotateAgentKey', () => {
    it('writes the new key to the secret before revoking the old one', async () => {
      stubWorkspace();
      const first = await service.syncAgent(orgId);

      sent = [];
      const rotated = await service.rotateAgentKey(orgId);

      const patch = sent.find((r) => r.method === 'PATCH' && r.url.includes('/secrets/'));
      expect(patch!.body.value).toBe(`Bearer ${rotated.agentKey}`);
      expect(rotated.agentKey).not.toBe(first.agentKey);

      // Exactly one key survives: the new one.
      const keys = await prisma.apiKey.findMany({ where: { organizationId: orgId } });
      expect(keys).toHaveLength(1);
    });

    it('leaves no second valid credential when the rotation fails', async () => {
      stubWorkspace();
      await service.syncAgent(orgId);

      stubWorkspace((req) =>
        req.method === 'PATCH' && req.url.includes('/secrets/')
          ? { status: 500, body: { detail: 'nope' } }
          : undefined
      );

      await expect(service.rotateAgentKey(orgId)).rejects.toThrow(/ElevenLabs/i);
      // The minted key was never installed anywhere, so it must not linger as
      // an accepted credential.
      expect(await prisma.apiKey.count({ where: { organizationId: orgId } })).toBe(1);
    }, 30_000);

    it('refuses to rotate before there is anything to rotate', async () => {
      await expect(service.rotateAgentKey(orgId)).rejects.toThrow(/no agent key secret/i);
    });
  });
});
