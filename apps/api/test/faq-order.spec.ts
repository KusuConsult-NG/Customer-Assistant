/**
 * FAQ order, and what it decides.
 *
 * ── Order is not cosmetic ───────────────────────────────────────────────────
 *
 * The orchestrator reads FAQs `orderBy: sortOrder asc` and keeps the first on
 * a tie (`overlap > best.overlap`, strictly). So when two FAQs match a
 * citizen's question equally well, POSITION DECIDES WHICH ANSWER THEY GET —
 * and it is the only lever an agency has over that.
 *
 * Two things were wrong with the surface around it.
 *
 * `reorderFaqs` accepted any subset of ids. Because `sortOrder` is a position
 * rather than a rank, a partial list assigned 0…k-1 to some rows and left the
 * rest as they were, putting two entries in the same place; ids that matched
 * nothing updated no rows and it still returned `{success: true}`, reporting a
 * change that had not happened.
 *
 * And the agent path's FAQ lookup had NO ordering at all, so the same question
 * answered on a hosted-agent call could pick a different FAQ than the same
 * question on WhatsApp. Both engines must keep the same guarantees, and what
 * an agency is told its ordering controls is one of them.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { AgentToolsService } from '../src/agent-tools/agent-tools.service';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('FAQ order', () => {
  let app: INestApplication;
  let agentTools: AgentToolsService;
  let agency: TestTenant;
  let other: TestTenant;

  jest.setTimeout(90000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    agentTools = app.get(AgentToolsService);

    agency = await createTenant(app, 'faq-order', { role: 'OWNER' });
    other = await createTenant(app, 'faq-other', { role: 'OWNER' });
  });

  afterAll(async () => {
    await dropTenant(agency?.orgId);
    await dropTenant(other?.orgId);
    await app?.close();
  });

  beforeEach(async () => {
    await prisma.faqEntry.deleteMany({ where: { organizationId: agency.orgId } });
    await prisma.faqEntry.deleteMany({ where: { organizationId: other.orgId } });
  });

  const addFaq = (question: string, answer: string, sortOrder: number, orgId = agency.orgId) =>
    prisma.faqEntry.create({
      data: { organizationId: orgId, question, answer, sortOrder, isActive: true },
    });

  const reorder = (ids: string[], token = agency.token) =>
    request(app.getHttpServer())
      .patch('/api/knowledge/faqs/reorder')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids });

  const positions = async () =>
    (
      await prisma.faqEntry.findMany({
        where: { organizationId: agency.orgId },
        orderBy: { sortOrder: 'asc' },
        select: { question: true, sortOrder: true },
      })
    ).map((f) => `${f.sortOrder}:${f.question}`);

  // ── Reordering ────────────────────────────────────────────────────────────

  describe('reordering', () => {
    it('assigns consecutive positions in the order given', async () => {
      const a = await addFaq('First', 'a', 0);
      const b = await addFaq('Second', 'b', 1);
      const c = await addFaq('Third', 'c', 2);

      await reorder([c.id, a.id, b.id]).expect(200);

      expect(await positions()).toEqual(['0:Third', '1:First', '2:Second']);
    });

    it('refuses a partial order and names what was left out', async () => {
      const a = await addFaq('Kept', 'a', 0);
      await addFaq('Omitted', 'b', 1);

      // Accepting this would leave "Omitted" at position 1 and put "Kept" at
      // 0 — two rows claiming the same place the next time anything is moved.
      const res = await reorder([a.id]).expect(400);
      expect(res.body.message).toMatch(/every FAQ/i);

      // And nothing moved.
      expect(await positions()).toEqual(['0:Kept', '1:Omitted']);
    });

    it('refuses the same entry listed twice', async () => {
      const a = await addFaq('One', 'a', 0);
      await addFaq('Two', 'b', 1);

      const res = await reorder([a.id, a.id]).expect(400);
      expect(res.body.message).toMatch(/more than once/i);
    });

    it('refuses an id from another agency, and moves nothing', async () => {
      const mine = await addFaq('Mine', 'a', 0);
      const theirs = await addFaq('Theirs', 'b', 0, other.orgId);

      await reorder([theirs.id, mine.id]).expect(404);

      // The previous version skipped the foreign id silently, reordered the
      // rest and reported success.
      expect(await positions()).toEqual(['0:Mine']);
      const untouched = await prisma.faqEntry.findUnique({ where: { id: theirs.id } });
      expect(untouched?.sortOrder).toBe(0);
    });

    it('refuses an empty order rather than treating it as a no-op success', async () => {
      await addFaq('Something', 'a', 0);
      await reorder([]).expect(400);
    });
  });

  // ── What the order decides ────────────────────────────────────────────────

  describe('the hosted-agent path honours the order', () => {
    it('answers a tie with the FAQ the agency put first', async () => {
      // Identical questions, so both score the same and only position can
      // separate them.
      const first = await addFaq('What are the opening hours?', 'We open at 8am.', 0);
      const second = await addFaq('What are the opening hours?', 'We open at 10am.', 1);

      await reorder([second.id, first.id]).expect(200);

      const result = await agentTools.searchKnowledge(
        agency.orgId,
        'What are the opening hours?'
      );
      expect(result.ok).toBe(true);
      expect(result.speak).toBe('We open at 10am.');
    });

    it('still answers by position after the top entry is edited', async () => {
      // ── Why the edit is the point of this test ───────────────────────────
      //
      // The two assertions either side of this one pass even with no ordering
      // on the query, because the reorder transaction rewrites rows in the
      // target order — so an unordered scan comes back in that order by
      // accident, and the bug hides.
      //
      // Editing an answer is what breaks the coincidence. Postgres writes the
      // updated row at the end of the heap, so an unordered scan returns the
      // EDITED entry last however high the agency placed it, and the
      // assistant starts quietly answering with the other one. That is a real
      // sequence: set the order, then correct a wording.
      const top = await addFaq('What are the opening hours?', 'We open at 8am.', 0);
      const below = await addFaq('What are the opening hours?', 'We open at 10am.', 1);
      await reorder([top.id, below.id]).expect(200);

      await request(app.getHttpServer())
        .patch(`/api/knowledge/faqs/${top.id}`)
        .set('Authorization', `Bearer ${agency.token}`)
        .send({ answer: 'We open at 8am sharp.' })
        .expect(200);

      const result = await agentTools.searchKnowledge(
        agency.orgId,
        'What are the opening hours?'
      );
      expect(result.speak).toBe('We open at 8am sharp.');
    });

    it('follows the order when it changes again', async () => {
      const a = await addFaq('What are the opening hours?', 'We open at 8am.', 0);
      const b = await addFaq('What are the opening hours?', 'We open at 10am.', 1);

      await reorder([b.id, a.id]).expect(200);
      expect((await agentTools.searchKnowledge(agency.orgId, 'What are the opening hours?')).speak)
        .toBe('We open at 10am.');

      await reorder([a.id, b.id]).expect(200);
      expect((await agentTools.searchKnowledge(agency.orgId, 'What are the opening hours?')).speak)
        .toBe('We open at 8am.');
    });

    it('never reads another agency’s FAQs', async () => {
      await addFaq('What are the opening hours?', 'Ours: 8am.', 0);
      await addFaq('What are the opening hours?', 'Theirs: 6am.', 0, other.orgId);

      const result = await agentTools.searchKnowledge(
        agency.orgId,
        'What are the opening hours?'
      );
      expect(result.speak).toBe('Ours: 8am.');
    });
  });

  // ── Who may change what the assistant says ────────────────────────────────

  describe('authorization', () => {
    /**
     * A colleague inside the SAME agency, so a refusal is about their role and
     * not about tenancy — `createTenant` would build them a separate agency,
     * which proves the wrong thing.
     */
    const memberToken = async (role: 'AGENT' | 'VIEWER' | 'ADMIN') => {
      const user = await prisma.user.create({
        data: {
          organizationId: agency.orgId,
          email: `faq-${role.toLowerCase()}-${randomBytes(3).toString('hex')}@tenant.test`,
          passwordHash: 'not-a-login-path',
          fullName: `FAQ ${role}`,
          role,
        },
      });
      return app.get(JwtService).sign({
        userId: user.id,
        organizationId: agency.orgId,
        email: user.email,
        fullName: user.fullName,
        role,
        tokenVersion: user.tokenVersion,
      });
    };

    it.each(['AGENT', 'VIEWER'] as const)('refuses every write for role %s', async (role) => {
      const token = await memberToken(role);
      const faq = await addFaq('Existing', 'answer', 0);
      const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);
      const http = request(app.getHttpServer());

      // These four were open to any signed-in member, including a VIEWER,
      // while documents in the sibling controller were OWNER/ADMIN.
      await auth(http.post('/api/knowledge/faqs')).send({ question: 'q', answer: 'a' }).expect(403);
      await auth(
        request(app.getHttpServer()).patch(`/api/knowledge/faqs/${faq.id}`)
      ).send({ answer: 'rewritten' }).expect(403);
      await auth(
        request(app.getHttpServer()).patch('/api/knowledge/faqs/reorder')
      ).send({ ids: [faq.id] }).expect(403);
      await auth(
        request(app.getHttpServer()).delete(`/api/knowledge/faqs/${faq.id}`)
      ).expect(403);

      // A 403 that changed the row anyway would be worse than no guard.
      const after = await prisma.faqEntry.findUnique({ where: { id: faq.id } });
      expect(after?.answer).toBe('answer');
    });

    it.each(['AGENT', 'VIEWER'] as const)('still lets role %s read them', async (role) => {
      const token = await memberToken(role);
      await addFaq('Published answer', 'We open at 8am.', 0);

      // An officer on a call needs to know what the agency has already
      // committed to saying. Reading is not the privilege.
      const res = await request(app.getHttpServer())
        .get('/api/knowledge/faqs')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.map((f: any) => f.question)).toContain('Published answer');
    });

    it('lets an ADMIN write, so the guard is a role check and not a lockout', async () => {
      const token = await memberToken('ADMIN');

      // The counterpart assertion. A guard that refused everyone would pass
      // every test above and still be broken.
      await request(app.getHttpServer())
        .post('/api/knowledge/faqs')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'Admin may write', answer: 'yes' })
        .expect(201);
    });
  });
});
