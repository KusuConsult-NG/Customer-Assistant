/**
 * Reading and rewriting the translation table, for people who do not read code.
 *
 * `packages/orchestrator/src/languages.ts` holds 260 strings across five
 * languages, and every one of them was machine-authored. The file says so, in a
 * banner asking for native-speaker review before production — and that review
 * has not happened, while every other translation task has. The reason is
 * mechanical rather than anything to do with priorities: reviewing them means
 * opening a TypeScript file, finding the right nested object literal, and
 * editing string literals without breaking the build. That is a developer task
 * wearing a translator's clothes, so it waits for a developer.
 *
 * This module is the seam that separates the two. It can read every string out
 * with enough context to judge it, and put corrections back without the
 * reviewer touching the source.
 *
 * ── Why the source is edited textually rather than regenerated ──────────────
 *
 * The obvious implementation writes the whole TEMPLATES object out from data.
 * It also destroys every comment in it, and those comments are the reason
 * several strings say what they say — the note on why the plan labels stay
 * English, the warning that a wrong register in a payment instruction is a
 * trust problem. So each value is located and replaced in place, and everything
 * around it is left exactly as it was.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'packages/orchestrator/src/languages.ts');
const DIST = path.join(ROOT, 'packages/orchestrator/dist/languages.js');

/** The languages, and which of them are up for review. */
const ALL_LANGUAGES = ['en', 'pcm', 'ha', 'ig', 'yo'];
const LANGUAGE_NAMES = {
  en: 'English',
  pcm: 'Nigerian Pidgin',
  ha: 'Hausa',
  ig: 'Igbo',
  yo: 'Yoruba',
};

/**
 * Which conversation each key belongs to, so a reviewer knows what they are
 * reading. "enrol_lga_ask" means nothing on its own; "the PLASCHEMA enrollment
 * form, asking which Local Government Area you live in" can be judged.
 */
const AREA_BY_FILE = {
  'enrollment-flow.ts': 'PLASCHEMA enrollment form',
  'booking-flow.ts': 'Booking an appointment',
  'reschedule-flow.ts': 'Moving an appointment',
  'cancel-flow.ts': 'Cancelling an appointment',
  'reservation-flow.ts': 'Reserving a table',
  'appointment-targets.ts': 'Choosing which appointment',
  'flows.ts': 'Any form',
  'index.ts': 'General replies',
};

/**
 * The built module is the authority on what a string currently IS.
 *
 * The source is the authority on where it lives, but reading a value out of it
 * would mean evaluating a TypeScript expression — several are written as
 * multi-line concatenations. `dist` has already done that, correctly, and a
 * mismatch between the two is a stale build the caller must fix anyway.
 */
function loadBuilt() {
  if (!fs.existsSync(DIST)) {
    throw new Error(
      `${path.relative(ROOT, DIST)} is missing. Run \`npx turbo run build --filter=@ace/orchestrator...\` first — ` +
        'this reads the current strings from the built module.'
    );
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(DIST);
  if (!Array.isArray(mod.TEMPLATE_KEYS) || typeof mod.t !== 'function') {
    throw new Error('The built languages module does not export TEMPLATE_KEYS and t — is the build stale?');
  }
  return mod;
}

/** The placeholders a template carries, sorted, e.g. ['list', 'verb']. */
function placeholdersOf(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

/**
 * Locate every `<lang>: { … }` block and every `key:` inside it.
 *
 * Returns, for each language and key, the character range covering the VALUE
 * expression — everything between the colon and the comma that ends it. The
 * scanner is deliberately anchored on indentation (`\n  <lang>: {`, `\n    <key>:`)
 * because that is the file's actual shape and a looser pattern would happily
 * match a key name appearing inside a translated sentence.
 */
function locate(text) {
  const found = {};

  for (const lang of ALL_LANGUAGES) {
    const blockStart = text.indexOf(`\n  ${lang}: {\n`);
    if (blockStart === -1) throw new Error(`Could not find the "${lang}" block in ${path.relative(ROOT, SOURCE)}`);
    const bodyStart = text.indexOf('{', blockStart) + 1;
    const blockEnd = text.indexOf('\n  },', bodyStart);
    if (blockEnd === -1) throw new Error(`Could not find the end of the "${lang}" block`);

    const body = text.slice(bodyStart, blockEnd);
    const entries = {};

    // Every key at exactly four spaces of indentation. The value runs to the
    // next such key, or to the end of the block.
    const keyRe = /\n {4}([A-Za-z_][A-Za-z0-9_]*):/g;
    const marks = [];
    let m;
    while ((m = keyRe.exec(body)) !== null) {
      marks.push({ key: m[1], valueStart: bodyStart + m.index + m[0].length, at: bodyStart + m.index });
    }
    marks.forEach((mark, i) => {
      const rawEnd = i + 1 < marks.length ? marks[i + 1].at : bodyStart + body.length;
      // Trim the trailing comma and whitespace so the range covers the value
      // expression and nothing else.
      let end = rawEnd;
      while (end > mark.valueStart && /[\s,]/.test(text[end - 1])) end--;
      entries[mark.key] = { start: mark.valueStart, end };
    });

    found[lang] = entries;
  }

  return found;
}

/** A TypeScript string literal for `value`, safe for any content we carry. */
function literal(value) {
  // JSON.stringify escapes exactly what must be escaped — quotes, backslashes,
  // newlines — and leaves diacritics alone, so the file stays readable in Igbo
  // and Yoruba rather than turning into a wall of \u escapes.
  return JSON.stringify(value);
}

/**
 * Where each key is used, as an area name a reviewer can act on.
 *
 * Derived rather than hand-listed: a hand-kept map goes stale the first time a
 * key moves, and a WRONG context is worse than none — it tells a reviewer they
 * are correcting a booking message when they are correcting an enrollment one.
 */
function contextByKey(keys) {
  const srcDir = path.join(ROOT, 'packages/orchestrator/src');
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts') && f !== 'languages.ts');
  const areas = {};

  for (const file of files) {
    const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
    for (const key of keys) {
      if (new RegExp(`['"\`]${key}['"\`]`).test(text)) {
        const area = AREA_BY_FILE[file] || file.replace(/\.ts$/, '');
        (areas[key] = areas[key] || new Set()).add(area);
      }
    }
  }

  const out = {};
  for (const key of keys) {
    out[key] = areas[key] ? [...areas[key]].sort().join(' · ') : 'General replies';
  }
  return out;
}

/**
 * Apply corrections to the source file and return the new text.
 *
 * Replacements are applied back-to-front so that each range stays valid while
 * the ones before it are still being rewritten.
 */
function applyCorrections(text, corrections) {
  const positions = locate(text);
  const edits = [];

  for (const { lang, key, value } of corrections) {
    const at = positions[lang] && positions[lang][key];
    if (!at) throw new Error(`No entry for ${lang}.${key} in the source — is the build stale?`);
    edits.push({ ...at, literal: literal(value) });
  }

  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + ' ' + edit.literal + out.slice(edit.end);
  }
  return out;
}

module.exports = {
  ROOT,
  SOURCE,
  ALL_LANGUAGES,
  LANGUAGE_NAMES,
  loadBuilt,
  placeholdersOf,
  locate,
  literal,
  contextByKey,
  applyCorrections,
};
