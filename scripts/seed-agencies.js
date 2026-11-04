#!/usr/bin/env node
/**
 * Onboard the State's ministries, departments and agencies from a list.
 *
 *   npm run agencies:seed -- agencies.json              # report what it would do
 *   npm run agencies:seed -- agencies.json --apply      # create them
 *
 * ── Why this takes a file rather than a built-in list ───────────────────────
 *
 * Because the list has to be RIGHT, and no public source I could reach states
 * it authoritatively. An MDA directory is not decoration: each row becomes a
 * tenant whose name the AI says to citizens, and whose services and offices
 * are filed under it. A wrong or stale name means a citizen is told about a
 * ministry that does not exist under that name, or two agencies exist for one
 * body and neither has the records.
 *
 * Hard-coding a half-verified list here would make it look settled, and the
 * next person would extend it rather than check it. So the list lives outside
 * the code, somebody is accountable for it, and this applies it faithfully.
 *
 * The 17 Local Government Areas ARE in the code (`state-geography.ts`),
 * because an LGA is a stable fact about the State rather than an org chart
 * that changes with each administration.
 *
 * ── The file ────────────────────────────────────────────────────────────────
 *
 * JSON array, or `{ "agencies": [...] }`. Only `name` is required:
 *
 *   [
 *     { "name": "Ministry of Health",
 *       "category": "GOVERNMENT",
 *       "phone": "+2347000000000",
 *       "defaultLanguage": "en" },
 *     { "name": "Plateau State Internal Revenue Service" }
 *   ]
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It creates no users. `addTeamMember` emails an invitation, and an agency
 * seeded with an owner nobody can sign in as is worse than one with no staff:
 * the platform console shows "no active staff" honestly, and an invitation can
 * be sent when email delivery is working. Check it first with
 * `GET /api/diagnostics/providers`.
 *
 * Idempotent by slug: a second run reports every agency as already present and
 * changes nothing. It never renames or deletes an existing agency — a rename
 * is a decision about an existing tenant's records, not a seed.
 */

const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const { PrismaClient } = require('@prisma/client');

/**
 * Mirrors `generateUniqueSlug`, which the API uses for the same purpose.
 *
 * The length cap cuts at a WORD boundary. A plain `.slice(0, 60)` produced
 * `ministry-of-livestock-development-veterinary-services-and-fi` — a slug that
 * appears in URLs and in the platform console, ending mid-word. Worse, two
 * long names sharing their first sixty characters would truncate to the same
 * slug and the second would be refused as a duplicate of a body it has
 * nothing to do with.
 */
function slugify(name) {
  const full = String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (full.length <= 60) return full;

  const cut = full.slice(0, 60);
  const lastBreak = cut.lastIndexOf('-');
  // Keep whole words, unless the first word alone is over the limit.
  return (lastBreak > 20 ? cut.slice(0, lastBreak) : cut).replace(/-+$/, '');
}

const VALID_CATEGORIES = new Set([
  'HOSPITAL', 'CLINIC', 'HOTEL', 'RESTAURANT', 'SALON', 'GYM',
  'SCHOOL', 'REAL_ESTATE', 'RETAIL', 'GOVERNMENT', 'OTHER',
]);

function readList(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`No such file: ${file}`);
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed?.agencies;
  if (!Array.isArray(list)) {
    throw new Error('The file must be a JSON array, or an object with an "agencies" array.');
  }
  return list;
}

/**
 * Seed through the DEPLOYED API instead of the database.
 *
 *   npm run agencies:seed -- <file> --api https://host [--apply]
 *   ACE_EMAIL=… ACE_PASSWORD=… is how it signs in.
 *
 * The database mode needs `DATABASE_URL`, and for a hosted deployment that
 * means pointing a laptop at the production database — which this repository
 * tells you not to do, and which nobody holding only the dashboard login can
 * do anyway. The platform tier already has the endpoint, guarded by
 * `PlatformAdminGuard`, so the operator who is allowed to onboard an agency
 * can do it from wherever they are.
 *
 * Agencies are created with NO owner. The Ministry decides who owns each one,
 * and an invented address is an officer who can never sign in.
 */
