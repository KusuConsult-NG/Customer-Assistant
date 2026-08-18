/**
 * The agent tool catalogue.
 *
 * This tests configuration, which is unusual, but the properties here are the
 * ones that decide whether the agent can hurt a customer:
 *
 *  - The caller's phone number must be injected by the platform, never
 *    supplied by the model. Every customer-identifying tool takes phoneNumber,
 *    and the platform acts on whatever it receives. A mis-heard or invented
 *    number means cancel-booking cancels a stranger's appointment, and the
 *    transcript reads as a completely normal call. The schema fields are
 *    mutually exclusive, so "bound" and "model-supplied" is a one-word
 *    difference in a JSON file that nobody re-reads.
 *
 *  - Every tool must carry the tenant's credential, because that is the only
 *    thing telling the platform which organization it is acting for.
 *
 *  - The prompt must keep the honesty rules the platform enforces server-side.
 *    They are belt and braces: the tools refuse to fabricate, and the prompt
 *    tells the agent not to try.
 *
 * These used to test scripts/generate-agent-config.js, which held its own copy
 * of the definitions. Both the script and the live sync now read this module,
 * so testing it covers both.
 */

import {
  agentDefinitionFor,
  agentToolCatalog,
  CALLER_VARIABLE,
  remoteToolName,
  SYSTEM_PROMPT,
  TOOL_NAMES,
  type AgentOrganization,
} from '../src/agent-tools/agent-tool-catalog';
import { fromSecret } from '../src/agent-tools/elevenlabs-contracts';

const BASE = 'https://api.example.test';
const SECRET = 'secret_abc123';

const ORG: AgentOrganization = {
  name: 'Test Clinic',
  slug: 'test-clinic',
  timezone: 'Africa/Lagos',
  welcomeMessage: null,
  aiPersonaPrompt: null,
};

