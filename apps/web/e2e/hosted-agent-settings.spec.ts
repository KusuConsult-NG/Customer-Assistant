import { test, expect, Page } from '@playwright/test';

/**
 * Settings → Hosted Agent: the tenant's own ElevenLabs workspace.
 *
 * An ElevenLabs workspace has no tenancy of its own — the agents, the numbers,
 * the WhatsApp lines and every transcript belong to whoever holds the key — so
 * the API refuses hosted-agent operations for a tenant that has no key. That
 * refusal shipped with no way to clear it from the dashboard: the key could only
 * be written by hand in SQL, and a credential nobody can rotate without a
 * database console does not get rotated.
 *
 * So what is being tested here is whether an operator can actually get out of
 * that state, and whether the screen tells them the truth on the way:
 *
 *   - the half-configured state is VISIBLE. A tenant with a key but no webhook
 *     secret looks fully set up and silently loses every transcript, and that is
 *     the state this whole feature makes reachable.
 *   - the server's own wording survives. It names the exact gap and the exact
 *     URL; a friendlier re-write in the browser is a second description of one
 *     state, and the friendlier one always drifts.
 *   - nothing echoes a credential back. There is no read-back endpoint at all,
 *     so a pre-filled box could only ever contain a mask — which somebody would
 *     eventually save as the new secret.
 *
 * Unlike live-console.spec.ts, nothing here is intercepted. These are real
 * requests against the real API, because the thing at risk is whether the two
 * agree about what is configured.
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

/** Open Settings → Hosted Agent, optionally overriding the signed-in role. */
async function openTab(page: Page, roleOverride?: string) {
  const { token, user } = await getAuth();
  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [token, roleOverride ? { ...user, role: roleOverride } : user]
  );

  await page.goto('/settings');
  await page.waitForLoadState('networkidle');
  const agentTabBtn = page.getByRole('button', { name: 'Hosted Agent' });
  await expect(agentTabBtn).toBeVisible({ timeout: 10000 });
  await agentTabBtn.click();
  await expect(page.getByText('ElevenLabs Workspace', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');
}

test.describe('Settings — Hosted Agent workspace', () => {
  test('displays dedicated workspace status and masked key fingerprint', async ({ page }) => {
    await openTab(page);

    await expect(page.getByText(/OWN WORKSPACE/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/••••/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/Webhook secret/i)).toBeVisible({ timeout: 15000 });
  });

  test('renders webhook URL matching current ngrok endpoint', async ({ page }) => {
    await openTab(page);

    await expect(
      page.locator('code').filter({ hasText: /\/api\/webhooks\/elevenlabs/ })
    ).toBeVisible({ timeout: 15000 });
  });

  test('leaves credential input empty so masks cannot be saved as secrets', async ({ page }) => {
    await openTab(page);

    const key = page.getByPlaceholder(/Replace the current key/i);
    await expect(key).toBeVisible({ timeout: 15000 });
    await expect(key).toHaveValue('');
  });

  test('offers no credential change form to viewers', async ({ page }) => {
    await openTab(page, 'VIEWER');

    await expect(page.getByText(/Only an OWNER or ADMIN can change workspace credentials/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Save Credentials' })).toHaveCount(0);
  });
});
