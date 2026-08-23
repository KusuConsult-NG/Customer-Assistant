/**
 * The translation export/import round trip.
 *
 * These two scripts exist so that a native speaker can correct what the
 * assistant says without touching TypeScript. That means the corrections
 * arrive from someone who cannot see the code, get applied by someone who
 * cannot read the language, and land in the sentences that tell customers
 * where to send money and what their health card will say.
 *
 * Nobody in that chain can eyeball the result, so the guards have to hold:
 *
 *   - a correction that drops or invents a {placeholder} is refused, because
 *     `t` interpolates by string replacement and the damage is silent
 *   - a correction made against a stale sheet is refused, because applying it
 *     would undo a change the reviewer never saw
 *   - the rewrite lands on the right key, with every comment around it intact
 *
 * The rewrite is tested against a fixture rather than the real file: a test
 * that edits `languages.ts` to prove it can edit `languages.ts` is one crash
 * away from leaving the repository broken.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const EXPORT = path.join(ROOT, 'scripts/export-translations.js');
const IMPORT = path.join(ROOT, 'scripts/import-translations.js');

const { applyCorrections, locate, placeholdersOf } = require('../scripts/lib/translation-table');

let dir: string;

const run = (script: string, args: string[] = []) =>
  execFileSync('node', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TRANSLATIONS_DIR: dir },
  });

/** Read a sheet back as rows of cells. */
function readSheet(lang: string): string[][] {
  const text = fs.readFileSync(path.join(dir, `${lang}.csv`), 'utf8');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (row.length || field) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ''));
}

/** Put a correction into one row and write the sheet back out. */
function correct(lang: string, edits: Record<string, string>, also?: (row: string[], header: string[]) => void) {
  const rows = readSheet(lang);
  const header = rows[0];
  const iKey = header.indexOf('key');
  const iCorrected = header.indexOf('corrected');
  for (const row of rows.slice(1)) {
    if (edits[row[iKey]] !== undefined) {
      row[iCorrected] = edits[row[iKey]];
      also?.(row, header);
    }
  }
  const csv = rows
    .map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(','))
    .join('\n');
  fs.writeFileSync(path.join(dir, `${lang}.csv`), `${csv}\n`, 'utf8');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'translations-'));
  run(EXPORT);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('exporting for review', () => {
  it('writes one sheet per language needing review, and not English', () => {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).sort();
    expect(files).toEqual(['ha.csv', 'ig.csv', 'pcm.csv', 'yo.csv']);
    // English is the source, not a translation — a sheet whose "current" column
    // repeats its own "english" column is noise in front of the real work.
    expect(files).not.toContain('en.csv');
  });

  it('gives every string the context needed to judge it', () => {
    const rows = readSheet('ha');
    expect(rows[0]).toEqual(['key', 'where_it_appears', 'placeholders', 'english', 'current_ha', 'corrected']);

    const byKey = Object.fromEntries(rows.slice(1).map((r) => [r[0], r]));
    // An enrollment question is labelled as one, so a reviewer knows the
    // customer is part-way through a form rather than asking a question.
    expect(byKey.enrol_lga_ask[1]).toContain('PLASCHEMA enrollment form');
    expect(byKey.enrol_lga_unknown[2]).toBe('{list}');
    expect(byKey.enrol_lga_unknown[5]).toBe(''); // the reviewer's column starts empty
  });

  it('keeps every string on one row, with line breaks written as \\n', () => {
    const rows = readSheet('ha');
    const menu = rows.slice(1).find((r) => r[0] === 'enrol_plan_ask')!;
    expect(menu[4]).toContain('\\n');
    expect(menu[4]).not.toContain('\n');
  });

  it('ships the reviewer instructions beside the sheets', () => {
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    expect(readme).toMatch(/Keep every placeholder/);
    // The things that must NOT be translated are the ones a well-meaning
    // reviewer would otherwise "fix" — and the plan names go on a health card.
    expect(readme).toMatch(/Formal Sector/);
  });
});

