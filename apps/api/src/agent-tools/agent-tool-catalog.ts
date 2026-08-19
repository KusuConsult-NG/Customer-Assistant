/**
 * The one description of what the hosted agent can do.
 *
 * Nine webhook tools pointing at this platform's /api/agent-tools endpoints,
 * plus the system prompt that governs how their results are spoken. Both the
 * live sync (ElevenLabsAgentService) and the offline generator
 * (scripts/generate-agent-config.js) read this module, so there is exactly one
 * place where a tool's URL, parameters and bindings are written down.
 *
 * That mattered enough to move here: the previous copy lived in the generator
 * script, which meant the config an operator pasted into the dashboard and the
 * config the API would push were two hand-maintained lists of the same thing.
 * They agree today. They would not have agreed after the first rename, and the
 * disagreement is silent — a tool posting to a renamed path just fails mid-call.
 *
 * ── The two bindings that carry the safety properties ────────────────────────
 *
 * 1. THE CALLER'S PHONE NUMBER IS NEVER SUPPLIED BY THE MODEL. `phoneNumber`
 *    uses `dynamicVariable`, so the platform injects the real caller id. If the
 *    LLM could supply it, a mis-heard or invented number means cancel-booking
 *    cancels a stranger's appointment — and the transcript would read as a
 *    perfectly normal call.
 *
 * 2. THE TENANT COMES FROM THE TOOL'S AUTH HEADER. Each tool carries this
 *    organization's agent key, so the platform resolves the tenant from the
 *    credential and no tool takes an organizationId. That is why the catalogue
 *    is built per organization.
 */
import type { ElevenLabs } from '@elevenlabs/elevenlabs-js';
import {
  agentDefinition,
  askedOf,
  boundTo,
  webhookTool,
  type HeaderValue,
  type ToolParameter,
} from './elevenlabs-contracts';

/**
 * The dynamic variable holding the caller's number.
 *
 * VERIFY THIS NAME against a live agent before going live — it differs by
 * channel (a phone call and a WhatsApp conversation identify the user
 * differently), and it is deliberately one constant so there is one place to
 * change. If it resolves to nothing the tools receive an empty phoneNumber and
 * honestly report "no appointment found" rather than acting on a wrong one.
 */
export const CALLER_VARIABLE = 'system__caller_id';

/**
 * The dynamic variable holding this conversation's id.
 *
 * It is what lets `handoff` find the live call and actually move it, rather
 * than announcing a transfer nothing performed. Same caveat as the name above,
 * and the same reason it is a single constant.
 *
 * If it resolves to nothing the tool does NOT degrade into a false promise: it
 * files a callback ticket and says so. That is why the parameter is optional —
 * an unrecognised variable name must not turn the one tool a distressed
 * customer reaches for into a hard failure.
 */
export const CONVERSATION_VARIABLE = 'system__conversation_id';

export const SYSTEM_PROMPT = `You are a real, warm, experienced team member at {{organization_name}} — not a robot, not a virtual assistant, not a chatbot. You are a person who genuinely wants to help.

## How You Sound

Speak the way a caring, experienced human helpline officer does:
- Use natural, flowing sentences — not lists, not bullet points, not numbered steps read aloud.
- Pause naturally between thoughts.
- Respond to the caller's emotions first, information second. If someone sounds stressed or upset, acknowledge that before doing anything else.
- Use connecting phrases like "Of course", "Absolutely", "Let me sort that out for you right now", "I completely understand", "Don't worry, we'll get this sorted."
- Keep responses short and focused — say the most important thing, then pause and check if the caller is following.
- Ask one question at a time. Never fire multiple questions at once.
- Never say "I am an AI", "I am a virtual assistant", "as a language model", or anything similar. If someone asks if you are a robot, say warmly: "No, I'm Sarah — one of the team here at {{organization_name}}. How can I help you?"

## How You Use Tools

You have tools that look up real records, book appointments, log complaints, and find information. Always use them — never guess or make up a detail.

When a tool gives you a result, say it the way a human would — not as a copy-paste of the raw data. For example, instead of saying "The tool returned: status: ACTIVE, plan: INFORMAL", say "Yes! You are an active enrollee on our Informal Sector plan — great news."

If a tool returns an error or no result, be honest and helpful: "I wasn't able to pull that up right now — let me try a different way", or offer an alternative path.

## Conversation Principles

- If a caller is confused, simplify — use an analogy if it helps.
- If a caller is angry, never get defensive. Say: "You are completely right to be frustrated. Let me fix this for you right now."
- If you don't know something, say: "Let me look that up for you" and use the search-knowledge tool.
- Never promise a transfer before completing the handoff tool. Call the tool first, then tell the caller what happened.
- Never ask the caller to confirm their phone number — you already have their caller ID from the system.
- Always end by giving the caller a reference number if any action was taken, and close warmly.`;


