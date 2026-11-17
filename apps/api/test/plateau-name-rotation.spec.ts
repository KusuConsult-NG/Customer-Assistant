/**
 * Rotating the Plateau assistant's name between calls.
 *
 * The State line gives its assistant a different name from a 100-name roster
 * on each call. With the conversation-start webhook off, that happens by
 * PATCHing the live agent's first message after a call's turn-1 lookup.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * Every call kept the name Nanpan. The PATCH used `ELEVENLABS_API_KEY` — the
 * SHARED workspace key — while the agent lives in the agency's OWN workspace,
 * so ElevenLabs refused every rotation. The refusal was invisible: the code
 * never read the response and logged "rotated" either way.
 *
 * The rotation is disabled under Jest (it would PATCH a real agent from every
 * suite), so this spec switches NODE_ENV for the one call it makes and stubs
 * `fetch` to see the request.
 */
import { randomBytes } from 'crypto';
import { prisma, encryptSecret } from '@ace/database';
import { AgentToolsService } from '../src/agent-tools/agent-tools.service';
import { ElevenLabsApi } from '../src/agent-tools/elevenlabs-client';
import { PLATEAU_MALE_NAMES } from '../src/agent-tools/agent-tool-catalog';
import { lastNameRotation } from '../src/agent-tools/plateau-name-rotation';
import { ElevenLabsWebhookService } from '../src/agent-tools/elevenlabs-webhook.service';

