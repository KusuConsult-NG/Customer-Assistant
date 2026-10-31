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

/**
 * ── The agency detail panel ──────────────────────────────────────────────────
 *
 * The table answers "which agency is struggling"; the panel answers
 * "struggling at WHAT". The assertions below are about the three facts that
 * cannot be read from a row of totals — whether a citizen can reach the
 * agency at all, whether anybody ever accepted their invitation, and why a
 * suspension happened — plus the one that matters most: that opening a new
 * surface over an agency did not open a window onto its citizens.
 */

/** An agency that is already out of service, so the reason has something to render. */
async function seedSuspendedAgency(reason: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@ace/database');
  const tag = `e2esusp-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: {
      name: `${tag} Bureau of Statistics`,
      slug: tag,
      industry: 'GOVERNMENT',
      suspendedAt: new Date(),
      suspendedReason: reason,
    },
  });
  createdOrgIds.push(org.id);
  return org;
}

async function openDetail(page: Page, agencyName: string) {
  await page.getByRole('button', { name: agencyName }).first().click();
  const panel = page.getByRole('dialog', { name: 'Agency detail' });
  await expect(panel).toBeVisible({ timeout: 10000 });

  // VISIBILITY IS NOT READINESS. The panel renders the moment it is opened,
  // with "Loading…" as its heading, and fills in when the request returns.
  // Without this wait, a test that snapshots the document reads it before any
  // agency data is in it — which is how the privacy assertion below first
  // passed against a build that was provably leaking a citizen's name and
  // phone number into this very panel.
  await expect(panel.getByText('Channels', { exact: true })).toBeVisible({ timeout: 10000 });
  return panel;
}

test('the detail panel shows what a row of totals cannot', async ({ page }) => {
  const s = await seed();
  await openAs(page, s.operatorToken, true);
  await expect(page.locator('h1').filter({ hasText: 'Platform Console' })).toBeVisible({ timeout: 15000 });

  const panel = await openDetail(page, s.busyAgencyName);

  // Counts the comparison table does not carry at all.
  await expect(panel).toContainText('Knowledge docs');
  await expect(panel).toContainText('Automations');

  // Readiness, which is a different question from activity: this fixture has
  // neither channel configured, so no citizen can reach it however busy its
  // totals look.
  await expect(panel).toContainText('WhatsApp: not connected');
  await expect(panel).toContainText('Telephone: not connected');
  await expect(panel).toContainText(/No channel is connected/i);
});

test('an invitation nobody accepted does not read as a quiet agency', async ({ page }) => {
  const s = await seed();
  await openAs(page, s.operatorToken, true);
  await expect(page.locator('h1').filter({ hasText: 'Platform Console' })).toBeVisible({ timeout: 15000 });

  const panel = await openDetail(page, s.busyAgencyName);

  // The fixture's owner has never verified their email, so they have never
  // signed in. In the table this agency is indistinguishable from one that is
  // simply idle, and the remedy is completely different.
  await expect(panel).toContainText('invitation not accepted');
});

test('a suspension states its reason in text, not in a tooltip', async ({ page }) => {
  const s = await seed();
  const reason = 'Data-protection review pending';
  const suspended = await seedSuspendedAgency(reason);

  await openAs(page, s.operatorToken, true);
  await expect(page.locator('h1').filter({ hasText: 'Platform Console' })).toBeVisible({ timeout: 15000 });

  const panel = await openDetail(page, suspended.name);

  // The table could only fit this in a title attribute. It is the whole reason
  // the agency is off, so it has to be readable.
  await expect(panel).toContainText('Suspended');
  await expect(panel).toContainText(reason);
  await expect(panel).toContainText(/refused on their next request/i);
  await expect(panel.getByRole('button', { name: /Reinstate this agency/i })).toBeVisible();
});

test('an agency with no active staff says so plainly', async ({ page }) => {
  const s = await seed();
  await openAs(page, s.operatorToken, true);
  await expect(page.locator('h1').filter({ hasText: 'Platform Console' })).toBeVisible({ timeout: 15000 });

  const panel = await openDetail(page, s.quietAgencyName);
  await expect(panel).toContainText(/Nobody can sign in to this agency/i);
});

test('no citizen name, number or message appears in the detail panel either', async ({ page }) => {
  const s = await seed();
  await openAs(page, s.operatorToken, true);
  await expect(page.locator('h1').filter({ hasText: 'Platform Console' })).toBeVisible({ timeout: 15000 });

  // The busy agency is the one holding the seeded citizen and message.
  await openDetail(page, s.busyAgencyName);

  // The whole rendered document again, not the panel locator: a leak through a
  // tooltip or a title attribute is still a leak, and this panel added staff
  // names and an audit trail — two places a citizen could arrive by mistake.
  const body = await page.locator('body').innerText();
  const html = await page.content();

  for (const forbidden of [s.citizenName, s.citizenPhone, s.secretMessage]) {
    expect(body).not.toContain(forbidden);
    expect(html).not.toContain(forbidden);
  }

  // And the count itself is still reported, so the absence above is the
  // boundary holding rather than the panel having failed to load.
  await expect(page.getByRole('dialog', { name: 'Agency detail' })).toContainText('Citizens');
});

test('the detail panel closes on Escape', async ({ page }) => {
  const s = await seed();
  await openAs(page, s.operatorToken, true);
  await expect(page.locator('h1').filter({ hasText: 'Platform Console' })).toBeVisible({ timeout: 15000 });

  await openDetail(page, s.quietAgencyName);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Agency detail' })).toHaveCount(0);
});
