import { test, expect, Page } from '@playwright/test';

/**
 * Agent Provisioning, in a real browser.
 *
 * Two of these operations change something in the world: importing a phone
 * number moves who answers an agency's calls, and pausing a WhatsApp line
 * stops the agent replying to every citizen on that number. The API guards
 * both behind a confirmation flag it will not default, and the point of that
 * flag is that a person reads a sentence before it is set.
 *
 * A screen can satisfy that server-side check and still defeat it completely,
 * by sending the flag on a bare button click. So what is tested here is not
 * that the requests succeed — the API suite covers the endpoints — but that
 * the browser makes somebody acknowledge the consequence FIRST, and that no
 * request leaves until they have.
 *
 * ElevenLabs cannot be driven from a test, so its responses are intercepted.
 * The thing under test lives entirely in the browser: whether the screen tells
 * an operator the truth about what a button is about to do.
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

const AGENT = {
  configured: true,
  agentId: 'agent_e2e',
  remoteAgentFound: true,
  drift: [],
  toolCount: 7,
  expectedToolCount: 7,
};

const OUR_LINE = {
  phoneNumberId: 'wa_ours',
  phoneNumber: '+2348012340001',
  phoneNumberName: 'Main line',
  businessAccountName: 'Ministry of Information',
  assignedAgentId: 'agent_e2e',
  isOurs: true,
  isTokenExpired: false,
  messagingEnabled: true,
};

/** Every POST body the page sent, by endpoint, so a test can assert on it. */
type Sent = Record<string, any>;

async function openPage(
  page: Page,
  opts: {
    agent?: any;
    numbers?: any[];
    whatsapp?: any[];
    role?: string;
    rotateKey?: string;
    releaseNote?: string;
  } = {}
): Promise<Sent> {
  const { token, user } = await getAuth();
  const sent: Sent = {};

  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [token, { ...user, ...(opts.role ? { role: opts.role } : {}) }]
  );

  const json = (body: any) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/agent-provisioning/status', r => r.fulfill(json(opts.agent ?? AGENT)));
  await page.route('**/api/agent-provisioning/numbers', r => r.fulfill(json(opts.numbers ?? [])));
  await page.route('**/api/agent-provisioning/whatsapp', r => r.fulfill(json(opts.whatsapp ?? [])));

  await page.route('**/api/agent-provisioning/numbers/import', r => {
    sent.import = r.request().postDataJSON();
    return r.fulfill(json({ phoneNumberId: 'phnum_e2e', phoneNumber: '+2348012340001', label: 'x', assignedAgentId: 'agent_e2e', isOurs: true }));
  });
  await page.route('**/api/agent-provisioning/numbers/release', r => {
    sent.release = r.request().postDataJSON() ?? {};
    return r.fulfill(json({ released: true, note: opts.releaseNote ?? 'Re-point its voice webhook in the Twilio console.' }));
  });
  await page.route('**/api/agent-provisioning/whatsapp/pause', r => {
    sent.pause = r.request().postDataJSON();
    const paused = sent.pause?.paused !== false;
    return r.fulfill(json({ paused, note: paused ? 'Nothing is answering this line.' : 'The agent is answering again.' }));
  });
  await page.route('**/api/agent-provisioning/rotate-key', r => {
    sent.rotate = true;
    return r.fulfill(json({ agentKey: opts.rotateKey ?? 'ace_live_pk_e2e_rotated' }));
  });

  await page.goto('/agent-provisioning');
  await expect(page.locator('h1').filter({ hasText: 'Agent Provisioning' })).toBeVisible({ timeout: 15000 });
  return sent;
}

const gate = (page: Page, text: string) =>
  page.locator('label').filter({ hasText: text }).locator('input[type=checkbox]');

test.describe('Agent provisioning — the voice cutover', () => {
  test('sends nothing until the operator acknowledges what importing does', async ({ page }) => {
    const sent = await openPage(page);

    await page.getByRole('button', { name: 'Import the Twilio number' }).click();

    const importBtn = page.getByRole('button', { name: 'Import and cut over', exact: true });
    await expect(importBtn).toBeDisabled();

    // The flag the API requires is not something the screen may supply on its
    // own. Nothing has left the browser while the box is unticked.
    await importBtn.click({ force: true }).catch(() => {});
    expect(sent.import).toBeUndefined();

    await gate(page, 'I understand that the hosted agent will answer').check();
    await expect(importBtn).toBeEnabled();
    await importBtn.click();

    await expect.poll(() => sent.import?.confirmVoiceCutover).toBe(true);
  });

  test('says plainly that this changes who answers the citizen', async ({ page }) => {
    await openPage(page);
    await page.getByRole('button', { name: 'Import the Twilio number' }).click();

    await expect(page.getByText('This changes who talks to your citizens')).toBeVisible();
    // The reversal is part of the decision: a cutover nobody can undo is a
    // cutover nobody will risk.
    await expect(page.getByText(/releasing the number brings it back/i)).toBeVisible();
  });

  test('leaves inbound SMS alone unless it is asked for', async ({ page }) => {
    const sent = await openPage(page);

    await page.getByRole('button', { name: 'Import the Twilio number' }).click();
    await gate(page, 'I understand that the hosted agent will answer').check();
    await page.getByRole('button', { name: 'Import and cut over', exact: true }).click();

    // Upstream defaults this ON. This platform consumes no inbound SMS, so
    // taking that default would change a tenant's Twilio configuration for
    // nothing they asked for.
    await expect.poll(() => sent.import?.enableSms).toBe(false);
  });

  test("shows the server's own note about what releasing leaves undone", async ({ page }) => {
    const sent = await openPage(page, {
      numbers: [{ phoneNumberId: 'phnum_e2e', phoneNumber: '+2348012340001', label: 'Main line', assignedAgentId: 'agent_e2e', isOurs: true }],
      releaseNote: 'ElevenLabs no longer answers this number. Re-point its voice webhook in the Twilio console.',
    });

    await page.getByRole('button', { name: 'Release this number', exact: true }).click();
    await page.getByRole('button', { name: 'Release the number', exact: true }).click();

    await expect.poll(() => sent.release).toBeTruthy();
    // Verbatim. A friendlier re-write in the browser is a second description
    // of one state, and it is the one that drifts.
    await expect(page.getByText(/Re-point its voice webhook in the Twilio console/)).toBeVisible();
  });
});