describe('Agent tool catalogue', () => {
  const catalog = agentToolCatalog({
    baseUrl: BASE,
    authorization: fromSecret(SECRET),
    namePrefix: ORG.slug,
  });
  const all = TOOL_NAMES.map((name) => catalog[name]);

  const cfg = (tool: any) => tool.toolConfig;
  const props = (tool: any) => cfg(tool).apiSchema.requestBodySchema?.properties ?? {};

  it('defines every tool the platform exposes', () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [
        'book-appointment',
        'cancel-booking',
        'check-booking',
        'create-ticket',
        'handoff',
        'lookup-customer',
        'payment-details',
        'reschedule-booking',
        'search-knowledge',
      ].sort()
    );
  });

  it('never lets the model supply the caller phone number', () => {
    for (const tool of all) {
      const phone: any = props(tool).phoneNumber;
      if (!phone) continue;

      expect(phone.dynamicVariable).toBe(CALLER_VARIABLE);
      // The schema fields are mutually exclusive. `description` present means
      // the LLM fills it in — which is exactly what must not happen here.
      expect(phone.description).toBeUndefined();
      expect(phone.constantValue).toBeUndefined();
    }
  });

  it('binds the phone number on every tool that acts on a specific customer', () => {
    // If one of these ever stops taking a bound phoneNumber, it is either
    // reading someone else's data or no longer scoped to the caller at all.
    for (const name of [
      'lookup-customer',
      'check-booking',
      'book-appointment',
      'reschedule-booking',
      'cancel-booking',
      'create-ticket',
    ] as const) {
      expect((props(catalog[name]).phoneNumber as any)?.dynamicVariable).toBe(CALLER_VARIABLE);
    }
  });

  it('sets exactly one value-source per parameter', () => {
    const sources = [
      'description',
      'dynamicVariable',
      'constantValue',
      'isSystemProvided',
      'isOmitted',
    ];
    for (const tool of all) {
      for (const [name, schema] of Object.entries<any>(props(tool))) {
        const set = sources.filter((s) => schema[s] !== undefined);
        // Reported as an object so a failure names the offending parameter
        // rather than just "expected 2 to be 1".
        expect({ tool: cfg(tool).name, param: name, sources: set }).toEqual({
          tool: cfg(tool).name,
          param: name,
          sources: [expect.any(String)],
        });
      }
    }
  });

  it('authenticates every tool with the tenant credential and posts to its own path', () => {
    for (const name of TOOL_NAMES) {
      const schema = cfg(catalog[name]).apiSchema;
      expect(schema.requestHeaders.Authorization).toEqual({ secretId: SECRET });
      expect(schema.method).toBe('POST');
      expect(schema.url).toBe(`${BASE}/api/agent-tools/${name}`);
    }
  });

  it('accepts a literal bearer credential for a hand-configured agent', () => {
    const literal = agentToolCatalog({ baseUrl: BASE, authorization: 'Bearer ace_agent_sk_x' });
    expect(cfg(literal.handoff).apiSchema.requestHeaders.Authorization).toBe(
      'Bearer ace_agent_sk_x'
    );
  });

  it('never takes an organizationId — the tenant comes from the credential alone', () => {
    for (const tool of all) {
      expect(Object.keys(props(tool))).not.toContain('organizationId');
    }
  });

  it('distinguishes one tenant from another in a shared workspace', () => {
    // Tools are workspace-scoped. Two tenants with identically named tools is
    // how the wrong one gets attached to an agent — which is one tenant's agent
    // writing to another tenant's calendar.
    const a = agentToolCatalog({ baseUrl: BASE, authorization: fromSecret('s1'), namePrefix: 'aa' });
    const b = agentToolCatalog({ baseUrl: BASE, authorization: fromSecret('s2'), namePrefix: 'bb' });
    expect(cfg(a['check-booking']).name).not.toBe(cfg(b['check-booking']).name);
    expect(cfg(a['check-booking']).name).toBe(remoteToolName('check-booking', 'aa'));
  });

  it('keeps the tool name and its URL path the same string', () => {
    // They are the same identifier by construction. If they ever diverge, a
    // tool posts to a path that does not exist and the failure is mid-call.
    for (const name of TOOL_NAMES) {
      expect(cfg(catalog[name]).apiSchema.url.endsWith(`/${name}`)).toBe(true);
    }
  });

  it('keeps the honesty rules in the prompt', () => {
    // Each of these mirrors a rule the server enforces anyway. If the prompt
    // stops saying them the agent will still be refused by the tools — but it
    // will argue with the customer first.
    expect(SYSTEM_PROMPT).toMatch(/never invent/i);
    expect(SYSTEM_PROMPT).toMatch(/never claim to be human|you are an AI/i);
    // The handoff tool now PERFORMS the transfer rather than reporting whether
    // one is possible, so the prompt's job changed with it: the model must say
    // what the reply says happened, not decide from a flag whether to announce.
    expect(SYSTEM_PROMPT).toMatch(/never say you are transferring someone before calling the handoff tool/i);
    // \s+ rather than literal spaces: the prompt is a wrapped template literal,
    // so any phrase long enough to be worth asserting on straddles a newline.
    expect(SYSTEM_PROMPT).toMatch(/say\s+what\s+its\s+reply\s+says\s+happened/i);
    expect(SYSTEM_PROMPT).toMatch(/say it as written|do not paraphrase/i);
  });

  it('gives each tool a description an LLM can route on', () => {
    for (const tool of all) {
      expect(cfg(tool).description.length).toBeGreaterThan(40);
    }
  });
});

describe('Agent definition', () => {
  it("carries the organization's timezone, so relative dates resolve", () => {
    const def = agentDefinitionFor(ORG, ['t1', 't2']);
    expect(def.conversationConfig.agent.prompt.timezone).toBe('Africa/Lagos');
    expect(def.conversationConfig.agent.prompt.toolIds).toEqual(['t1', 't2']);
  });

  it('refuses to build an agent for an organization with no timezone', () => {
    expect(() => agentDefinitionFor({ ...ORG, timezone: '' }, ['t1'])).toThrow(/timezone/i);
  });

  it("appends the business's own persona rather than replacing the rules", () => {
    const def = agentDefinitionFor({ ...ORG, aiPersonaPrompt: 'We are formal.' }, ['t1']);
    const prompt = def.conversationConfig.agent.prompt.prompt;
    expect(prompt).toContain('We are formal.');
    expect(prompt).toMatch(/never claim to be human/i);
    // The persona comes after, so it cannot pre-empt the honesty rules.
    expect(prompt.indexOf('We are formal.')).toBeGreaterThan(prompt.indexOf('Never claim'));
  });

  it('greets with the configured welcome message when there is one', () => {
    expect(
      agentDefinitionFor({ ...ORG, welcomeMessage: 'Kedu!' }, ['t1']).conversationConfig.agent
        .firstMessage
    ).toBe('Kedu!');
    expect(agentDefinitionFor(ORG, ['t1']).conversationConfig.agent.firstMessage).toContain(
      ORG.name
    );
  });
});
