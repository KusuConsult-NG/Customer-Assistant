/**
 * ElevenLabs Agents contracts, taken from the SDK's own type definitions
 * (@elevenlabs/elevenlabs-js@2.64.0), which are generated from their OpenAPI
 * spec. The published docs site is not reachable from every environment; these
 * types are, and they cannot drift from the API the way prose can.
 *
 * This module exists so A2 (agent create/update) builds against verified
 * shapes rather than plausible-looking ones. Everything below was read out of
 * the SDK, not inferred.
 *
 * ── Four findings, two of which correct code already shipped ────────────────
 *
 * 1. `prompt.tools` IS DEPRECATED — the SDK says outright: "A list of tools
 *    that the agent can use over the course of the conversation, use tool_ids
 *    instead". Tools are first-class resources now: create each one, keep its
 *    id, and reference the ids from the agent. scripts/generate-agent-config.js
 *    emits the deprecated inline shape and needs migrating.
 *
 * 2. THE AGENT DOES NOT KNOW WHAT DAY IT IS unless `prompt.timezone` is set.
 *    Verbatim from the SDK: "without this, the agent has no knowledge of the
 *    current date/time ... which can lead to incorrect or hallucinated time
 *    references." Our book-appointment tool asks the model to turn "next
 *    Tuesday" into an ISO timestamp. Unset, that is a hallucinated date
 *    written into a real calendar — a booking on the wrong day that looks
 *    entirely normal in the transcript. Organizations already carry a
 *    `timezone`; it must be passed through.
 *
 * 3. THE SDK IS camelCase. It converts to the wire's snake_case itself, so
 *    `dynamicVariable` here becomes `dynamic_variable` on the wire. Code that
 *    hand-writes snake_case and passes it to the SDK silently drops those
 *    fields — including the phone-number binding that is the whole safety
 *    property. Use the SDK's casing everywhere and let it do the conversion.
 *
 * 4. `responseTimeoutSecs` must be between 5 and 300 inclusive.
 */
import type { ElevenLabs } from '@elevenlabs/elevenlabs-js';

/**
 * How a tool parameter gets its value. Exactly one of these may be set — the
 * API rejects more than one, and the difference between the first two is the
 * difference between the platform supplying the caller's phone number and the
 * model guessing at it.
 */
export type ParameterSource =
  | { description: string } // the LLM fills it in from the conversation
  | { dynamicVariable: string } // the platform injects it
  | { constantValue: string | number | boolean }
  | { isSystemProvided: true }
  | { isOmitted: true };

/** A parameter in a webhook tool's request body. */
export type ToolParameter = ElevenLabs.LiteralJsonSchemaProperty;

/**
 * Bind a parameter to a dynamic variable, so the platform supplies it.
 *
 * Use this for anything that identifies a customer. A model-supplied phone
 * number means cancel-booking can cancel a stranger's appointment, and nothing
 * in the transcript would look wrong.
 */
export const boundTo = (dynamicVariable: string): ToolParameter => ({
  type: 'string',
  dynamicVariable,
});

/** A parameter the model fills in from what the customer actually said. */
export const askedOf = (
  type: ElevenLabs.LiteralJsonSchemaPropertyType,
  description: string
): ToolParameter => ({ type, description });

/**
 * A header value on a webhook tool. It may be a literal string, or a reference
 * to a workspace secret.
 *
 * Prefer the secret reference for anything credential-shaped. A literal is
 * stored in the tool definition and shown in the ElevenLabs dashboard to
 * everyone with workspace access; a secret reference is resolved at call time
 * and can be rotated without touching a single tool.
 */
export type HeaderValue =
  | string
  | ElevenLabs.ConvAiSecretLocator
  | ElevenLabs.ConvAiDynamicVariable
  | ElevenLabs.ConvAiEnvVarLocator;

/** Reference a workspace secret (`conversationalAi.secrets`) by id. */
export const fromSecret = (secretId: string): ElevenLabs.ConvAiSecretLocator => ({ secretId });

export interface WebhookToolSpec {
  name: string;
  description: string;
  url: string;
  headers: Record<string, HeaderValue>;
  parameters: Record<string, ToolParameter>;
  required?: string[];
  /** 5–300 inclusive. */
  timeoutSecs?: number;
}