describe('Plateau name rotation', () => {
  jest.setTimeout(60000);

  const TENANT_KEY = `sk_tenant_${randomBytes(6).toString('hex')}`;
  const SHARED_KEY = `sk_shared_${randomBytes(6).toString('hex')}`;
  let orgId: string;
  const realFetch = global.fetch;
  const realEnv = { NODE_ENV: process.env.NODE_ENV, ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY };

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: {
        name: 'Plateau State Government Citizen Contact Centre',
        slug: `plateau-rotation-${randomBytes(4).toString('hex')}`,
        industry: 'GOVERNMENT',
        timezone: 'Africa/Lagos',
        welcomeMessage:
          '<governor>{greeting}, and welcome. Our virtual assistant, {name}, will help you now.</governor> <break time="1.0s" /> I\'m {name}, the virtual assistant. May I have your full name?',
      },
    });
    orgId = org.id;
    await prisma.hostedAgentConfig.create({
      data: { organizationId: orgId, agentId: 'agent_rotation_test', apiKey: encryptSecret(TENANT_KEY) },
    });
  });

  afterAll(async () => {
    global.fetch = realFetch;
    process.env.NODE_ENV = realEnv.NODE_ENV;
    if (realEnv.ELEVENLABS_API_KEY === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = realEnv.ELEVENLABS_API_KEY;
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  });

  const rotate = async (status: number) => {
    const sent: { url: string; key: string | null; body: any }[] = [];
    global.fetch = (async (input: any, init: any) => {
      const headers = new Headers(init?.headers ?? {});
      sent.push({ url: String(input), key: headers.get('xi-api-key'), body: init?.body ? JSON.parse(init.body) : null });
      return new Response(status === 200 ? '{}' : '{"detail":"refused"}', { status });
    }) as any;

    // Only the dependency the rotation uses; the rest are not touched by it.
    const service = new AgentToolsService(
      undefined as any, undefined as any, undefined as any, undefined as any, undefined as any,
      new ElevenLabsApi()
    );
    const logs: string[] = [];
    (service as any).log = { log: (m: string) => logs.push(`log ${m}`), warn: (m: string) => logs.push(`warn ${m}`) };

    process.env.ELEVENLABS_API_KEY = SHARED_KEY;
    process.env.NODE_ENV = 'production';
    try {
      await (service as any).rotateNextPlateauAgentPersona(orgId);
    } finally {
      process.env.NODE_ENV = realEnv.NODE_ENV;
    }
    return { sent, logs };
  };

  it("PATCHes the agent with the AGENCY's own key, never the shared one", async () => {
    const { sent } = await rotate(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toMatch(/\/v1\/convai\/agents\/agent_rotation_test$/);
    expect(sent[0].key).toBe(TENANT_KEY);
    expect(sent[0].key).not.toBe(SHARED_KEY);

    // A roster name, in both voices' lines of the opening.
    const first: string = sent[0].body.conversation_config.agent.first_message;
    const name = sent[0].body.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders.representative_name;
    expect(PLATEAU_MALE_NAMES).toContain(name);
    expect(first).toContain(`Our virtual assistant, ${name}, will help you now.`);
    expect(first).toContain(`I'm ${name}, the virtual assistant.`);
    // The next caller is not asked their name before they are looked up.
    expect(first).not.toMatch(/your (full )?name/i);
    expect(first).toMatch(/How may I help you today\?$/);
  });

  it('does not switch the conversation-start webhook itself', async () => {
    const { sent } = await rotate(200);
    expect(sent[0].body.platform_settings).toBeUndefined();
  });

  it('logs a refusal as a refusal, not as a rotation', async () => {
    const { logs } = await rotate(403);
    expect(logs.some((l) => l.startsWith('warn rotate_plateau_persona_refused') && l.includes('status=403'))).toBe(true);
    expect(logs.some((l) => l.includes('rotated_plateau_persona'))).toBe(false);
  });

  // Nothing on any screen said whether the rotation ran, was refused or never
  // fired, so "callers still hear Nanpan" could not be told apart from a
  // working rotation. The outcome is kept and the Hosted Agent screen shows it.
  it('keeps the outcome, with ElevenLabs\' own words when it refused', async () => {
    await rotate(403);
    expect(lastNameRotation(orgId)).toMatchObject({
      trigger: 'lookup',
      outcome: 'refused',
      detail: expect.stringContaining('HTTP 403'),
    });
    const { sent } = await rotate(200);
    const staged = sent[0].body.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders.representative_name;
    expect(lastNameRotation(orgId)).toMatchObject({ trigger: 'lookup', outcome: 'rotated', name: staged });
  });

  // The turn-1 lookup was the only trigger, and a model can skip it — the next
  // caller then heard the same name. The end of every call rotates too.
  describe('after a call ends', () => {
    const ingestCall = async (endedSecondsAgo: number) => {
      const sent: string[] = [];
      global.fetch = (async (input: any) => {
        sent.push(String(input));
        return new Response('{}', { status: 200 });
      }) as any;
      const webhooks = new ElevenLabsWebhookService(
        { followUp: async () => ({ sent: false, reason: 'stub' }) } as any,
        new ElevenLabsApi()
      );
      const duration = 60;
      const start = Math.floor(Date.now() / 1000) - endedSecondsAgo - duration;
      process.env.NODE_ENV = 'production';
      try {
        await webhooks.ingest(
          {
            type: 'post_call_transcription',
            data: {
              agent_id: 'agent_rotation_test',
              conversation_id: `conv_${randomBytes(4).toString('hex')}`,
              status: 'done',
              transcript: [{ role: 'agent', message: 'Hello', time_in_call_secs: 0 }],
              metadata: {
                start_time_unix_secs: start,
                call_duration_secs: duration,
                phone_call: {
                  type: 'twilio',
                  direction: 'inbound',
                  call_sid: `CA${randomBytes(6).toString('hex')}`,
                  agent_number: '+2348000000009',
                  external_number: '+2348111111119',
                },
              },
            },
          } as any,
          'test',
          orgId
        );
        // The rotation is fire-and-forget after the webhook is recorded.
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        process.env.NODE_ENV = realEnv.NODE_ENV;
      }
      return sent.filter((u) => /\/v1\/convai\/agents\/agent_rotation_test$/.test(u));
    };

    afterAll(async () => {
      await prisma.callLog.deleteMany({ where: { organizationId: orgId } });
      await prisma.contact.deleteMany({ where: { organizationId: orgId } });
    });

    it('stages a new name when a call has just ended', async () => {
      expect(await ingestCall(30)).toHaveLength(1);
      expect(lastNameRotation(orgId)).toMatchObject({ trigger: 'call-ended', outcome: 'rotated' });
    });

    it('does not for an old call replayed by the call-sync poller', async () => {
      expect(await ingestCall(3600)).toHaveLength(0);
    });
  });
});
