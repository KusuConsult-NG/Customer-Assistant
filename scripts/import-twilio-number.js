#!/usr/bin/env node
/**
 * Automatically import the Twilio number into ElevenLabs and link it to the agent.
 */
const path = require('path');
require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const orgSlug = process.argv[2] || 'ace-demo';
  console.log(`📞 Importing Twilio number for org "${orgSlug}" into ElevenLabs...`);

  const org = await prisma.organization.findFirst({
    where: { OR: [{ slug: orgSlug }, { id: orgSlug }] },
  });

  if (!org) {
    console.error(`Organization "${orgSlug}" not found in database.`);
    process.exit(1);
  }

  const { ElevenLabsNumbersService } = require('../apps/api/dist/agent-tools/elevenlabs-numbers.service');
  const { ElevenLabsApi } = require('../apps/api/dist/agent-tools/elevenlabs-client');
  const numbersService = new ElevenLabsNumbersService(new ElevenLabsApi());

  const result = await numbersService.importTwilioNumber(org.id, {
    confirmVoiceCutover: true,
    enableSms: false,
    label: `${org.name} — Main Line (+17372212163)`,
  });

  console.log('\n✅ Twilio Number Successfully Imported into ElevenLabs!');
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error('❌ Import failed:', err.message || err);
    if (err.response) {
      console.error('Details:', err.response);
    }
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
