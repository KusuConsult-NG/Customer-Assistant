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
  summariseRecognition,
  RECOGNITION_MIN_CALLS,
  endedUnderOldSetting,
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
    live.conversationConfig.tts.speed = 0.9;
    live.conversationConfig.tts.supportedVoices[0].speed = 0.9;
    live.conversationConfig.tts.modelId = 'eleven_v3_conversational';
    live.conversationConfig.turn.silenceEndCallTimeout = 10;
    live.conversationConfig.languagePresets = { ha: { overrides: {} } };
    live.conversationConfig.agent.prompt.prompt = 'An older prompt.';

    const drift = liveSettingsDrift(live, expectedFor());
    const by = Object.fromEntries(drift.map((d) => [d.setting, d]));
    expect(by['Speaking speed']).toEqual({ setting: 'Speaking speed', live: '0.9', expected: '1' });
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
    expect(health.reasons[0]).toMatchObject({ reason: 'Call ended due to silence timeout', kind: 'abnormal', count: 6 });
  });

  it('stays quiet on an ordinary day and on too few calls to tell', () => {
    const ordinary = [
      ...Array(19).fill({ terminationReason: 'end_call tool was called.', status: 'done' }),
      { terminationReason: 'Max duration exceeded', status: 'done' },
    ];
    expect(summariseCallHealth(ordinary, 24).alert).toBe(false);
    expect(summariseCallHealth([{ terminationReason: 'Internal error', status: 'failed' }], 24).alert).toBe(false);
  });

  it('stops counting calls cut off by a silence timeout the live agent no longer has', () => {
    // The 10-second hang-up was fixed; its endings kept the dashboard red for
    // a day afterwards. ElevenLabs names the timeout in force in the reason.
    const day = [
      { terminationReason: 'Ending conversation after 10 seconds of silence', status: 'done' },
      { terminationReason: 'Ending conversation after 10 seconds of silence', status: 'done' },
      { terminationReason: 'end_call tool was called.', status: 'done' },
      { terminationReason: '', status: 'failed' },
    ];
    const fixed = summariseCallHealth(day, 24, { liveSilenceSeconds: SILENCE_END_CALL_TIMEOUT_SECONDS });
    expect(fixed).toMatchObject({ superseded: 2, total: 2, abnormal: 1, normal: 1 });
    expect(fixed.reasons.map((r) => r.reason)).not.toContain('Ending conversation after 10 seconds of silence');
    // Nothing fixed about a failed call: it stays.
    expect(fixed.reasons.map((r) => r.reason)).toContain('(no reason; status failed)');
  });

  it('keeps them when the live agent is STILL on the old timeout, or cannot be read', () => {
    // A refused sync leaves the agent on 10: those endings are current.
    expect(endedUnderOldSetting('Ending conversation after 10 seconds of silence', 10)).toBe(false);
    expect(endedUnderOldSetting('Ending conversation after 10 seconds of silence', null)).toBe(false);
    // A silence ending at the CURRENT value is a real one and is counted.
    expect(endedUnderOldSetting(`Ending conversation after ${SILENCE_END_CALL_TIMEOUT_SECONDS} seconds of silence`, SILENCE_END_CALL_TIMEOUT_SECONDS)).toBe(false);
    expect(endedUnderOldSetting('Internal error', SILENCE_END_CALL_TIMEOUT_SECONDS)).toBe(false);
  });

  it('says when, which way and which call, for every ending that is not normal', () => {
    // "(no reason; status failed)" could not be traced from the dashboard.
    const health = summariseCallHealth(
      [
        { status: 'failed', conversationId: 'conv_old', startTimeUnixSecs: 1_800_000_000, direction: 'outbound', callDurationSecs: 0 },
        { status: 'failed', conversationId: 'conv_new', startTimeUnixSecs: 1_800_000_600, direction: 'inbound', callDurationSecs: 3 },
        { status: 'done', terminationReason: 'end_call tool was called.', conversationId: 'conv_ok', startTimeUnixSecs: 1_800_000_300 },
      ],
      24
    );
    const failed = health.reasons.find((r) => r.reason === '(no reason; status failed)')!;
    expect(failed.lastAt).toBe(new Date(1_800_000_600_000).toISOString());
    expect(failed.calls).toEqual([
      { conversationId: 'conv_new', at: new Date(1_800_000_600_000).toISOString(), direction: 'inbound', durationSecs: 3 },
      { conversationId: 'conv_old', at: new Date(1_800_000_000_000).toISOString(), direction: 'outbound', durationSecs: 0 },
    ]);
    // A normal ending lists no calls: there is nothing to investigate.
    expect(health.reasons.find((r) => r.kind === 'normal')!.calls).toBeUndefined();
    // Identity only, never content.
    expect(JSON.stringify(health)).not.toMatch(/summary|transcript/i);
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
          conversations: {
            list: async (req: any, opts?: any) => {
              if (opts?.queryParams) return { conversations: [], hasMore: false };
              requests.push(req);
              return pages[requests.length - 1];
            },
          },
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

  it('asks the LIVE agent for its silence timeout before leaving old endings out', async () => {
    const day = {
      conversations: [
        { status: 'done', terminationReason: 'Ending conversation after 10 seconds of silence' },
        { status: 'done', terminationReason: 'end_call tool was called.' },
      ],
      hasMore: false,
    };
    const withLive = (seconds: number) => {
      const api = new ElevenLabsApi();
      (api as any).for = () => ({
        conversationalAi: {
          conversations: { list: async () => day },
          agents: { get: async () => ({ conversationConfig: { turn: { silenceEndCallTimeout: seconds } } }) },
        },
      });
      return new ElevenLabsAgentService(api);
    };
    expect(await withLive(SILENCE_END_CALL_TIMEOUT_SECONDS).getCallHealth(orgId, 24, { fresh: true }))
      .toMatchObject({ superseded: 1, total: 1, abnormal: 0 });
    // Sync refused: still 10 on the live agent, so it is still a problem.
    expect(await withLive(10).getCallHealth(orgId, 24, { fresh: true }))
      .toMatchObject({ superseded: 0, total: 2, abnormal: 1 });
  });
});

