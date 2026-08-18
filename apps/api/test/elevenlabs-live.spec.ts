/**
 * The live conversation feed.
 *
 * ElevenLabs pushes nothing mid-conversation — every webhook event type they
 * define fires after the call ends — so a live console is a poller. These tests
 * are about the consequences of that, which are not obvious:
 *
 *   - polling costs a rate limit, so a tenant nobody is watching must generate
 *     no provider traffic at all
 *   - one tenant's expired key must not stop every other tenant's console
 *   - the workspace may hold other tenants' conversations, and a console must
 *     never show them
 *   - snapshots must be complete, because a console can connect mid-call and a
 *     duplicate emit across two pods must be a visual no-op
 */

import { Test } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import {
  ElevenLabsLiveService,
  LiveConversation,
} from '../src/agent-tools/elevenlabs-live.service';
import { ElevenLabsApi } from '../src/agent-tools/elevenlabs-client';

interface Captured {
  url: string;
  method: string;
}

describe('ElevenLabs live conversations', () => {
  let service: ElevenLabsLiveService;
  let orgId: string;
  let otherOrgId: string;
  let sent: Captured[];

  const agentId = `agent_${randomBytes(4).toString('hex')}`;
  const realFetch = global.fetch;
  const realBase = process.env.ELEVENLABS_BASE_URL;
  const realKey = process.env.ELEVENLABS_API_KEY;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ElevenLabsLiveService, ElevenLabsApi],
    }).compile();
    service = moduleRef.get(ElevenLabsLiveService);

    process.env.ELEVENLABS_BASE_URL = 'https://elevenlabs.test';
    process.env.ELEVENLABS_API_KEY = 'xi-test-key';

    const org = await prisma.organization.create({
      data: {
        name: 'Live Test Ltd',
        slug: `live-${randomBytes(4).toString('hex')}`,
        industry: 'OTHER',
      },
    });
    orgId = org.id;

    const other = await prisma.organization.create({
      data: {
        name: 'Live Other',
        slug: `live-other-${randomBytes(4).toString('hex')}`,
        industry: 'OTHER',
      },
    });
    otherOrgId = other.id;
  }, 60_000);

  afterAll(async () => {
    service.onModuleDestroy();
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    global.fetch = realFetch;
    if (realBase === undefined) delete process.env.ELEVENLABS_BASE_URL;
    else process.env.ELEVENLABS_BASE_URL = realBase;
    if (realKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = realKey;
  });

  beforeEach(async () => {
    sent = [];
    for (const id of service.watchedOrganizations()) {
      // Drain any watchers a previous test left behind.
      while (service.watchedOrganizations().includes(id)) service.unwatch(id);
    }
    await prisma.hostedAgentConfig.deleteMany({
      where: { organizationId: { in: [orgId, otherOrgId] } },
    });
    await prisma.hostedAgentConfig.create({ data: { organizationId: orgId, agentId } });
  });

  const turn = (role: string, message: string | null, at: number) => ({
    role,
    message,
    time_in_call_secs: at,
  });

  const summary = (id: string, status: string) => ({
    agent_id: agentId,
    conversation_id: id,
    start_time_unix_secs: 1_760_000_000,
    call_duration_secs: 12,
    message_count: 2,
    status,
    call_successful: 'success',
  });

  const detail = (id: string, status: string, over: Record<string, any> = {}) => ({
    agent_id: agentId,
    conversation_id: id,
    status,
    has_audio: false,
    has_user_audio: false,
    has_response_audio: false,
    has_auxiliary_audio: false,
    metadata: {
      start_time_unix_secs: 1_760_000_000,
      call_duration_secs: 12,
      phone_call: {
        type: 'twilio',
        direction: 'inbound',
        call_sid: 'CA1',
        stream_sid: 'MZ1',
        phone_number_id: 'phnum_1',
        agent_number: '+2348000000001',
        external_number: '+2348111111111',
      },
    },
    transcript: [
      turn('agent', 'Thank you for calling.', 0),
      turn('user', 'I need to reschedule.', 3),
      turn('agent', null, 5),
    ],
    ...over,
  });

  const stub = (
    routes: {
      list?: any[];
      details?: Record<string, any>;
      fail?: (req: Captured) => { status: number; body: any } | undefined;
    } = {}
  ) => {
    global.fetch = (async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const req: Captured = { url, method };
      sent.push(req);

      const failure = routes.fail?.(req);
      if (failure) return new Response(JSON.stringify(failure.body), { status: failure.status });

      const parsed = new URL(url);
      const reply = (body: any) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      if (parsed.pathname === '/v1/convai/conversations') {
        return reply({ conversations: routes.list ?? [], has_more: false });
      }
      const match = parsed.pathname.match(/^\/v1\/convai\/conversations\/([^/]+)$/);
      if (match) {
        const found = routes.details?.[match[1]];
        if (found) return reply(found);
        return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ detail: `no stub for ${parsed.pathname}` }), {
        status: 404,
      });
    }) as any;
  };

  // ── Cost ───────────────────────────────────────────────────────────────────

  describe('polling only what someone is watching', () => {
    it('makes no provider request when nobody is at the console', async () => {
      stub({ list: [summary('conv_1', 'in-progress')] });

      await service.pollAll();

      // An always-on poller across every tenant spends a rate limit budget on
      // an empty room.
      expect(sent).toHaveLength(0);
    });

    it('polls once a console connects, and stops when the last one leaves', async () => {
      stub({ list: [] });

      service.watch(orgId);
      await service.pollAll();
      expect(sent.length).toBeGreaterThan(0);

      sent = [];
      service.unwatch(orgId);
      await service.pollAll();
      expect(sent).toHaveLength(0);
    });

    it('keeps polling while other viewers remain', async () => {
      stub({ list: [] });

      service.watch(orgId);
      service.watch(orgId);
      service.unwatch(orgId);

      await service.pollAll();
      // Two people watching, one closed their tab. The other is still looking.
      expect(sent.length).toBeGreaterThan(0);
    });
  });

  // ── Isolation ──────────────────────────────────────────────────────────────

  describe('isolation', () => {
    it('asks only for this tenant agent conversations', async () => {
      stub({ list: [] });
      service.watch(orgId);

      await service.pollAll();

      const list = sent.find((r) => r.url.includes('/conversations'));
      // The workspace may hold every other tenant's conversations. An unscoped
      // list is one tenant reading another's calls.
      expect(new URL(list!.url).searchParams.get('agent_id')).toBe(agentId);
    });

    it('returns nothing for an organization with no provisioned agent', async () => {
      stub({ list: [summary('conv_1', 'in-progress')] });

      const result = await service.fetchLive(otherOrgId);

      expect(result).toEqual([]);
      expect(sent).toHaveLength(0);
    });

    it('keeps polling other tenants when one of them fails', async () => {
      await prisma.hostedAgentConfig.create({
        data: { organizationId: otherOrgId, agentId: `${agentId}_other` },
      });
      stub({
        list: [],
        fail: (req) =>
          req.url.includes(`${agentId}_other`)
            ? { status: 401, body: { detail: 'key revoked' } }
            : undefined,
      });

      service.watch(otherOrgId);
      service.watch(orgId);

      // One tenant's expired key must not blank every other console.
      await expect(service.pollAll()).resolves.toBeUndefined();
      expect(sent.some((r) => r.url.includes(`agent_id=${agentId}&`) || r.url.includes(agentId))).toBe(
        true
      );
    });
  });

  // ── Snapshots ──────────────────────────────────────────────────────────────

  describe('what a snapshot contains', () => {
    it('carries the whole transcript so far, not a delta', async () => {
      stub({
        list: [summary('conv_1', 'in-progress')],
        details: { conv_1: detail('conv_1', 'in-progress') },
      });

      const [live] = await service.fetchLive(orgId);

      // A console that connects mid-call has to be correct on the next tick,
      // and a duplicate emit from a second pod has to be a visual no-op.
      expect(live.turns.map((t) => [t.role, t.message])).toEqual([
        ['agent', 'Thank you for calling.'],
        ['user', 'I need to reschedule.'],
      ]);
      expect(live.turnCount).toBe(2);
    });

    it('drops turns with no text', async () => {
      stub({
        list: [summary('conv_1', 'in-progress')],
        details: { conv_1: detail('conv_1', 'in-progress') },
      });

      const [live] = await service.fetchLive(orgId);
      // Tool-call-only turns would render as blank bubbles, which reads as a
      // broken console rather than a working one.
      expect(live.turns.every((t) => t.message.length > 0)).toBe(true);
    });

    it('identifies the channel and the customer', async () => {
      stub({
        list: [summary('conv_1', 'in-progress')],
        details: { conv_1: detail('conv_1', 'in-progress') },
      });

      const [live] = await service.fetchLive(orgId);
      expect(live.channel).toBe('voice');
      expect(live.customerNumber).toBe('+2348111111111');
    });

    it('reads a WhatsApp conversation as WhatsApp', async () => {
      stub({
        list: [summary('conv_2', 'in-progress')],
        details: {
          conv_2: detail('conv_2', 'in-progress', {
            metadata: {
              start_time_unix_secs: 1_760_000_000,
              call_duration_secs: 0,
              whatsapp: { direction: 'inbound', whatsapp_user_id: '2348111111111' },
            },
          }),
        },
      });

      const [live] = await service.fetchLive(orgId);
      expect(live.channel).toBe('whatsapp');
      expect(live.customerNumber).toBe('2348111111111');
    });
  });

  // ── Which conversations count as live ──────────────────────────────────────

  describe('deciding what is still happening', () => {
    it('ignores conversations that have finished', async () => {
      stub({
        list: [summary('conv_done', 'done'), summary('conv_failed', 'failed')],
        details: {
          conv_done: detail('conv_done', 'done'),
          conv_failed: detail('conv_failed', 'failed'),
        },
      });

      expect(await service.fetchLive(orgId)).toEqual([]);
    });

    it('still shows one that is processing', async () => {
      stub({
        list: [summary('conv_p', 'processing')],
        details: { conv_p: detail('conv_p', 'processing') },
      });

      // The transcript is complete but the post-call webhook may not have
      // landed. Blanking the console in that gap looks like a dropped call.
      const live = await service.fetchLive(orgId);
      expect(live.map((c) => c.conversationId)).toEqual(['conv_p']);
    });

    it('keeps a conversation whose detail could not be read', async () => {
      stub({ list: [summary('conv_x', 'in-progress')], details: {} });

      const live = await service.fetchLive(orgId);
      // Degrades to what the list already said rather than dropping a call that
      // is genuinely happening.
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ conversationId: 'conv_x', turns: [], turnCount: 0 });
    });
  });

  // ── Emitting ───────────────────────────────────────────────────────────────

  describe('what the console is told', () => {
    it('announces an ending rather than leaving the console to infer it', async () => {
      const emitted: LiveConversation[][] = [];
      const ended: string[] = [];
      service.attach({
        emitLiveConversations: (_org, conversations) => emitted.push(conversations),
        emitConversationEnded: (_org, id) => ended.push(id),
      });

      service.watch(orgId);
      stub({
        list: [summary('conv_1', 'in-progress')],
        details: { conv_1: detail('conv_1', 'in-progress') },
      });
      await service.pollAll();
      expect(emitted[0].map((c) => c.conversationId)).toEqual(['conv_1']);
      expect(ended).toEqual([]);

      stub({ list: [] });
      await service.pollAll();

      // An absence also describes a failed poll, so the ending is said out loud.
      expect(ended).toEqual(['conv_1']);
    });

    it('does not announce the same ending twice', async () => {
      const ended: string[] = [];
      service.attach({
        emitLiveConversations: () => {},
        emitConversationEnded: (_org, id) => ended.push(id),
      });

      service.watch(orgId);
      stub({
        list: [summary('conv_1', 'in-progress')],
        details: { conv_1: detail('conv_1', 'in-progress') },
      });
      await service.pollAll();

      stub({ list: [] });
      await service.pollAll();
      await service.pollAll();

      expect(ended).toEqual(['conv_1']);
    });
  });
});
