/**
 * Apply data/verified-leadership.json to every place a leader's name lives.
 *
 *   npm run leadership:apply            report what would change
 *   npm run leadership:apply -- --apply write it
 *
 * The leadership records had drifted badly: most commissioners were the 2023
 * cabinet, two months after the August 2026 reshuffle, and some entries were
 * not names at all ("Dr. Cletus Bako / Dr. Agabus" as a Permanent Secretary).
 * Every name the platform states now comes from ONE table, each with the date
 * and source that confirmed it. An agency the table does not list has its
 * head's name REMOVED and is shown as not confirmed — the assistant then says
 * so and points the citizen to the office, rather than reading out a guess.
 *
 * Writes:
 *   - data/plateau-mdas-knowledge-base.json  currentLeadership (the source the
 *     State documents and FAQs are built from)
 *   - data/mda-knowledge/<ABBR>-*.md         each agency's "Current Leadership"
 *   - the Leadership Directory and Master Citizen Guide leadership sections
 *
 * Past leadership is NOT touched: it is history, not who to call today, and
 * this pass did not verify it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERIFIED_PATH = path.join(ROOT, 'data', 'verified-leadership.json');
const CATALOG_PATH = path.join(ROOT, 'data', 'plateau-mdas-knowledge-base.json');
const MD_DIR = path.join(ROOT, 'data', 'mda-knowledge');
const DIRECTORY_MD = path.join(MD_DIR, 'Plateau-State-House-of-Assembly-and-Government-Leadership.md');
const GUIDE_MD = path.join(MD_DIR, 'Plateau-State-Master-Citizen-Guide.md');

const NOT_CONFIRMED =
  "The current head's name is not confirmed in our records. Please confirm with the office before relying on any name.";

function loadVerified() {
  return JSON.parse(fs.readFileSync(VERIFIED_PATH, 'utf8'));
}

/** The currentLeadership record for one agency, from the verified table. */
function leadershipFor(agency, verified) {
  const v = verified.leaders[agency.abbreviation];
  if (!v) {
    const old = agency.currentLeadership || {};
    return { position: old.position || 'Head of agency', name: null, unconfirmed: true };
  }
  const out = { position: v.position, name: v.name, asOf: v.asOf };
  if (v.permanentSecretary) {
    out.permanentSecretary = v.permanentSecretary.name;
    out.permanentSecretaryAsOf = v.permanentSecretary.asOf;
  }
  return out;
}

/**
 * The "Current Leadership" lines of an agency document. Shared with
 * update-state-info-center.js, so the indexed documents and the files here
 * cannot say different things.
 */
function leadershipLines(cur) {
  if (!cur) return [];
  if (cur.unconfirmed || !cur.name) {
    return ['## Current Leadership', `- **${cur.position || 'Head of agency'}**: ${NOT_CONFIRMED}`, ''];
  }
  const who = [cur.title, cur.name].filter(Boolean).join(' ').trim();
  const lines = ['## Current Leadership', `- **${cur.position || 'Head of agency'}**: ${who}${cur.asOf ? ` (as of ${cur.asOf})` : ''}`];
  if (cur.permanentSecretary) {
    lines.push(`- **Permanent Secretary**: ${cur.permanentSecretary}${cur.permanentSecretaryAsOf ? ` (as of ${cur.permanentSecretaryAsOf})` : ''}`);
  }
  lines.push('');
  return lines;
}

