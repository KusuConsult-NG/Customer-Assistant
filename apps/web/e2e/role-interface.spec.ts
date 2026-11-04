import { test, expect, Page } from '@playwright/test';
import { randomBytes } from 'crypto';

/**
 * Does a front-desk officer see the same dashboard as an administrator?
 *
 * They did — exactly the same. Every signed-in member was shown all fifteen
 * screens, System Settings, Branding & White Label, Agent Provisioning,
 * Automation Workflows and WhatsApp Broadcasts included, and found out which
 * ones were not theirs by pressing a button and receiving a 403 with nothing
 * attached to explain it. The API's rules were right the whole time; the
 * dashboard did not reflect them.
 *
 * What a browser adds over the API suite is the thing only a browser can get
 * wrong: that hiding a link is COSMETIC. `ace_user` is in localStorage and
 * anybody can edit it, so a member who forces their way onto an admin screen
 * must still get a plain explanation and still be refused by the server — the
 * same property the platform console's e2e pins for `isPlatformAdmin`.
 */

const API_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:4000';
const createdOrgIds: string[] = [];

type Member = { token: string; role: string };

async function seedMember(role: 'OWNER' | 'ADMIN' | 'AGENT' | 'VIEWER'): Promise<Member> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@ace/database');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET must be set for the role interface e2e.');

  const tag = `e2erole-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: { name: `${tag} Agency`, slug: tag, industry: 'GOVERNMENT' },
  });
  createdOrgIds.push(org.id);
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `${tag}@mda.test`,
      passwordHash: 'x',
      fullName: `${role} Member`,
      role,
    },
  });
  // `userId`, not `sub`: JwtStrategy.validate refuses a payload without it,
  // and the dashboard treats that 401 as a dead session — so a token signed
  // the other way lands on the login page and then the dashboard, and every
  // assertion about a screen quietly tests the dashboard instead.
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      organizationId: org.id,
      role,
      tokenVersion: user.tokenVersion ?? 0,
    },
    secret,
    { expiresIn: '1h' }
  );
  return { token, role };
}

test.afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@ace/database');
  for (const id of createdOrgIds) {
    await prisma.auditLog.deleteMany({ where: { organizationId: id } });
    await prisma.organization.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

async function openAs(page: Page, member: Member, path = '/') {
  await page.addInitScript(
    ([t, r]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem(
        'ace_user',
        JSON.stringify({ fullName: 'E2E Member', email: 'e2e@mda.test', role: r, organizationName: 'E2E' })
      );
    },
    [member.token, member.role]
  );
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

const ADMIN_ONLY = ['Automation Workflows', 'WhatsApp Broadcasts', 'Agent Provisioning', 'Branding & White Label'];

test('an administrator still sees the whole dashboard', async ({ page }) => {
  await openAs(page, await seedMember('ADMIN'));
  const nav = page.locator('nav');
  for (const label of [...ADMIN_ONLY, 'Appointments', 'Callback Queue', 'Citizens & Contacts']) {
    await expect(nav.getByText(label, { exact: false }).first()).toBeVisible({ timeout: 15000 });
  }
});

test('a front-desk officer is not offered the agency administration screens', async ({ page }) => {
  await openAs(page, await seedMember('AGENT'));
  const nav = page.locator('nav');

  // Their own work is there.
  await expect(nav.getByText('Callback Queue', { exact: false }).first()).toBeVisible({ timeout: 15000 });
  await expect(nav.getByText('Appointments', { exact: false }).first()).toBeVisible();

  // The administration surface is not.
  for (const label of ADMIN_ONLY) {
    await expect(nav.getByText(label, { exact: false })).toHaveCount(0);
  }
});

test('a read-only member is told the screen is read-only rather than left to guess', async ({ page }) => {
  await openAs(page, await seedMember('VIEWER'), '/callbacks');
  await expect(page.getByText(/read-only for you/i)).toBeVisible({ timeout: 15000 });
});

test('hiding a link is cosmetic: forcing the URL still explains and still refuses', async ({ page }) => {
  // The officer edits localStorage, or simply types the path. The screen must
  // say what is happening — not render the admin UI and fail on click.
  await openAs(page, await seedMember('AGENT'), '/workflows');
  await expect(page.getByText(/not available to you/i)).toBeVisible({ timeout: 15000 });
  // And nothing from the real screen is drawn behind it.
  await expect(page.getByRole('button', { name: /new workflow/i })).toHaveCount(0);
});
