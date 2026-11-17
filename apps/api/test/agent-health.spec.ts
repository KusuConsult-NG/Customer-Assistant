/**
 * The two checks that would have caught this week's phone-line failures before
 * a caller did.
 *
 *   - A sync ElevenLabs REFUSED left the live agent on its old voice speed and
 *     a 10-second silence timeout, while every screen here said the fixes had
 *     shipped. `liveSettingsDrift` must name each of those settings.
 *   - That timeout hung up on callers mid-sentence, and the first anyone knew
 *     was a person hearing it. `summariseCallHealth` must raise the alarm on a
 *     day like that, and must not on an ordinary one.
 */
import {
  agentDefinitionFor,
  agentPromptFor,
  AgentOrganization,
} from '../src/agent-tools/agent-tool-catalog';
import { fromSecret, SILENCE_END_CALL_TIMEOUT_SECONDS } from '../src/agent-tools/elevenlabs-contracts';
import {
  classifyEnding,
  describeSettingDrift,
  liveSettingsDrift,
  summariseCallHealth,
} from '../src/agent-tools/agent-health';

const PLATEAU: AgentOrganization = {
  name: 'Plateau State Government Citizen Contact Centre',
  slug: 'plateau-state',
  timezone: 'Africa/Lagos',
  welcomeMessage: null,
  aiPersonaPrompt: null,
};

const expectedFor = (webhookOn = false) =>
  agentDefinitionFor(PLATEAU, ['tool_1'], undefined, {
    initiationWebhook: {
      url: 'https://api.example.gov.ng/api/agent-tools/conversation-start',
      authorization: fromSecret('secret_1'),
      enabled: webhookOn,
    },
  }) as any;

/** What `agents.get` returns for an agent the last sync DID reach. */
const liveCopy = () => JSON.parse(JSON.stringify(expectedFor()));

describe('Live agent settings drift', () => {
  it('reports nothing for an agent that matches what a sync writes', () => {
    expect(liveSettingsDrift(liveCopy(), expectedFor())).toEqual([]);
  });

  it('is stable: the expected prompt is the same on every build, so it cannot flap', () => {
    expect(agentPromptFor(PLATEAU)).toBe(agentPromptFor(PLATEAU));
  });

  it('ignores the first message and name, which the per-call name rotation rewrites', () => {
    const live = liveCopy();
    live.conversationConfig.agent.firstMessage = 'Something else entirely';
    live.conversationConfig.agent.dynamicVariables = { dynamic_variable_placeholders: { representative_name: 'Gwaman' } };
    expect(liveSettingsDrift(live, expectedFor())).toEqual([]);
  });

  it('names every setting a refused sync left behind', () => {
    const live = liveCopy();
    live.conversationConfig.tts.speed = 1.0;
    live.conversationConfig.tts.supportedVoices[0].speed = 1.0;
    live.conversationConfig.tts.modelId = 'eleven_v3_conversational';
    live.conversationConfig.turn.silenceEndCallTimeout = 10;
    live.conversationConfig.languagePresets = { ha: { overrides: {} } };
    live.conversationConfig.agent.prompt.prompt = 'An older prompt.';

    const drift = liveSettingsDrift(live, expectedFor());
    const by = Object.fromEntries(drift.map((d) => [d.setting, d]));
    expect(by['Speaking speed']).toEqual({ setting: 'Speaking speed', live: '1', expected: '0.9' });
    expect(by['Governor speaking speed']).toBeDefined();
    expect(by['Voice model'].live).toBe('eleven_v3_conversational');
    expect(by['Hang-up after caller silence (seconds)']).toEqual({
      setting: 'Hang-up after caller silence (seconds)',
      live: '10',
      expected: String(SILENCE_END_CALL_TIMEOUT_SECONDS),
    });
    expect(by['Other languages offered'].live).toBe('ha');
    expect(by['Instructions (system prompt)']).toBeDefined();
  });

  it('catches the conversation-start webhook left on (the "all circuits are busy" setting)', () => {
    const live = liveCopy();
    live.platformSettings.overrides.enableConversationInitiationClientDataFromWebhook = true;
    const drift = liveSettingsDrift(live, expectedFor(false));
    expect(drift).toEqual([{ setting: 'Caller lookup before greeting', live: 'on', expected: 'off' }]);
  });

  it('catches the noisy-line settings missing from the live agent', () => {
    // Without them a caller shouting over a generator is asked whether they
    // are still there instead of being answered.
    const live = liveCopy();
    delete live.conversationConfig.turn.retranscribeOnTurnTimeout;
    live.conversationConfig.turn.spellingPatience = 'off';
    const by = Object.fromEntries(liveSettingsDrift(live, expectedFor()).map((d) => [d.setting, d]));
    expect(by['Re-listen when speech was missed (noisy lines)']).toMatchObject({ live: 'off', expected: 'on' });
    expect(by['Patience while spelling']).toMatchObject({ live: 'off', expected: 'auto' });
  });

  it('asks the agent to say when it could not hear, not to guess', () => {
    const prompt = agentPromptFor(PLATEAU);
    expect(prompt).toContain('NOISY LINE');
    expect(prompt).toMatch(/do not guess and do not answer something else/);
    expect(expectedFor().conversationConfig.turn).toMatchObject({ retranscribeOnTurnTimeout: true, spellingPatience: 'auto' });
  });

  it('treats a setting missing from the live agent as drift, not as a match', () => {
    const live = liveCopy();
    delete live.conversationConfig.turn.silenceEndCallTimeout;
    const drift = liveSettingsDrift(live, expectedFor());
    expect(drift.map((d) => d.live)).toEqual(['(not set)']);
  });

  it('tells the reader what to do about it', () => {
    const line = describeSettingDrift({ setting: 'Speaking speed', live: '1', expected: '0.9' });
    expect(line).toMatch(/Speaking speed .* is 1; this platform expects 0\.9/);
    expect(line).toMatch(/Sync configuration/);
    expect(line).toMatch(/refused/);
  });
});

