#!/usr/bin/env node
/**
 * Export the translation table as one spreadsheet per language.
 *
 *   npm run translations:export              # every language needing review
 *   npm run translations:export -- --lang=ha # just Hausa
 *   npm run translations:export -- --all     # include English
 *
 * Writes `translations/<lang>.csv` plus a README explaining the two rules that
 * matter. Open the file in Excel, Google Sheets, LibreOffice or anything else
 * that reads CSV; fill in the `corrected` column; send it back.
 *
 * ── Why CSV, and why \n stays as two characters ─────────────────────────────
 *
 * CSV because it opens in whatever the reviewer already has, and because the
 * result is still a text file that can be read in a diff. A real line break
 * inside a quoted cell is legal CSV and every spreadsheet handles it — but it
 * makes one string span several rows on screen, which is exactly the moment a
 * reviewer stops trusting the layout and starts editing the wrong line. So a
 * line break travels as the two characters `\n`, one row per string, and the
 * importer turns it back.
 */
const fs = require('fs');
const path = require('path');
const {
  ROOT, ALL_LANGUAGES, LANGUAGE_NAMES, loadBuilt, placeholdersOf, contextByKey,
} = require('./lib/translation-table');

// Overridable so the tests can exercise the real scripts without writing
// over the sheets a reviewer may be part-way through.
const OUT_DIR = process.env.TRANSLATIONS_DIR || path.join(ROOT, 'translations');

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith('--lang=')) || '').split('=')[1];
const includeEnglish = argv.includes('--all') || only === 'en';

/** One CSV field: escaped, quoted, and never spanning a line. */
function field(value) {
  const flat = String(value ?? '').split('\n').join('\\n');
  return `"${flat.replace(/"/g, '""')}"`;
}

function main() {
  const { TEMPLATE_KEYS, t } = loadBuilt();
  const context = contextByKey(TEMPLATE_KEYS);

  let languages = ALL_LANGUAGES.filter((l) => includeEnglish || l !== 'en');
  if (only) {
    if (!ALL_LANGUAGES.includes(only)) {
      console.error(`Unknown language "${only}". Known: ${ALL_LANGUAGES.join(', ')}`);
      process.exit(1);
    }
    languages = [only];
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const lang of languages) {
    const rows = [
      ['key', 'where_it_appears', 'placeholders', 'english', `current_${lang}`, 'corrected'].map(field).join(','),
    ];

    for (const key of TEMPLATE_KEYS) {
      const english = t('en', key);
      const current = t(lang, key);
      rows.push([
        key,
        context[key],
        placeholdersOf(english).map((p) => `{${p}}`).join(' '),
        english,
        current,
        '', // the reviewer's column
      ].map(field).join(','));
    }

    const file = path.join(OUT_DIR, `${lang}.csv`);
    fs.writeFileSync(file, `${rows.join('\n')}\n`, 'utf8');
    console.log(`${LANGUAGE_NAMES[lang].padEnd(16)} ${TEMPLATE_KEYS.length} strings → ${path.relative(ROOT, file)}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), readme(languages), 'utf8');
  console.log(`\nInstructions for the reviewer → ${path.relative(ROOT, path.join(OUT_DIR, 'README.md'))}`);
  console.log('When the files come back:  npm run translations:import          (shows what would change)');
  console.log('                           npm run translations:import -- --apply');
}

function readme(languages) {
  return `# Reviewing the translations

These are the exact words the assistant says to customers on WhatsApp and on the
phone. They were written by a machine and have never been read by a native
speaker. That is what these files are for.

There is one file per language:

${languages.map((l) => `- \`${l}.csv\` — ${LANGUAGE_NAMES[l]}`).join('\n')}

## What to do

Open the file in Excel, Google Sheets, Numbers or LibreOffice.

| column | what it is |
|---|---|
| \`key\` | the internal name. **Do not change it.** |
| \`where_it_appears\` | which conversation the customer is in when they read this |
| \`placeholders\` | see below. **Do not change these.** |
| \`english\` | the English original, for reference |
| \`current_<lang>\` | what the assistant says today |
| \`corrected\` | **your column.** Leave it empty if the current wording is fine. |

Only fill in \`corrected\` where the current wording is wrong, unclear, rude, or
simply not how a person would say it. An empty cell means "this one is fine" —
you do not need to retype anything you are happy with.

## The two rules

**1. Keep every placeholder, spelled exactly.** A placeholder is a word in curly
brackets: \`{name}\`, \`{list}\`, \`{account}\`. Each one is replaced with a real
value before the customer sees it — their name, a list of times, a bank account
number. You may move a placeholder to wherever it belongs in your language, but
if you drop one, the sentence promises something and then does not say it. The
importer refuses any correction that loses or invents one, so nothing can slip
through — but it costs a round-trip, so it is worth checking.

**2. \`\\n\` means "start a new line".** Where you see the two characters \`\\n\` in
the middle of a string, that is a line break. Keep them where the message needs
a break — most of the numbered lists depend on them.

## What NOT to translate

Some things inside these strings are deliberately left in English, and should
stay that way:

- **Plan names** — Formal Sector, Informal Sector, Equity Programme, BHCPF.
  These are printed on the customer's health card, so the words they choose from
  must be the words the card will use.
- **Place names** — Jos North, Barkin Ladi, and the hospitals.
- **\`*yes*\`** — the asterisks make the word bold on WhatsApp, and the system
  understands the customer's own language when they reply, so a customer may
  answer "eh", "na'am", "ee" or "beeni" as they prefer.

If something in that list reads badly in your language, say so in an email
rather than changing it here — it needs a decision, not a translation.

## Sending it back

Save as CSV (keep the same filename) and return the file. The corrections are
checked and applied automatically; nothing is edited by hand on the way in.
`;
}

main();
