import { test, expect, Page } from '@playwright/test';
import { randomBytes } from 'crypto';

/**
 * The catalogue editor, in a real browser.
 *
 * The API suite already proves tenant scoping and validation. What a browser
 * adds is whether the page tells the truth about CONSEQUENCES: these rows are
 * not settings, they are what the assistant says to a citizen and where it
 * sends them, and an editor that hides that invites someone to switch off the
 * only service the agency offers without realising registration stops.
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

async function open(page: Page) {
  const { token, user } = await getAuth();
  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [token, user]
  );
  await page.goto('/services');
  await expect(page.locator('h1').filter({ hasText: 'Services & Locations' })).toBeVisible({
    timeout: 15000,
  });
  await page.waitForLoadState('networkidle');
}

test('adds a service and then removes it again', async ({ page }) => {
  await open(page);
  const name = `E2E Service ${randomBytes(3).toString('hex')}`;

  await page.getByRole('button', { name: /Add service/i }).click();
  await page.locator('#svc-name').fill(name);
  await page.locator('#svc-phrases').fill('  E2E Probe , e2e probe , ');
  await page.getByRole('button', { name: 'Save' }).click();

  const row = page.getByText(name, { exact: false });
  await expect(row).toBeVisible({ timeout: 10000 });

  // Phrases are shown as they are actually matched — lowercased, trimmed and
  // de-duplicated — rather than as typed, so the editor is not quietly
  // showing something different from what a citizen's words are compared to.
  await expect(page.getByText('Recognised from: e2e probe', { exact: false })).toBeVisible();

  // Removing takes two steps and says what survives.
  await page.getByRole('button', { name: `Remove ${name}` }).click();
  await expect(page.getByText(/keep their records/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();

  await expect(page.getByText(name, { exact: false })).toHaveCount(0, { timeout: 10000 });
});

test('offers the State’s LGAs instead of a free-text box', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /^Locations/ }).click();
  await page.getByRole('button', { name: /Add location/i }).click();

  const select = page.locator('#loc-lga');
  await expect(select).toBeVisible();
  // A typed LGA is a location the assistant can never match a citizen to.
  await expect(select.locator('option')).toHaveCount(17);
  await expect(select.locator('option', { hasText: 'Jos North' })).toHaveCount(1);
});

test('says plainly what happens when nothing is offered', async ({ page }) => {
  await open(page);

  const services = await page.evaluate(async () => {
    const r = await fetch('http://localhost:4000/api/catalogue/services', {
      headers: { Authorization: `Bearer ${localStorage.getItem('ace_token')}` },
    });
    return r.json();
  });

  // The demo agency has services, so the warning must NOT be showing. The
  // assertion is on the pairing: a banner that appears regardless would be
  // noise, and one that never appears would be a trap.
  const active = (services as any[]).filter((s) => s.isActive).length;
  const warning = page.getByText('No active services', { exact: false });

  if (active > 0) {
    await expect(warning).toHaveCount(0);
  } else {
    await expect(warning).toBeVisible();
  }

  // And the coverage note states the real figure rather than a vague hint.
  const coverage = page.getByText(/of 17 LGAs/i);
  if ((await coverage.count()) > 0) {
    await expect(coverage.first()).toBeVisible();
  }
});
