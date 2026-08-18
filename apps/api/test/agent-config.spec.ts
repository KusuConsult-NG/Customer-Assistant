/**
 * The generated ElevenLabs agent configuration.
 *
 * This tests a config file, which is unusual, but the properties here are the
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
 *  - Every tool must carry the tenant's key, because that is the only thing
 *    telling the platform which organization it is acting for.
 *
 *  - The prompt must keep the honesty rules the platform enforces server-side.
 *    They are belt and braces: the tools refuse to fabricate, and the prompt
 *    tells the agent not to try.
 */

const { tools, CALLER_VARIABLE, SYSTEM_PROMPT } = require('../../../scripts/generate-agent-config');

const BASE = 'https://api.example.test';
const KEY = 'ace_agent_sk_testkey';

describe('Generated agent configuration', () => {
  const all = tools(BASE, KEY);

  const props = (tool: any) => tool.api_schema.request_body_schema.properties ?? {};

  it('defines every tool the platform exposes', () => {
    expect(all.map((t: any) => t.name).sort()).toEqual(
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
      const phone = props(tool).phoneNumber;
      if (!phone) continue;

      expect(phone.dynamic_variable).toBe(CALLER_VARIABLE);
      // The schema fields are mutually exclusive. `description` present means
      // the LLM fills it in — which is exactly what must not happen here.
      expect(phone.description).toBeUndefined();
      expect(phone.constant_value).toBeUndefined();
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
    ]) {
      const tool = all.find((t: any) => t.name === name);
      expect(props(tool).phoneNumber?.dynamic_variable).toBe(CALLER_VARIABLE);
    }
  });

  it('sets exactly one value-source per parameter', () => {
    const sources = ['description', 'dynamic_variable', 'constant_value', 'is_system_provided', 'is_omitted'];
    for (const tool of all) {
      for (const [name, schema] of Object.entries<any>(props(tool))) {
        const set = sources.filter((s) => schema[s] !== undefined);
        // Reported as an object so a failure names the offending parameter
        // rather than just "expected 2 to be 1".
        expect({ tool: tool.name, param: name, sources: set }).toEqual({
          tool: tool.name,
          param: name,
          sources: [expect.any(String)],
        });
      }
    }
  });

  it('authenticates every tool with the tenant key', () => {
    for (const tool of all) {
      expect(tool.api_schema.request_headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(tool.api_schema.method).toBe('POST');
      expect(tool.api_schema.url).toBe(`${BASE}/api/agent-tools/${tool.name}`);
    }
  });

  it('never takes an organizationId — the tenant comes from the key alone', () => {
    for (const tool of all) {
      expect(Object.keys(props(tool))).not.toContain('organizationId');
    }
  });

  it('keeps the honesty rules in the prompt', () => {
    // Each of these mirrors a rule the server enforces anyway. If the prompt
    // stops saying them the agent will still be refused by the tools — but it
    // will argue with the customer first.
    expect(SYSTEM_PROMPT).toMatch(/never invent/i);
    expect(SYSTEM_PROMPT).toMatch(/never claim to be human|you are an AI/i);
    expect(SYSTEM_PROMPT).toMatch(/handoff tool.*canTransfer|canTransfer.*true/is);
    expect(SYSTEM_PROMPT).toMatch(/say it as written|do not paraphrase/i);
  });

  it('gives each tool a description an LLM can route on', () => {
    for (const tool of all) {
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});
