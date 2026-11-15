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
});
