import { test, expect, Page } from '@playwright/test';

/**
 * Settings → Voice, in a real browser.
 *
 * This form decides how citizens' calls reach an agency, and three of its
 * defects were invisible from the screen — it reported "saved" and the damage
 * appeared on a phone line.
 *
 *  - It PRE-FILLED credentials from their own masks. `GET /me` returns
 *    `••••1234`, the input showed that, and saving stored the mask as the
 *    credential. Twilio then rejected every call with an auth error pointing at
 *    the wrong system entirely. The screen is the only place this can be
 *    prevented, because the API cannot tell a mask from a password somebody
 *    genuinely typed.
 *  - Two of its five providers were not enum values, so choosing them returned
 *    a bare 500 and the form said "Failed to save" with nothing else.
 *  - A SIP trunk — the arrangement that removes Twilio from voice entirely —
 *    had no fields at all, so the import endpoint that reads them could only
 *    answer "No SIP trunk is configured".
 *
 * The API suite covers what the endpoint stores. What is tested here is what
 * the form SENDS, because that is where a mask becomes a credential.
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

/** An organization as `GET /api/organizations/me` returns it: credentials MASKED. */
const orgWith = (telephony: Record<string, unknown>) => ({
  id: 'org_e2e',
  name: 'Ministry of Information',
  slug: 'ministry-e2e',
  industry: 'OTHER',
  whatsAppConfigs: [],
  users: [],
  telephonyConfigs: [telephony],
});

async function openVoiceTab(
  page: Page,
  telephony: Record<string, unknown> = {}
): Promise<{ saved?: any }> {
  const { token, user } = await getAuth();
  const sent: { saved?: any } = {};

  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [token, user]
  );

  const json = (body: any, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/organizations/me', r => r.fulfill(json(orgWith(telephony))));
  await page.route('**/api/organizations/telephony-config', r => {
    sent.saved = r.request().postDataJSON();
    return r.fulfill(json({ ...telephony, ...sent.saved, sipPassword: null, authToken: null }, 201));
  });

  await page.goto('/settings');
  await page.getByRole('button', { name: /^Voice/i }).first().click();
  await expect(page.getByText('Voice AI Telephony')).toBeVisible({ timeout: 15000 });
  return sent;
}

const saveButton = (page: Page) => page.getByRole('button', { name: /Save Voice Config/i });

test.describe('Settings → Voice — credentials', () => {
  test('never puts a masked credential in an input, and never sends one back', async ({ page }) => {
    const sent = await openVoiceTab(page, {
      id: 'tc_1',
      provider: 'TWILIO',
      phoneNumber: '+2348012345670',
      accountSid: '••••1234',
      authToken: '••••abcd',
    });

    // The masks are shown as TEXT, so the operator can tell which credential is
    // configured...
    await expect(page.getByText('••••abcd')).toBeVisible();

    // ...and the inputs are empty, so a save cannot store the mask.
    const authInput = page.locator('input[type=password]').first();
    await expect(authInput).toHaveValue('');

    await saveButton(page).click();
    await expect.poll(() => sent.saved?.provider).toBe('TWILIO');

    // The whole point: nothing credential-shaped left the browser.
    expect(sent.saved.authToken).toBeUndefined();
    expect(sent.saved.accountSid).toBeUndefined();
    expect(JSON.stringify(sent.saved)).not.toContain('••••');
  });

  test('sends a credential the operator actually typed', async ({ page }) => {
    const sent = await openVoiceTab(page, {
      id: 'tc_1',
      provider: 'TWILIO',
      phoneNumber: '+2348012345670',
      accountSid: '••••1234',
      authToken: '••••abcd',
    });

    await page.locator('input[type=password]').first().fill('a-real-twilio-token');
    await saveButton(page).click();

    await expect.poll(() => sent.saved?.authToken).toBe('a-real-twilio-token');
  });
});

