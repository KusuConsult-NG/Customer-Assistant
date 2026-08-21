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
      const email = 'admin@acedemo.com';
      const password = 'Admin@2030!';

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

  test('J1 & J9: the web chat widget is retired, and the dashboard does not offer it', async ({ page }) => {
    // The channel is gone: customers reach this platform on WhatsApp and by
    // phone. A nav entry or a reachable generator page would send an operator
    // off to configure something that no longer answers anyone.
    await page.goto('/');
    await expect(page.getByRole('link', { name: /embeddable widget/i })).toHaveCount(0);

    // Still served, and inert. A 404 here is a network error in a tenant's own
    // browser console that reads like an outage on our side.
    const script = await page.request.get('/widget.js');
    expect(script.status()).toBe(200);
    expect(await script.text()).toMatch(/retired/i);
  });

  test('J2: Telephony Dashboard & Voice Simulator', async ({ page }) => {
    await page.goto('/telephony');
    await expect(pageHeading(page, /PLASCHEMA.*Helpline/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Start Demo Simulation/i })).toBeVisible();
  });

  test('J3: CRM Pipeline & Contacts Board', async ({ page }) => {
    await page.goto('/crm');
    await expect(pageHeading(page, /Enrollee & Beneficiary Management/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Contacts/i }).first()).toBeVisible();
  });

  test('J5 & J6: Scheduling & Refund Request Management', async ({ page }) => {
    await page.goto('/scheduling');
    await expect(pageHeading(page, /PLASCHEMA Enrolment & Clinic Appointments/i)).toBeVisible();
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
    await expect(pageHeading(page, /PLASCHEMA Helpline Automation Workflows/i)).toBeVisible();
  });

  test('Auth guard: unauthenticated visitor is redirected to login', async ({ browser }) => {
    // Fresh context WITHOUT the injected token — must land on /login
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/crm');
    await page.waitForURL(/\/login/);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible({ timeout: 15_000 });
    await context.close();
  });
});
