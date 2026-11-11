/**
 * Budget intelligence and the project register (PRD §03, §04, §13, §17).
 *
 * What these tests hold the platform to, in the PRD's own terms:
 *  - "Zero fabricated critical figures": a figure comes only from an APPROVED
 *    document; a draft is never read; with no data the citizen is told so.
 *  - "Calculations use deterministic decimal arithmetic … avoid double
 *    counting": two approved documents restating the same figure give it ONCE;
 *    two that disagree give NO figure and ask a person to verify.
 *  - Stage is never mixed: an approved allocation is not reported as spent.
 *  - "Separate approval and editing permissions": the uploader cannot approve,
 *    and a document whose lines do not add up to its stated total cannot be
 *    approved by anyone.
 *  - Citizen observations are recorded apart from the verified project status.
 *
 * The conversation tests run the REAL orchestrator against the real database —
 * the same engine WhatsApp and the phone line call — so what is asserted is
 * what a citizen would actually be sent.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { ConversationOrchestrator } from '@ace/orchestrator';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Budget intelligence and project register', () => {
  let app: INestApplication;
  let owner: TestTenant;
  let otherAdminToken: string;
  let otherAdminId: string;
  let stranger: TestTenant;
  const orchestrator = new ConversationOrchestrator();

  jest.setTimeout(60000);

  const as = (token: string, m: 'get' | 'post', path: string) =>
    (request(app.getHttpServer()) as any)[m](path).set('Authorization', `Bearer ${token}`);

  const ask = async (text: string) =>
    orchestrator.processIncomingMessage(
      {
        conversationId: `budget-${randomBytes(4).toString('hex')}`,
        organizationId: owner.orgId,
        customerPhoneNumber: '+2348030000001',
        channel: 'WHATSAPP' as any,
        history: [],
        slots: {},
        isHumanHandoffActive: false,
      },
      text,
    );

  /** Create a document as the owner, import lines, approve as the OTHER admin. */
  const publish = async (doc: Record<string, unknown>, csv: string) => {
    const created = await as(owner.token, 'post', '/api/budget/documents').send(doc).expect(201);
    const imported = await as(owner.token, 'post', `/api/budget/documents/${created.body.id}/lines`).send({ csv }).expect(201);
    expect(imported.body.rejected).toEqual([]);
    await as(otherAdminToken, 'post', `/api/budget/documents/${created.body.id}/approve`).expect(201);
    return created.body.id as string;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    delete process.env.OPENAI_API_KEY;
    app = await createTestApp();
    owner = await createTenant(app, 'budget-owner', { role: 'OWNER', industry: 'GOVERNMENT' });
    stranger = await createTenant(app, 'budget-stranger', { role: 'OWNER' });

    const admin = await prisma.user.create({
      data: {
        organizationId: owner.orgId,
        email: `budget-admin-${randomBytes(4).toString('hex')}@tenant.test`,
        passwordHash: 'not-a-login-path',
        fullName: 'Second Admin',
        role: 'ADMIN',
      },
    });
    otherAdminId = admin.id;
    otherAdminToken = app.get(JwtService).sign({
      userId: admin.id,
      organizationId: owner.orgId,
      email: admin.email,
      fullName: admin.fullName,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
    });

    // 2024 and 2025 approved appropriations, education sector split across two bodies.
    await publish(
      { title: '2024 Appropriation Law', documentType: 'APPROPRIATION_LAW', fiscalYear: 2024, declaredTotal: '15,000,000,000.10' },
      [
        'mda,sector,amount,sourcePage',
        'Ministry of Education,Education,"8,000,000,000.05",p. 100',
        'Universal Basic Education Board (PLSUBEB),Education,"2,000,000,000.05",p. 101',
        'Ministry of Health,Health,"5,000,000,000",p. 120',
      ].join('\n'),
    );
    await publish(
      { title: '2025 Appropriation Law', documentType: 'APPROPRIATION_LAW', fiscalYear: 2025, declaredTotal: '17,500,000,000', sourceUrl: 'https://example.gov.ng/budget-2025.pdf' },
      [
        'mda,sector,amount,sourcePage',
        'Ministry of Education,Education,"9,000,000,000",p. 98',
        'Universal Basic Education Board (PLSUBEB),Education,"2,500,000,000",p. 99',
        'Ministry of Health,Health,"6,000,000,000",p. 118',
      ].join('\n'),
    );
  });

  afterAll(async () => {
    await prisma.budgetLine.deleteMany({ where: { organizationId: { in: [owner.orgId, stranger.orgId] } } });
    await prisma.budgetDocument.deleteMany({ where: { organizationId: { in: [owner.orgId, stranger.orgId] } } });
    await prisma.projectObservation.deleteMany({ where: { organizationId: owner.orgId } });
    await prisma.governmentProject.deleteMany({ where: { organizationId: owner.orgId } });
    await prisma.user.deleteMany({ where: { id: otherAdminId } });
    await dropTenant(owner?.orgId);
    await dropTenant(stranger?.orgId);
    await app?.close();
  });

  describe('publishing', () => {
    it('reports rejected rows rather than guessing them', async () => {
      const doc = await as(owner.token, 'post', '/api/budget/documents')
        .send({ title: 'Partly bad', documentType: 'APPROPRIATION_LAW', fiscalYear: 2023 })
        .expect(201);
      const r = await as(owner.token, 'post', `/api/budget/documents/${doc.body.id}/lines`)
        .send({ csv: 'mda,amount,lga\nMinistry A,"1,000",\nMinistry B,1.5e9,\nMinistry C,500m,\nMinistry D,"1,00,000",\nMinistry E,100,Atlantis\n' })
        .expect(201);
      expect(r.body.imported).toBe(1);
      expect(r.body.rejected.map((x: any) => x.line)).toEqual([3, 4, 5, 6]);
      expect(r.body.rejected[4 - 1].message).toMatch(/not a Plateau LGA/);
    });

    it('will not let the uploader approve their own document', async () => {
      const doc = await as(owner.token, 'post', '/api/budget/documents')
        .send({ title: 'Self-approved', documentType: 'APPROPRIATION_LAW', fiscalYear: 2022 })
        .expect(201);
      await as(owner.token, 'post', `/api/budget/documents/${doc.body.id}/lines`).send({ csv: 'mda,amount\nX,100' }).expect(201);
      const r = await as(owner.token, 'post', `/api/budget/documents/${doc.body.id}/approve`).expect(403);
      expect(r.body.message).toMatch(/cannot also approve/);
    });

    it('will not approve lines that do not add up to the document total', async () => {
      const doc = await as(owner.token, 'post', '/api/budget/documents')
        .send({ title: 'Dropped a page', documentType: 'APPROPRIATION_LAW', fiscalYear: 2021, declaredTotal: '1,000' })
        .expect(201);
      await as(owner.token, 'post', `/api/budget/documents/${doc.body.id}/lines`).send({ csv: 'mda,amount\nX,600' }).expect(201);
      const r = await as(otherAdminToken, 'post', `/api/budget/documents/${doc.body.id}/approve`).expect(400);
      expect(r.body.message).toMatch(/₦600.*₦1,000/);
      const row = await prisma.budgetDocument.findUnique({ where: { id: doc.body.id } });
      expect(row!.status).toBe('DRAFT');
    });

    it('keeps another agency out', async () => {
      const docs = await as(owner.token, 'get', '/api/budget/documents').expect(200);
      await as(stranger.token, 'get', `/api/budget/documents/${docs.body[0].id}/validation`).expect(404);
      const theirs = await as(stranger.token, 'get', '/api/budget/documents').expect(200);
      expect(theirs.body).toEqual([]);
    });
  });

  describe('what a citizen is told', () => {
    it('gives the exact approved figure with its source, and says an allocation is not spending', async () => {
      const r = await ask('What is the 2025 budget for the Ministry of Health?');
      expect(r.intentDetected).toBe('BUDGET_ANSWER');
      expect(r.replyText).toContain('₦6,000,000,000');
      expect(r.replyText).toContain('2025 Appropriation Law');
      expect(r.replyText).toContain('p. 118');
      expect(r.replyText).toMatch(/approved allocation/);
      expect(r.replyText).toMatch(/not what has been released or spent/);
    });

    it('treats "education" as the sector and compares with last year, exactly', async () => {
      const r = await ask('How does the 2025 education budget compare with last year?');
      expect(r.intentDetected).toBe('BUDGET_ANSWER');
      // 8,000,000,000.05 + 2,000,000,000.05 = 10,000,000,000.10 — exact, not 1e10.
      expect(r.replyText).toContain('₦10,000,000,000.10');
      expect(r.replyText).toContain('₦11,500,000,000');
      // 11,500,000,000 - 10,000,000,000.10 = 1,499,999,999.90 → 15.0%
      expect(r.replyText).toContain('₦1,499,999,999.90');
      expect(r.replyText).toContain('(15.0%)');
      expect(r.replyText).toMatch(/an increase/);
    });

    it('does not report an allocation when asked what was SPENT', async () => {
      const r = await ask('How much did the Ministry of Health spend in 2025?');
      expect(r.intentDetected).toBe('BUDGET_UNAVAILABLE');
      expect(r.replyText).not.toMatch(/₦/);
      expect(r.replyText).toMatch(/won't give a figure/);
    });

    it('never reads a draft, and does not answer a named body with the State total', async () => {
      const r = await ask('What was the 2022 budget for X?');
      expect(r.replyText).not.toContain('₦100');
      expect(r.intentDetected).toBe('BUDGET_CLARIFY');
      const state = await ask('What was the total 2022 State budget?');
      expect(state.intentDetected).toBe('BUDGET_UNAVAILABLE');
      expect(state.replyText).not.toMatch(/₦/);
    });

    it('gives a figure once when two approved documents agree, and refuses when they disagree', async () => {
      await publish(
        { title: "2025 Citizens' Budget", documentType: 'CITIZENS_BUDGET', fiscalYear: 2025 },
        'mda,sector,amount\nMinistry of Health,Health,"6,000,000,000"',
      );
      const agree = await ask('2025 budget for the Ministry of Health');
      expect(agree.intentDetected).toBe('BUDGET_ANSWER');
      expect(agree.replyText).toContain('₦6,000,000,000');
      expect(agree.replyText).not.toContain('₦12,000,000,000'); // not double-counted

      await publish(
        { title: '2025 Revised Health Schedule', documentType: 'CITIZENS_BUDGET', fiscalYear: 2025 },
        'mda,sector,stage,amount\nMinistry of Health,Health,APPROVED,"6,400,000,000"',
      );
      const conflict = await ask('2025 budget for the Ministry of Health');
      expect(conflict.intentDetected).toBe('BUDGET_CONFLICT');
      expect(conflict.shouldHandoff).toBe(true);
      expect(conflict.replyText).toMatch(/disagree/);
      expect(conflict.replyText).toMatch(/won't pick one/);
    });
  });

  describe('projects', () => {
    let projectId: string;

    beforeAll(async () => {
      const r = await as(owner.token, 'post', '/api/budget/projects/import')
        .send({
          csv: [
            'name,responsibleMda,lga,community,approvedAllocation,contractValue,contractor,status,physicalProgress,sourceDocument',
            'Mangu-Bokkos Road Rehabilitation,Ministry of Works,Bokkos,Mushere,"2,000,000,000","1,850,000,000",Example Ltd,ONGOING,40,2025 Appropriation Law',
            'Unsourced Clinic,Ministry of Health,Wase,,,,,PLANNED,,',
          ].join('\n'),
        })
        .expect(201);
      expect(r.body.imported).toBe(2);
      const list = await as(owner.token, 'get', '/api/budget/projects').expect(200);
      projectId = list.body.find((p: any) => p.name.startsWith('Mangu')).id;
      const unsourced = list.body.find((p: any) => p.name === 'Unsourced Clinic').id;
      await as(otherAdminToken, 'post', `/api/budget/projects/${projectId}/approve`).expect(201);
      const refused = await as(otherAdminToken, 'post', `/api/budget/projects/${unsourced}/approve`).expect(400);
      expect(refused.body.message).toMatch(/needs a source/);
    });

    it('answers what projects are in an LGA from the published register only', async () => {
      const r = await ask('What projects are in Bokkos?');
      expect(r.intentDetected).toBe('PROJECT_ANSWER');
      expect(r.replyText).toContain('Mangu-Bokkos Road Rehabilitation');
      expect(r.replyText).toContain('contract value ₦1,850,000,000');
      expect(r.replyText).toMatch(/not the same as money paid/);
      const none = await ask('What projects are in Wase?');
      expect(none.intentDetected).toBe('PROJECT_UNAVAILABLE'); // the draft is not published
    });

    it('records a citizen report apart from the official status', async () => {
      const r = await ask('The road project in Bokkos has been abandoned, nothing is happening');
      expect(r.intentDetected).toBe('PROJECT_OBSERVATION');
      expect(r.replyText).toMatch(/separate from the project's official status/);
      const obs = await prisma.projectObservation.findMany({ where: { projectId } });
      expect(obs).toHaveLength(1);
      const p = await prisma.governmentProject.findUnique({ where: { id: projectId } });
      expect(p!.status).toBe('ONGOING');

      await as(owner.token, 'post', `/api/budget/observations/${obs[0].id}/referred`).expect(201);
      const listed = await as(owner.token, 'get', '/api/budget/observations').expect(200);
      expect(listed.body[0].referred).toBe(true);
    });
  });
});
