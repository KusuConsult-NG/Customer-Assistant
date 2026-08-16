import { test, expect, Page } from '@playwright/test';

/**
 * Customer Care Agent — Customer Journey E2E Tests
 *
 * These run against the REAL stack: Next.js app + NestJS API + PostgreSQL.
 *
 * Why this file authenticates first: every dashboard page is behind the
 * layout's auth guard (no ace_token in localStorage → router.replace('/login')).
 * The previous version of this suite navigated straight to the pages with a
 * fresh browser context, so 6 of 7 tests could never pass against the real
 * app — they asserted page headings while sitting on the login screen.
 *
 * A real org is registered through the API once per run, and the issued JWT is
 * injected into localStorage BEFORE each page load via addInitScript.
 *
 * Locator note: the app shell renders its own <h1>Customer Care Agent</h1> brand next
 * to each page's <h1>, so a bare locator('h1') is ambiguous (strict-mode
 * violation). Assertions filter by expected text instead.
 */

const API_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:4000';

let cachedAuth: Promise<{ token: string; user: any }> | null = null;

function getAuth(): Promise<{ token: string; user: any }> {
  if (!cachedAuth) {
    cachedAuth = (async () => {
      const email = `e2e.${Date.now()}@aceplatform.test`;
      const password = 'E2ETestPass123!';
      const reg = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationName: 'E2E Journey Org',
          industry: 'CLINIC',
          email,
          password,
          fullName: 'E2E Tester',
        }),
      });
      if (!reg.ok) throw new Error(`E2E register failed: ${reg.status} ${await reg.text()}`);

      const login = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!login.ok) throw new Error(`E2E login failed: ${login.status} ${await login.text()}`);
      const data: any = await login.json();
      return { token: data.accessToken, user: data.user };
    })();
  }
  return cachedAuth;
}

async function authedPage(page: Page): Promise<void> {
  const { token, user } = await getAuth();
  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [token, user]
  );
}

function pageHeading(page: Page, pattern: RegExp) {
  // Filter avoids the shell's own <h1>Customer Care Agent</h1> (strict-mode safe)
  return page.locator('h1').filter({ hasText: pattern }).first();
}

test.describe('Customer Care Agent Customer Journey E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await authedPage(page);
  });

  test('J1 & J9: Widget Generator & Embeddable Web Chat', async ({ page }) => {
    await page.goto('/widget');
    await expect(page).toHaveTitle(/Customer Care Agent/i);
    await expect(pageHeading(page, /Widget/i)).toBeVisible();
  });

  test('J2: Telephony Dashboard & Voice Simulator', async ({ page }) => {
    await page.goto('/telephony');
    await expect(pageHeading(page, /Voice AI Telephony/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Start Demo Simulation/i })).toBeVisible();
  });

  test('J3: CRM Pipeline & Contacts Board', async ({ page }) => {
    await page.goto('/crm');
    // Real heading is 'Customer Relationship Management' — the original
    // suite asserted /CRM/i, text that has never appeared in this h1.
    await expect(pageHeading(page, /Customer Relationship Management/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Contacts/i }).first()).toBeVisible();
  });

  test('J5 & J6: Scheduling & Refund Request Management', async ({ page }) => {
    await page.goto('/scheduling');
    // Real heading is 'Scheduling & Reservation Engine' (original suite
    // asserted 'Bookings & Reservations', which never existed on this page).
    await expect(pageHeading(page, /Scheduling & Reservation/i)).toBeVisible();
  });

  test('J7: Settings & Team Management', async ({ page }) => {
    await page.goto('/settings');
    await expect(pageHeading(page, /Settings/i)).toBeVisible();
  });

  test('J8: Billing & Plan Comparison', async ({ page }) => {
    await page.goto('/billing');
    await expect(pageHeading(page, /Billing/i)).toBeVisible();
  });

  test('J10: Workflows Automation Engine', async ({ page }) => {
    await page.goto('/workflows');
    // Real heading is 'Visual Workflow Automation Engine' (singular 'Workflow').
    await expect(pageHeading(page, /Workflow Automation/i)).toBeVisible();
  });

  test('Auth guard: unauthenticated visitor is redirected to login', async ({ browser }) => {
    // Fresh context WITHOUT the injected token — must land on /login
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/crm');
    await page.waitForURL(/\/login/);
    // The guard redirects with a client-side router.replace, so the URL changes
    // as soon as navigation starts — before the login route's payload has been
    // fetched and rendered. Waiting only for the URL raced that fetch against
    // the default 5s assertion timeout and failed intermittently under load.
    // The assertion itself is unchanged: the sign-in form must appear.
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible({ timeout: 15_000 });
    await context.close();
  });
});