/**
 * Build the request for `conversationalAi.tools.create`.
 *
 * Returns one tool. The agent is then created with the resulting ids in
 * `prompt.toolIds` — see finding 1.
 */
export function webhookTool(spec: WebhookToolSpec): ElevenLabs.ToolRequestModel {
  const timeout = spec.timeoutSecs ?? 10;
  if (timeout < 5 || timeout > 300) {
    throw new Error(`responseTimeoutSecs must be between 5 and 300, got ${timeout}`);
  }

  return {
    toolConfig: {
      type: 'webhook',
      name: spec.name,
      description: spec.description,
      responseTimeoutSecs: timeout,
      apiSchema: {
        url: spec.url,
        method: 'POST',
        requestHeaders: spec.headers,
        requestBodySchema: {
          type: 'object',
          properties: spec.parameters,
          required: spec.required ?? [],
        },
      },
    },
  };
}

export interface AgentSpec {
  name: string;
  firstMessage: string;
  systemPrompt: string;
  /** Tool ids from `tools.create` — NOT inline definitions. See finding 1. */
  toolIds: string[];
  /**
   * IANA timezone, e.g. "Africa/Lagos". Required in practice: without it the
   * agent cannot resolve "next Tuesday" and will invent a date. See finding 2.
   */
  timezone: string;
  language?: string;
  voiceId?: string;
  llm?: ElevenLabs.PromptAgentApiModelInput['llm'];
  maxDurationSeconds?: number;
  /**
   * Pronunciation dictionary locators to attach to the TTS engine.
   * Each entry ties a specific dictionary version to this agent so custom
   * phoneme rules (e.g. PLASCHEMA → PLAS-CHEH-MA) survive every sync.
   */
  pronunciationDictionaryLocators?: Array<{ pronunciationDictionaryId: string; versionId: string }>;
}

/** Build the request for `conversationalAi.agents.create`. */
export function agentDefinition(spec: AgentSpec) {
  if (!spec.timezone) {
    // Refusing here rather than defaulting: a wrong timezone silently books
    // customers on the wrong day, and a default would hide that choice.
    throw new Error(
      'timezone is required — without it the agent has no knowledge of the current date and will invent one'
    );
  }

  return {
    name: spec.name,
    conversationConfig: {
      agent: {
        firstMessage: spec.firstMessage,
        language: spec.language ?? 'en',
        prompt: {
          prompt: spec.systemPrompt,
          llm: spec.llm ?? 'gpt-4o-mini',
          toolIds: spec.toolIds,
          timezone: spec.timezone,
        },
      },
      asr: {
        quality: 'high',
        userInputAudioFormat: 'pcm_16000',
      },
      turn: {
        turnTimeout: 7,
        mode: 'turn',
      },
      tts: {
        ...(spec.voiceId ? { voiceId: spec.voiceId } : {}),
        pronunciationDictionaryLocators: spec.pronunciationDictionaryLocators ?? [],
      },
      conversation: {
        maxDurationSeconds: spec.maxDurationSeconds ?? 900,
        clientEvents: ['interruption', 'agent_response', 'user_transcript'],
      },
    },
  };
}

/**
 * Import a Twilio number so ElevenLabs answers it natively — no TwiML, and no
 * media-stream handling on our side.
 *
 * `sid` and `token` are the tenant's Twilio credentials, which we already hold
 * in TelephonyConfig.
 */
export function twilioPhoneNumberImport(args: {
  phoneNumber: string;
  label: string;
  accountSid: string;
  authToken: string;
  agentId?: string;
  supportsInbound?: boolean;
  supportsOutbound?: boolean;
}): ElevenLabs.CreateTwilioPhoneNumberRequest & { provider: 'twilio' } {
  return {
    provider: 'twilio',
    phoneNumber: args.phoneNumber,
    label: args.label,
    sid: args.accountSid,
    token: args.authToken,
    ...(args.agentId ? { agentId: args.agentId } : {}),
    supportsInbound: args.supportsInbound ?? true,
    supportsOutbound: args.supportsOutbound ?? true,
  };
}
