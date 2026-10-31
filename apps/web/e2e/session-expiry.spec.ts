import { test, expect, Page } from '@playwright/test';
import { randomBytes } from 'crypto';

/**
 * What a dashboard page does when the access token has expired.
 *
 * ── The gap this covers ─────────────────────────────────────────────────────
 *
 * `lib/api.ts` refreshes a rejected token and retries — but only for callers
 * that went through it. Most dashboard pages called the API with raw `fetch`
 * and their own captured `authHeaders`: 69 call sites across ten pages, and
 * `grep -c 401` returned zero for every one of them. The usual shape was
 *
 *     const res = await fetch(`${API_URL}/api/organizations/me`, { headers });
 *     if (res.ok) setOrg(await res.json());
 *
 * so a 401 skipped the branch, threw nothing, and the page finished loading
 * with no data, no error and no redirect. On Settings that meant a form with
 * every field blank — which an operator could then save over the agency's
 * real configuration.
 *
 * The layout guard did not catch it either: it checks whether a token EXISTS
 * in storage, not whether the API still accepts one, so a token that is
 * present and expired goes straight through.
 *
 * ── Why each test builds its own account ───────────────────────────────────
 *
 * Refreshing ROTATES `tokenVersion` on the User row, deliberately, so that a
 * replayed refresh token invalidates the whole session. Three tests sharing
 * the demo admin therefore sign each other out the moment one of them
 * refreshes — which looked exactly like the fix failing. Its own user per
 * test is the only way the assertions mean anything.
 */

const API_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:4000';

const createdOrgIds: string[] = [];

type Session = { accessToken: string; refreshToken: string; user: any; orgName: string };

/**
 * A fresh agency and operator, with an ALREADY-EXPIRED access token and a
 * valid refresh token — the state every session reaches on its own once the
 * access token's lifetime runs out.
 */
async function expiredSession(): Promise<Session> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@ace/database');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require('jsonwebtoken');

  const secret = process.env.JWT_SECRET;
  const refreshSecret = process.env.JWT_REFRESH_SECRET;
  if (!secret || !refreshSecret) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set for the session-expiry e2e.');
  }

  const tag = `e2eexp-${randomBytes(3).toString('hex')}`;
  const orgName = `${tag} Ministry of Works`;
  const org = await prisma.organization.create({
    data: { name: orgName, slug: tag, industry: 'GOVERNMENT' },
  });
  createdOrgIds.push(org.id);

  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `${tag}@tenant.test`,
      passwordHash: 'not-a-login-path',
      fullName: 'Expiry Tester',
      role: 'OWNER',
    },
  });

  const claims = {
    userId: user.id,
    organizationId: org.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    tokenVersion: user.tokenVersion,
  };

  return {
    accessToken: jwt.sign(claims, secret, { expiresIn: '-30s' }),
    refreshToken: jwt.sign(claims, refreshSecret, { expiresIn: '7d' }),
    user: { ...claims, organizationName: orgName },
    orgName,
  };
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

async function openSettings(page: Page, s: Session, withRefreshToken = true) {
  await page.addInitScript(
    ([t, r, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      if (r) window.localStorage.setItem('ace_refresh_token', r as string);
      else window.localStorage.removeItem('ace_refresh_token');
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [s.accessToken, withRefreshToken ? s.refreshToken : null, s.user]
  );
  await page.goto('/settings');
}

test.describe('an expired access token', () => {
  test('still loads the page, by refreshing instead of rendering nothing', async ({ page }) => {
    const s = await expiredSession();
    await openSettings(page, s);

    await page.getByRole('button', { name: 'General' }).click();

    // The agency's real name, which only arrives if the refused request was
    // retried. Blank here is the bug: a settings form offering to save
    // nothing over the agency's actual configuration.
    await expect(page.getByLabel('Organization Name')).toHaveValue(s.orgName, { timeout: 15000 });
  });

  test('replaces the stale token rather than retrying with it forever', async ({ page }) => {
    const s = await expiredSession();
    await openSettings(page, s);

    await expect(page.getByRole('button', { name: 'General' })).toBeVisible({ timeout: 15000 });
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('ace_token')), { timeout: 15000 })
      .not.toBe(s.accessToken);
  });

  test('sends the operator to sign in when the session cannot be recovered', async ({ page }) => {
    const s = await expiredSession();
    // Expired access token and NO refresh token: there is nothing to recover
    // with, so sitting on a blank page is the one outcome that must not happen.
    await openSettings(page, s, false);

    await page.waitForURL(/\/login/, { timeout: 15000 });
  });
});