describe('importing corrections', () => {
  it('changes nothing when nobody has filled anything in', () => {
    const out = run(IMPORT);
    expect(out).toMatch(/0 row\(s\) filled in · 0 change something · 0 refused/);
    expect(out).toMatch(/Nothing to apply/);
  });

  it('accepts a correction that keeps its placeholders', () => {
    correct('ha', { enrol_lga_unknown: 'Ban gane ba.\\nKa zabi daga cikin: {list}.' });
    const out = run(IMPORT);
    expect(out).toMatch(/1 change something · 0 refused/);
    expect(out).toMatch(/enrol_lga_unknown/);
    // Report only until asked — nothing was written.
    expect(out).toMatch(/Report only/);
  });

  it('refuses a correction that drops a placeholder', () => {
    correct('ha', { which_one_unclear: 'Ban gane wanne ba. Ka amsa da lamba.' });
    const out = run(IMPORT);
    expect(out).toMatch(/0 change something · 1 refused/);
    expect(out).toMatch(/ha\.which_one_unclear: placeholders must stay the same/);
  });

  it('refuses a correction that invents a placeholder', () => {
    correct('ha', { escalation_connecting: 'Ina hada ka da {agent} yanzu.' });
    expect(run(IMPORT)).toMatch(/ha\.escalation_connecting: placeholders must stay the same/);
  });

  it('refuses a correction made against a sheet that has gone stale', () => {
    // The reviewer corrected a sentence whose English has since changed, so
    // what they were correcting is not what is there now.
    correct('ha', { enrol_name_ask: 'Wani sabon rubutu.' }, (row, header) => {
      row[header.indexOf('english')] = 'An older English wording.';
    });
    const out = run(IMPORT);
    expect(out).toMatch(/ha\.enrol_name_ask: the English changed since this sheet was exported/);
    expect(out).toMatch(/0 change something · 1 refused/);
  });

  it('counts a row filled in with the existing wording as reviewed, not as a change', () => {
    const rows = readSheet('ha');
    const current = rows.slice(1).find((r) => r[0] === 'flow_abandoned')![4];
    correct('ha', { flow_abandoned: current });
    const out = run(IMPORT);
    expect(out).toMatch(/1 row\(s\) filled in · 0 change something · 0 refused/);
  });

  it('lets the good corrections through when others are refused', () => {
    correct('ha', {
      flow_what_to_change: 'Babu matsala. Wanne bangare zan gyara?',
      which_one_unclear: 'Ban gane wanne ba.',
    });
    const out = run(IMPORT);
    expect(out).toMatch(/1 change something · 1 refused/);
    // A bad row must not hold up the rest — the alternative is a reviewer's
    // whole sheet waiting on one cell.
    expect(out).toMatch(/Refused rows are left alone/);
  });
});

describe('rewriting the source', () => {
  // A miniature of the real file: same shape, same indentation, and comments
  // in the places that matter.
  const FIXTURE = `const TEMPLATES: Record<Language, Record<TemplateKey, string>> = {
  en: {
    greeting: 'Hello {name}',
    /** A comment that must survive. */
    farewell:
      'Goodbye, ' +
      'for now',
  },
  pcm: {
    greeting: 'How far {name}',
    farewell: 'Later',
  },
  ha: {
    greeting: 'Sannu {name}',
    farewell: 'Sai an jima',
  },
  ig: {
    greeting: 'Ndewo {name}',
    farewell: 'Ka omesia',
  },
  yo: {
    greeting: 'Bawo {name}',
    farewell: 'O dabo',
  },
};
`;

  it('replaces one value and leaves everything else byte for byte', () => {
    const out = applyCorrections(FIXTURE, [
      { lang: 'ha', key: 'farewell', value: 'Sai anjima' },
    ]);
    expect(out).toContain('farewell: "Sai anjima"');
    // The comment, the multi-line concatenation and the other languages are
    // untouched — this is why the file is edited rather than regenerated.
    expect(out).toContain('/** A comment that must survive. */');
    expect(out).toContain("'Goodbye, ' +");
    expect(out).toContain("greeting: 'Sannu {name}'");
    expect(out).toContain("farewell: 'Ka omesia'");
  });

  it('writes into the language it was asked for, not the first one that matches', () => {
    const out = applyCorrections(FIXTURE, [{ lang: 'yo', key: 'greeting', value: 'Pẹlẹ o {name}' }]);
    expect(out).toContain('greeting: "Pẹlẹ o {name}"');
    expect(out).toContain("greeting: 'Sannu {name}'"); // Hausa untouched
    expect(out).toContain("greeting: 'Hello {name}'"); // English untouched
  });

  it('round-trips a value containing quotes, apostrophes and line breaks', () => {
    const nasty = 'Ka ce "a\'a"\nko ka ba ni lambar.';
    const out = applyCorrections(FIXTURE, [{ lang: 'ha', key: 'greeting', value: nasty }]);
    const at = locate(out).ha.greeting;
    expect(JSON.parse(out.slice(at.start, at.end).trim())).toBe(nasty);
  });

  it('applies several corrections at once without disturbing each other', () => {
    const out = applyCorrections(FIXTURE, [
      { lang: 'ha', key: 'greeting', value: 'A' },
      { lang: 'ha', key: 'farewell', value: 'B' },
      { lang: 'en', key: 'greeting', value: 'C {name}' },
    ]);
    const found = locate(out);
    expect(JSON.parse(out.slice(found.ha.greeting.start, found.ha.greeting.end).trim())).toBe('A');
    expect(JSON.parse(out.slice(found.ha.farewell.start, found.ha.farewell.end).trim())).toBe('B');
    expect(JSON.parse(out.slice(found.en.greeting.start, found.en.greeting.end).trim())).toBe('C {name}');
  });
});

describe('placeholdersOf', () => {
  it('finds them in any order and reports them sorted, so two sets can be compared', () => {
    expect(placeholdersOf('{b} and {a}')).toEqual(['a', 'b']);
    expect(placeholdersOf('{a} then {b}')).toEqual(['a', 'b']);
    expect(placeholdersOf('nothing here')).toEqual([]);
  });
});
