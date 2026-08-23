/**
 * A tenant for a test to work in, without spending the registration budget.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 *
 * `POST /api/auth/register` is throttled to 5/min per IP, and the whole API
 * suite is one IP. Four specs were registering purely to obtain a token —
 * `analytics-insights`, `contact-language`, `conversation-history` and
 * `organization-language` — while `api-integration` uses the endpoint for the
 * thing it is actually testing: that a bad payload is rejected with a 400
 * rather than crashing inside bcrypt.
 *
 * Seven registrations against a limit of five is arithmetic, not luck. Which
 * three tests lost depended on how Jest happened to schedule the workers, so
 * it surfaced as an intermittent handful of 429s in unrelated suites — and a
 * 429 reads exactly like a broken endpoint, in a spec that has nothing to do
 * with registration.
 *
 * Throttling is a production safety control and turning it off for tests would
 * mean nothing exercises it. So instead the specs that only need a tenant stop
 * paying for one, and the budget goes to the tests that are about registering.
 *
 * ── Why a signed token is the real thing ────────────────────────────────────
 *
 * `JwtStrategy.validate` re-reads the user from the database on every request
 * and checks `isActive`, the role and `tokenVersion` — it trusts almost
 * nothing in the token. A payload signed over a real User row is therefore the
 * same object a login would have produced, and a test using one is not taking
 * a shortcut past any check the endpoint performs.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';

export interface TestTenant {
  orgId: string;
  userId: string;
  email: string;
  token: string;
}

export async function createTenant(
  app: INestApplication,
  label: string,
  options: { role?: 'OWNER' | 'ADMIN' | 'AGENT' | 'VIEWER'; industry?: string } = {}
): Promise<TestTenant> {
  const suffix = randomBytes(4).toString('hex');
  const slug = `${label}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const org = await prisma.organization.create({
    data: { name: `${label} ${suffix}`, slug, industry: (options.industry ?? 'OTHER') as any },
  });

  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `${slug}@tenant.test`,
      // Never used: these tenants are signed for, not logged in as. A real
      // hash here would only suggest otherwise.
      passwordHash: 'not-a-login-path',
      fullName: `${label} Tester`,
      role: (options.role ?? 'OWNER') as any,
    },
  });

  const token = app.get(JwtService).sign({
    userId: user.id,
    organizationId: org.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    tokenVersion: user.tokenVersion,
  });

  return { orgId: org.id, userId: user.id, email: user.email, token };
}

/** Remove a tenant and everything that cascades from it. */
export async function dropTenant(orgId: string | undefined) {
  if (!orgId) return;
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}
