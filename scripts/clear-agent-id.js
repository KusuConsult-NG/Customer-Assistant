#!/usr/bin/env node
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'apps', 'api', 'dist', 'config', 'load-env.js'));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.findFirst({ where: { slug: 'plaschema' } });
  if (!org) throw new Error('Org plaschema not found');
  console.log(`Found org: ${org.name} (${org.id})`);

  const result = await prisma.hostedAgentConfig.updateMany({
    where: { organizationId: org.id },
    data: { agentId: null },
  });
  console.log(`✓ Cleared agentId for ${result.count} config(s). Ready for clean recreate.`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e.message); process.exit(1); });