test.describe('Settings → Voice — the provider list', () => {
  test('offers only providers the API accepts', async ({ page }) => {
    await openVoiceTab(page, { id: 'tc_1', provider: 'TWILIO', phoneNumber: '+2348012345670' });

    const values = await page.locator('select').first().locator('option').evaluateAll(
      opts => opts.map(o => (o as HTMLOptionElement).value)
    );

    // These two were in the list and are not enum members, so choosing either
    // returned a 500 and saved nothing.
    expect(values).not.toContain('AFRICA_TALKING');
    expect(values).not.toContain('NIGERIAN_CARRIER');
    expect(values).toContain('AFRICAS_TALKING');
    expect(values).toContain('NIGERIA_CARRIER_FORWARD');
    expect(values).toContain('SIP_TRUNK');
  });

  test("shows the API's own reason when a save is refused", async ({ page }) => {
    await openVoiceTab(page, { id: 'tc_1', provider: 'TWILIO', phoneNumber: '+2348012345670' });

    await page.route('**/api/organizations/telephony-config', r =>
      r.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 400, message: 'A SIP trunk needs its host address — sip.carrier.ng' }),
      })
    );

    await saveButton(page).click();

    // "Failed to save" with the reason discarded is what left an operator with
    // two unsaveable providers and nothing to go on.
    await expect(page.getByText(/needs its host address/i)).toBeVisible();
  });
});

test.describe('Settings → Voice — a SIP trunk', () => {
  test('offers the trunk fields the import endpoint reads', async ({ page }) => {
    const sent = await openVoiceTab(page, { id: 'tc_1', provider: 'TWILIO', phoneNumber: '+2348012345670' });

    await page.locator('select').first().selectOption('SIP_TRUNK');
    await expect(page.getByText('SIP trunk', { exact: true })).toBeVisible();

    await page.getByLabel('SIP Host Address').fill('sip.carrier.ng');
    await page.getByLabel('Transport').selectOption('tls');
    await page.getByLabel('SIP Username').fill('ministry');
    await page.locator('input[type=password]').first().fill('trunk-secret');

    await saveButton(page).click();

    await expect.poll(() => sent.saved?.provider).toBe('SIP_TRUNK');
    expect(sent.saved.sipAddress).toBe('sip.carrier.ng');
    expect(sent.saved.sipTransport).toBe('tls');
    expect(sent.saved.sipUsername).toBe('ministry');
    expect(sent.saved.sipPassword).toBe('trunk-secret');
  });

  test('does not print an inbound webhook URL for a line it does not answer', async ({ page }) => {
    await openVoiceTab(page, { id: 'tc_1', provider: 'TWILIO', phoneNumber: '+2348012345670' });

    // Twilio delivers here, so the URL belongs on screen.
    await expect(page.getByText('/api/telephony/inbound/twilio')).toBeVisible();

    await page.locator('select').first().selectOption('SIP_TRUNK');

    // A SIP trunk is answered by the hosted agent. Printing our webhook URL
    // invites the operator to point the trunk back at us and undo the cutover.
    await expect(page.getByText('/api/telephony/inbound/')).toHaveCount(0);
    await expect(page.getByText(/Point the trunk at ElevenLabs, not here/i)).toBeVisible();
  });

  test("spells Africa's Talking webhook the way the route is actually registered", async ({ page }) => {
    await openVoiceTab(page, { id: 'tc_1', provider: 'TWILIO', phoneNumber: '+2348012345670' });

    await page.locator('select').first().selectOption('AFRICAS_TALKING');

    // The enum is AFRICAS_TALKING; the route is 'africa-talking'. Spelling the
    // URL from the enum hands the operator a 404 to paste into their carrier's
    // portal.
    await expect(page.getByText('/api/telephony/inbound/africa-talking')).toBeVisible();
  });
});

test.describe('Settings → Voice — the forwarding number', () => {
  test('is settable, because every handoff refusal tells operators to set it', async ({ page }) => {
    const sent = await openVoiceTab(page, { id: 'tc_1', provider: 'TWILIO', phoneNumber: '+2348012345670' });

    await page.getByLabel('Forwarding Number').fill('+2348090000001');
    await saveButton(page).click();

    await expect.poll(() => sent.saved?.forwardingNumber).toBe('+2348090000001');
  });

  test('says what happens when it is empty, instead of leaving it a mystery', async ({ page }) => {
    await openVoiceTab(page, { id: 'tc_1', provider: 'TWILIO', phoneNumber: '+2348012345670' });

    // The AI must never claim a transfer it cannot make, and an operator who
    // leaves this blank should know what the caller will actually be told.
    await expect(page.getByText(/high-priority ticket/i)).toBeVisible();
  });
});
