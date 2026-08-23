import { test, expect, Page } from '@playwright/test';

/**
 * The analytics page, against the real API and the seeded demo data.
 *
 * What matters here is not that charts draw — recharts draws — but the three
 * promises the page makes to the person staffing a helpline off it:
 *
 *   - the numbers come from the same keys the live engine writes
 *     (metadata.intent on AI replies, preferredLanguage on contacts), so the
 *     seeded fixtures must surface under their HUMAN labels;
 *   - every chart carries the relief the light-mode contrast WARNs obligate:
 *     a working table view of the same rows;
 *   - a section with nothing to show says so honestly instead of rendering an
 *     empty chart that reads as "zero of everything".
 */

const API_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:4000';

let cachedAuth: Promise<{ token: string; user: any }> | null = null;

function getAuth(): Promise<{ token: string; user: any }> {
  if (!cachedAuth) {
    cachedAuth = (async () => {
      const login = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@acedemo.com', password: 'Admin@2030!' }),
      });
      if (!login.ok) throw new Error(`E2E login failed: ${login.status} ${await login.text()}`);
      const data: any = await login.json();
      return { token: data.accessToken, user: data.user };
    })();
  }
  return cachedAuth;
}

async function openAnalytics(page: Page) {
  const { token, user } = await getAuth();
  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [token, user]
  );
  await page.goto('/analytics');
  await expect(page.locator('h1').filter({ hasText: 'Analytics' })).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');
}

/** The card whose <h3> is `title` — scoped so shared words cannot collide. */
function card(page: Page, title: string) {
  return page
    .locator('div.rounded-2xl')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

test.describe('Analytics — staff insights', () => {
  test('shows what customers ask for, under human labels', async ({ page }) => {
    await openAnalytics(page);

    const intents = card(page, 'What customers ask for');
    await expect(intents).toBeVisible();
    // The seed labels AI replies REQUEST_QUOTATION and BOOK_APPOINTMENT — the
    // page must render the human names, not the enum values.
    await expect(intents.getByText('Price / quote')).toBeVisible({ timeout: 10000 });
    await expect(intents.getByText('Book appointment')).toBeVisible();
    await expect(intents.getByText('REQUEST_QUOTATION')).toHaveCount(0);
  });

  test('shows the customer language mix, including the honest unknown bucket', async ({ page }) => {
    await openAnalytics(page);

    const langs = card(page, 'Languages your customers prefer');
    await expect(langs).toBeVisible();
    // Seeded: 2× Hausa, 1× Pidgin, 1× English, 4 with no recorded language.
    await expect(langs.getByText('Hausa')).toBeVisible({ timeout: 10000 });
    await expect(langs.getByText('Nigerian Pidgin')).toBeVisible();
    // Absence of a detection is "not yet known" — never silently dropped, and
    // never miscounted as English. Exact: the card's description quotes the
    // phrase too.
    await expect(langs.getByText('Not yet known', { exact: true })).toBeVisible();
  });

  test('every populated chart offers the table view (the relief rule)', async ({ page }) => {
    await openAnalytics(page);

    const intents = card(page, 'What customers ask for');
    await intents.getByRole('button', { name: 'Show as table' }).click();

    const table = intents.locator('table');
    await expect(table).toBeVisible();
    // The table is the same data, not a decoration: the seeded intent row is in it.
    await expect(table.getByText('Price / quote')).toBeVisible();

    // And it toggles back.
    await intents.getByRole('button', { name: 'Show as chart' }).click();
    await expect(intents.locator('table')).toHaveCount(0);
  });

  test('a section with nothing to report says so instead of drawing an empty chart', async ({ page }) => {
    await openAnalytics(page);

    // The seed escalates nothing to a human, so this section must be an honest
    // sentence — and with nothing to tabulate, no table toggle either.
    const handoffs = card(page, 'Why threads reach your team');
    await expect(handoffs.getByText('No conversations are waiting on a person right now.')).toBeVisible();
    await expect(handoffs.getByRole('button', { name: 'Show as table' })).toHaveCount(0);
  });

  test('the period filter reloads the data it claims to', async ({ page }) => {
    await openAnalytics(page);

    const request30d = page.waitForRequest((r) => r.url().includes('/api/analytics/insights?period=30d'));
    await page.getByRole('button', { name: 'Last 30 days' }).click();
    await request30d;

    // Seeded activity is from today, so it stays visible in the wider window.
    await expect(card(page, 'What customers ask for').getByText('Price / quote')).toBeVisible({ timeout: 10000 });
  });

  test('daily volume is present with its own table view', async ({ page }) => {
    await openAnalytics(page);

    const volume = card(page, 'Daily volume');
    await expect(volume).toBeVisible();
    await volume.getByRole('button', { name: 'Show as table' }).click();
    await expect(volume.locator('table th').filter({ hasText: 'Customer' })).toBeVisible();
  });
});
