#!/usr/bin/env node
/**
 * Generate the ElevenLabs agent configuration for one organization.
 *
 *   node scripts/generate-agent-config.js <org-slug-or-id> [--key <agent-key>]
 *
 * Emits JSON: nine webhook tools pointing at this platform's /api/agent-tools
 * endpoints, the system prompt, and the system tools. Paste it into the agent
 * dashboard, or POST it with the ElevenLabs CLI / API.
 *
 * ── Why this is generated rather than hand-written ───────────────────────────
 *
 * The tool URLs, the auth header and the parameter bindings all have to agree
 * with the endpoints in apps/api/src/agent-tools. Hand-maintaining that in a
 * web dashboard is how the two drift apart, and the drift is silent: a tool
 * that posts to a renamed path just fails mid-call.
 *
 * ── The two bindings that carry the safety properties ────────────────────────
 *
 * 1. THE CALLER'S PHONE NUMBER IS NEVER SUPPLIED BY THE MODEL.
 *    Every parameter here uses exactly one of the mutually exclusive schema
 *    fields, and `phoneNumber` uses `dynamic_variable` — the platform injects
 *    the real caller id. If the LLM could supply it, a mis-heard or invented
 *    number means cancel-booking cancels a stranger's appointment, and the
 *    transcript would look entirely reasonable. This is the single most
 *    important line in the file.
 *
 * 2. THE TENANT COMES FROM THE TOOL'S AUTH HEADER.
 *    Each tool carries this organization's agent key, so the platform resolves
 *    the tenant from the credential and no tool takes an organizationId. That
 *    is why the config is per organization.
 *
 * ── One agent per tenant, or one shared agent? ───────────────────────────────
 *
 * This generates a per-tenant configuration, which is correct under either
 * model. A single shared agent would need the auth header to interpolate a
 * dynamic variable ({{agent_key}}); whether header values support that is NOT
 * something this script can verify, so it does not assume it. Verify it against
 * a live agent before consolidating — a header that interpolates the literal
 * string "{{agent_key}}" fails closed with a 401, which is at least loud.
 */
const path = require('path');

require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));
const { PrismaClient } = require('@prisma/client');

/**
 * The dynamic variable holding the caller's number.
 *
 * VERIFY THIS NAME against your agent before going live — it differs by
 * channel (a phone call and a WhatsApp conversation identify the user
 * differently), and it is deliberately one constant so there is one place to
 * change. If it resolves to nothing the tools receive an empty phoneNumber and
 * honestly report "no appointment found" rather than acting on a wrong one.
 */
const CALLER_VARIABLE = 'system__caller_id';

