#!/usr/bin/env node
/**
 * Mint an agent key for one organization.
 *
 *   node scripts/mint-agent-key.js <organization-slug-or-id>
 *
 * The key authenticates a hosted conversational agent (ElevenLabs and the like)
 * against /api/agent-tools/*, and it is what tells the platform which tenant the
 * agent is acting for. One key per organization: the tenant is never a request
 * parameter, so a key can only ever reach its own org's data.
 *
 * Only the SHA-256 hash is stored, so the key is printed once and cannot be
 * recovered. Losing it means minting another and updating the agent config.
 *
 * This is a SECRET credential — unlike the widget key, which is published in
 * every visitor's page source. It belongs in the agent's authentication
 * settings, never in a web page.
 */
const { createHash, randomBytes } = require('crypto');
const path = require('path');

require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));
const { assertLocalDatabase } = require('./guard-production-db');
const { PrismaClient } = require('@prisma/client');

const AGENT_KEY_PREFIX = 'ace_agent_sk_';

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/mint-agent-key.js <organization-slug-or-id>');
    process.exit(1);
  }

  // Minting a key for a production tenant is a real thing to want, so this asks
  // rather than forbids: ALLOW_PRODUCTION_DB=1 lets it through.
  assertLocalDatabase('minting an agent key');

  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findFirst({
      where: { OR: [{ slug: target }, { id: target }] },
      select: { id: true, name: true, slug: true },
    });
    if (!org) {
      console.error(`No organization matches "${target}".`);
      process.exit(1);
    }

    const key = `${AGENT_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.create({
      data: {
        organizationId: org.id,
        keyName: 'Hosted agent key',
        keyHash: createHash('sha256').update(key).digest('hex'),
        keyPrefix: key.slice(0, 20),
      },
    });

    const base = process.env.API_BASE_URL || process.env.API_URL || 'http://localhost:4000';
    console.log(`\nAgent key for ${org.name} (${org.slug}):\n`);
    console.log(`  ${key}\n`);
    console.log('Shown once — only its hash is stored. Put it in the agent as:\n');
    console.log(`  Authorization: Bearer ${key}\n`);
    console.log(`Tool endpoints (POST, JSON), based at ${base}:\n`);
    for (const tool of [
      'lookup-customer',
      'book-appointment',
      'check-booking',
      'cancel-booking',
      'reschedule-booking',
      'create-ticket',
      'payment-details',
      'search-knowledge',
      'handoff',
    ]) {
      console.log(`  ${base}/api/agent-tools/${tool}`);
    }
    console.log(
      '\nEach returns { ok, speak, data, handoff }. `speak` is the sentence the\n' +
        'agent should say verbatim — booking times, references and account details\n' +
        'are worded here rather than left to the model.\n'
    );
    if (base.includes('localhost')) {
      console.log('NOTE: a hosted agent cannot reach localhost. Expose the API with a\n' +
        'tunnel (ngrok http 4000) and set API_BASE_URL before configuring tools.\n');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Failed to mint agent key:', err.message);
  process.exit(1);
});
