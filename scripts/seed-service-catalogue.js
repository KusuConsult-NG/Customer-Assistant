#!/usr/bin/env node
/**
 * Move an agency's services and locations out of platform code and into its
 * own rows.
 *
 * The health scheme's four plans and its accredited-facility directory used to
 * be constants every tenant shared. They are now `ServiceOption` and
 * `ServiceLocation` rows belonging to one agency, and this is what puts them
 * there — so the scheme keeps working while the platform stops carrying it.
 *
 * Usage:
 *   node scripts/seed-service-catalogue.js <org-slug>            # report
 *   node scripts/seed-service-catalogue.js <org-slug> --apply    # write
 *
 * Report-first, like every other script here that writes. Idempotent: rows are
 * upserted on (organizationId, name), so re-running changes nothing and a
 * half-finished run is resumable rather than duplicating.
 *
 * It does NOT guess which agency. Seeding one agency's hospitals into another
 * is exactly the defect this whole change exists to remove, so the slug is
 * required and the agency must already exist.
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (process.env[k] === undefined) {
      process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
}

const { prisma, ACCREDITED_FACILITIES, PLATEAU_LGAS } = require('@ace/database');

/**
 * The health scheme's plans, as they were written in the orchestrator.
 *
 * `isNoCost` replaces a regex over the plan NAME (/equity|bhcpf|free/i) that
 * decided whether a citizen owed money by pattern-matching a label.
 */
const HEALTH_PLANS = [
  {
    name: 'Formal Sector',
    description: 'Employed workers, government or private. Contribution shared with the employer.',
    matchPhrases: ['formal', 'civil servant', 'government work', 'company staff', 'employed', 'salary'],
    isNoCost: false,
    requiresReview: false,
    sortOrder: 1,
  },
  {
    name: 'Informal Sector',
    description: 'Self-employed, traders, farmers and artisans.',
    matchPhrases: ['informal', 'self employed', 'self-employed', 'trader', 'farmer', 'artisan', 'business'],
    isNoCost: false,
    requiresReview: false,
    sortOrder: 2,
  },
  {
    name: 'Equity Program',
    description: 'No cost. Pregnant women, children under five, people aged 65 and over, people living with disabilities, orphans.',
    matchPhrases: ['equity', 'free', 'pregnan', 'under 5', 'under five', 'elderly', 'disab', 'orphan', 'vulnerable'],
    isNoCost: true,
    requiresReview: true,
    sortOrder: 3,
  },
  {
    name: 'BHCPF',
    description: 'Basic Health Care Provision Fund. No cost.',
    matchPhrases: ['bhcpf', 'basic health'],
    isNoCost: true,
    requiresReview: true,
    sortOrder: 4,
  },
];

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');

async function main() {
  if (!slug) {
    console.error('\nUsage: node scripts/seed-service-catalogue.js <org-slug> [--apply]\n');
    console.error('The agency is named explicitly. Seeding one agency’s services into');
    console.error('another is the defect this change removes.\n');
    process.exitCode = 1;
    return;
  }

  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true, name: true, industry: true },
  });
  if (!org) {
    console.error(`\nNo agency with slug "${slug}". Create it first.\n`);
    process.exitCode = 1;
    return;
  }

  const locations = [];
  for (const [lga, facilities] of Object.entries(ACCREDITED_FACILITIES)) {
    if (!PLATEAU_LGAS.includes(lga)) {
      console.error(`  ! "${lga}" is not a Plateau LGA — skipping its ${facilities.length} entries`);
      continue;
    }
    for (const f of facilities) {
      locations.push({ name: f.name, kind: f.type, address: f.address, lga });
    }
  }

  const [existingOptions, existingLocations] = await Promise.all([
    prisma.serviceOption.count({ where: { organizationId: org.id } }),
    prisma.serviceLocation.count({ where: { organizationId: org.id } }),
  ]);

  console.log(`\n  agency:            ${org.name}  (${slug})`);
  console.log(`  category:          ${org.industry}`);
  console.log(`  services now:      ${existingOptions}  → upserting ${HEALTH_PLANS.length}`);
  console.log(`  locations now:     ${existingLocations}  → upserting ${locations.length}`);
  console.log(`  LGAs covered:      ${new Set(locations.map((l) => l.lga)).size} of ${PLATEAU_LGAS.length}`);

  const uncovered = PLATEAU_LGAS.filter((l) => !locations.some((x) => x.lga === l));
  if (uncovered.length) {
    console.log(`  no location in:    ${uncovered.join(', ')}`);
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.\n');
    return;
  }

  for (const o of HEALTH_PLANS) {
    await prisma.serviceOption.upsert({
      where: { organizationId_name: { organizationId: org.id, name: o.name } },
      create: { organizationId: org.id, ...o },
      update: {
        description: o.description,
        matchPhrases: o.matchPhrases,
        isNoCost: o.isNoCost,
        requiresReview: o.requiresReview,
        sortOrder: o.sortOrder,
        isActive: true,
      },
    });
  }

  for (const l of locations) {
    await prisma.serviceLocation.upsert({
      where: {
        organizationId_lga_name: { organizationId: org.id, lga: l.lga, name: l.name },
      },
      create: { organizationId: org.id, ...l },
      update: { kind: l.kind, address: l.address, isActive: true },
    });
  }

  // Counted back from the database, not from the input. The first version
  // printed the number of rows it INTENDED to write: it said 46 locations
  // while 43 existed, because a unique key collapsed one hospital listed in
  // four LGAs. A seed that reports what it meant to do hides exactly that.
  const [wroteOptions, wroteLocations] = await Promise.all([
    prisma.serviceOption.count({ where: { organizationId: org.id } }),
    prisma.serviceLocation.count({ where: { organizationId: org.id } }),
  ]);
  console.log(`\nWritten. ${wroteOptions} services and ${wroteLocations} locations now exist for ${org.name || slug}.`);
  if (wroteLocations !== locations.length) {
    console.log(`  NOTE: ${locations.length} were offered \u2014 ${locations.length - wroteLocations} did not land. Investigate before relying on this.`);
  }
  console.log('');
}

main()
  .catch((e) => {
    if (e?.code === 'P2021') {
      console.error('\nThose tables do not exist. Run `npm run db:push` first.\n');
    } else {
      console.error('\n', e?.message ?? e, '\n');
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