describe('returning callers are recognised (the SIP bridge lookup reached the call)', () => {
  const call = (id: string, at: number, extra: Record<string, unknown> = {}) => ({
    conversationId: id,
    startTimeUnixSecs: at,
    direction: 'inbound',
    source: 'sip_trunk',
    callDurationSecs: 30,
    ...extra,
  });

  it('raises the alarm when calls stop arriving with the lookup, and names them', () => {
    const calls = [call('a', 100), call('b', 200), call('c', 300), call('d', 400)];
    const r = summariseRecognition(calls, new Set(['a']), true);
    expect(r).toMatchObject({ inboundCalls: 4, lookedUp: 1, missed: 3, alert: true });
    expect(r.lastLookedUpAt).toBe(new Date(100 * 1000).toISOString());
    expect(r.recentMisses.map((m) => m.conversationId)).toEqual(['d', 'c', 'b']);
  });

  it('every call missed with no lookup at all is the "stopped entirely" case', () => {
    const calls = [call('a', 100), call('b', 200), call('c', 300)];
    expect(summariseRecognition(calls, new Set(), true)).toMatchObject({ missed: 3, lookedUp: 0, alert: true, lastLookedUpAt: null });
  });

  it('does not count the calls before the lookup was switched on', () => {
    const calls = [call('old1', 10), call('old2', 20), call('old3', 30), call('a', 100), call('b', 200), call('c', 300)];
    expect(summariseRecognition(calls, new Set(['a', 'b', 'c']), true)).toMatchObject({ inboundCalls: 3, missed: 0, alert: false });
  });

  it('counts only inbound SIP calls: our callbacks and other channels are not looked up', () => {
    const calls = [
      call('a', 100),
      call('out', 200, { direction: 'outbound' }),
      call('wa', 300, { source: 'whatsapp' }),
      call('b', 400),
    ];
    expect(summariseRecognition(calls, new Set(['a', 'b']), true)).toMatchObject({ inboundCalls: 2, missed: 0 });
  });

  it('stays quiet below the minimum, and for an agency the lookup is not switched on for', () => {
    const few = Array.from({ length: RECOGNITION_MIN_CALLS - 1 }, (_, i) => call(`x${i}`, i + 1));
    expect(summariseRecognition(few, new Set(), true).alert).toBe(false);
    const many = Array.from({ length: 10 }, (_, i) => call(`y${i}`, i + 1));
    expect(summariseRecognition(many, new Set(), false)).toMatchObject({ missed: 10, alert: false });
  });
});

