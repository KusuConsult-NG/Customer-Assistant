/**
 * Contracts derived from the ElevenLabs SDK's own type definitions.
 *
 * The types are checked by the compiler. What these tests hold are the two
 * runtime properties the compiler cannot express, both of which produce a
 * wrong booking rather than an error when they are missing:
 *
 *   - the caller's identity is bound, never asked of the model
 *   - the agent is told what day it is
 */

import {
  agentDefinition,
  webhookTool,
  boundTo,
  askedOf,
} from '../src/agent-tools/elevenlabs-contracts';

describe('ElevenLabs contracts', () => {
  describe('agent definition', () => {
    const valid = {
      name: 'Test agent',
      firstMessage: 'Hello',
      systemPrompt: 'Be helpful',
      toolIds: ['tool_1'],
      timezone: 'Africa/Lagos',
    };

    it('refuses to build an agent with no timezone', () => {
      // The SDK's own words: without a timezone the agent "has no knowledge of
      // the current date/time ... which can lead to incorrect or hallucinated
      // time references". Our booking tool asks the model to resolve "next
      // Tuesday" into a timestamp, so an unset timezone is a booking on an
      // invented day — which reads as a perfectly normal call.
      expect(() => agentDefinition({ ...valid, timezone: '' })).toThrow(/timezone is required/i);
    });

    it('passes the timezone through to the prompt', () => {
      const def = agentDefinition(valid);
      expect(def.conversationConfig.agent.prompt.timezone).toBe('Africa/Lagos');
    });

    it('references tools by id and never inlines them', () => {
      const def = agentDefinition(valid);
      expect(def.conversationConfig.agent.prompt.toolIds).toEqual(['tool_1']);
      // `prompt.tools` is deprecated in favour of tool_ids. Emitting both, or
      // the wrong one, is how the agent ends up with no tools at all.
      expect(def.conversationConfig.agent.prompt).not.toHaveProperty('tools');
    });
  });

  describe('webhook tool', () => {
    const base = {
      name: 'check-booking',
      description: "Find the caller's upcoming appointment.",
      url: 'https://api.example.test/api/agent-tools/check-booking',
      headers: { Authorization: 'Bearer ace_agent_sk_x' },
    };

    it('binds a parameter to a dynamic variable rather than describing it', () => {
      const tool = webhookTool({
        ...base,
        parameters: { phoneNumber: boundTo('system__caller_id') },
        required: ['phoneNumber'],
      });

      const props: any = (tool.toolConfig as any).apiSchema.requestBodySchema.properties;
      expect(props.phoneNumber.dynamicVariable).toBe('system__caller_id');
      // Exactly one value source may be set; `description` present would mean
      // the model supplies the number.
      expect(props.phoneNumber.description).toBeUndefined();
    });

    it('lets the model supply only what it actually heard', () => {
      const tool = webhookTool({
        ...base,
        name: 'book-appointment',
        parameters: {
          phoneNumber: boundTo('system__caller_id'),
          serviceName: askedOf('string', 'The service being booked.'),
        },
      });

      const props: any = (tool.toolConfig as any).apiSchema.requestBodySchema.properties;
      expect(props.serviceName.description).toBeTruthy();
      expect(props.serviceName.dynamicVariable).toBeUndefined();
    });

    it('rejects a timeout outside the range the API accepts', () => {
      expect(() => webhookTool({ ...base, parameters: {}, timeoutSecs: 2 })).toThrow(/between 5 and 300/);
      expect(() => webhookTool({ ...base, parameters: {}, timeoutSecs: 301 })).toThrow(/between 5 and 300/);
      expect(() => webhookTool({ ...base, parameters: {}, timeoutSecs: 10 })).not.toThrow();
    });

    it('uses the SDK camelCase the wire conversion depends on', () => {
      const tool = webhookTool({ ...base, parameters: { phoneNumber: boundTo('system__caller_id') } });
      const cfg: any = tool.toolConfig;
      // Hand-written snake_case is silently dropped by the SDK, taking the
      // phone-number binding with it.
      expect(cfg.apiSchema).toBeDefined();
      expect(cfg.api_schema).toBeUndefined();
      expect(cfg.apiSchema.requestBodySchema).toBeDefined();
      expect(cfg.apiSchema.request_body_schema).toBeUndefined();
    });
  });
});
