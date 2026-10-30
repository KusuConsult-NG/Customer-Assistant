import { test, expect, Page } from '@playwright/test';
import { randomBytes } from 'crypto';

/**
 * The operating ministry's console, in a real browser against the real API.
 *
 * The API suite already proves the authorization rules. What a browser adds is
 * the thing only a browser can get wrong:
 *
 *   - that an ordinary agency OWNER whose localStorage CLAIMS to be a platform
 *     operator still gets refused. The stored flag decides whether a nav link
 *     is drawn, never what the server will serve, and this is where a UI starts
 *     quietly trusting the client;
 *   - that a rate with nothing to divide renders as "—" and not "0%", because a
 *     0 would rank an agency that has handled nothing at the top of a league
 *     table it never entered;
 *   - that nothing on the page shows a citizen's name, number or message.
 *
 * Each run creates its own agencies and removes them, so the suite does not
 * depend on what a previous run left behind.
 */

const API_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:4000';

type Seeded = {
  operatorToken: string;
  tenantToken: string;
  operatorOrgId: string;
  tenantOrgId: string;
  busyAgencyName: string;
  quietAgencyName: string;
  citizenName: string;
  citizenPhone: string;
  secretMessage: string;
};

let seeded: Seeded | null = null;

/**
 * Fixtures are created through the database rather than the API: provisioning
 * an agency needs a platform operator, and granting that is deliberately not
 * reachable over HTTP at all.
 */