describe('ElevenLabsAgentService.getCallHealth — caller recognition', () => {
  jest.setTimeout(60000);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma, encryptSecret } = require('@ace/database');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ElevenLabsAgentService } = require('../src/agent-tools/elevenlabs-agent.service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ElevenLabsApi } = require('../src/agent-tools/elevenlabs-client');
  let orgId: string;
  const saved = process.env.SIP_BRIDGE_SECRET;

  beforeAll(async () => {
    process.env.SIP_BRIDGE_SECRET = 'recognition-test-secret-0123456789';
    const org = await prisma.organization.create({
      data: { name: 'Recognition Agency', slug: `recognition-${Date.now()}`, industry: 'GOVERNMENT', timezone: 'Africa/Lagos' },
    });
    orgId = org.id;
    await prisma.hostedAgentConfig.create({
      data: { organizationId: orgId, agentId: 'agent_recognition_test', apiKey: encryptSecret('sk_tenant_recognition') },
    });
    await prisma.telephonyConfig.create({
      data: { organizationId: orgId, provider: 'SIP_TRUNK', phoneNumber: `+23480${String(Date.now()).slice(-8)}` },
    });
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.SIP_BRIDGE_SECRET;
    else process.env.SIP_BRIDGE_SECRET = saved;
    await prisma.telephonyConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  });

  const service = (lookedUp: any) => {
    const filters: any[] = [];
    const now = Math.floor(Date.now() / 1000);
    const day = ['c1', 'c2', 'c3', 'c4'].map((id, i) => ({
      conversationId: id,
      status: 'done',
      terminationReason: 'end_call tool was called.',
      direction: 'inbound',
      conversationInitiationSource: 'sip_trunk',
      startTimeUnixSecs: now - 3600 + i * 60,
    }));
    const api = new ElevenLabsApi();
    (api as any).for = () => ({
      conversationalAi: {
        conversations: {
          list: async (req: any, opts?: any) => {
            if (opts?.queryParams) {
              filters.push({ req, opts });
              if (lookedUp instanceof Error) throw lookedUp;
              return { conversations: lookedUp.map((id: string) => ({ conversationId: id })), hasMore: false };
            }
            return { conversations: day, hasMore: false };
          },
        },
      },
    });
    return { svc: new ElevenLabsAgentService(api), filters };
  };

  it('asks ElevenLabs, for THIS agent only, which calls carried the lookup, and reports the misses', async () => {
    const { svc, filters } = service(['c1']);
    const health = await svc.getCallHealth(orgId, 24, { fresh: true });
    expect(filters).toHaveLength(1);
    expect(filters[0].req.agentId).toBe('agent_recognition_test');
    expect(filters[0].opts.queryParams).toEqual({ dynamic_variable_params: 'sip_callerstatus:neq:' });
    expect(health.recognition).toMatchObject({ expected: true, inboundCalls: 4, lookedUp: 1, missed: 3, alert: true });
  });

  it('a lookup that cannot be read is unknown, and the rest of the report still comes back', async () => {
    const { svc } = service(new Error('ElevenLabs refused the filter'));
    const health = await svc.getCallHealth(orgId, 24, { fresh: true });
    expect(health.recognition).toBeNull();
    expect(health).toMatchObject({ total: 4, normal: 4 });
  });
});
