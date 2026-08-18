#!/usr/bin/env node
/**
 * Show exactly what would be pushed to ElevenLabs for one organization,
 * without pushing it.
 *
 *   node scripts/generate-agent-config.js <org-slug-or-id> [--key <agent-key>]
 *
 * ── This is a dry run, not the provisioning path ─────────────────────────────
 *
 * The API provisions agents itself: POST /api/agent-provisioning/sync creates
 * the nine tools, creates or updates the agent, and records the ids. That is
 * the path to use, because it is idempotent and because it records what it did.
 *
 * This script prints the same payloads for inspection and for the case where an
 * operator is setting an agent up by hand in the dashboard. It reads the SAME
 * catalogue the sync reads (apps/api/src/agent-tools/agent-tool-catalog.ts), so
 * the two cannot disagree — which is why this file no longer contains any tool
 * definitions of its own. It used to, and the copy in the API was a second
 * hand-maintained list of the same nine URLs.
 *
 * ── Two shapes worth knowing before you paste anything ───────────────────────
 *
 * 1. TOOLS ARE SEPARATE RESOURCES. `prompt.tools` is deprecated; each tool is
 *    created on its own and the agent references the resulting ids. So the
 *    output has two halves: create the tools first, then create the agent with
 *    their ids. There is no single paste-in-one-box config any more.
 *
 * 2. THIS IS THE SDK'S camelCase. The SDK converts to the wire's snake_case
 *    itself. If you are POSTing this with curl rather than the SDK, convert the
 *    keys — a hand-written camelCase body silently drops fields, including the
 *    `dynamicVariable` binding that stops the model supplying the caller's
 *    phone number.
 */
const path = require('path');

require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const CATALOG_PATH = path.join(
  __dirname,
  '..',
  'apps',
  'api',
  'dist',
  'agent-tools',
  'agent-tool-catalog.js'
);

let catalog;
try {
  catalog = require(CATALOG_PATH);
} catch (err) {
  console.error(
    'Could not load the agent tool catalogue. Build the API first:\n\n' +
      '  npx turbo run build --filter=@ace/api...\n\n' +
      `(${err.message})`
  );
  process.exit(1);
}

const { agentToolCatalog, agentDefinitionFor, dynamicVariablesFor, TOOL_NAMES, CALLER_VARIABLE } =
  catalog;

const { PrismaClient } = require('@prisma/client');

async function main() {
  const target = process.argv[2];
  const keyFlag = process.argv.indexOf('--key');
  const providedKey = keyFlag > -1 ? process.argv[keyFlag + 1] : null;

  if (!target) {
    console.error(
      'usage: node scripts/generate-agent-config.js <org-slug-or-id> [--key <agent-key>]'
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findFirst({
      where: { OR: [{ slug: target }, { id: target }] },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        welcomeMessage: true,
        aiPersonaPrompt: true,
      },
    });
    if (!org) {
      console.error(`No organization matches "${target}".`);
      process.exit(1);
    }

    const baseUrl = (process.env.API_BASE_URL || process.env.API_URL || 'http://localhost:4000')
      .replace(/\/+$/, '');

    // A literal key when one was supplied (what a manual dashboard setup needs),
    // otherwise a workspace-secret reference — which is what the sync uses, and
    // what keeps the credential out of nine tool definitions.
    const authorization = providedKey
      ? `Bearer ${providedKey}`
      : { secretId: 'REPLACE_WITH_WORKSPACE_SECRET_ID' };

    const tools = agentToolCatalog({ baseUrl, authorization, namePrefix: org.slug });

    const plan = {
      $comment:
        'Dry run. Create each entry in `tools` (POST /v1/convai/tools), collect the ids in the same order, then create the agent with those ids in conversationConfig.agent.prompt.toolIds. POST /api/agent-provisioning/sync does all of this and records the ids.',
      organization: { name: org.name, slug: org.slug, timezone: org.timezone },
      tools: TOOL_NAMES.map((name) => tools[name]),
      agent: agentDefinitionFor(org, TOOL_NAMES.map((name) => `REPLACE_WITH_ID_FOR_${name}`)),
      dynamicVariables: dynamicVariablesFor(org),
      _notes: {
        toolBaseUrl: `${baseUrl}/api/agent-tools`,
        callerVariable: CALLER_VARIABLE,
        verifyBeforeGoingLive: [
          `The caller variable "${CALLER_VARIABLE}" must resolve to the customer's number on BOTH channels. If it does not, phoneNumber arrives empty and the tools honestly report "no appointment found" — safe, but useless.`,
          'phoneNumber uses dynamicVariable so the model cannot supply it. Do not change it to a description field: an invented number cancels a stranger\'s booking.',
          `The agent's timezone is ${org.timezone}. Without it the agent does not know what day it is, and book-appointment asks it to resolve "next Tuesday" into a timestamp.`,
          providedKey
            ? 'The agent key is embedded literally in every tool header. It is visible to anyone with workspace access — prefer the sync endpoint, which stores it as a workspace secret instead.'
            : 'No key supplied, so the Authorization header references a workspace secret. Create the secret with the value "Bearer <agent-key>" and substitute its id, or let the sync endpoint do it.',
          baseUrl.includes('localhost')
            ? 'API_BASE_URL is localhost — ElevenLabs cannot reach it. The agent would answer calls and fail every tool call. Expose the API with a tunnel and re-run.'
            : `Tools will call ${baseUrl}, which must be reachable from the public internet.`,
        ],
      },
    };

    console.log(JSON.stringify(plan, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to generate agent config:', err.message);
    process.exit(1);
  });
}