test.describe('Agent provisioning — the WhatsApp line', () => {
  test('gates a line-wide pause behind its own acknowledgement', async ({ page }) => {
    const sent = await openPage(page, { whatsapp: [OUR_LINE] });

    await page.getByRole('button', { name: 'Pause the whole line' }).click();
    await expect(page.getByText('This is an outage, not a handoff')).toBeVisible();

    const pauseBtn = page.getByRole('button', { name: 'Pause the line', exact: true });
    await expect(pauseBtn).toBeDisabled();
    expect(sent.pause).toBeUndefined();

    await gate(page, 'I understand this silences the agent for every conversation').check();
    await pauseBtn.click();

    await expect.poll(() => sent.pause?.confirmAffectsEveryConversation).toBe(true);
    await expect.poll(() => sent.pause?.paused).toBe(true);
  });

  test('shows a paused line as an unanswered queue, and resumes without a second gate', async ({ page }) => {
    const sent = await openPage(page, { whatsapp: [{ ...OUR_LINE, messagingEnabled: false }] });

    await expect(page.getByText('PAUSED')).toBeVisible();
    await expect(page.getByText(/Messages from citizens still arrive and nothing answers them/)).toBeVisible();

    // Resuming restores service, so it needs no ceremony — only pausing does.
    await page.getByRole('button', { name: 'Let the agent answer again' }).click();
    await expect.poll(() => sent.pause?.paused).toBe(false);
  });

  test('reports an unknown pause state as unknown, rather than picking one', async ({ page }) => {
    await openPage(page, { whatsapp: [{ ...OUR_LINE, messagingEnabled: null }] });

    // false would invent an outage; true would hide a real one.
    await expect(page.getByText('PAUSE STATE NOT REPORTED')).toBeVisible();
    await expect(page.getByText('PAUSED', { exact: true })).toHaveCount(0);
  });

  test('will not attach a line whose Meta token has expired', async ({ page }) => {
    await openPage(page, {
      whatsapp: [{ ...OUR_LINE, phoneNumberId: 'wa_free', assignedAgentId: null, isOurs: false, isTokenExpired: true }],
    });

    await expect(page.getByText('META TOKEN EXPIRED')).toBeVisible();
    // Attaching it would report success and then answer nothing.
    await expect(page.getByRole('button', { name: /Attach to this agency/ })).toBeDisabled();
    await expect(page.getByText(/Reconnect it in the ElevenLabs dashboard/)).toBeVisible();
  });

  test('says a line is connected elsewhere, not here', async ({ page }) => {
    await openPage(page, { whatsapp: [] });

    // There is no create endpoint — Meta's embedded signup needs a human — and
    // the screen must not imply otherwise.
    await expect(page.getByText(/Connect one in the ElevenLabs dashboard/)).toBeVisible();
  });
});

test.describe('Agent provisioning — the agent key', () => {
  test('shows a rotated key once and says it will not be shown again', async ({ page }) => {
    await openPage(page, { rotateKey: 'ace_live_pk_e2e_rotated' });

    await page.getByRole('button', { name: 'Rotate agent key' }).click();

    await expect(page.getByText('ace_live_pk_e2e_rotated')).toBeVisible();
    await expect(page.getByText(/only time this key is displayed/i)).toBeVisible();

    // Dismissal is an acknowledgement, not a close button.
    await page.getByRole('button', { name: 'I have saved this key' }).click();
    await expect(page.getByText('ace_live_pk_e2e_rotated')).toHaveCount(0);
  });

  test('tells a member they cannot change how the agency is connected', async ({ page }) => {
    // The stored role is a CONVENIENCE for the wording; the API is what
    // refuses. This asserts the screen states the limit rather than leaving
    // somebody to find it by clicking.
    await openPage(page, { role: 'AGENT' });

    await expect(page.getByText(/restricted to an OWNER or ADMIN/)).toBeVisible();
  });
});
