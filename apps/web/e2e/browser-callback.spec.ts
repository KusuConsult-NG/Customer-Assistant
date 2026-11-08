import { test, expect, Page } from '@playwright/test';
import { randomBytes } from 'crypto';

/**
 * Ringing a citizen back from the browser, on an Infobip line.
 *
 * What a browser adds over the API suite (`apps/api/test/infobip-callbacks.spec.ts`):
 *
 *  - the queue shows "Call from browser" — and NOT "Call now", which the API
 *    would only refuse — exactly when the agency's line is Infobip, and says
 *    what is missing when it cannot work;
 *  - a refused claim (another officer is on it) shows the server's words and
 *    reports nothing;
 *  - when Infobip's SDK cannot connect, the page says so and reports the call
 *    as NOT PLACED with a reason, so the citizen is charged no attempt. This
 *    runs the REAL `infobip-rtc` package against a token Infobip will not
 *    accept: there is no Infobip account behind this suite, and the honest
 *    failure is the one path that can be proven without one.
 *
 * Assertions are on the REQUESTS the page makes, not only on its toasts — a
 * toast can claim a call that no request recorded.
 */

const API_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:4000';
const createdOrgIds: string[] = [];

type Seeded = { token: string; callbackId: string; citizen: string };

async function seedAgency(): Promise<Seeded> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@ace/database');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET must be set for the browser callback e2e.');

  const tag = `e2eibcb-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: { name: `${tag} Agency`, slug: tag, industry: 'GOVERNMENT' },
  });
  createdOrgIds.push(org.id);
  const digits = String(randomBytes(3).readUIntBE(0, 3)).padStart(8, '0').slice(0, 8);
  await prisma.telephonyConfig.create({
    data: { organizationId: org.id, provider: 'INFOBIP', phoneNumber: `+23480${digits}` },
  });
  const user = await prisma.user.create({
    data: { organizationId: org.id, email: `${tag}@mda.test`, passwordHash: 'x', fullName: 'Amina Officer', role: 'AGENT' },
  });
  const citizen = `+23481${digits}`;
  const contact = await prisma.contact.create({
    data: { organizationId: org.id, phoneNumber: citizen, fullName: 'Ngozi Pam' },
  });
  const cb = await prisma.callbackRequest.create({
    data: {
      organizationId: org.id,
      contactId: contact.id,
      phoneNumber: citizen,
      reason: 'pension arrears since March',
      promisedText: 'Within the hour',
      status: 'DUE',
      dueAt: new Date(Date.now() - 60_000),
    },
  });
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      organizationId: org.id,
      role: 'AGENT',
      tokenVersion: user.tokenVersion ?? 0,
    },
    secret,
    { expiresIn: '1h' }
  );
  return { token, callbackId: cb.id, citizen };
}

test.afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@ace/database');
  for (const id of createdOrgIds) {
    await prisma.callLog.deleteMany({ where: { organizationId: id } }).catch(() => {});
    await prisma.organization.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

async function openQueue(page: Page, seeded: Seeded) {
  await page.addInitScript((t) => {
    window.localStorage.setItem('ace_token', t as string);
    window.localStorage.setItem(
      'ace_user',
      JSON.stringify({ fullName: 'Amina Officer', email: 'amina@mda.test', role: 'AGENT', organizationName: 'E2E' })
    );
  }, seeded.token);
  await page.goto('/callbacks');
  await expect(page.locator(`[data-callback-row]`).first()).toBeVisible({ timeout: 20000 });
}

const json = (body: any, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

test.describe('Callback queue on an Infobip line', () => {
  test('offers "Call from browser" instead of "Call now", from the real API', async ({ page }) => {
    const seeded = await seedAgency();
    await openQueue(page, seeded);

    // The REAL dialling endpoint decided this: nothing is stubbed here.
    await expect(page.getByTestId('officer-dialling-notice')).toContainText('is on Infobip');
    await expect(page.getByRole('button', { name: /Call from browser/ })).toBeEnabled();
    await expect(page.getByRole('button', { name: /^Call now$/ })).toHaveCount(0);
  });

  test('says what is missing, and disables the button, when it cannot work', async ({ page }) => {
    const seeded = await seedAgency();
    await page.route('**/api/callbacks/dialling', (r) =>
      r.fulfill(json({ mode: 'officer-browser', line: '+2348000000000', ready: false, blocked: ['INFOBIP_API_KEY is not set.'] }))
    );
    await openQueue(page, seeded);

    await expect(page.getByTestId('officer-dialling-notice')).toContainText('INFOBIP_API_KEY is not set.');
    await expect(page.getByRole('button', { name: /Call from browser/ })).toBeDisabled();
  });

  test('keeps "Call now" for an agency the API dials itself', async ({ page }) => {
    const seeded = await seedAgency();
    await page.route('**/api/callbacks/dialling', (r) =>
      r.fulfill(json({ mode: 'automatic', line: '+2348000000000', ready: true, blocked: [] }))
    );
    await openQueue(page, seeded);

    await expect(page.getByRole('button', { name: /^Call now$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Call from browser/ })).toHaveCount(0);
    await expect(page.getByTestId('officer-dialling-notice')).toHaveCount(0);
  });

  test('shows the server\'s refusal when another officer has the call, and reports nothing', async ({ page }) => {
    const seeded = await seedAgency();
    let results = 0;
    await page.route('**/api/callbacks/*/browser-call', (r) =>
      r.fulfill(json({ statusCode: 409, message: 'Musa Danladi is already calling this citizen.' }, 409))
    );
    await page.route('**/api/callbacks/*/browser-call/result', (r) => {
      results += 1;
      return r.fulfill(json({}, 500));
    });
    await openQueue(page, seeded);

    await page.getByRole('button', { name: /Call from browser/ }).click();
    await expect(page.getByText('Musa Danladi is already calling this citizen.')).toBeVisible();
    await expect(page.getByTestId('browser-call-panel')).toHaveCount(0);
    expect(results).toBe(0);
  });

  test('a double-click sends ONE claim, not two', async ({ page }) => {
    const seeded = await seedAgency();
    let claims = 0;
    await page.route('**/api/callbacks/*/browser-call', async (r) => {
      claims += 1;
      // Slow, so the second click lands while the first claim is in flight.
      // What stops it is that the click sets "starting" synchronously and React
      // re-renders after a click before the next one is handled — the button
      // is already disabled. A change that moved that state change behind an
      // await would send two claims, and this would catch it.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return r.fulfill(json({ statusCode: 409, message: 'Stopped here on purpose.' }, 409));
    });
    await openQueue(page, seeded);

    await page.getByRole('button', { name: /Call from browser/ }).dblclick();
    // `.first()`: two claims would raise two identical toasts, and a strict
    // locator would then fail on visibility instead of on the count below.
    await expect(page.getByText('Stopped here on purpose.').first()).toBeVisible();
    await page.waitForTimeout(600); // let a second claim, if any, arrive
    expect(claims).toBe(1);
  });

  // Two ways the real SDK fails before a phone rings, each reported as NOT
  // PLACED with the SDK's own reason:
  //  - a token it cannot parse: `createInfobipRtc` throws before connecting;
  //  - a well-formed but unsigned token: it CONNECTS to Infobip, and Infobip
  //    refuses the registration — the page then hears DISCONNECTED.
  const b64u = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsignedJwt = () =>
    `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({
      identity: 'officer_e2e',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.bm90LWEtc2lnbmF0dXJl`;

  for (const variant of [
    { name: 'a token the SDK cannot read', token: () => 'not-a-real-infobip-token', reason: /could not start/ },
    { name: 'a token Infobip refuses', token: unsignedJwt, reason: /Infobip/ },
  ]) {
    test(`with ${variant.name}: reports NOT PLACED with the reason, and claims nothing`, async ({ page }) => {
      test.setTimeout(90_000);
      const seeded = await seedAgency();
      let started: any = null;
      let reported: any = null;

      // The claim is stubbed so no real Infobip token is requested; everything
      // after it — loading the SDK, connecting, giving up — is the real package.
      await page.route('**/api/callbacks/*/browser-call', (r) => {
        started = { url: r.request().url(), method: r.request().method() };
        return r.fulfill(
          json(
            {
              reference: 'CB-E2E',
              token: variant.token(),
              expiresAt: null,
              to: seeded.citizen.replace(/^\+/, ''),
              from: '2348000000000',
            },
            201
          )
        );
      });
      await page.route('**/api/callbacks/*/browser-call/result', (r) => {
        reported = r.request().postDataJSON();
        return r.fulfill(json({ reference: 'CB-E2E', status: 'DUE', attempts: null, failureReason: null }, 201));
      });
      await openQueue(page, seeded);

      await page.getByRole('button', { name: /Call from browser/ }).click();

      // The connect timeout is 20s; the SDK may give up sooner.
      await expect.poll(() => reported, { timeout: 45_000 }).not.toBeNull();
      expect(started.url).toContain(`/api/callbacks/${seeded.callbackId}/browser-call`);
      expect(started.method).toBe('POST');
      expect(reported.outcome).toBe('not_placed');
      expect(reported.reason).toMatch(variant.reason);
      expect(reported.durationSeconds).toBe(0);

      await expect(page.getByText(/Not placed/)).toBeVisible();
      await expect(page.getByText(/no attempt was counted/)).toBeVisible();
      await expect(page.getByText(/^Reached/)).toHaveCount(0);
      await expect(page.getByTestId('browser-call-panel')).toHaveCount(0);
    });
  }
});
