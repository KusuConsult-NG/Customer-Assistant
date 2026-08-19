#!/usr/bin/env node
/**
 * Sync the organization's agent and all 9 webhook tools directly to ElevenLabs.
 */
const path = require('path');
require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const personaIdx = args.indexOf('--persona');
  let requestedPersona = null;
  if (personaIdx !== -1 && args[personaIdx + 1]) {
    requestedPersona = args[personaIdx + 1];
    process.env.ELEVENLABS_PERSONA = requestedPersona;
  }

  const { TEAM_PERSONAS, resolvePersona } = require('../apps/api/dist/agent-tools/agent-tool-catalog');

  if (args.includes('--list-personas')) {
    console.log('\nAvailable Team Personas:');
    for (const [key, p] of Object.entries(TEAM_PERSONAS)) {
      console.log(`  • ${p.name} (${p.gender}, voiceId: ${p.voiceId}) - "${p.description}"`);
    }
    process.exit(0);
  }

  const orgSlug = args.find(a => !a.startsWith('--') && a !== requestedPersona) || 'ace-demo';
  const persona = resolvePersona(requestedPersona);

  console.log(`🚀 Provisioning ElevenLabs Agent for org "${orgSlug}" with persona "${persona.name}"...`);

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