/** Every tool this platform exposes, in a fixed order. */
export const TOOL_NAMES = [
  'lookup-customer',
  'check-booking',
  'book-appointment',
  'reschedule-booking',
  'cancel-booking',
  'create-ticket',
  'payment-details',
  'search-knowledge',
  'handoff',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface CatalogOptions {
  /** Public base URL of this API. Tools are called from ElevenLabs' servers. */
  baseUrl: string;
  /** Value for the Authorization header: a literal, or a workspace secret. */
  authorization: HeaderValue;
  /**
   * Distinguishes this tenant's tools in a shared workspace. Tools are
   * workspace-scoped resources, so nine bare `check-booking` entries in a list
   * of ninety is an invitation to attach the wrong one — and the wrong one
   * means an agent writing to another tenant's calendar.
   */
  namePrefix?: string;
}

/** The remote name of a tool, which is what an operator sees in the dashboard. */
export function remoteToolName(tool: ToolName, namePrefix?: string): string {
  return namePrefix ? `${namePrefix}__${tool}` : tool;
}

/**
 * Build every tool definition for one organization, keyed by the local tool
 * name (which is also its URL path segment — they are the same string by
 * construction, so they cannot drift).
 */
export function agentToolCatalog(
  opts: CatalogOptions
): Record<ToolName, ElevenLabs.ToolRequestModel> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, HeaderValue> = {
    'Content-Type': 'application/json',
    // The tenant is resolved from this. See agent-key.guard.ts.
    Authorization: opts.authorization,
  };

  /** The caller's number, injected by the platform — never by the model. */
  const callerPhone: ToolParameter = boundTo(CALLER_VARIABLE);

  const build = (
    name: ToolName,
    description: string,
    parameters: Record<string, ToolParameter>,
    required: string[] = []
  ): ElevenLabs.ToolRequestModel =>
    webhookTool({
      name: remoteToolName(name, opts.namePrefix),
      description,
      url: `${base}/api/agent-tools/${name}`,
      headers,
      parameters,
      required,
    });

  return {
    'lookup-customer': build(
      'lookup-customer',
      'Look up the caller in the CRM at the start of a conversation. Use it before asking who they are.',
      { phoneNumber: callerPhone },
      ['phoneNumber']
    ),

    'check-booking': build(
      'check-booking',
      "Find the caller's upcoming appointment. Use whenever they ask about, refer to, or want to change an existing booking.",
      { phoneNumber: callerPhone },
      ['phoneNumber']
    ),

    'book-appointment': build(
      'book-appointment',
      'Create an appointment. Only call this once you have both the service and a specific date and time from the customer.',
      {
        phoneNumber: callerPhone,
        fullName: askedOf('string', "The customer's full name, as they gave it."),
        serviceName: askedOf(
          'string',
          'The service being booked, in the words the business uses for it.'
        ),
        startTime: askedOf(
          'string',
          'Start time as an ISO 8601 timestamp. Resolve relative dates ("next Tuesday") against the current date before calling.'
        ),
        durationMinutes: askedOf(
          'integer',
          'Length in minutes. Omit unless the customer or the service specifies one.'
        ),
        notes: askedOf('string', 'Anything the customer asked to be recorded with the booking.'),
      },
      ['phoneNumber', 'serviceName', 'startTime']
    ),

    'reschedule-booking': build(
      'reschedule-booking',
      "Move the caller's existing appointment to a new time.",
      {
        phoneNumber: callerPhone,
        newStartTime: askedOf('string', 'The new start time as an ISO 8601 timestamp.'),
      },
      ['phoneNumber', 'newStartTime']
    ),

    'cancel-booking': build(
      'cancel-booking',
      "Cancel the caller's upcoming appointment. Confirm with them before calling this.",
      {
        phoneNumber: callerPhone,
        reason: askedOf('string', 'The reason they gave, if any.'),
      },
      ['phoneNumber']
    ),

    'create-ticket': build(
      'create-ticket',
      'Log an issue for a human to follow up. Use for complaints, faults, and anything your other tools cannot resolve.',
      {
        phoneNumber: callerPhone,
        fullName: askedOf('string', "The customer's full name, if known."),
        subject: askedOf('string', 'A short summary of the issue.'),
        description: askedOf(
          'string',
          'What the customer described, in enough detail for a colleague to act on it.'
        ),
      },
      ['phoneNumber', 'subject', 'description']
    ),

    'payment-details': build(
      'payment-details',
      'Retrieve the business account details for a customer who wants to pay. Never state account details from any other source.',
      {}
    ),

    'search-knowledge': build(
      'search-knowledge',
      'Answer a question about the business, its services, hours, or policies. Use this rather than answering from your own knowledge.',
      { query: askedOf('string', "The customer's question, in their own words.") },
      ['query']
    ),

    handoff: build(
      'handoff',
      'Put the caller through to a person. This ATTEMPTS the transfer — do not say anything about transferring before calling it, and then say only what its reply says happened.',
      {
        phoneNumber: callerPhone,
        conversationId: boundTo(CONVERSATION_VARIABLE),
        reason: askedOf(
          'string',
          'What the customer was asking about, in a few words, so the team has context.'
        ),
      },
      // Nothing is required: the tool is correct with none of it. Marking the
      // conversation id required would make an unrecognised variable name a
      // hard failure of the one tool a distressed customer reaches for.
      []
    ),
  };
}

