#!/usr/bin/env node
/**
 * Read reviewed translation sheets back into the source.
 *
 *   npm run translations:import              # report what would change
 *   npm run translations:import -- --apply   # rewrite languages.ts
 *
 * Report-only by default, like every other script here that edits something
 * real. The report is the point: a native speaker's corrections change what the
 * assistant says about somebody's money and somebody's health card, and the
 * person applying them cannot read the language. Being able to see the count,
 * the keys and the before/after without committing to anything is what makes
 * that safe to do.
 *
 * ── What is refused, and why refusing beats fixing ──────────────────────────
 *
 * A correction that drops a placeholder is refused rather than repaired. `t`
 * interpolates by plain string replacement, so a Yoruba sentence that lost its
 * `{list}` still renders — fluently — promising a list of times and then not
 * containing one. Nothing fails, and the only person who ever finds out is a
 * Yoruba speaker at the moment the assistant stops making sense. Guessing where
 * the placeholder belonged in a language nobody here reads would be worse than
 * asking for the row again.
 */
const fs = require('fs');
const path = require('path');
const {
  ROOT, SOURCE, ALL_LANGUAGES, LANGUAGE_NAMES,
  loadBuilt, placeholdersOf, locate, applyCorrections,
} = require('./lib/translation-table');

const IN_DIR = process.env.TRANSLATIONS_DIR || path.join(ROOT, 'translations');
const APPLY = process.argv.includes('--apply');

/** Parse a CSV that may quote fields and double up quotes inside them. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ''));
}

/** `\n` in a sheet means a line break — see the note in the exporter. */
const unescapeBreaks = (s) => s.split('\\n').join('\n');

function main() {
  if (!fs.existsSync(IN_DIR)) {
    console.error(`No ${path.relative(ROOT, IN_DIR)}/ directory. Run \`npm run translations:export\` first.`);
    process.exit(1);
  }

  const { TEMPLATE_KEYS, t } = loadBuilt();
  const known = new Set(TEMPLATE_KEYS);

  const files = fs.readdirSync(IN_DIR)
    .filter((f) => f.endsWith('.csv'))
    .filter((f) => ALL_LANGUAGES.includes(path.basename(f, '.csv')));

  if (files.length === 0) {
    console.error(`No language CSVs in ${path.relative(ROOT, IN_DIR)}/. Expected one of: ${ALL_LANGUAGES.map((l) => `${l}.csv`).join(', ')}`);
    process.exit(1);
  }

  const corrections = [];
  const refused = [];
  let reviewed = 0;

  for (const file of files) {
    const lang = path.basename(file, '.csv');
    const rows = parseCsv(fs.readFileSync(path.join(IN_DIR, file), 'utf8'));
    const header = rows.shift() || [];
    const col = (name) => header.indexOf(name);

    const iKey = col('key');
    const iCorrected = col('corrected');
    // The sheet carries the English and the current rendering it was made
    // from, so it can say whether it is still describing today's table. This
    // is what makes it safe to keep exported sheets in the repository: a
    // reviewer working from a stale copy corrected a sentence that has since
    // changed, and applying that silently would undo the change they never saw.
    const iEnglish = col('english');
    const iCurrent = col(`current_${lang}`);
    if (iKey === -1 || iCorrected === -1) {
      refused.push({ lang, key: '(file)', why: `${file} has no "key" and "corrected" columns — is it the exported sheet?` });
      continue;
    }

    for (const row of rows) {
      const key = (row[iKey] || '').trim();
      const corrected = unescapeBreaks(row[iCorrected] || '').trim();
      if (!key || !corrected) continue;
      reviewed++;

      if (!known.has(key)) {
        refused.push({ lang, key, why: 'not a template key — was the key column edited?' });
        continue;
      }

      const stale = [];
      if (iEnglish !== -1 && unescapeBreaks(row[iEnglish] || '') !== t('en', key)) stale.push('the English');
      if (iCurrent !== -1 && unescapeBreaks(row[iCurrent] || '') !== t(lang, key)) stale.push(`the current ${LANGUAGE_NAMES[lang]}`);
      if (stale.length) {
        refused.push({
          lang,
          key,
          why: `${stale.join(' and ')} changed since this sheet was exported — re-export and review this row again`,
        });
        continue;
      }

      const want = placeholdersOf(t('en', key)).join(',');
      const got = placeholdersOf(corrected).join(',');
      if (want !== got) {
        refused.push({
          lang,
          key,
          why: `placeholders must stay the same. Expected ${want ? `{${want.split(',').join('} {')}}` : 'none'}, ` +
               `this has ${got ? `{${got.split(',').join('} {')}}` : 'none'}`,
        });
        continue;
      }

      const current = t(lang, key);
      if (corrected === current) continue; // filled in, but unchanged

      corrections.push({ lang, key, value: corrected, from: current });
    }
  }

  report({ files, reviewed, corrections, refused });

  if (refused.length) {
    console.log('\nRefused rows are left alone. Nothing else is blocked by them —');
    console.log('the accepted corrections above can be applied now and the rest re-sent.');
  }

  if (!corrections.length) {
    console.log('\nNothing to apply.');
    return;
  }

  if (!APPLY) {
    console.log('\nReport only. Re-run with --apply to write these into');
    console.log(`  ${path.relative(ROOT, SOURCE)}`);
    return;
  }

  write(corrections);
}