async function seed(): Promise<Seeded> {
  if (seeded) return seeded;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@ace/database');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require('jsonwebtoken');

  const tag = `e2eplat-${randomBytes(3).toString('hex')}`;
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET must be set for the platform console e2e.');

  const mkOrg = async (name: string) =>
    prisma.organization.create({
      data: { name, slug: `${tag}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, industry: 'GOVERNMENT' },
    });

  const ministry = await mkOrg(`${tag} Ministry of Information`);
  const busy = await mkOrg(`${tag} Board of Internal Revenue`);
  const quiet = await mkOrg(`${tag} Water Services Corporation`);
  createdOrgIds.push(ministry.id, busy.id, quiet.id);

  const operator = await prisma.user.create({
    data: {
      organizationId: ministry.id, email: `${tag}-operator@mda.test`, passwordHash: 'x',
      fullName: 'Platform Operator', role: 'OWNER', isPlatformAdmin: true,
    },
  });
  const tenant = await prisma.user.create({
    data: {
      organizationId: busy.id, email: `${tag}-owner@mda.test`, passwordHash: 'x',
      fullName: 'Agency Owner', role: 'OWNER',
    },
  });

  // One citizen with one message, so the privacy assertion has something real
  // to fail against rather than passing because the database is empty.
  const citizenName = `Amina ${tag}`;
  const citizenPhone = `+2348${String(Date.now()).slice(-9)}`;
  const secretMessage = `CONFIDENTIAL-${tag}`;
  const contact = await prisma.contact.create({
    data: { organizationId: busy.id, fullName: citizenName, phoneNumber: citizenPhone },
  });
  const conversation = await prisma.conversation.create({
    data: { organizationId: busy.id, contactId: contact.id, channel: 'WHATSAPP', isHumanHandoffActive: true },
  });
  await prisma.message.create({
    data: { conversationId: conversation.id, sender: 'CUSTOMER', content: secretMessage },
  });

  const sign = (u: any, orgId: string) =>
    jwt.sign(
      { userId: u.id, organizationId: orgId, email: u.email, fullName: u.fullName, role: 'OWNER', tokenVersion: 0 },
      secret,
      { expiresIn: '1h' }
    );

  seeded = {
    operatorToken: sign(operator, ministry.id),
    tenantToken: sign(tenant, busy.id),
    operatorOrgId: ministry.id,
    tenantOrgId: busy.id,
    busyAgencyName: busy.name,
    quietAgencyName: quiet.name,
    citizenName, citizenPhone, secretMessage,
  };
  return seeded;
}

/** Only what THIS worker created. See the note in afterAll. */
const createdOrgIds: string[] = [];

test.afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@ace/database');

  // By id, not by slug prefix. `fullyParallel` runs this file's tests across
  // workers and each worker builds its own fixtures, so a prefix match deleted
  // ANOTHER worker's agencies while it was still using them — which surfaced
  // as this file intermittently failing one assertion in a full run and
  // passing every time it ran alone.
  for (const id of createdOrgIds) {
    await prisma.auditLog.deleteMany({ where: { organizationId: id } });
    await prisma.organization.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

async function openAs(page: Page, token: string, claimOperator: boolean) {
  await page.addInitScript(
    ([t, claim]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem(
        'ace_user',
        JSON.stringify({
          fullName: 'E2E User', email: 'e2e@mda.test', role: 'OWNER',
          organizationName: 'E2E', isPlatformAdmin: claim,
        })
      );
    },
    [token, claimOperator]
  );
  await page.goto('/platform');
  await page.waitForLoadState('networkidle');
}

test('the operator sees every agency, and rates with no basis read as a dash', async ({ page }) => {
  const s = await seed();
  await openAs(page, s.operatorToken, true);

  await expect(page.locator('h1').filter({ hasText: 'Platform Console' })).toBeVisible({ timeout: 15000 });

  // Cross-agency: both the operator's own agency and somebody else's.
  await expect(page.getByText(s.busyAgencyName, { exact: false })).toBeVisible();
  await expect(page.getByText(s.quietAgencyName, { exact: false })).toBeVisible();

  // An agency with no conversations has no handover rate. Scoped to that row,
  // because "—" appears wherever a rate cannot be computed.
  const quietRow = page.locator('tr').filter({ hasText: s.quietAgencyName });
  await expect(quietRow).toContainText('—');
  await expect(quietRow).toContainText('In service');
});

test('no citizen name, number or message appears anywhere on the page', async ({ page }) => {
  const s = await seed();
  await openAs(page, s.operatorToken, true);
  await expect(page.locator('h1').filter({ hasText: 'Platform Console' })).toBeVisible({ timeout: 15000 });

  // The whole rendered document, not a locator: a leak through a tooltip, a
  // title attribute or a stray field would still be a leak.
  const body = await page.locator('body').innerText();
  const html = await page.content();

  for (const forbidden of [s.citizenName, s.citizenPhone, s.secretMessage]) {
    expect(body).not.toContain(forbidden);
    expect(html).not.toContain(forbidden);
  }
});

test('an agency owner claiming to be an operator is still refused', async ({ page }) => {
  const s = await seed();
  // localStorage says isPlatformAdmin: true. It is not a permission.
  await openAs(page, s.tenantToken, true);

  await expect(page.getByText('Platform console unavailable')).toBeVisible({ timeout: 15000 });

  // Assert on controls, not on the heading: `hasText` is a case-insensitive
  // SUBSTRING match, so "Platform console unavailable" matches a filter for
  // "Platform Console" and an h1 check passes whichever page rendered.
  await expect(page.getByRole('button', { name: /Onboard agency/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Suspend/i })).toHaveCount(0);
  // And none of another agency's figures rendered before the refusal.
  await expect(page.getByText(s.quietAgencyName, { exact: false })).toHaveCount(0);
});

test('the console link is shown to an operator', async ({ page }) => {
  const s = await seed();
  await openAs(page, s.operatorToken, true);
  await expect(page.locator('a[href="/platform"]')).toHaveCount(1);
});

test('the console link is hidden from an agency owner', async ({ page }) => {
  const s = await seed();

  // A SEPARATE test rather than a second page in the operator's context: an
  // init script added to a context that already has one does not replace it,
  // so the two fixtures fought over the same localStorage key and the
  // assertion depended on their order. Each test gets its own fresh context
  // from the fixture, which is both correct and far quicker — the earlier
  // version loaded the whole dashboard root and sat at the 30s timeout.
  await openAs(page, s.tenantToken, false);

  // The sidebar still renders on the refusal page, which is where the link's
  // absence actually matters.
  await expect(page.getByText('Platform console unavailable')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('a[href="/platform"]')).toHaveCount(0);
});
