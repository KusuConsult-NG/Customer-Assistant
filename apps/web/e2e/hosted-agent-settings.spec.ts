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
      const email = `e2e.agent.${Date.now()}@aceplatform.test`;
      const password = 'E2ETestPass123!';
      // Registration is throttled to 5/min, deliberately. This is the third e2e
      // file that registers an org, so a 429 waits rather than failing the suite
      // with an error that looks like a broken feature.
      let reg: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        reg = await fetch(`${API_URL}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            organizationName: 'E2E Hosted Agent Org',
            industry: 'CLINIC',
            email,
            password,
            fullName: 'E2E Agent Tester',
          }),
        });
        if (reg.status !== 429) break;
        await new Promise(resolve => setTimeout(resolve, 20_000));
      }
      if (!reg || !reg.ok) {
        throw new Error(`E2E register failed: ${reg?.status} ${await reg?.text()}`);
      }

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

const WORKSPACE_KEY = 'sk_e2e_tenant_workspace_key_wxyz';
const WEBHOOK_SECRET = 'wsec_e2e_tenant_secret_2468';

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
  await page.getByRole('button', { name: 'Hosted Agent' }).click();
  // The tab renders behind a fetch. The section heading proves it landed rather
  // than still spinning, and unlike the badge it says the same thing in both
  // states — so waiting on it does not presume which one we are in.
  await expect(page.getByText('ElevenLabs Workspace', { exact: true })).toBeVisible();
}

// Serial: these walk one organization from unconfigured to configured, and the
// unconfigured assertions are only true before the save.
test.describe.serial('Settings — Hosted Agent workspace', () => {
  test('says plainly that this organization has no workspace of its own', async ({ page }) => {
    await openTab(page);

    await expect(page.getByText('NO KEY OF ITS OWN', { exact: true })).toBeVisible();
    // Verbatim from the API. Not "not configured" — the consequence is that
    // every hosted-agent call is refused, and that is what an operator needs.
    await expect(page.getByText(/will all be refused|shared workspace/i)).toBeVisible();
  });

  test('renders the agent-status refusal rather than sitting blank', async ({ page }) => {
    await openTab(page);

    // Reading the agent status throws for a tenant with no key, and that
    // exception text IS the instruction. A panel that swallowed it would leave
    // an empty box with no way to find out why.
    //
    // Scoped to the Agent Status panel, and it has to be: unscoped, this matched
    // the workspace warning higher up the page, so the assertion passed with the
    // panel's own error swallowed entirely. A mutation run caught that.
    //
    // Matching on "ElevenLabs API key" rather than the whole sentence because the
    // refusal has two wordings — one for a deployment with a shared key present,
    // one without — and which fires depends on the environment, not on the code
    // being tested.
    const agentStatus = page
      .getByRole('heading', { name: 'Agent Status' })
      .locator('xpath=../..');
    await expect(agentStatus.getByText(/ElevenLabs API key/i)).toBeVisible();
  });

  test('offers empty credential boxes, never a credential read back', async ({ page }) => {
    await openTab(page);

    const key = page.getByPlaceholder('sk_...');
    const secret = page.getByPlaceholder('wsec_...');
    await expect(key).toHaveValue('');
    await expect(secret).toHaveValue('');
  });

  test('storing the key alone flips the workspace, and says what is still missing', async ({ page }) => {
    await openTab(page);

    await page.getByPlaceholder('sk_...').fill(WORKSPACE_KEY);
    await page.getByRole('button', { name: 'Save Credentials' }).click();

    await expect(page.getByText('OWN WORKSPACE', { exact: true })).toBeVisible();

    // The half-configured state, stated rather than implied: calls work, and
    // every transcript is rejected because nothing can verify its signature.
    await expect(page.getByText(/no webhook signing secret/i)).toBeVisible();
    // And the fix is an exact URL with this organization in the path — offered
    // as something to copy, not only described in the warning prose (which also
    // carries it, hence locating the code block rather than the text).
    await expect(
      page.locator('code').filter({ hasText: /\/api\/webhooks\/elevenlabs\/[0-9a-f-]{36}$/ })
    ).toBeVisible();
  });

  test('shows a fingerprint of the stored key and never the key', async ({ page }) => {
    await openTab(page);

    await expect(page.getByText('••••wxyz')).toBeVisible();
    // The point of a fingerprint is that it identifies without revealing.
    expect(await page.content()).not.toContain(WORKSPACE_KEY);
  });

  test('leaves the key box empty after a save, so a mask cannot be saved as the secret', async ({ page }) => {
    await openTab(page);

    const key = page.getByPlaceholder(/Replace the current key/);
    await expect(key).toBeVisible();
    await expect(key).toHaveValue('');
  });

  test('has nothing left to warn about once both halves are stored', async ({ page }) => {
    await openTab(page);

    await page.getByPlaceholder('wsec_...').fill(WEBHOOK_SECRET);
    await page.getByRole('button', { name: 'Save Credentials' }).click();

    await expect(page.getByText('Workspace credentials saved')).toBeVisible();
    await expect(page.getByText(/no webhook signing secret/i)).toBeHidden();
    await expect(page.getByText(/Webhook secret\s*set/)).toBeVisible();
  });

  test('offers no form at all to someone who cannot use it', async ({ page }) => {
    // The API refuses a non-admin with a 403. A form that submits into one is a
    // control that looks available and is not.
    await openTab(page, 'VIEWER');

    await expect(page.getByText(/Only an OWNER or ADMIN can change workspace credentials/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Credentials' })).toHaveCount(0);
  });
});
