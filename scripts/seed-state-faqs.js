/**
 * State FAQs, generated from the verified agency records — never written by hand.
 *
 *   npm run faqs:seed -- <org-slug>            report what would be written
 *   npm run faqs:seed -- <org-slug> --apply    write it
 *
 * Every answer is assembled from `data/plateau-mdas-knowledge-base.json` (the
 * same record the knowledge documents are built from) and the December events
 * lineup, so an FAQ can never say something the knowledge base does not. Run
 * `npm run leadership:apply` first: leaders' names come only from the verified
 * table, and an agency whose head is not confirmed gets no "who heads" FAQ. Fields
 * scraped from the old website (`raw*`) are NOT used: they are unreliable — the
 * Ministry of Agriculture's `rawLeader` is a college provost.
 *
 * For each agency, up to four questions a citizen actually asks:
 *   - who heads it        (currentLeadership, with the Permanent Secretary)
 *   - what it does        (mandate)
 *   - where it is / how to reach it (contact)
 *   - what it offers citizens (citizenServices)
 * plus one for the December Tourism Month lineup, listing every event.
 *
 * Questions carry the agency's full name AND its abbreviation, so both "who
 * heads MOH" and "who is the commissioner of health" find the right one under
 * the shared FAQ rule (faq-match.ts); anything they do not match still goes to
 * the knowledge base, and a matched FAQ is answered together with it.
 *
 * Generated FAQs carry category "State directory". A rerun UPDATES them in
 * place (matched by question) and never touches the agency's own FAQs. It
 * deletes nothing: an FAQ for an agency that disappears from the record stays
 * until an officer removes it, because deleting what a citizen is being told
 * is not something a seed script should do on its own.
 */
const fs = require('fs');
const path = require('path');

const CATEGORY = 'State directory';
const ROOT = path.join(__dirname, '..');

function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function sentence(text) {
  const t = clean(text);
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
}

function listOf(items) {
  return (items || []).map(clean).filter(Boolean);
}

/** "+2348037042854" → "0803 704 2854", which is how a Nigerian number is read. */
function phoneForPeople(raw) {
  const digits = String(raw).replace(/\D/g, '');
  const local = digits.startsWith('234') ? `0${digits.slice(3)}` : digits;
  return local.length === 11 ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : String(raw);
}

function agencyLabel(a) {
  return a.abbreviation ? `${clean(a.name)} (${clean(a.abbreviation)})` : clean(a.name);
}

/** The FAQs for one agency, from its verified fields only. */
function agencyFaqs(a) {
  const label = agencyLabel(a);
  const out = [];

  // Only a head CONFIRMED by a published source (data/verified-leadership.json,
  // applied by `npm run leadership:apply`), and with the date it was
  // confirmed. An unconfirmed head gets no FAQ: the knowledge base says the
  // name is not confirmed and gives the office, which is the honest answer.
  const lead = a.currentLeadership;
  if (lead && !lead.unconfirmed && clean(lead.name) && clean(lead.position)) {
    const who = clean([lead.title, lead.name].filter(Boolean).join(' '));
    let answer = `As of ${clean(lead.asOf) || 'our latest confirmed record'}, the ${clean(lead.position)} of the ${label} is ${who}.`;
    if (clean(lead.permanentSecretary)) {
      answer += ` The Permanent Secretary is ${clean(lead.permanentSecretary)}${lead.permanentSecretaryAsOf ? ` (as of ${clean(lead.permanentSecretaryAsOf)})` : ''}.`;
    }
    out.push({
      question: `Who is the ${clean(lead.position)} (head) of the ${label}?`,
      answer,
    });
  }

  if (clean(a.mandate)) {
    let answer = `The mandate of the ${label}: ${sentence(a.mandate)}`;
    const parastatals = listOf(a.supervisedParastatals);
    if (parastatals.length) answer += ` It supervises: ${parastatals.join('; ')}.`;
    out.push({ question: `What does the ${label} do?`, answer });
  }

  const c = a.contact || {};
  const phones = listOf(c.phones).map(phoneForPeople);
  if (clean(c.office) || phones.length || clean(c.email)) {
    const parts = [];
    if (clean(c.office)) parts.push(`Office: ${sentence(c.office)}`);
    if (phones.length) parts.push(`Phone: ${phones.join(', ')}.`);
    if (clean(c.email)) parts.push(`Email: ${clean(c.email)}.`);
    if (clean(c.website)) parts.push(`Website: ${clean(c.website)}.`);
    out.push({
      question: `Where is the office of the ${label} and how can I contact them?`,
      answer: `The ${label}. ${parts.join(' ')}`,
    });
  }

  const services = listOf(a.citizenServices);
  if (services.length) {
    out.push({
      question: `What services does the ${label} offer citizens?`,
      answer: `The ${label} offers: ${services.map((s, i) => `(${i + 1}) ${s.replace(/[.;]$/, '')}`).join('; ')}.`,
    });
  }
  return out;
}

