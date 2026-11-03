import { test, expect, Page } from '@playwright/test';

/**
 * Every word the dashboard renders is readable, in both themes.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * Primary buttons were `bg-[#558A02] hover:bg-[#74BA03] text-white`. White on
 * #74BA03 measures 2.40:1 — under AA's 4.5 for text and under even the 3:1
 * floor for graphics — so the button failed at the moment a pointer was on it,
 * and failed worse than at rest. That shipped 175 times as a literal hex.
 *
 * apps/api/test/palette-contrast.spec.ts pins the BRAND ramp's roles. It
 * cannot see what those tokens are actually painted on, and that is where the
 * rest of the damage was:
 *
 *  - `dark:bg-white dark:bg-slate-900` on the Conversations panes. Two dark
 *    backgrounds on one element; which wins is decided by the order Tailwind
 *    emits them, not the order they are written, and white won — so the whole
 *    conversation list stayed white in dark mode with dark-mode text on it.
 *    Citizen names rendered at 1.1:1. Invisible, and no test could see it.
 *  - `text-slate-400 dark:text-slate-500`, inverted: the LIGHTER step in light
 *    mode (2.56:1) and the darker one on the dark canvas.
 *  - Status chips — emerald, amber, blue, purple — at 3.0–4.4:1 on their own
 *    pale tints.
 *  - recharts paints each legend label in its SERIES colour, inline, which
 *    beats `wrapperStyle`, so "Calls" rendered at 2.82:1.
 *
 * None of those is visible in a class name. Each needs the colour that was
 * actually painted, which is why this measures the rendered page.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *
 * Walks every element that paints its own text, composites the background
 * actually behind it (respecting translucency), and applies the AA threshold
 * for that text's size and weight.
 *
 * Two things are deliberately not measured:
 *  - text over a CSS gradient, because `backgroundColor` is transparent there
 *    and compositing down to the page would report white-on-white for every
 *    white-on-brand-gradient button. Those pairs are asserted by role in
 *    apps/api/test/palette-contrast.spec.ts.
 *  - anything inside `[data-brand-preview]`, which renders the TENANT'S own
 *    chosen colours. They may pick an unreadable one; the preview shows it
 *    faithfully and the note under the picker states the measurement.
 */

const API_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:4000';

const ROUTES = [
  '/', '/analytics', '/crm', '/conversations', '/agent-console', '/knowledge',
  '/workflows', '/broadcasts', '/telephony', '/scheduling', '/callbacks', '/agent-provisioning',
  '/services', '/white-label', '/settings', '/platform',
];

type Finding = {
  route: string; theme: string; text: string; cls: string;
  color: string; bg: string; ratio: number; need: number;
};

async function signIn(page: Page, theme: 'light' | 'dark') {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@acedemo.com', password: 'Admin@2030!' }),
  });
  if (!res.ok) throw new Error(`E2E login failed: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  await page.addInitScript(
    ([token, user, th]) => {
      localStorage.setItem('ace_token', token as string);
      localStorage.setItem('ace_user', JSON.stringify(user));
      localStorage.setItem('ace_theme', th as string);
    },
    [data.accessToken, data.user, theme] as const
  );
}

/** Runs in the page. Returns every text node whose contrast is below AA. */
const MEASURE = () => {
  const channel = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = (c: { r: number; g: number; b: number }) =>
    0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);

  const parse = (s: string) => {
    const m = (s || '').match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };

  // Source-over. The backdrop carries its own alpha: treating it as opaque
  // reports every translucent dark card as a light one.
  const over = (fg: any, bg: any) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    };
  };

  // null means "painted over a gradient" — not measurable this way.
  const backdrop = (el: Element) => {
    let acc: any = null;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (st.backgroundImage && st.backgroundImage !== 'none') return null;
      const c = parse(st.backgroundColor);
      if (c && c.a > 0) acc = acc ? over(acc, c) : c;
      if (acc && acc.a >= 0.999) return acc;
    }
    const page = parse(getComputedStyle(document.body).backgroundColor);
    const base = page && page.a >= 1 ? page : { r: 255, g: 255, b: 255, a: 1 };
    return acc ? over(acc, base) : base;
  };

  const out: any[] = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (el.closest('[data-brand-preview]')) continue;

    const paintsOwnText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent || '').trim().length > 1
    );
    if (!paintsOwnText) continue;

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

    const fgRaw = parse(cs.color);
    if (!fgRaw) continue;
    const bg = backdrop(el);
    if (!bg) continue;
    const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;

    const l1 = lum(fg), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (px >= 18.66 && +cs.fontWeight >= 700);
    const need = large ? 3 : 4.5;

    if (ratio < need) {
      const cls =
        typeof el.className === 'string' ? el.className : (el as any).className?.baseVal || '';
      out.push({
        text: (el.textContent || '').trim().slice(0, 50),
        cls: cls.slice(0, 110),
        color: cs.color,
        bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        ratio: +ratio.toFixed(2),
        need,
      });
    }
  }
  return out;
};

for (const theme of ['light', 'dark'] as const) {
  test(`every dashboard page meets WCAG AA in ${theme} mode`, async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, theme);

    const findings: Finding[] = [];
    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);

      // A page rendering in the wrong theme measures the wrong thing and
      // would pass by accident, so this is checked rather than assumed.
      const isDark = await page.evaluate(() =>
        document.documentElement.classList.contains('dark')
      );
      expect(isDark, `${route} should render in ${theme} mode`).toBe(theme === 'dark');

      for (const f of await page.evaluate(MEASURE)) findings.push({ route, theme, ...f });
    }

    // Asserts it actually looked at something: a selector that silently
    // matches nothing passes every time.
    const measured = await page.evaluate(
      () => document.querySelectorAll('body *').length
    );
    expect(measured).toBeGreaterThan(50);

    const report = findings
      .map(
        (f) =>
          `  ${f.ratio}:1 (needs ${f.need}) ${f.theme} ${f.route}\n` +
          `    "${f.text}"  ${f.color} on ${f.bg}\n    ${f.cls}`
      )
      .join('\n');
    expect(findings.length, `Text below WCAG AA:\n${report}`).toBe(0);
  });
}
