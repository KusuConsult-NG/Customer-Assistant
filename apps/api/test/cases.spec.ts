/**
 * Citizen cases and MDA referrals (PRD §10, §15, §18).
 *
 * Pinned, in the PRD's words:
 *  - a report becomes a structured case with a reference, category, location
 *    and the citizen's original words;
 *  - "Referral is not resolution" — a referred case stays open, and resolving
 *    needs a recorded outcome;
 *  - an anonymous reporter is withheld from staff below OWNER/ADMIN and from
 *    every MDA; a sensitive case is hidden from staff it is not assigned to —
 *    on the Cases API AND the older CRM ticket list, which is the same data;
 *  - "No MDA may alter another institution's data": a liaison sees only cases
 *    referred to their MDA and can answer the referral, not move the case.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { ConversationOrchestrator } from '@ace/orchestrator';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Cases and MDA referrals', () => {
  let app: INestApplication;
  let owner: TestTenant;
  let other: TestTenant;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const orchestrator = new ConversationOrchestrator();
  jest.setTimeout(60000);

  const as = (who: string, m: 'get' | 'post' | 'patch', path: string) =>
    (request(app.getHttpServer()) as any)[m](path).set('Authorization', `Bearer ${tokens[who]}`);

  const member = async (key: string, role: string, mdaName: string | null = null) => {
    const u = await prisma.user.create({
      data: {
        organizationId: owner.orgId,
        email: `cases-${key}-${randomBytes(4).toString('hex')}@tenant.test`,
        passwordHash: 'not-a-login-path',
        fullName: `Case ${key}`,
        role: role as any,
        mdaName,
      },
    });
    ids[key] = u.id;
    tokens[key] = app.get(JwtService).sign({
      userId: u.id, organizationId: owner.orgId, email: u.email, fullName: u.fullName, role: u.role, tokenVersion: u.tokenVersion,
    });
  };

  const report = async (text: string, phone = `+23480${Math.floor(10_000_000 + Math.random() * 89_999_999)}`) => {
    const r = await orchestrator.processIncomingMessage(
      {
        conversationId: `case-${randomBytes(4).toString('hex')}`,
        organizationId: owner.orgId,
        customerPhoneNumber: phone,
        channel: 'WHATSAPP' as any,
        history: [],
        slots: {},
        isHumanHandoffActive: false,
      },
      text,
    );
    const ticketNumber = r.toolCallsExecuted?.[0]?.result?.ticketNumber;
    const row = ticketNumber ? await prisma.ticket.findUnique({ where: { ticketNumber } }) : null;
    return { reply: r, row };
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    delete process.env.OPENAI_API_KEY;
    app = await createTestApp();
    owner = await createTenant(app, 'cases-owner', { role: 'OWNER', industry: 'GOVERNMENT' });
    other = await createTenant(app, 'cases-other', { role: 'OWNER' });
    tokens.owner = owner.token;
    tokens.other = other.token;
    await member('agent', 'AGENT');
    await member('agent2', 'AGENT');
    await member('liaison', 'AGENT', 'Plateau State Water Board');
    await member('roadsLiaison', 'AGENT', 'Ministry of Works');
  });

  afterAll(async () => {
    await prisma.mdaReferral.deleteMany({ where: { organizationId: owner.orgId } });
    await prisma.caseEvent.deleteMany({ where: { organizationId: owner.orgId } });
    await prisma.ticket.deleteMany({ where: { organizationId: owner.orgId } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await dropTenant(owner?.orgId);
    await dropTenant(other?.orgId);
    await app?.close();
  });

  describe('a report becomes a case', () => {
    it('classifies it, keeps the citizen\'s words, notes the LGA, and promises only what is true', async () => {
      const { reply, row } = await report('There is no water in our area in Jos South for three weeks now');
      expect(reply.intentDetected).toBe('CREATE_TICKET');
      expect(row).toBeTruthy();
      expect(row!.category).toBe('water');
      expect(row!.caseStage).toBe('CLASSIFIED');
      expect(row!.lga).toBe('Jos South');
      expect(row!.description).toBe('There is no water in our area in Jos South for three weeks now');
      expect(row!.dueAt).toBeTruthy();
      expect(reply.replyText).toContain(row!.ticketNumber);
      expect(reply.replyText).not.toMatch(/will be (fixed|repaired|resolved)|within \d+ (days|hours)/i);
      const events = await prisma.caseEvent.findMany({ where: { ticketId: row!.id } });
      expect(events.map((e) => e.type)).toEqual(['CREATED']);
      ids.water = row!.id;
    });

    it('withholds the name when the citizen asks, and treats misconduct as sensitive', async () => {
      const { reply, row } = await report('I want to report an officer who demanded money from me. Please keep my name out of it.');
      expect(row!.isAnonymous).toBe(true);
      expect(row!.isSensitive).toBe(true);
      expect(row!.category).toBe('misconduct');
      expect(reply.replyText).toMatch(/your name will not be shared/i);
      ids.misconduct = row!.id;
    });
  });

  describe('the lifecycle', () => {
    it('refuses to resolve without an outcome, to close unresolved, and to move backwards', async () => {
      const id = ids.water;
      const noOutcome = await as('agent', 'post', `/api/cases/${id}/stage`).send({ stage: 'RESOLVED' }).expect(409);
      expect(noOutcome.body.message).toMatch(/referral to an MDA is not a resolution/);
      await as('agent', 'post', `/api/cases/${id}/stage`).send({ stage: 'CLOSED' }).expect(409);
      await as('agent', 'post', `/api/cases/${id}/stage`).send({ stage: 'ACTION_IN_PROGRESS' }).expect(201);
      const back = await as('agent', 'post', `/api/cases/${id}/stage`).send({ stage: 'ASSIGNED' }).expect(409);
      expect(back.body.message).toMatch(/reopen it instead/);
    });

    it('a referral moves the case to review, never to resolved', async () => {
      const { row } = await report('Report a burst pipe flooding the road at Rayfield, Jos South');
      const id = row!.id;
      await as('agent', 'post', `/api/cases/${id}/refer`).send({ mdaName: 'Plateau State Water Board', note: 'Please send a team' }).expect(201);
      const after = await prisma.ticket.findUnique({ where: { id } });
      expect(after!.caseStage).toBe('UNDER_REVIEW');
      expect(after!.responsibleMda).toBe('Plateau State Water Board');
      expect(after!.resolvedAt).toBeNull();
      ids.referred = id;
    });

    it('resolves with an outcome, records the citizen being told, and can be reopened', async () => {
      const id = ids.referred;
      await as('agent', 'post', `/api/cases/${id}/citizen-notified`).send({ channel: 'phone' }).expect(409);
      await as('agent', 'post', `/api/cases/${id}/stage`).send({ stage: 'RESOLVED', outcome: 'Water Board replaced the pipe on 3 Nov.' }).expect(201);
      await as('agent', 'post', `/api/cases/${id}/citizen-notified`).send({ channel: 'phone', note: 'Told it was fixed' }).expect(201);
      await as('agent', 'post', `/api/cases/${id}/stage`).send({ stage: 'REOPENED', note: 'Citizen says it leaks again' }).expect(201);
      const c = await as('owner', 'get', `/api/cases/${id}`).expect(200);
      expect(c.body.caseStage).toBe('REOPENED');
      expect(c.body.citizenNotifiedAt).toBeNull();
      expect(c.body.events.map((e: any) => e.type)).toEqual(
        expect.arrayContaining(['CREATED', 'REFERRED', 'STAGE_CHANGED', 'CITIZEN_NOTIFIED']),
      );
    });
  });

  describe('who sees what', () => {
    it('hides a sensitive case from staff it is not assigned to — on both lists', async () => {
      const agentList = await as('agent', 'get', '/api/cases').expect(200);
      expect(agentList.body.map((c: any) => c.id)).not.toContain(ids.misconduct);
      await as('agent', 'get', `/api/cases/${ids.misconduct}`).expect(404);
      const crm = await as('agent', 'get', '/api/crm/tickets?limit=100').expect(200);
      expect(crm.body.data.map((t: any) => t.id)).not.toContain(ids.misconduct);

      await as('owner', 'post', `/api/cases/${ids.misconduct}/assign`).send({ userId: ids.agent }).expect(201);
      const assigned = await as('agent', 'get', `/api/cases/${ids.misconduct}`).expect(200);
      // Assigned, so visible — but the reporter is still withheld below OWNER/ADMIN.
      expect(assigned.body.contactId).toBeNull();
      expect(assigned.body.contact.fullName).toBe('Anonymous reporter');
      expect(assigned.body.contact.phoneNumber).toBeNull();
      const ownerView = await as('owner', 'get', `/api/cases/${ids.misconduct}`).expect(200);
      expect(ownerView.body.contact.phoneNumber).toMatch(/^\+234/);
      await as('agent2', 'get', `/api/cases/${ids.misconduct}`).expect(404);
    });

    it('gives an MDA liaison only the cases referred to their MDA, and no way to move them', async () => {
      const list = await as('liaison', 'get', '/api/cases').expect(200);
      expect(list.body.map((c: any) => c.id)).toEqual([ids.referred]);
      await as('roadsLiaison', 'get', `/api/cases/${ids.referred}`).expect(404);
      await as('liaison', 'get', `/api/cases/${ids.water}`).expect(404);
      const crm = await as('liaison', 'get', '/api/crm/tickets?limit=100').expect(200);
      expect(crm.body.data.map((t: any) => t.id)).toEqual([ids.referred]);

      const move = await as('liaison', 'post', `/api/cases/${ids.referred}/stage`).send({ stage: 'ACTION_IN_PROGRESS' }).expect(403);
      expect(move.body.message).toMatch(/Respond to the referral/);
      await as('liaison', 'post', `/api/cases/${ids.referred}/refer`).send({ mdaName: 'Somewhere else' }).expect(403);

      const c = await as('liaison', 'get', `/api/cases/${ids.referred}`).expect(200);
      const referral = c.body.referrals[0];
      await as('roadsLiaison', 'post', `/api/cases/referrals/${referral.id}/respond`).send({ status: 'ACKNOWLEDGED' }).expect(404);
      await as('liaison', 'post', `/api/cases/referrals/${referral.id}/respond`).send({ status: 'RESPONDED' }).expect(400);
      await as('liaison', 'post', `/api/cases/referrals/${referral.id}/respond`).send({ status: 'RESPONDED', response: 'Team dispatched to replace the valve.' }).expect(201);
      const r = await prisma.mdaReferral.findUnique({ where: { id: referral.id } });
      expect(r!.status).toBe('RESPONDED');
      expect(r!.acknowledgedAt).toBeTruthy();
      // The MDA responded; the case is still the State's to resolve.
      const t = await prisma.ticket.findUnique({ where: { id: ids.referred } });
      expect(t!.caseStage).not.toBe('RESOLVED');
    });

    it('keeps other agencies out entirely', async () => {
      await as('other', 'get', `/api/cases/${ids.water}`).expect(404);
      const list = await as('other', 'get', '/api/cases').expect(200);
      expect(list.body).toEqual([]);
    });

    it('lets an admin scope a member to an MDA, but never an administrator', async () => {
      await as('owner', 'patch', `/api/organizations/members/${ids.agent2}/mda`).send({ mdaName: 'Ministry of Works' }).expect(200);
      const u = await prisma.user.findUnique({ where: { id: ids.agent2 } });
      expect(u!.mdaName).toBe('Ministry of Works');
      const refused = await as('owner', 'patch', `/api/organizations/members/${owner.userId}/mda`).send({ mdaName: 'X' }).expect(400);
      expect(refused.body.message).toMatch(/cannot be scoped/);
      await as('agent', 'patch', `/api/organizations/members/${ids.agent2}/mda`).send({ mdaName: null }).expect(403);
    });
  });

  it('summarises open, overdue and awaiting-MDA counts', async () => {
    await prisma.ticket.update({ where: { id: ids.water }, data: { dueAt: new Date(Date.now() - 86_400_000) } });
    const s = await as('owner', 'get', '/api/cases/summary').expect(200);
    expect(s.body.overdue).toBeGreaterThanOrEqual(1);
    const overdue = await as('owner', 'get', '/api/cases?overdue=true').expect(200);
    expect(overdue.body.map((c: any) => c.id)).toContain(ids.water);
    expect(overdue.body.find((c: any) => c.id === ids.water).overdue).toBe(true);
  });
});