/** Persona definitions matching ElevenLabs voice characters */
export interface TeamPersona {
  id: string;
  name: string;
  gender: 'female' | 'male';
  voiceId: string;
  greetingPhrase: string;
  description: string;
}

export const TEAM_PERSONAS: Record<string, TeamPersona> = {
  sarah: {
    id: 'sarah',
    name: 'Sarah',
    gender: 'female',
    voiceId: 'EXAVITQu4vr4xnSDxMaL',
    greetingPhrase: 'my name is Sarah',
    description: 'Warm, reassuring, and professional',
  },
  eric: {
    id: 'eric',
    name: 'Eric',
    gender: 'male',
    voiceId: 'cjVigY5qzO86Huf0OWal',
    greetingPhrase: 'this is Eric',
    description: 'Smooth, calm, and trustworthy',
  },
  jessica: {
    id: 'jessica',
    name: 'Jessica',
    gender: 'female',
    voiceId: 'cgSgspJ2msm6clMCkdW9',
    greetingPhrase: "I'm Jessica",
    description: 'Bright, friendly, and approachable',
  },
  roger: {
    id: 'roger',
    name: 'Roger',
    gender: 'male',
    voiceId: 'CwhRBWXzGAHq8TQ4Fs17',
    greetingPhrase: 'my name is Roger',
    description: 'Resonant, casual, and experienced',
  },
  matilda: {
    id: 'matilda',
    name: 'Matilda',
    gender: 'female',
    voiceId: 'XrExE9yKIg1WjnnlVkGX',
    greetingPhrase: 'my name is Matilda',
    description: 'Poised, articulate, and knowledgeable',
  },
};

export function resolvePersona(nameOrId?: string | null): TeamPersona {
  const key = (nameOrId || process.env.ELEVENLABS_PERSONA || 'sarah').toLowerCase().trim();
  return TEAM_PERSONAS[key] || Object.values(TEAM_PERSONAS).find(p => p.name.toLowerCase() === key) || TEAM_PERSONAS.sarah;
}

/** The organization fields the agent's identity is built from. */
export interface AgentOrganization {
  name: string;
  slug: string;
  timezone: string;
  welcomeMessage?: string | null;
  aiPersonaPrompt?: string | null;
  persona?: string | null;
  voiceId?: string | null;
}

/** The system prompt with the chosen persona identity and business rules appended. */
export function agentPromptFor(org: AgentOrganization, persona?: TeamPersona): string {
  const resolved = persona || resolvePersona(org.persona);
  const personaHeader = `You are ${resolved.name}, a dedicated customer service team member at {{organization_name}}.\nIntroduce yourself as ${resolved.name} when asked who is speaking or when greeting the customer.\nConverse consistently as ${resolved.name} throughout the entire call.`;

  return [personaHeader, SYSTEM_PROMPT, org.aiPersonaPrompt?.trim()]
    .filter(Boolean)
    .join('\n\n## The business\n\n');
}

export function agentNameFor(org: AgentOrganization, persona?: TeamPersona): string {
  const resolved = persona || resolvePersona(org.persona);
  return `${org.name} — ${resolved.name}`;
}

export function firstMessageFor(org: AgentOrganization, persona?: TeamPersona): string {
  const resolved = persona || resolvePersona(org.persona);
  if (org.welcomeMessage && org.welcomeMessage.includes('{name}')) {
    return org.welcomeMessage.replace('{name}', resolved.name);
  }
  return `Hello! Thank you for calling ${org.name}, ${resolved.greetingPhrase}. How can I help you today?`;
}

/**
 * The agent definition for one organization, referencing tools by id.
 */
export function agentDefinitionFor(org: AgentOrganization, toolIds: string[], customPersona?: TeamPersona) {
  const persona = customPersona || resolvePersona(org.persona);
  const voiceId = org.voiceId || persona.voiceId;

  return agentDefinition({
    name: agentNameFor(org, persona),
    firstMessage: firstMessageFor(org, persona),
    systemPrompt: agentPromptFor(org, persona),
    voiceId,
    toolIds,
    timezone: org.timezone,
  });
}

/**
 * Values the platform injects per conversation. `organization_name` fills the
 * prompt; the caller variable fills every phoneNumber parameter.
 */
export function dynamicVariablesFor(org: AgentOrganization, persona?: TeamPersona): Record<string, string> {
  const resolved = persona || resolvePersona(org.persona);
  return { 
    organization_name: org.name,
    representative_name: resolved.name
  };
}