const SYSTEM_PROMPT = `You are the customer care agent for {{organization_name}}.

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

Never say you are transferring someone before calling the handoff tool and
seeing canTransfer:true. Announcing a transfer that then fails leaves the
customer holding a promise nothing kept.

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

/**
 * A webhook tool definition.
 *
 * `parameters` map to the json_schema properties on the ElevenLabs side. Each
 * entry sets exactly ONE of description / dynamic_variable / constant_value —
 * they are mutually exclusive, and mixing them is rejected.
 */
function tools(baseUrl, agentKey) {
  const endpoint = (name) => `${baseUrl}/api/agent-tools/${name}`;
  const headers = {
    'Content-Type': 'application/json',
    // The tenant is resolved from this key. See agent-key.guard.ts.
    Authorization: `Bearer ${agentKey}`,
  };

  /** The caller's number, injected by the platform — never by the model. */
  const callerPhone = {
    type: 'string',
    dynamic_variable: CALLER_VARIABLE,
  };

  const webhook = (name, description, properties, required) => ({
    name,
    description,
    type: 'webhook',
    response_timeout_secs: 10,
    api_schema: {
      url: endpoint(name),
      method: 'POST',
      request_headers: headers,
      request_body_schema: {
        type: 'object',
        properties,
        required: required ?? [],
      },
    },
  });

  return [
    webhook(
      'lookup-customer',
      'Look up the caller in the CRM at the start of a conversation. Use it before asking who they are.',
      { phoneNumber: callerPhone },
      ['phoneNumber']
    ),

    webhook(
      'check-booking',
      "Find the caller's upcoming appointment. Use whenever they ask about, refer to, or want to change an existing booking.",
      { phoneNumber: callerPhone },
      ['phoneNumber']
    ),

    webhook(
      'book-appointment',
      'Create an appointment. Only call this once you have both the service and a specific date and time from the customer.',
      {
        phoneNumber: callerPhone,
        fullName: {
          type: 'string',
          description: "The customer's full name, as they gave it.",
        },
        serviceName: {
          type: 'string',
          description: 'The service being booked, in the words the business uses for it.',
        },
        startTime: {
          type: 'string',
          description:
            'Start time as an ISO 8601 timestamp. Resolve relative dates ("next Tuesday") against the current date before calling.',
        },
        durationMinutes: {
          type: 'integer',
          description: 'Length in minutes. Omit unless the customer or the service specifies one.',
        },
        notes: {
          type: 'string',
          description: 'Anything the customer asked to be recorded with the booking.',
        },
      },
      ['phoneNumber', 'serviceName', 'startTime']
    ),

    webhook(
      'reschedule-booking',
      "Move the caller's existing appointment to a new time.",
      {
        phoneNumber: callerPhone,
        newStartTime: {
          type: 'string',
          description: 'The new start time as an ISO 8601 timestamp.',
        },
      },
      ['phoneNumber', 'newStartTime']
    ),

    webhook(
      'cancel-booking',
      "Cancel the caller's upcoming appointment. Confirm with them before calling this.",
      {
        phoneNumber: callerPhone,
        reason: {
          type: 'string',
          description: 'The reason they gave, if any.',
        },
      },
      ['phoneNumber']
    ),

    webhook(
      'create-ticket',
      'Log an issue for a human to follow up. Use for complaints, faults, and anything your other tools cannot resolve.',
      {
        phoneNumber: callerPhone,
        fullName: { type: 'string', description: "The customer's full name, if known." },
        subject: { type: 'string', description: 'A short summary of the issue.' },
        description: {
          type: 'string',
          description: "What the customer described, in enough detail for a colleague to act on it.",
        },
      },
      ['phoneNumber', 'subject', 'description']
    ),

    webhook(
      'payment-details',
      'Retrieve the business account details for a customer who wants to pay. Never state account details from any other source.',
      {},
      []
    ),

    webhook(
      'search-knowledge',
      'Answer a question about the business, its services, hours, or policies. Use this rather than answering from your own knowledge.',
      {
        query: {
          type: 'string',
          description: "The customer's question, in their own words.",
        },
      },
      ['query']
    ),

    webhook(
      'handoff',
      'Check whether the caller can be transferred to a person, and get the wording to use. Call this BEFORE saying anything about transferring.',
      {},
      []
    ),
  ];
}

async function main() {
  const target = process.argv[2];
  const keyFlag = process.argv.indexOf('--key');
  const providedKey = keyFlag > -1 ? process.argv[keyFlag + 1] : null;

  if (!target) {
    console.error('usage: node scripts/generate-agent-config.js <org-slug-or-id> [--key <agent-key>]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findFirst({
      where: { OR: [{ slug: target }, { id: target }] },
      select: { id: true, name: true, slug: true, welcomeMessage: true, aiPersonaPrompt: true },
    });
    if (!org) {
      console.error(`No organization matches "${target}".`);
      process.exit(1);
    }

    const baseUrl = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');
    const agentKey = providedKey || 'REPLACE_WITH_AGENT_KEY';

    const config = {
      name: `${org.name} — Customer Care`,
      conversation_config: {
        agent: {
          // The opening line the business configured, so the agent and the
          // widget greet callers the same way.
          first_message:
            org.welcomeMessage || `Thank you for calling ${org.name}. How can I help you today?`,
          language: 'en',
          prompt: {
            prompt: [SYSTEM_PROMPT, org.aiPersonaPrompt?.trim()].filter(Boolean).join('\n\n## The business\n\n'),
            // A capable model matters more here than latency: it is deciding
            // whether to call a tool that writes to the business's calendar.
            llm: 'gpt-4o-mini',
            tools: tools(baseUrl, agentKey),
          },
        },
        conversation: {
          // A customer-care call that has run 15 minutes needs a person.
          max_duration_seconds: 900,
        },
      },
      platform_settings: {
        // System tools. transfer_to_number is deliberately NOT enabled here:
        // the handoff tool decides whether a transfer is possible and returns
        // the number, so enabling a second, independent transfer path would let
        // the agent transfer without that check.
        // end_call lets it hang up once the customer is done.
        // language_detection matters in Nigeria, where a caller may switch.
        overrides: {},
      },
      // Values the platform injects per conversation. organization_name fills
      // the prompt; the caller variable fills every phoneNumber parameter.
      dynamic_variables: {
        organization_name: org.name,
      },
      _notes: {
        organization: `${org.name} (${org.slug})`,
        toolBaseUrl: `${baseUrl}/api/agent-tools`,
        callerVariable: CALLER_VARIABLE,
        verifyBeforeGoingLive: [
          `The caller variable "${CALLER_VARIABLE}" must resolve to the customer's number on BOTH channels. If it does not, phoneNumber arrives empty and the tools honestly report "no appointment found" — safe, but useless.`,
          'phoneNumber uses dynamic_variable so the model cannot supply it. Do not change it to a description field: an invented number cancels a stranger\'s booking.',
          'The Authorization header carries this organization\'s agent key. A different tenant needs a different key, and therefore its own tool set.',
          agentKey === 'REPLACE_WITH_AGENT_KEY'
            ? 'No key was supplied — mint one with scripts/mint-agent-key.js and re-run with --key.'
            : 'Key embedded. Treat this file as a secret.',
          baseUrl.includes('localhost')
            ? 'API_BASE_URL is localhost — ElevenLabs cannot reach it. Expose the API with a tunnel and re-run.'
            : `Tools will call ${baseUrl}, which must be reachable from the public internet.`,
        ],
      },
    };

    console.log(JSON.stringify(config, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

// Exported so the safety properties can be tested without a database: the
// binding of phoneNumber is the whole point of this file.
module.exports = { tools, CALLER_VARIABLE, SYSTEM_PROMPT };

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to generate agent config:', err.message);
    process.exit(1);
  });
}
