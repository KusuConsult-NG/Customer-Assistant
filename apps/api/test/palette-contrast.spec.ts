/**
 * The brand palette meets WCAG AA, and nothing reintroduces a raw brand hex.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * Every primary button in the dashboard was written
 * `bg-[#558A02] hover:bg-[#74BA03] text-white`. White on #74BA03 measures
 * 2.40:1 — under the 4.5 AA needs for body text, and under even the 3:1 floor
 * for large text and graphics. So the button failed AA at the exact moment a
 * pointer was on it, and failed it WORSE than at rest (#558A02 is 4.18:1,
 * itself under the line). Hover lifted the fill when it needed to deepen it.
 *
 * It was written that way 175 times, as a literal hex, so there was no single
 * place to correct it and no way to notice it had drifted.
 *
 * ── The second bug ──────────────────────────────────────────────────────────
 *
 * tailwind.config.js redefined `indigo`, `blue` AND `purple` to that same lime
 * ramp. Three semantic families collapsed into one colour: scheduling draws a
 * RESCHEDULED chip blue and a COMPLETED chip purple, so two statuses were
 * indistinguishable on screen, and every `text-blue-600` in the app — toast
 * info icons, ticket references — rendered acid green. A colour override that
 * makes `blue` not blue is invisible at every call site, which is why this
 * asserts on the config rather than on any one page.
 *
 * ── Why it asserts ratios and not hex values ────────────────────────────────
 *
 * Pinning the hexes would only restate the config. The ratios are the property
 * anybody actually cares about, so a future palette is free to change as long
 * as each ROLE still clears its floor.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const WEB_SRC = join(__dirname, '..', '..', 'web', 'src');
const TAILWIND_CONFIG = join(__dirname, '..', '..', 'web', 'tailwind.config.js');
const PDF_SRC = join(__dirname, '..', '..', '..', 'packages', 'pdf-generator', 'src', 'index.ts');

// WCAG 2.1 relative luminance and contrast ratio.
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tailwind = require(TAILWIND_CONFIG);
const brand = tailwind.theme.extend.colors.brand as Record<string, string>;
const surface = tailwind.theme.extend.colors.surface as Record<string, string>;

const WHITE = '#ffffff';
const SLATE_50 = '#f8fafc';
const SLATE_100 = '#f1f5f9';
const SLATE_800 = '#1e293b';

describe('brand palette contrast', () => {
  // [description, foreground, background, minimum]
  // 4.5 is AA for body text; 3 is AA for graphics, icons and borders.
  const roles: Array<[string, string, string, number]> = [
    ['white text on a primary fill (brand-600)', WHITE, brand[600], 4.5],
    ['white text on a hovered fill (brand-700)', WHITE, brand[700], 4.5],
    ['brand text on white (brand-700)', brand[700], WHITE, 4.5],
    ['brand text on slate-50 (brand-700)', brand[700], SLATE_50, 4.5],
    ['brand text on a dark card (brand-300)', brand[300], surface.card, 4.5],
    ['brand text on the dark canvas (brand-300)', brand[300], surface.canvas, 4.5],
    ['brand icon on a light badge (brand-600)', brand[600], SLATE_100, 3],
    ['brand icon on a dark badge (brand-400)', brand[400], SLATE_800, 3],
    ['brand graphic on white (brand-600)', brand[600], WHITE, 3],
    ['brand graphic on a dark card (brand-500)', brand[500], surface.card, 3],
    ['focus ring on white (brand-600)', brand[600], WHITE, 3],
    ['logo-chip gradient, lightest stop under a white icon', WHITE, brand[600], 3],
  ];

  it.each(roles)('%s clears its floor', (_label, fg, bg, min) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
  });

  it('deepens on hover rather than lifting', () => {
    // The specific regression: a hover step that raises luminance under white
    // text. brand-700 must be darker than brand-600, not lighter.
    expect(luminance(brand[700])).toBeLessThan(luminance(brand[600]));
    expect(ratio(WHITE, brand[700])).toBeGreaterThan(ratio(WHITE, brand[600]));
  });
});

describe('the semantic colour families mean what they say', () => {
  it('does not redefine indigo, blue or purple', () => {
    const overridden = ['indigo', 'blue', 'purple', 'red', 'emerald', 'amber'].filter(
      (family) => family in tailwind.theme.extend.colors,
    );
    expect(overridden).toEqual([]);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css|svg)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('no raw brand hex returns to the dashboard', () => {
  it('has every brand colour behind a token', () => {
    const offenders: string[] = [];
    for (const file of walk(WEB_SRC)) {
      const body = readFileSync(file, 'utf8');
      // The two literals the sweep replaced, in either case.
      const hits = body.match(/#(?:558a02|74ba03)/gi);
      if (hits) offenders.push(`${file.replace(WEB_SRC, '')} (${hits.length})`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps no duplicate className attribute on one element', () => {
    // Replacing `style={{ color }}` with a class produced four tags carrying
    // className twice. JSX keeps the LAST one, so the first silently lost its
    // font sizing — a change that renders, and is wrong.
    const offenders: string[] = [];
    for (const file of walk(WEB_SRC).filter((f) => f.endsWith('.tsx'))) {
      const body = readFileSync(file, 'utf8');
      for (const line of body.split('\n')) {
        if (/className=[^>]*\bclassName=/.test(line)) offenders.push(`${file.replace(WEB_SRC, '')}: ${line.trim().slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the digital ID card uses the same ramp', () => {
  it('draws its colours from brand steps, not its own greens', () => {
    const body = readFileSync(PDF_SRC, 'utf8');
    const declared = [...body.matchAll(/(?:mark|fill|deep):\s*'(#[0-9a-f]{6})'/gi)].map((m) => m[1].toLowerCase());
    expect(declared.length).toBeGreaterThan(0);
    const ramp = Object.values(brand).map((v) => v.toLowerCase());
    for (const colour of declared) expect(ramp).toContain(colour);
  });

  it('keeps the card readable at the mark colour', () => {
    // The card is dark in both themes, so the mark itself carries text there.
    expect(ratio(brand[500], '#0f172a')).toBeGreaterThanOrEqual(4.5);
  });
});
