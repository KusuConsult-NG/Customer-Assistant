#!/usr/bin/env node
/**
 * Load the State's MDA directory into an agency's knowledge base.
 *
 *   node scripts/seed-plateau-mdas.js <org-slug>                 # report only
 *   node scripts/seed-plateau-mdas.js <org-slug> --apply         # write it
 *   node scripts/seed-plateau-mdas.js <org-slug> --out ./tmp     # also dump markdown to review
 *   node scripts/seed-plateau-mdas.js <org-slug> --from mda.json # use a saved snapshot
 *
 * `--from` takes a file holding what the API returned — either one page's
 * response or an array of MDA records. It exists because this content gets
 * read aloud to citizens, so fetch-review-apply is the right order: save the
 * directory, read the markdown `--out` produces, then apply. It also covers a
 * machine that cannot reach the API directly (a proxied network: Node's fetch
 * ignores HTTPS_PROXY, where curl does not).
 *
 *   curl -sS 'https://plsgov-api-7254c9d5c242.herokuapp.com/api/v1/mda?page=1' -o p1.json
 *
 * ── Where this content comes from, and why that matters ─────────────────────
 *
 * From the Plateau State Government's own portal — not from a model, and not
 * from a search result. plateaustate.gov.ng/mdas renders its directory from
 *
 *   https://plsgov-api-7254c9d5c242.herokuapp.com/api/v1/mda
 *
 * which is the API the official site itself calls. That is the most
 * authoritative public source there is for this list, and it is the reason
 * this script exists rather than a hand-written file: each row becomes text
 * the AI reads out to a citizen, so the provenance has to be checkable and
 * the content has to be refreshable when the State changes it.
 *
 * `scripts/seed-agencies.js` deliberately refuses to carry a built-in list for
 * the same reason, and says so in its header. This does not contradict that:
 * that script creates TENANTS, where a wrong name means a citizen is told
 * about a ministry that does not exist. This writes KNOWLEDGE for one agency
 * to answer from, every line of it attributed, and it names its source in the
 * document so a reader can check it.
 *
 * ── What it refuses to copy ─────────────────────────────────────────────────
 *
 * PLACEHOLDER PHONE NUMBERS. The upstream directory carries several:
 * `+2348030000000`, `+2348000000000`, `+234 8010101000`, and for the Jos
 * Metropolitan Development Board `+23483000000`, which is too short to be a
 * Nigerian number at all. Copying those would have the assistant read an
 * invented phone number to a citizen who then cannot reach anybody — the
 * first non-negotiable invariant in CLAUDE.md, arrived at from the upstream
 * data rather than from a model, which makes no difference to the citizen.
 *
 * They are dropped, counted, and listed in the report so somebody can chase
 * the real numbers. Everything else is copied verbatim.
 *
 * ── Why the title carries the acronym ──────────────────────────────────────
 *
 * Each document is titled `<ABBREV> — <Full name>`, and the body repeats both.
 * Retrieval searches the title as well as the chunk body precisely because an
 * agency's short name is usually only in the title, and a citizen asking about
 * "JMDB" must reach a document whose text spells out "Jos Metropolitan
 * Development Board". That is the defect this content is being loaded to
 * answer, so the shape of the document matters as much as the words in it.
 */

const path = require('path');
const fs = require('fs');

try {
  require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));
} catch {
  /* env may already be present; reported below if not */
}

const { PrismaClient } = require('@prisma/client');

const API = 'https://plsgov-api-7254c9d5c242.herokuapp.com/api/v1/mda';
const SOURCE_PAGE = 'https://plateaustate.gov.ng/mdas';

// Matches the real ingestion (apps/api/src/knowledge/document.worker.ts), so a
// document seeded here is chunked the same way as one a person uploads.
const CHUNK_SIZE_CHARS = 1800;

const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const SLUG = ARGV.find((a) => !a.startsWith('--'));
const OUT = (() => {
  const i = ARGV.indexOf('--out');
  return i >= 0 ? ARGV[i + 1] : null;
})();
const FROM = (() => {
  const i = ARGV.indexOf('--from');
  return i >= 0 ? ARGV[i + 1] : null;
})();

