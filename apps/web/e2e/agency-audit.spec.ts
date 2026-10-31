import { test, expect, Page } from '@playwright/test';

/**
 * Settings → Activity Log.
 *
 * The API behaviour — what is recorded, what is scoped out, and that a
 * ministry official is never named to a tenant — is covered by the Jest suite
 * against a real database. What a browser adds is the one thing that lives
 * only here: whether an operator reading the log can tell what their own
 * agency did from what was done to it, and whether a change is legible at all.
 *
 * An audit entry that renders as a JSON blob is technically complete and
 * practically useless; a role change shown as `{"role":"ADMIN"}` does not say
 * what it replaced. So these assert on the rendered meaning, not on presence.
 *
 * Responses are intercepted. The real endpoint needs audit rows belonging to
 * the demo agency, and seeding them through the API would mean performing the
 * very administrative actions whose records are being inspected — which makes
 * the fixture depend on the feature under test.
 */

const API_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:4000';

let cachedAuth: Promise<{ token: string; user: any }> | null = null;
function getAuth() {
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

const ROLE_CHANGE = {
  id: 'aud-1',
  action: 'agency.member.role_changed',
  origin: 'agency',
  actor: 'Grace Yakubu (grace@mda.test)',
  actorIsOwnStaff: true,
  targetType: 'User',
  targetId: 'user-1',
  previousValue: { role: 'AGENT' },
  newValue: { role: 'ADMIN', email: 'tanko@mda.test' },
  createdAt: new Date('2026-10-20T09:15:00Z').toISOString(),
};

const SUSPENSION = {
  id: 'aud-2',
  action: 'platform.agency.suspended',
  origin: 'platform',
  actor: 'Platform operator (operating ministry)',
  actorIsOwnStaff: false,
  targetType: 'Organization',
  targetId: 'org-1',
  previousValue: null,
  newValue: { reason: 'Pending data-protection review' },
  createdAt: new Date('2026-10-21T11:00:00Z').toISOString(),
};

async function openActivityLog(
  page: Page,
  opts: { entries?: any[]; status?: number } = {}
) {
  const { token, user } = await getAuth();
  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [token, user]
  );

  await page.route('**/api/organizations/audit*', (route) => {
    if (opts.status && opts.status !== 200) {
      return route.fulfill({
        status: opts.status,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Forbidden resource', statusCode: opts.status }),
      });
    }
    const entries = opts.entries ?? [ROLE_CHANGE, SUSPENSION];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries, count: entries.length, limit: 200 }),
    });
  });

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Activity Log' }).click();
  await expect(page.getByRole('heading', { name: 'Activity Log' })).toBeVisible({ timeout: 15000 });
}

test.describe('Settings — activity log', () => {
  test('says which entries are the agency’s own and which the ministry’s', async ({ page }) => {
    await openActivityLog(page);

    // An operator looking for "why were we suspended" should not have to
    // decode an action prefix to find it.
    //
    // `exact` on both, because getByText is a case-insensitive SUBSTRING
    // match: a bare 'THIS AGENCY' also matches the page's own "Configure this
    // agency's identity…" blurb and the "By this agency (1)" filter button,
    // and 'MINISTRY' matches the sentence about the operating ministry.
    await expect(page.getByText('THIS AGENCY', { exact: true })).toBeVisible();
    await expect(page.getByText('MINISTRY', { exact: true })).toBeVisible();
    await expect(page.getByText('agency.member.role_changed')).toBeVisible();
    await expect(page.getByText('platform.agency.suspended')).toBeVisible();
  });

  test('renders a role change as what it replaced, not just what it became', async ({ page }) => {
    await openActivityLog(page);

    // `{"role":"ADMIN"}` does not say who was promoted from what. Both sides,
    // or the entry answers nothing.
    const entry = page.locator('li').filter({ hasText: 'agency.member.role_changed' });
    await expect(entry).toContainText('AGENT');
    await expect(entry).toContainText('ADMIN');
    await expect(entry).toContainText('Grace Yakubu');
  });

  test('shows the suspension reason the ministry recorded', async ({ page }) => {
    await openActivityLog(page);

    const entry = page.locator('li').filter({ hasText: 'platform.agency.suspended' });
    await expect(entry).toContainText('Pending data-protection review');
  });

  test('explains why an outside actor has no name', async ({ page }) => {
    await openActivityLog(page);

    // Without this, somebody reads an unnamed actor as the record being vague
    // rather than as a boundary being held deliberately.
    await expect(page.getByText(/names the role and not the person/i)).toBeVisible();
    await expect(page.getByText('Platform operator (operating ministry)')).toBeVisible();
  });

  test('filters to just what was done to the agency', async ({ page }) => {
    await openActivityLog(page);

    await page.getByRole('button', { name: /By the ministry/ }).click();

    await expect(page.getByText('platform.agency.suspended')).toBeVisible();
    await expect(page.getByText('agency.member.role_changed')).toHaveCount(0);
  });

  test('an empty log says what will appear in it', async ({ page }) => {
    await openActivityLog(page, { entries: [] });

    // "No records" invites the reader to wonder whether logging is even on.
    await expect(page.getByText(/Changes to team roles, account access and API keys appear here/i)).toBeVisible();
  });

  test('a member without permission is told why, not shown an error', async ({ page }) => {
    await openActivityLog(page, { status: 403 });

    // A 403 here is a legitimate answer for an AGENT or VIEWER.
    await expect(page.getByText(/Only an OWNER or ADMIN can read the activity log/i)).toBeVisible();
  });
});
