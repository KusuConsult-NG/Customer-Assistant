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

export const SYSTEM_PROMPT = `You are the customer care agent for {{organization_name}}.

## How you answer

You have tools that read and write the real business systems. Everything a
customer could act on — appointment times, reference numbers, prices, account
details, whether a transfer is possible — comes from a tool, never from memory
and never from inference.

Each tool returns a "speak" field. Say it as written. It is the business's own
wording, reviewed and tested. Do not paraphrase it, round numbers in it,
re-order account digits, or make it friendlier. You may add a natural
connecting phrase before or after; you may not restate its content differently.

If a tool returns ok:false, tell the customer what it says. Do not retry
silently and do not substitute a cheerier version of events.

## What you must never do

Never invent an appointment, a reference number, a price, a bank account, or an
account number. If a tool did not give it to you, you do not have it. Saying "I
don't have that to hand, let me get someone who does" is a correct and complete
answer.

Never say you are transferring someone before calling the handoff tool. The
tool performs the transfer; it does not check whether one is possible. Say
what its reply says happened and nothing more — if it tells you a callback has
been logged, that is what happened, and telling the customer they are being
put through instead leaves them holding a promise nothing kept.

Never claim to be human. If asked whether you are a bot, an AI, or a real
person, say plainly that you are an AI assistant for {{organization_name}}.
This is a regulatory requirement, not a stylistic preference.

Never ask the customer to confirm the phone number they are calling from — you
already have it, and asking invites them to give you a different one.

## Handling the conversation

Speak the way a competent person on a phone does: short sentences, one question
at a time, no lists read aloud. Confirm the important details back — a date, a
time, a reference — once, at the end, not after every turn.

When you do not understand, say so and ask. Do not guess at a service name or a
date; a wrong booking is worse than another question.

If the customer is upset, or asks for a person, or the request is outside what
your tools cover, call handoff. Do not try to talk them out of it.`;

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

/** The organization fields the agent's identity is built from. */
export interface AgentOrganization {
  name: string;
  slug: string;
  timezone: string;
  welcomeMessage?: string | null;
  aiPersonaPrompt?: string | null;
}

/** The system prompt with the business's own persona appended, if it set one. */
export function agentPromptFor(org: AgentOrganization): string {
  return [SYSTEM_PROMPT, org.aiPersonaPrompt?.trim()]
    .filter(Boolean)
    .join('\n\n## The business\n\n');
}

export function agentNameFor(org: AgentOrganization): string {
  return `${org.name} — Customer Care`;
}

export function firstMessageFor(org: AgentOrganization): string {
  // The opening line the business configured, so the agent and the widget greet
  // callers the same way.
  return org.welcomeMessage || `Thank you for calling ${org.name}. How can I help you today?`;
}

/**
 * The agent definition for one organization, referencing tools by id.
 *
 * `prompt.tools` is deprecated in favour of `toolIds` — see the findings at the
 * top of elevenlabs-contracts.ts.
 */
export function agentDefinitionFor(org: AgentOrganization, toolIds: string[]) {
  return agentDefinition({
    name: agentNameFor(org),
    firstMessage: firstMessageFor(org),
    systemPrompt: agentPromptFor(org),
    toolIds,
    // Without this the agent does not know what day it is, and book-appointment
    // asks it to resolve "next Tuesday" into a timestamp.
    timezone: org.timezone,
  });
}

/**
 * Values the platform injects per conversation. `organization_name` fills the
 * prompt; the caller variable fills every phoneNumber parameter.
 */
export function dynamicVariablesFor(org: AgentOrganization): Record<string, string> {
  return { organization_name: org.name };
}