/**
 * Host, port and database name — never the user and never the password.
 *
 * This line is read in terminals, pasted into chats and screenshotted, which
 * is exactly how a production password ends up somewhere it cannot be taken
 * back from.
 */
function describeTarget() {
  const raw = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '(could not parse the connection URL)';
  }
}

function chunkText(text, chunkSize = CHUNK_SIZE_CHARS) {
  const overlap = Math.floor(chunkSize * 0.1);
  const chunks = [];
  for (let i = 0; i < text.length; ) {
    chunks.push(text.slice(i, Math.min(i + chunkSize, text.length)).trim());
    i += chunkSize - overlap;
  }
  return chunks.filter(Boolean);
}

/** HTML from a CMS field → readable plain text, keeping paragraph breaks. */
function plain(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    // A LITERAL non-breaking space, not just the entity. Upstream carries them
    // inside agency names ("Plateau Environmental Protection And Sanitation
    // Agency\u00a0(PEPSA\u00a0)"), where they are invisible and behave like
    // nothing else: a citizen typing an ordinary space does not match them, so
    // the phrase they are in is unsearchable, and a filename carrying one is
    // the only non-ASCII name in an otherwise plain set.
    .replace(/\u00a0/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

/**
 * Is this a real number or a filler one?
 *
 * Deliberately conservative in ONE direction: a number it cannot vouch for is
 * dropped, never reformatted or guessed at. A dropped real number is an
 * omission somebody notices; a fabricated one is a citizen standing somewhere
 * holding a phone that rings nowhere.
 */
function phoneProblem(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null; // nothing to judge
  if (digits.length < 11) return 'too short to be a Nigerian number';
  if (digits.length > 15) return 'too long for E.164';
  if (/0{5,}/.test(digits)) return 'a run of zeros';
  const tail = digits.slice(-7);
  if (new Set(tail).size <= 2) return 'repeated digits';
  return null;
}

function documentFor(m, dropped) {
  const name = String(m.name || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const abbr = String(m.abbreviation || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const about = m.about || {};
  const contact = m.contact || {};
  const director = m.director || {};

  const title = abbr ? `${abbr} — ${name}` : name;

  const phones = [];
  for (const key of ['phone_number_1', 'phone_number_2']) {
    const raw = String(contact[key] || '').trim();
    if (!raw) continue;
    const problem = phoneProblem(raw);
    if (problem) {
      dropped.push({ mda: abbr || name, number: raw, problem });
      continue;
    }
    phones.push(raw);
  }

  const lines = [];
  lines.push(`# ${name}`);
  if (abbr) lines.push(`Also known as: ${abbr}`);
  lines.push('');

  const description = plain(about.description);
  if (description) {
    lines.push('## What this agency does');
    lines.push(description);
    lines.push('');
  }

  const contactLines = [];
  // A "location" that is a bare house number and nothing else is filler, not an
  // address — upstream carries `no. 123` for the Jos Metropolitan Development
  // Board. Telling a citizen the office is at "no. 123" sends them nowhere.
  // Deliberately narrow: a real address always carries a road, area or
  // secretariat name, so this cannot swallow one. Vague but TRUE values like
  // "Jos" are kept — unhelpful is not the same as wrong.
  const location = String(contact.location || '').trim();
  const usableLocation = location && !/^no\.?\s*\d+[a-z]?$/i.test(location) ? location : '';
  if (usableLocation) contactLines.push(`- Office: ${usableLocation}`);
  else if (location) dropped.push({ mda: abbr || name, number: location, problem: 'a house number with no address' });
  if (phones.length) contactLines.push(`- Phone: ${phones.join(', ')}`);
  if (contact.email) contactLines.push(`- Email: ${String(contact.email).trim()}`);
  if (contactLines.length) {
    lines.push('## How to reach it');
    lines.push(...contactLines);
    lines.push('');
  }

  const who = [director.title, director.name].filter(Boolean).join(' ').trim();
  if (who) {
    lines.push('## Who leads it');
    lines.push(`${who}${director.position ? ` — ${String(director.position).trim()}` : ''}`);
    lines.push('');
  }

  // Provenance in the document itself, not only in this script: whoever reads
  // this in the dashboard, or sees it quoted back to a citizen, can check it.
  lines.push('---');
  lines.push(
    `Source: Plateau State Government MDA directory (${SOURCE_PAGE}), retrieved ` +
      `${new Date().toISOString().slice(0, 10)}.`
  );

  return { title, body: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/** Pull the MDA array out of whatever shape the snapshot holds. */
function recordsFrom(json) {
  if (Array.isArray(json)) return json;
  if (json && json.data && Array.isArray(json.data.mdas)) return json.data.mdas;
  if (json && Array.isArray(json.mdas)) return json.mdas;
  throw new Error(
    'could not find MDA records in that file — expected an array, or the API response ' +
      'with data.mdas'
  );
}

async function fetchAll() {
  if (FROM) {
    const files = FROM.split(',').map((f) => f.trim()).filter(Boolean);
    const out = [];
    for (const f of files) out.push(...recordsFrom(JSON.parse(fs.readFileSync(f, 'utf8'))));
    const byId = new Map();
    for (const m of out) byId.set(m.id, m);
    return [...byId.values()];
  }

  const out = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await fetch(`${API}?page=${page}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${API}?page=${page} answered ${res.status}`);
    const json = await res.json();
    const data = json && json.data;
    if (!data || !Array.isArray(data.mdas)) throw new Error('unexpected response shape from the MDA API');
    out.push(...data.mdas);
    totalPages = (data.pagination && data.pagination.totalPages) || 1;
    page += 1;
  } while (page <= totalPages);

  // De-duplicate by id: the pages are fetched separately and could overlap if
  // the upstream list changes between requests.
  const byId = new Map();
  for (const m of out) byId.set(m.id, m);
  return [...byId.values()];
}

(async () => {
  if (!SLUG) {
    console.error(
      'Usage: node scripts/seed-plateau-mdas.js <org-slug> [--apply] [--out <dir>]\n\n' +
        '  <org-slug>  the agency whose knowledge base receives the directory\n' +
        '  --apply     write it (otherwise this only reports)\n' +
        '  --out <dir> also write each document as markdown, to read before applying\n'
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL && !process.env.DIRECT_URL) {
    console.error('DATABASE_URL (or DIRECT_URL) is not set.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const target = describeTarget();

    const org = await prisma.organization.findFirst({
      where: { slug: SLUG },
      select: { id: true, name: true, slug: true },
    });
    if (!org) {
      const some = await prisma.organization.findMany({ select: { slug: true, name: true }, take: 25 });
      console.error(
        `No organization with slug "${SLUG}".\n\n` +
          `Database: ${target}\n` +
          `  Check this is the one you mean before seeding. Twenty leftover \`e2e-*\`\n` +
          `  organizations is the signature of a test database, not a live one.\n\n` +
          `Agencies on this database:\n` +
          some.map((o) => `  ${o.slug}  (${o.name})`).join('\n')
      );
      process.exit(1);
    }

    // SAY WHICH DATABASE, before writing a word to it.
    //
    // The agency slug alone does not tell you that. A developer ran
    // `whoami` against a local database carrying twenty leftover `e2e-*`
    // organizations and a `plaschema` org, and nothing in the output said it
    // was not production — so the next step would have loaded 41 MDAs
    // somewhere no citizen will ever read them, and the WhatsApp line would
    // have been just as empty afterwards with no error anywhere to explain it.
    //
    // Host, port and database name only. Never the user and never the
    // password: this line is read in terminals, pasted into chats and
    // screenshotted, which is how a production password ends up somewhere it
    // cannot be taken back from.
    console.log(`${APPLY ? 'APPLY' : 'REPORT ONLY'} — agency "${org.name}" (${org.slug})`);
    console.log(`  database: ${target}`);
    console.log(`  source: ${FROM ? `snapshot ${FROM}` : API}\n`);

    const all = await fetchAll();
    const active = all.filter((m) => m.published && !m.is_suspended && !m.is_deleted);
    const skipped = all.length - active.length;

    const dropped = [];
    const docs = active.map((m) => documentFor(m, dropped));

    console.log(`  ${all.length} MDA(s) upstream, ${active.length} published and active` +
      (skipped ? `, ${skipped} skipped (unpublished, suspended or deleted)` : ''));

    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      for (const d of docs) {
        const safe = d.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
        fs.writeFileSync(path.join(OUT, `${safe}.md`), d.body + '\n');
      }
      console.log(`  wrote ${docs.length} markdown file(s) to ${OUT}`);
    }

    // Two different agencies publishing one address is almost always an
    // upstream copy-paste (Lands & Survey currently carries Agriculture's
    // secretariat line). Flagged, never "corrected": the right address is not
    // something this script knows, and guessing sends a citizen to the wrong
    // building just as confidently.
    const byLocation = new Map();
    for (const m of active) {
      const loc = String((m.contact || {}).location || '').trim().toLowerCase();
      if (!loc || loc.length < 20) continue;
      if (!byLocation.has(loc)) byLocation.set(loc, []);
      byLocation.get(loc).push(m.abbreviation || m.name);
    }
    const shared = [...byLocation.entries()].filter(([, who]) => who.length > 1);
    if (shared.length) {
      console.log(`\n  ${shared.length} address(es) published by more than one agency — worth checking upstream,`);
      console.log('  loaded as published because the correct address is not ours to invent:');
      for (const [loc, who] of shared) console.log(`    ${who.join(' + ')}\n      ${loc.slice(0, 88)}`);
    }

    if (dropped.length) {
      console.log(`\n  ${dropped.length} contact detail(s) NOT copied — they are placeholders upstream,`);
      console.log('  and an invented detail is worse for a citizen than none:');
      for (const d of dropped) console.log(`    ${String(d.mda).padEnd(12)} ${String(d.number).padEnd(18)} ${d.problem}`);
      console.log('  Everything else about these agencies is still loaded.');
    }

    const withPhone = docs.filter((d) => /\n- Phone: /.test(d.body)).length;
    console.log(
      `\n  documents: ${docs.length} | with a usable phone: ${withPhone} | ` +
        `with an email: ${docs.filter((d) => /\n- Email: /.test(d.body)).length} | ` +
        `with an office: ${docs.filter((d) => /\n- Office: /.test(d.body)).length}`
    );
    console.log(`  total chunks: ${docs.reduce((n, d) => n + chunkText(d.body).length, 0)}`);

    if (!APPLY) {
      console.log('\n  Nothing written. Re-run with --apply.');
      console.log('  Examples of what would be created:');
      for (const d of docs.slice(0, 3)) console.log(`    "${d.title}"`);
      return;
    }

    let created = 0;
    let updated = 0;
    for (const d of docs) {
      const existing = await prisma.knowledgeDocument.findFirst({
        where: { organizationId: org.id, title: d.title },
        select: { id: true },
      });
      const chunks = chunkText(d.body);

      const data = {
        organizationId: org.id,
        title: d.title,
        fileName: `${d.title.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60)}.md`,
        mimeType: 'text/markdown',
        fileSize: Buffer.byteLength(d.body, 'utf8'),
        // Not a bucket path: this content came from an API, and signing a
        // storage URL for it would produce a link to an object that does not
        // exist. The crawled-page case in CLAUDE.md is the same shape.
        storageUrl: SOURCE_PAGE,
        status: 'INDEXED',
        chunkCount: chunks.length,
        errorMessage: null,
      };

      const doc = existing
        ? await prisma.knowledgeDocument.update({ where: { id: existing.id }, data })
        : await prisma.knowledgeDocument.create({ data });
      existing ? updated++ : created++;

      // Replace rather than append, so re-running does not duplicate content.
      await prisma.documentChunk.deleteMany({ where: { documentId: doc.id } });
      for (let i = 0; i < chunks.length; i++) {
        await prisma.documentChunk.create({
          data: { organizationId: org.id, documentId: doc.id, chunkIndex: i, content: chunks[i] },
        });
      }
    }

    console.log(`\n  ${created} created, ${updated} updated.`);
    console.log(
      '\n  Keyword search will find these now. If QDRANT_URL and an embedding key are\n' +
        '  configured, run a reindex so semantic search sees them too — these rows carry\n' +
        '  no embeddings, and this script does not pretend otherwise.'
    );
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error('MDA seed failed:', err.message);
  process.exit(1);
});