async function seedViaApi(list, { base, apply }) {
  const email = process.env.ACE_EMAIL;
  const password = process.env.ACE_PASSWORD;
  if (!email || !password) {
    throw new Error('ACE_EMAIL and ACE_PASSWORD are needed to sign in to ' + base);
  }

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const auth = await login.json().catch(() => null);
  if (!login.ok || !auth?.accessToken) {
    throw new Error(`Sign-in to ${base} failed: ${auth?.message ?? login.status}`);
  }
  const headers = { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' };

  const existingRes = await fetch(`${base}/api/platform/agencies`, { headers });
  if (!existingRes.ok) {
    const why = await existingRes.json().catch(() => null);
    throw new Error(
      existingRes.status === 403
        ? `${email} is not a platform operator on ${base}. Grant it with npm run platform:grant.`
        : `Could not list agencies (HTTP ${existingRes.status}): ${why?.message ?? ''}`
    );
  }
  const existing = (await existingRes.json())?.agencies ?? [];
  const names = new Set(existing.map((a) => String(a.name).toLowerCase()));

  // Matched on NAME here, not slug: the API mints the slug itself, so
  // comparing slugs would depend on reimplementing its rules exactly.
  const missing = list.filter((a) => !names.has(String(a.name ?? '').trim().toLowerCase()));

  console.log(`${existing.length} agenc(ies) already on ${base}`);
  console.log(`${missing.length} of ${list.length} from the file are missing\n`);
  for (const a of missing) console.log(`   ${a.name}`);
  console.log('');

  if (missing.length === 0) return;
  if (!apply) {
    console.log('Report only — nothing was created. Re-run with --apply.');
    console.log('');
    console.log('Each becomes a TENANT whose name the AI says to citizens. Read the list above');
    console.log('against the official directory first.');
    return;
  }

  let created = 0;
  for (const a of missing) {
    const res = await fetch(`${base}/api/platform/agencies`, {
      method: 'POST',
      headers,
      // No owner: see the note above, and the platform service.
      body: JSON.stringify({
        name: String(a.name).trim(),
        category: a.category ? String(a.category).toUpperCase() : 'GOVERNMENT',
        ...(a.phone ? { phone: String(a.phone).trim() } : {}),
        ...(a.defaultLanguage ? { defaultLanguage: String(a.defaultLanguage).trim() } : {}),
      }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      created++;
      console.log(`   created  ${body?.agency?.slug ?? a.name}`);
    } else {
      // The server's own reason. "Failed" alone sends an operator to guess.
      console.log(`   FAILED   ${a.name} — HTTP ${res.status}: ${body?.message ?? ''}`);
    }
  }
  console.log(`\nCreated ${created} of ${missing.length}.`);
  console.log('Each has NO staff. Invite an owner once email delivery works.');
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const apiIdx = args.indexOf('--api');
  const api = apiIdx >= 0 ? args[apiIdx + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith('--') && i !== apiIdx + 1);

  if (!file) {
    console.error('Usage: npm run agencies:seed -- <agencies.json> [--apply]');
    console.error('       npm run agencies:seed -- <agencies.json> --api https://host [--apply]');
    console.error('         (ACE_EMAIL / ACE_PASSWORD to sign in; needs no database access)');
    console.error('');
    console.error('The file is a JSON array of { name, category?, phone?, defaultLanguage? }.');
    console.error('Only `name` is required. See the header of this script.');
    process.exit(2);
  }

  const list = readList(file);

  if (api) {
    await seedViaApi(list, { base: api.replace(/\/+$/, ''), apply });
    return;
  }

  const prisma = new PrismaClient();

  try {
    const existing = await prisma.organization.findMany({ select: { slug: true, name: true } });
    const bySlug = new Map(existing.map((o) => [o.slug, o.name]));

    const toCreate = [];
    const already = [];
    const rejected = [];
    const seen = new Set();

    for (const [i, raw] of list.entries()) {
      const name = String(raw?.name ?? '').trim();
      if (name.length < 3) {
        rejected.push(`#${i + 1}: a name of at least 3 characters is required (got ${JSON.stringify(raw?.name)})`);
        continue;
      }

      const slug = raw?.slug ? slugify(raw.slug) : slugify(name);
      if (!slug) {
        rejected.push(`${name}: produced an empty slug — it needs at least one letter or digit.`);
        continue;
      }

      // Two rows for one body is the failure this catches: both exist, each
      // holds half the records, and neither is wrong enough to notice.
      if (seen.has(slug)) {
        rejected.push(`${name}: duplicates an earlier entry in this file (slug ${slug}).`);
        continue;
      }
      seen.add(slug);

      const category = raw?.category ? String(raw.category).toUpperCase() : 'GOVERNMENT';
      if (!VALID_CATEGORIES.has(category)) {
        rejected.push(
          `${name}: category "${raw.category}" is not one of ${[...VALID_CATEGORIES].join(', ')}.`
        );
        continue;
      }

      if (bySlug.has(slug)) {
        already.push({ name, slug, storedAs: bySlug.get(slug) });
        continue;
      }

      toCreate.push({
        name,
        slug,
        industry: category,
        phone: raw?.phone ? String(raw.phone).trim() : undefined,
        defaultLanguage: raw?.defaultLanguage ? String(raw.defaultLanguage).trim() : undefined,
        timezone: raw?.timezone ? String(raw.timezone).trim() : undefined,
      });
    }

    console.log(`${list.length} entr(ies) in ${path.basename(file)}\n`);

    if (already.length) {
      console.log(`── Already on the platform (${already.length}) — unchanged`);
      for (const a of already) {
        const note = a.storedAs !== a.name ? `  (stored as "${a.storedAs}")` : '';
        console.log(`   ${a.slug}${note}`);
      }
      console.log('');
    }

    if (rejected.length) {
      console.log(`── Refused (${rejected.length})`);
      for (const r of rejected) console.log(`   ${r}`);
      console.log('');
    }

    if (toCreate.length === 0) {
      console.log('Nothing to create.');
      if (rejected.length) process.exitCode = 1;
      return;
    }

    console.log(`── Would create (${toCreate.length})`);
    for (const a of toCreate) {
      console.log(`   ${a.name}  →  ${a.slug}  [${a.industry}]`);
    }
    console.log('');

    if (!apply) {
      console.log('Report only — nothing was created. Re-run with --apply.');
      console.log('');
      console.log('Each of these becomes a TENANT whose name the AI says to citizens. Read the');
      console.log('list above against the official directory before applying.');
      if (rejected.length) process.exitCode = 1;
      return;
    }

    let created = 0;
    for (const a of toCreate) {
      try {
        await prisma.organization.create({
          data: {
            name: a.name,
            slug: a.slug,
            industry: a.industry,
            ...(a.phone ? { phone: a.phone } : {}),
            ...(a.defaultLanguage ? { defaultLanguage: a.defaultLanguage } : {}),
            ...(a.timezone ? { timezone: a.timezone } : {}),
            // No invented persona and no invented welcome message: the agent
            // guardrails supply safe default behaviour, and a greeting written
            // here would put words in an agency's mouth that it never approved.
            welcomeMessage: `Hello, you have reached ${a.name}. How may we help you today?`,
          },
        });
        created++;
        console.log(`   created  ${a.slug}`);
      } catch (err) {
        // P2002 means somebody created it between the read and this write.
        // Reported rather than swallowed: the operator should know the run was
        // not the only thing writing.
        console.log(`   FAILED   ${a.slug} — ${err.code === 'P2002' ? 'slug already taken' : err.message}`);
      }
    }

    console.log('');
    console.log(`Created ${created} of ${toCreate.length}.`);
    console.log('');
    console.log('Each has NO staff yet, which the platform console shows honestly. Invite an');
    console.log('owner once email delivery works — check GET /api/diagnostics/providers, and');
    console.log('note that a staff invitation is the one thing with no path round a broken');
    console.log('email provider except npm run user:password.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('agencies:seed failed:', err.message);
  process.exit(1);
});
