/**
 * The platform tier — the one deliberate exception to tenant isolation.
 *
 * Everything else in this codebase is built on a single rule: every query is
 * scoped by `organizationId`, and there is no automatic tenant filter. This
 * tier crosses that boundary on purpose, so the tests that matter are not the
 * happy-path ones. They are:
 *
 *   - that nobody without the flag can reach it, including an agency OWNER;
 *   - that the flag cannot be granted through any tenant-facing endpoint;
 *   - that a suspension actually stops an agency serving, rather than merely
 *     recording an intention;
 *   - that the operator can see COUNTS but never citizen CONTENT.
 *
 * The last one is a privacy boundary, not a nicety. An oversight tier that can
 * read every conversation in the State is a surveillance capability, and the
 * assertion below is what keeps a future `include:` from quietly creating one.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Platform administration tier', () => {
  let app: INestApplication;
  let operator: TestTenant;   // Ministry of Information — platform operator
  let agencyA: TestTenant;    // an ordinary agency, OWNER
  let agencyB: TestTenant;    // a second agency, to prove cross-agency reach

  jest.setTimeout(60000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    operator = await createTenant(app, 'ministry-of-information', { isPlatformAdmin: true });
    agencyA = await createTenant(app, 'agency-a', { role: 'OWNER' });
    agencyB = await createTenant(app, 'agency-b', { role: 'OWNER' });
  });

  afterAll(async () => {
    await dropTenant(operator?.orgId);
    await dropTenant(agencyA?.orgId);
    await dropTenant(agencyB?.orgId);
    await app?.close();
  });

  const asOperator = (m: 'get' | 'post', path: string) =>
    (request(app.getHttpServer()) as any)[m](path).set('Authorization', `Bearer ${operator.token}`);

  // ── Who may reach it ──────────────────────────────────────────────────────

  describe('access control', () => {
    const routes: Array<[string, string]> = [
      ['get', '/api/platform/overview'],
      ['get', '/api/platform/agencies'],
      ['get', '/api/platform/audit'],
    ];

    it.each(routes)('%s %s requires authentication', async (method, path) => {
      await (request(app.getHttpServer()) as any)[method](path).expect(401);
    });

    it.each(routes)('%s %s refuses an agency OWNER', async (method, path) => {
      await (request(app.getHttpServer()) as any)
        [method](path)
        .set('Authorization', `Bearer ${agencyA.token}`)
        .expect(403);
    });

    it('refuses a mutating route to an agency OWNER', async () => {
      await request(app.getHttpServer())
        .post(`/api/platform/agencies/${agencyB.orgId}/suspend`)
        .set('Authorization', `Bearer ${agencyA.token}`)
        .send({ reason: 'I should not be able to do this' })
        .expect(403);

      const org = await prisma.organization.findUnique({
        where: { id: agencyB.orgId },
        select: { suspendedAt: true },
      });
      expect(org?.suspendedAt).toBeNull();
    });

    it('admits the platform operator', async () => {
      await asOperator('get', '/api/platform/overview').expect(200);
    });
  });

  // ── The escalation that must stay closed ──────────────────────────────────

  describe('privilege escalation', () => {
    it('cannot be granted through the tenant role endpoint', async () => {
      // The role endpoint writes UserRole, and isPlatformAdmin is deliberately
      // NOT a UserRole value — so this is rejected by the schema rather than by
      // a check somebody has to remember to write.
      await request(app.getHttpServer())
        .patch(`/api/organizations/members/${agencyA.userId}/role`)
        .set('Authorization', `Bearer ${agencyA.token}`)
        .send({ role: 'PLATFORM_ADMIN' })
        .expect((res) => {
          if (res.status === 200) {
            throw new Error('PLATFORM_ADMIN was accepted as a tenant role');
          }
        });

      const user = await prisma.user.findUnique({
        where: { id: agencyA.userId },
        select: { isPlatformAdmin: true },
      });
      expect(user?.isPlatformAdmin).toBe(false);
    });

    it('is not taken from the token, so a forged claim does nothing', async () => {
      // A token minted with isPlatformAdmin: true. JwtStrategy reads the flag
      // from the database, so the claim is inert.
      const { JwtService } = require('@nestjs/jwt');
      const forged = app.get(JwtService).sign({
        userId: agencyA.userId,
        organizationId: agencyA.orgId,
        email: agencyA.email,
        fullName: 'Agency A Tester',
        role: 'OWNER',
        tokenVersion: 0,
        isPlatformAdmin: true,
      });

      await request(app.getHttpServer())
        .get('/api/platform/overview')
        .set('Authorization', `Bearer ${forged}`)
        .expect(403);
    });
  });

  // ── Cross-agency reporting ────────────────────────────────────────────────

  describe('reporting', () => {
    it('lists every agency, not just the operator’s own', async () => {
      const res = await asOperator('get', '/api/platform/agencies').expect(200);
      const ids = res.body.agencies.map((a: any) => a.id);
      expect(ids).toEqual(expect.arrayContaining([agencyA.orgId, agencyB.orgId, operator.orgId]));
    });

    it('reports no handover rate for an agency with no conversations', async () => {
      // Not 0 — an agency that has handled nothing has no rate, and a zero
      // would rank it top of a league table it never entered.
      const res = await asOperator('get', '/api/platform/agencies').expect(200);
      const a = res.body.agencies.find((x: any) => x.id === agencyA.orgId);
      expect(a.metrics.conversations).toBe(0);
      expect(a.metrics.handoverRatePercent).toBeNull();
    });

    it('counts a citizen without disclosing who they are', async () => {
      const contact = await prisma.contact.create({
        data: {
          organizationId: agencyA.orgId,
          fullName: 'Amina Yakubu',
          phoneNumber: `+2348${randomBytes(4).toString('hex').replace(/\D/g, '').padEnd(9, '1').slice(0, 9)}`,
        },
      });

      const conversation = await prisma.conversation.create({
        data: { organizationId: agencyA.orgId, contactId: contact.id, channel: 'WHATSAPP' },
      });
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          sender: 'CUSTOMER',
          content: 'MY CONFIDENTIAL MEDICAL DETAIL',
        },
      });

      const list = await asOperator('get', '/api/platform/agencies').expect(200);
      const detail = await asOperator('get', `/api/platform/agencies/${agencyA.orgId}`).expect(200);

      const a = list.body.agencies.find((x: any) => x.id === agencyA.orgId);
      expect(a.metrics.citizens).toBe(1);
      expect(a.metrics.conversations).toBe(1);
      expect(detail.body.metrics.citizens).toBe(1);

      // The privacy boundary: counts yes, content and citizen identity no.
      const serialised = JSON.stringify(list.body) + JSON.stringify(detail.body);
      expect(serialised).not.toContain('MY CONFIDENTIAL MEDICAL DETAIL');
      expect(serialised).not.toContain('Amina Yakubu');
      expect(serialised).not.toContain(contact.phoneNumber);

      await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
      await prisma.conversation.delete({ where: { id: conversation.id } });
      await prisma.contact.delete({ where: { id: contact.id } });
    });
  });

  // ── Suspension ────────────────────────────────────────────────────────────

  describe('suspension', () => {
    afterEach(async () => {
      await prisma.organization.update({
        where: { id: agencyB.orgId },
        data: { suspendedAt: null, suspendedReason: null },
      }).catch(() => {});
    });

    it('refuses a suspension with no reason', async () => {
      await asOperator('post', `/api/platform/agencies/${agencyB.orgId}/suspend`)
        .send({ reason: '   ' })
        .expect(400);

      const org = await prisma.organization.findUnique({
        where: { id: agencyB.orgId },
        select: { suspendedAt: true },
      });
      expect(org?.suspendedAt).toBeNull();
    });

    it('refuses to suspend the operator’s own agency', async () => {
      await asOperator('post', `/api/platform/agencies/${operator.orgId}/suspend`)
        .send({ reason: 'locking myself out' })
        .expect(400);
    });

    it('stops the suspended agency serving on its next request', async () => {
      // Before: the agency works.
      await request(app.getHttpServer())
        .get('/api/organizations/me')
        .set('Authorization', `Bearer ${agencyB.token}`)
        .expect(200);

      await asOperator('post', `/api/platform/agencies/${agencyB.orgId}/suspend`)
        .send({ reason: 'Failed to answer citizens for 14 days' })
        .expect(201);

      // After: the SAME token is refused. Suspension is not a cosmetic flag,
      // and it does not wait for the token to expire.
      await request(app.getHttpServer())
        .get('/api/organizations/me')
        .set('Authorization', `Bearer ${agencyB.token}`)
        .expect(401);
    });

    it('leaves the operator able to act, so a suspension can be lifted', async () => {
      await asOperator('post', `/api/platform/agencies/${agencyB.orgId}/suspend`)
        .send({ reason: 'temporary' })
        .expect(201);

      await asOperator('get', '/api/platform/overview').expect(200);

      await asOperator('post', `/api/platform/agencies/${agencyB.orgId}/reinstate`).expect(201);

      await request(app.getHttpServer())
        .get('/api/organizations/me')
        .set('Authorization', `Bearer ${agencyB.token}`)
        .expect(200);
    });

    it('records who suspended what, and why', async () => {
      await asOperator('post', `/api/platform/agencies/${agencyB.orgId}/suspend`)
        .send({ reason: 'Unanswered cases past the service standard' })
        .expect(201);

      const entry = await prisma.auditLog.findFirst({
        where: { action: 'platform.agency.suspended', targetId: agencyB.orgId },
        orderBy: { createdAt: 'desc' },
      });

      expect(entry).toBeTruthy();
      expect(entry!.actor).toBe(operator.userId);
      expect(entry!.targetType).toBe('Organization');
      expect((entry!.newValue as any).reason).toBe('Unanswered cases past the service standard');
    });
  });

  // ── Provisioning ──────────────────────────────────────────────────────────

  describe('provisioning an agency', () => {
    let createdOrgId: string | undefined;

    afterAll(async () => {
      await dropTenant(createdOrgId);
    });

    it('creates the agency with an invited owner, and audits it', async () => {
      const email = `works-${randomBytes(4).toString('hex')}@mda.test`;

      const res = await asOperator('post', '/api/platform/agencies')
        .send({
          name: 'Ministry of Works and Transport',
          category: 'GOVERNMENT',
          ownerEmail: email,
          ownerFullName: 'Permanent Secretary',
        })
        .expect(201);

      createdOrgId = res.body.agency.id;
      expect(res.body.agency.name).toBe('Ministry of Works and Transport');
      expect(res.body.agency.slug).toMatch(/^ministry-of-works-and-transport-/);

      const owner = await prisma.user.findUnique({ where: { email } });
      expect(owner?.role).toBe('OWNER');
      expect(owner?.organizationId).toBe(createdOrgId);
      // Provisioning must never mint another operator.
      expect(owner?.isPlatformAdmin).toBe(false);

      const entry = await prisma.auditLog.findFirst({
        where: { action: 'platform.agency.created', targetId: createdOrgId },
      });
      expect(entry?.actor).toBe(operator.userId);
    });

    it('refuses an owner email that already exists, creating no agency', async () => {
      const name = `Ministry of Duplicates ${randomBytes(4).toString('hex')}`;

      await asOperator('post', '/api/platform/agencies')
        .send({
          name,
          ownerEmail: agencyA.email,
          ownerFullName: 'Someone Else',
        })
        .expect(409);

      // The clash is checked BEFORE the organization is written, so a failed
      // provisioning does not leave an agency with no owner behind it.
      //
      // Asserted against THIS agency's name, not a global organization count.
      // The count version compared a total taken before the request with one
      // taken after, and Jest runs these suites in parallel workers that
      // create and drop their own tenants — so any other worker finishing a
      // teardown in between failed this test with an off-by-one that had
      // nothing to do with provisioning. Same shape as the e2e that deleted
      // fixtures by slug prefix across workers.
      expect(await prisma.organization.findFirst({ where: { name } })).toBeNull();
    });

    it('refuses an agency with no named owner', async () => {
      await asOperator('post', '/api/platform/agencies')
        .send({ name: 'Ministry of Nobody' })
        .expect(400);
    });
  });
});