function report({ files, reviewed, corrections, refused }) {
  console.log('Translation corrections\n');
  console.log(`Read ${files.length} sheet(s): ${files.join(', ')}`);
  console.log(`${reviewed} row(s) filled in · ${corrections.length} change something · ${refused.length} refused\n`);

  const byLang = {};
  for (const c of corrections) (byLang[c.lang] = byLang[c.lang] || []).push(c);

  for (const lang of Object.keys(byLang)) {
    console.log(`── ${LANGUAGE_NAMES[lang]} (${byLang[lang].length}) ${'─'.repeat(Math.max(0, 50 - LANGUAGE_NAMES[lang].length))}`);
    for (const c of byLang[lang]) {
      console.log(`  ${c.key}`);
      console.log(`    was: ${oneLine(c.from)}`);
      console.log(`    now: ${oneLine(c.value)}`);
    }
    console.log('');
  }

  if (refused.length) {
    console.log(`── Refused ${'─'.repeat(48)}`);
    for (const r of refused) console.log(`  ${r.lang}.${r.key}: ${r.why}`);
  }
}

const oneLine = (s) => {
  const flat = s.split('\n').join(' ⏎ ');
  return flat.length > 110 ? `${flat.slice(0, 107)}…` : flat;
};

/**
 * Rewrite the source, then prove the rewrite says what was intended.
 *
 * The verification is not ceremony. The file is edited by character range, and
 * a range that drifted would write a correct string into the wrong key — which
 * is silent, because both values are plausible strings in plausible places. So
 * the new text is re-scanned and every applied value read back; anything that
 * does not match exactly restores the original file and stops.
 */
function write(corrections) {
  const before = fs.readFileSync(SOURCE, 'utf8');
  const after = applyCorrections(before, corrections);

  const positions = locate(after);
  const wrong = [];
  for (const c of corrections) {
    const at = positions[c.lang][c.key];
    const raw = after.slice(at.start, at.end).trim();
    let readBack;
    try {
      readBack = JSON.parse(raw);
    } catch {
      wrong.push(`${c.lang}.${c.key}: rewritten value is not a plain string literal`);
      continue;
    }
    if (readBack !== c.value) wrong.push(`${c.lang}.${c.key}: read back as something else`);
  }

  if (wrong.length) {
    console.error('\nRefusing to write — the rewritten file does not read back correctly:');
    for (const w of wrong) console.error(`  ${w}`);
    console.error('\nThe source was NOT modified.');
    process.exit(1);
  }

  fs.writeFileSync(SOURCE, after, 'utf8');
  console.log(`\nWrote ${corrections.length} correction(s) to ${path.relative(ROOT, SOURCE)}.`);
  console.log('\nNow, in order:');
  console.log('  npx turbo run build --filter=@ace/orchestrator...');
  console.log('  npm run test:packages');
  console.log('  git diff packages/orchestrator/src/languages.ts');
  console.log('\nThe placeholder-parity test is what catches a correction that lost a {placeholder}');
  console.log('in a language nobody here reads.');
}

main();