/** One FAQ listing every event in the lineup, in the document's own words. */
function eventsFaq(eventsMd) {
  const lines = String(eventsMd || '')
    .split('\n')
    .filter((l) => /^- \*\*/.test(l))
    .map((l) => l.replace(/^- /, '').replace(/\*\*/g, '').trim());
  if (lines.length === 0) return [];
  const note = /Dates and venues may change[^\n]*/.exec(eventsMd || '');
  const answer =
    `December is Plateau State's official Tourism Month, coordinated under ONE PLATEAU FEST. The events are:\n` +
    lines.map((l, i) => `${i + 1}. ${l}`).join('\n') +
    (note ? `\n${note[0].trim()}` : '');
  return [
    'What events are happening in Plateau State for December Tourism Month?',
    'What events are happening in Plateau State in November and December?',
    'What events are happening in Jos in December?',
    'What is ONE PLATEAU FEST?',
    'What are the Ministry of Tourism activities for December?',
  ].map((question) => ({ question, answer }));
}

/** Every generated FAQ, in a stable order. Pure, so it can be tested. */
function buildStateFaqs(agencies, eventsMd) {
  const faqs = [...eventsFaq(eventsMd)];
  for (const a of agencies || []) faqs.push(...agencyFaqs(a));
  // One FAQ per question: two agencies can never share one, but guard anyway.
  const seen = new Set();
  return faqs.filter((f) => {
    const k = f.question.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const slug = args.find((a) => !a.startsWith('--'));
  if (!slug) {
    console.error('Usage: npm run faqs:seed -- <org-slug> [--apply]');
    process.exit(2);
  }
  const agencies = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'plateau-mdas-knowledge-base.json'), 'utf8'));
  const eventsMd = fs.readFileSync(path.join(ROOT, 'data', 'mda-knowledge', 'December-Tourism-Month-2026-Events.md'), 'utf8');
  const faqs = buildStateFaqs(agencies, eventsMd);

  const { prisma } = require('@ace/database');
  const org = await prisma.organization.findFirst({ where: { slug }, select: { id: true, name: true } });
  if (!org) {
    console.error(`No organization with slug "${slug}".`);
    process.exit(1);
  }
  const existing = await prisma.faqEntry.findMany({
    where: { organizationId: org.id },
    select: { id: true, question: true, answer: true, category: true },
  });
  const byQuestion = new Map(existing.map((f) => [f.question.trim().toLowerCase(), f]));
  const toCreate = [];
  const toUpdate = [];
  for (const f of faqs) {
    const found = byQuestion.get(f.question.toLowerCase());
    if (!found) toCreate.push(f);
    else if (found.category === CATEGORY && found.answer !== f.answer) toUpdate.push({ id: found.id, ...f });
  }

  console.log(`${org.name} (${slug}): ${existing.length} FAQs now, ${faqs.length} generated from the verified records.`);
  console.log(`  new: ${toCreate.length}   updated: ${toUpdate.length}   unchanged or agency-written: ${faqs.length - toCreate.length - toUpdate.length}`);
  for (const f of toCreate.slice(0, 5)) console.log(`  + ${f.question}`);
  if (!apply) {
    console.log('\nReport only. Re-run with --apply to write.');
    await prisma.$disconnect();
    return;
  }

  // After the agency's own FAQs, so on a tie its own wording still wins.
  const base = existing.length;
  let order = base;
  for (const f of toCreate) {
    await prisma.faqEntry.create({
      data: { organizationId: org.id, question: f.question, answer: f.answer, category: CATEGORY, isActive: true, sortOrder: order++ },
    });
  }
  for (const f of toUpdate) {
    await prisma.faqEntry.update({ where: { id: f.id }, data: { answer: f.answer } });
  }
  console.log(`Written: ${toCreate.length} created, ${toUpdate.length} updated.`);
  await prisma.$disconnect();
}

module.exports = { buildStateFaqs, agencyFaqs, eventsFaq, phoneForPeople, CATEGORY };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
