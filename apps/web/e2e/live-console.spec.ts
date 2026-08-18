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
      const email = `e2e.live.${Date.now()}@aceplatform.test`;
      const password = 'E2ETestPass123!';
      // Registration is throttled to 5/min, deliberately. This is now the
      // second e2e file that registers an org, and a retry in either one can
      // push a run over the limit — so a 429 waits rather than failing the
      // suite with an error that looks like a broken feature.
      let reg: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        reg = await fetch(`${API_URL}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            organizationName: 'E2E Live Console Org',
            industry: 'CLINIC',
            email,
            password,
            fullName: 'E2E Live Tester',
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

    await page.getByText('+2348111111111').first().click();

    // Exact, because the left-hand list also previews the latest turn — prefixed
    // with "Customer: " — and a substring match finds both.
    await expect(
      page.getByText('I need to move my appointment to Friday.', { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText('Thank you for calling. How can I help?', { exact: true })
    ).toBeVisible();
  });

  test('offers no reply box for a live call', async ({ page }) => {
    await consoleWithLiveCall(page);
    await page.getByText('+2348111111111').first().click();

    // The conversation is running on ElevenLabs. Anything typed here would be
    // saved nowhere and spoken to nobody, so there must be no input at all —
    // not a disabled one an operator can type into and wonder about.
    await expect(page.getByPlaceholder(/type your message/i)).toHaveCount(0);
    await expect(page.getByText(/read-only/i)).toBeVisible();
    await expect(page.getByText('AI is handling this')).toBeVisible();
  });

  test('says how stale the view is rather than claiming to be live', async ({ page }) => {
    await consoleWithLiveCall(page);

    // The feed is polled every few seconds. An unqualified "Live" would be a
    // promise this data cannot keep.
    await expect(page.getByTitle('This view is polled, not streamed')).toBeVisible();
  });

  test('hides the live section entirely when no call is in progress', async ({ page }) => {
    await consoleWithLiveCall(page, []);

    await expect(page.getByText('AI on a call now')).toHaveCount(0);
  });

  test('does not present a live call as a stored conversation', async ({ page }) => {
    await consoleWithLiveCall(page);

    // The stored inbox is fed by /api/conversations and is empty for a fresh
    // org. If a live call leaked into it, this would find it.
    await expect(page.getByText('Incoming customer chats will appear here')).toBeVisible();
  });
});