describe('How calls ended', () => {
  it('classifies the reasons ElevenLabs records', () => {
    expect(classifyEnding('end_call tool was called.')).toBe('normal');
    expect(classifyEnding('Remote party ended call')).toBe('normal');
    expect(classifyEnding('Client disconnected: 1000')).toBe('normal');
    expect(classifyEnding('Call ended due to silence timeout')).toBe('abnormal');
    expect(classifyEnding('Max duration exceeded')).toBe('abnormal');
    expect(classifyEnding('Internal error')).toBe('abnormal');
    expect(classifyEnding('anything', 'failed')).toBe('abnormal');
  });

  it('never counts a reason it does not recognise as fine', () => {
    expect(classifyEnding('Something new from ElevenLabs')).toBe('unknown');
    expect(classifyEnding(undefined)).toBe('unknown');
  });

  it('raises the alarm on a day like the one with the 10-second timeout', () => {
    const day = [
      ...Array(6).fill({ terminationReason: 'Call ended due to silence timeout', status: 'done' }),
      ...Array(4).fill({ terminationReason: 'end_call tool was called.', status: 'done' }),
    ];
    const health = summariseCallHealth(day, 24);
    expect(health).toMatchObject({ total: 10, abnormal: 6, normal: 4, unknown: 0, alert: true });
    expect(health.abnormalRate).toBeCloseTo(0.6);
    // Every raw reason is shown, most frequent first.
    expect(health.reasons[0]).toEqual({ reason: 'Call ended due to silence timeout', kind: 'abnormal', count: 6 });
  });

  it('stays quiet on an ordinary day and on too few calls to tell', () => {
    const ordinary = [
      ...Array(19).fill({ terminationReason: 'end_call tool was called.', status: 'done' }),
      { terminationReason: 'Max duration exceeded', status: 'done' },
    ];
    expect(summariseCallHealth(ordinary, 24).alert).toBe(false);
    expect(summariseCallHealth([{ terminationReason: 'Internal error', status: 'failed' }], 24).alert).toBe(false);
  });

  it('reports no calls as no calls, not as a rate', () => {
    expect(summariseCallHealth([], 24)).toMatchObject({ total: 0, abnormalRate: null, alert: false, reasons: [] });
  });
});

describe('ElevenLabsAgentService.getCallHealth', () => {
  jest.setTimeout(60000);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma, encryptSecret } = require('@ace/database');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ElevenLabsAgentService } = require('../src/agent-tools/elevenlabs-agent.service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ElevenLabsApi } = require('../src/agent-tools/elevenlabs-client');
  let orgId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'Call Health Agency', slug: `call-health-${Date.now()}`, industry: 'GOVERNMENT', timezone: 'Africa/Lagos' },
    });
    orgId = org.id;
    await prisma.hostedAgentConfig.create({
      data: { organizationId: orgId, agentId: 'agent_health_test', apiKey: encryptSecret('sk_tenant_health_test') },
    });
  });

  afterAll(async () => {
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  });

  it("reads only this agency's agent, across pages, and skips calls still in progress", async () => {
    const requests: any[] = [];
    const pages = [
      {
        conversations: [
          { status: 'done', terminationReason: 'Call ended due to silence timeout' },
          { status: 'in-progress', terminationReason: undefined },
        ],
        hasMore: true,
        nextCursor: 'page2',
      },
      { conversations: [{ status: 'done', terminationReason: 'end_call tool was called.' }], hasMore: false },
    ];
    const api = new ElevenLabsApi();
    let usedKey = '';
    (api as any).for = (key: string) => {
      usedKey = key;
      return {
        conversationalAi: {
          conversations: { list: async (req: any) => { requests.push(req); return pages[requests.length - 1]; } },
        },
      };
    };
    const service = new ElevenLabsAgentService(api);

    const health = await service.getCallHealth(orgId, 24, { fresh: true });
    expect(usedKey).toBe('sk_tenant_health_test');
    expect(requests.map((r) => r.agentId)).toEqual(['agent_health_test', 'agent_health_test']);
    expect(requests[1].cursor).toBe('page2');
    expect(requests[0].callStartAfterUnix).toBeGreaterThan(Date.now() / 1000 - 25 * 3600);
    expect(health).toMatchObject({ total: 2, abnormal: 1, normal: 1 });
  });
});