/** Replace the block that starts with `heading` and runs to the next "## " or "---". */
function replaceSection(text, heading, newBlock) {
  const start = text.indexOf(heading);
  if (start < 0) return null;
  const after = text.slice(start + heading.length);
  const m = /\n(?=## |---)/.exec(after);
  const end = m ? start + heading.length + m.index + 1 : text.length;
  return text.slice(0, start) + newBlock.trimEnd() + '\n\n' + text.slice(end);
}

function commissionerLines(verified) {
  return Object.entries(verified.leaders)
    .filter(([, v]) => /^Commissioner|^Attorney-General/.test(v.position))
    .map(([, v]) => `- **${v.position}**: ${v.name} (as of ${v.asOf})`)
    .sort();
}

function agencyHeadLines(verified, catalog) {
  const byAbbr = new Map(catalog.map((a) => [a.abbreviation, a]));
  return Object.entries(verified.leaders)
    .filter(([, v]) => !/^Commissioner|^Attorney-General/.test(v.position))
    .map(([abbr, v]) => {
      const name = byAbbr.get(abbr)?.name || abbr;
      return `- **${v.position}, ${name} (${abbr})**: ${v.name} (as of ${v.asOf})`;
    });
}

function principalLines(verified) {
  return verified.principalOfficers.map((p) => `- **${p.position}**: ${p.name}${p.asOf ? ` (as of ${p.asOf})` : ''}.`);
}

function rewriteDirectory(text, verified, catalog) {
  const note =
    `Names below are confirmed by published sources dated 2025-2026 (checked ${verified.checkedOn}). ` +
    `Where an agency is not listed, its head's name is not confirmed in our records.`;
  let out = text;
  out = replaceSection(out, '## Executive Arm — Principal Officers', ['## Executive Arm — Principal Officers', ...principalLines(verified)].join('\n')) ?? out;
  out = replaceSection(out, '## Key Executive Agencies and Parastatals', ['## Key Executive Agencies and Parastatals', note, ...agencyHeadLines(verified, catalog)].join('\n')) ?? out;
  out = replaceSection(out, '## Current State Commissioners (Executive Council)', [
    '## Current State Commissioners (Executive Council)',
    `After the August 2026 cabinet reshuffle. ${note}`,
    ...commissionerLines(verified),
  ].join('\n')) ?? out;
  return out;
}

function rewriteGuide(text, verified) {
  const heading = '## 1. Executive Leadership of Plateau State ("The Time is Now" Administration)';
  const lines = [heading, ...principalLines(verified)];
  const plaschema = verified.leaders.PLASCHEMA;
  if (plaschema) lines.push(`- **Director-General, PLASCHEMA**: ${plaschema.name} (as of ${plaschema.asOf}).`);
  let out = replaceSection(text, heading, lines.join('\n')) ?? text;
  out = out.replace(/- \*\*Current DG\*\*: [^\n]*/, plaschema ? `- **Current DG**: ${plaschema.name} (as of ${plaschema.asOf}).` : `- **Current DG**: ${NOT_CONFIRMED}`);
  return out;
}

function agencyMdFile(abbr) {
  const prefix = `${abbr.replace(/[&\s]/g, '-')}-`;
  return fs.readdirSync(MD_DIR).find((f) => f.startsWith(prefix) && f.endsWith('.md')) || null;
}

function main() {
  const apply = process.argv.includes('--apply');
  const verified = loadVerified();
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

  let confirmed = 0;
  let removed = 0;
  const unknown = Object.keys(verified.leaders).filter((abbr) => !catalog.some((a) => a.abbreviation === abbr));
  if (unknown.length) throw new Error(`verified-leadership.json names agencies not in the catalogue: ${unknown.join(', ')}`);

  const writes = [];
  for (const agency of catalog) {
    const next = leadershipFor(agency, verified);
    if (next.unconfirmed) removed++;
    else confirmed++;
    agency.currentLeadership = next;

    const file = agencyMdFile(agency.abbreviation);
    if (file) {
      const p = path.join(MD_DIR, file);
      const before = fs.readFileSync(p, 'utf8');
      const after = replaceSection(before, '## Current Leadership', leadershipLines(next).join('\n'));
      if (after && after !== before) writes.push([p, after]);
    }
  }
  writes.push([CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n']);
  writes.push([DIRECTORY_MD, rewriteDirectory(fs.readFileSync(DIRECTORY_MD, 'utf8'), verified, catalog)]);
  writes.push([GUIDE_MD, rewriteGuide(fs.readFileSync(GUIDE_MD, 'utf8'), verified)]);

  console.log(`${catalog.length} agencies: ${confirmed} heads confirmed, ${removed} names removed as not confirmed.`);
  console.log(`${writes.length} files to write.`);
  if (!apply) {
    console.log('Report only. Re-run with --apply to write.');
    return;
  }
  for (const [p, content] of writes) fs.writeFileSync(p, content);
  console.log('Written.');
}

module.exports = { leadershipFor, leadershipLines, replaceSection, NOT_CONFIRMED, loadVerified };

if (require.main === module) main();
