#!/usr/bin/env node
/**
 * Sync the organization's agent and all 9 webhook tools directly to ElevenLabs.
 */
const path = require('path');
require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const orgSlug = process.argv[2] || 'ace-demo';
  console.log(`🚀 Provisioning ElevenLabs Agent for org "${orgSlug}"...`);

  const org = await prisma.organization.findFirst({
    where: { OR: [{ slug: orgSlug }, { id: orgSlug }] },
  });

  if (!org) {
    console.error(`Organization "${orgSlug}" not found in database.`);
    process.exit(1);
  }

  const { ElevenLabsAgentService } = require('../apps/api/dist/agent-tools/elevenlabs-agent.service');
  const { ElevenLabsApi } = require('../apps/api/dist/agent-tools/elevenlabs-client');
  const service = new ElevenLabsAgentService(new ElevenLabsApi());

  console.log(`Found organization: ${org.name} (${org.id})`);
  console.log(`Connecting to ElevenLabs API and pushing custom tools + prompt...`);

  const result = await service.syncAgent(org.id);
  console.log('\n✅ ElevenLabs Agent Sync Complete!');
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
