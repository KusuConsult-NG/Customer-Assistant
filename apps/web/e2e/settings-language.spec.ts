import { test, expect, Page } from '@playwright/test';

/**
 * Settings → General → Default Language.
 *
 * The selector controls what language the AI opens conversations in until a
 * customer's own language is known. Two things are worth a browser test:
 *
 *   - the round trip is real: pick Hausa, save, reload — the selector shows
 *     Hausa because GET /organizations/me returned it, not because React
 *     remembered the click;
 *   - the five options are exactly the languages the orchestrator's template
 *     table can render. An option here with no templates behind it would be a
 *     selector that saves and changes nothing.
 *
 * The test restores English afterwards so reruns and neighbouring suites see
 * the org the way the seed left it.
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

async function openGeneralTab(page: Page) {
  const { token, user } = await getAuth();
  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [token, user]
  );
  await page.goto('/settings');
  await page.getByRole('button', { name: 'General' }).click();
  await expect(page.getByText('Default Language')).toBeVisible({ timeout: 15000 });
}

/** The one <select> that sits under the Default Language label. */
function languageSelect(page: Page) {
  return page
    .locator('div')
    .filter({ has: page.locator('label', { hasText: 'Default Language' }) })
    .locator('select')
    .last();
}

test.describe('Settings — default language', () => {
  test('offers exactly the five supported languages', async ({ page }) => {
    await openGeneralTab(page);

    const options = languageSelect(page).locator('option');
    await expect(options).toHaveCount(5);
    await expect(options).toHaveText([
      'English',
      'Nigerian Pidgin',
      'Hausa',
      'Igbo',
      'Yoruba',
    ]);
  });

  test('persists the choice through a save and a reload', async ({ page }) => {
    await openGeneralTab(page);

    await languageSelect(page).selectOption('ha');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('Settings saved!')).toBeVisible({ timeout: 10000 });

    // A fresh load: the value must come back from the API, not from state.
    await page.reload();
    await page.getByRole('button', { name: 'General' }).click();
    await expect(languageSelect(page)).toHaveValue('ha', { timeout: 15000 });

    // Restore the seed's default so reruns and neighbours are unaffected.
    await languageSelect(page).selectOption('en');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('Settings saved!')).toBeVisible({ timeout: 10000 });
  });

  test('the API refuses a language the platform cannot speak', async ({ page }) => {
    // The UI only offers valid codes, so this guard lives server-side — but it
    // is what stands between the form and a selector that silently saves
    // nothing, so it is pinned here with the same session the form uses.
    const { token } = await getAuth();
    const res = await fetch(`${API_URL}/api/organizations/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ defaultLanguage: 'fr' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/defaultLanguage must be one of/);
  });
});
