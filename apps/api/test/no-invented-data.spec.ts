/**
 * The dashboard must not invent facts about a citizen.
 *
 * ── Why a text scan, and why it is in the API suite ─────────────────────────
 *
 * This is invariant 1 applied to the screens: "no invented data shown to
 * humans". It has been broken three separate times in the same shape — a
 * falsy-fallback that substitutes a plausible value for an absent one:
 *
 *   contact.tags || ['customer', 'active-lead']   (the CRM detail panel)
 *   contact.tags || ['customer']                  (the CRM table, missed when
 *                                                  the panel was fixed)
 *   contact.tags || ['customer', 'active-lead']   (the scheduling screen)
 *
 * Each rendered a tag nobody assigned, in the same style as tags an officer
 * did assign, in the record they trust. A rendering test would have to find
 * every one of these screens with the right fixture; the pattern itself is
 * cheap to look for and is what keeps coming back.
 *
 * It lives here because `apps/web` has no test runner of its own beyond
 * Playwright, and the palette contrast suite already reads web source the same
 * way.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const WEB_APP = join(__dirname, '..', '..', 'web', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** A line that only DESCRIBES the pattern, such as the note recording its fix. */
function isComment(line: string): boolean {
  return /^\s*(\/\/|\*|\{\s*\/\*|\/\*)/.test(line);
}

describe('no screen substitutes a plausible value for an absent one', () => {
  const files = sourceFiles(WEB_APP);

  it('is reading the dashboard source at all', () => {
    // A scan that finds no files passes forever.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith(join('crm', 'page.tsx')))).toBe(true);
  });

  it('never falls back to an invented list of tags, badges or statuses', () => {
    // `x || ['something']` / `x ?? ['something']` — a literal array of strings
    // standing in for data that is simply not there.
    const inventedList = /(\|\||\?\?)\s*\[\s*'[^']+'\s*[,\]]/;
    const offenders: string[] = [];

    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (isComment(line)) return;
          if (!inventedList.test(line)) return;
          // A fallback the user is TOLD about is not an invention. The workflow
          // editor's reduced operator list says so on screen.
          if (/capabilities\?\.operators/.test(line)) return;
          offenders.push(`${file.replace(WEB_APP, 'apps/web/src')}:${i + 1}  ${line.trim()}`);
        });
    }

    expect(offenders).toEqual([]);
  });

  it('never invents a name, a status or a reference for a record that has none', () => {
    const invented =
      /(\|\||\?\?)\s*'(Valued Customer|customer|active-lead|Unknown Caller|CONFIRMED|PAID|ACTIVE|Verified)'/i;
    const offenders: string[] = [];

    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (isComment(line)) return;
          if (invented.test(line)) {
            offenders.push(`${file.replace(WEB_APP, 'apps/web/src')}:${i + 1}  ${line.trim()}`);
          }
        });
    }

    expect(offenders).toEqual([]);
  });
});
