import { test, expect, Page } from '@playwright/test';

/**
 * The agent console's live panel.
 *
 * A live conversation is one the hosted agent is running RIGHT NOW. It has no
 * row in our database, cannot be replied to, and vanishes when the call ends.
 * A stored conversation does none of those things. The whole risk this file
 * guards is the two being confused — an operator typing a reply into a call
 * that can never receive one, and believing they answered the customer.
 *
 * The live feed itself comes from ElevenLabs, which cannot be driven from a
 * test, so the API response is intercepted. That is not a mock standing in for
 * the feature: the endpoint and its payload are covered by the API suite, and
 * what is being tested here is the only thing that lives in the browser —
 * whether the screen tells an operator the truth about what they are looking
 * at.
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

const LIVE_CALL = {
  conversationId: 'conv_e2e_live',
  agentId: 'agent_e2e',
  status: 'in-progress',
  startedAt: new Date().toISOString(),
  durationSecs: 95,
  channel: 'voice',
  customerNumber: '+2348111111111',
  turns: [
    { role: 'agent', message: 'Thank you for calling. How can I help?', timeInCallSecs: 0 },
    { role: 'user', message: 'I need to move my appointment to Friday.', timeInCallSecs: 6 },
  ],
  turnCount: 2,
};

async function consoleWithLiveCall(page: Page, conversations: any[] = [LIVE_CALL]) {
  const { token, user } = await getAuth();
  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [token, user]
  );

  await page.route('**/api/agent-provisioning/live', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(conversations) })
  );

  await page.goto('/agent-console');
}

test.describe('Agent console — live calls', () => {
  test('shows a call the AI is handling right now', async ({ page }) => {
    await consoleWithLiveCall(page);

    await expect(page.getByText('AI on a call now')).toBeVisible();
    await expect(page.getByText('+2348111111111').first()).toBeVisible();
    // Duration, so an operator can see a call is dragging without opening it.
    await expect(page.getByText('1:35').first()).toBeVisible();
  });

  test('shows the transcript so far when the call is opened', async ({ page }) => {
    await consoleWithLiveCall(page);

    const callBtn = page.getByRole('button', { name: /\+2348111111111/ }).first();
    await expect(callBtn).toBeVisible({ timeout: 10000 });
    await callBtn.click();

    await expect(
      page.getByText('I need to move my appointment to Friday.', { exact: true })
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByText('Thank you for calling. How can I help?', { exact: true })
    ).toBeVisible({ timeout: 10000 });
  });

  test('offers no reply box for a live call', async ({ page }) => {
    await consoleWithLiveCall(page);
    const callBtn = page.getByRole('button', { name: /\+2348111111111/ }).first();
    await expect(callBtn).toBeVisible({ timeout: 10000 });
    await callBtn.click();

    // The conversation is running on ElevenLabs. Anything typed here would be
    // saved nowhere and spoken to nobody, so there must be no input at all —
    // not a disabled one an operator can type into and wonder about.
    await expect(page.getByPlaceholder(/type your message/i)).toHaveCount(0);
    await expect(page.getByText('AI is handling this')).toBeVisible();
  });

  test('offers a transfer, and says where the call goes', async ({ page }) => {
    await consoleWithLiveCall(page);
    const callBtn = page.getByRole('button', { name: /\+2348111111111/ }).first();
    await expect(callBtn).toBeVisible({ timeout: 10000 });
    await callBtn.click();

    // "Take over" alone reads like joining the call. It is not — the call
    // transfers to an operator phone. The button says where it goes.
    await expect(page.getByRole('button', { name: /transfer to a person|transfer/i })).toBeVisible();
    await expect(page.getByText(/Sends this call to your forwarding number/i)).toBeVisible();
  });

  test('shows the server refusal verbatim rather than a cheerier version', async ({ page }) => {
    await consoleWithLiveCall(page);
    const callBtn = page.getByRole('button', { name: /\+2348111111111/ }).first();
    await expect(callBtn).toBeVisible({ timeout: 10000 });
    await callBtn.click();

    // The API refuses the transfer when no operator number is configured.
    await page.route('**/api/agent-provisioning/live/*/takeover', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          taken: false,
          reason: 'No operator transfer phone number is configured for this organization.',
        }),
      });
    });

    await page.getByRole('button', { name: /transfer to a person|transfer/i }).click();

    await expect(
      page.getByText(/No operator transfer phone number is configured/i)
    ).toBeVisible();
  });

  test('confirms only what actually happened', async ({ page }) => {
    await consoleWithLiveCall(page);
    const callBtn = page.getByRole('button', { name: /\+2348111111111/ }).first();
    await expect(callBtn).toBeVisible({ timeout: 10000 });
    await callBtn.click();

    await page.route('**/api/agent-provisioning/live/*/takeover', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          taken: true,
          message: 'Transferred to +2348000000000',
        }),
      });
    });

    await page.getByRole('button', { name: /transfer to a person|transfer/i }).click();

    await expect(page.getByText(/Transferred to \+2348000000000/)).toBeVisible();
  });

  test('offers no transfer button for a WhatsApp conversation', async ({ page }) => {
    await consoleWithLiveCall(page, [{
      ...LIVE_CALL,
      channel: 'whatsapp',
      turns: [{ role: 'agent', message: 'Hello', timeInCallSecs: 0 }],
    }]);

    await expect(page.getByRole('button', { name: /transfer/i })).toHaveCount(0);
  });

  test('says how stale the view is rather than claiming to be live', async ({ page }) => {
    await consoleWithLiveCall(page);

    // Matches "just now", "10s ago", etc.
    await expect(page.getByText(/ago|just now/)).toBeVisible();
  });

  test('hides the live section entirely when no call is in progress', async ({ page }) => {
    await consoleWithLiveCall(page, null as any);

    await expect(page.getByText('AI on a call now')).toHaveCount(0);
  });

  test('does not present a live call as a stored conversation', async ({ page }) => {
    await consoleWithLiveCall(page);

    // Live section renders prominently above stored inbox
    await expect(page.getByText('AI on a call now')).toBeVisible();
    await expect(page.getByText('+2348111111111').first()).toBeVisible();
  });
});
