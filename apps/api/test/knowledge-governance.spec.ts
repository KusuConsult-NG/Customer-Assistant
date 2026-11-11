/**
 * Knowledge governance (PRD §12).
 *
 * Pinned: a DRAFT or WITHDRAWN document never answers a citizen — through the
 * real conversation engine's retrieval, not just the dashboard — the uploader
 * cannot approve their own document, and questions nothing could answer are
 * collected (one row per question, counted) for someone to fix.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { ConversationOrchestrator } from '@ace/orchestrator';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Knowledge governance', () => {
  let app: INestApplication;
  let t: TestTenant;
  let otherAdmin: string;
  let otherAdminId: string;
  const orchestrator = new ConversationOrchestrator();
  jest.setTimeout(60000);

  const as = (token: string, m: 'get' | 'post' | 'patch', path: string) =>
    (request(app.getHttpServer()) as any)[m](path).set('Authorization', `Bearer ${token}`);

  const ask = (text: string) =>
    orchestrator.processIncomingMessage(
      { conversationId: `kg-${randomBytes(3).toString('hex')}`, organizationId: t.orgId, customerPhoneNumber: '+2348030000777', channel: 'WHATSAPP' as any, history: [], slots: {}, isHumanHandoffActive: false },
      text,
    );

  const doc = async (title: string, content: string, over: Record<string, unknown> = {}) => {
    const d = await prisma.knowledgeDocument.create({
      data: { organizationId: t.orgId, title, fileName: `${title}.txt`, fileSize: content.length, mimeType: 'text/plain', storageUrl: 'x', status: 'INDEXED' as any, chunkCount: 1, ...over },
    });
    await prisma.documentChunk.create({ data: { documentId: d.id, organizationId: t.orgId, chunkIndex: 0, content } });
    return d;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    delete process.env.OPENAI_API_KEY; // forces the Postgres retrieval path, deterministically
    app = await createTestApp();
    t = await createTenant(app, 'kgov', { role: 'OWNER', industry: 'GOVERNMENT' });
    const u = await prisma.user.create({
      data: { organizationId: t.orgId, email: `kgov-admin-${randomBytes(3).toString('hex')}@tenant.test`, passwordHash: 'x', fullName: 'Second', role: 'ADMIN' },
    });
    otherAdminId = u.id;
    otherAdmin = app.get(JwtService).sign({ userId: u.id, organizationId: t.orgId, email: u.email, fullName: u.fullName, role: u.role, tokenVersion: 0 });
  });

  afterAll(async () => {
    await prisma.knowledgeGap.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.documentChunk.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.knowledgeDocument.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.user.deleteMany({ where: { id: otherAdminId } });
    await dropTenant(t?.orgId);
    await app?.close();
  });

  it('never answers from a draft, answers once approved, and stops when withdrawn', async () => {
    const d = await doc('Certificate of origin', 'Certificate of origin zebracode: apply at the LGA secretariat with two passport photographs.', {
      publicationStatus: 'DRAFT',
      createdByUserId: t.userId,
    });
    const draft = await ask('zebracode certificate of origin');
    expect(draft.replyText).not.toContain('two passport photographs');

    // The uploader cannot approve it…
    await as(t.token, 'post', `/api/knowledge/documents/${d.id}/approve`).expect(403);
    // …another administrator can.
    await as(otherAdmin, 'post', `/api/knowledge/documents/${d.id}/approve`).expect(201);
    const live = await ask('zebracode certificate of origin');
    expect(live.replyText).toContain('two passport photographs');

    await as(t.token, 'post', `/api/knowledge/documents/${d.id}/withdraw`).send({}).expect(400);
    await as(t.token, 'post', `/api/knowledge/documents/${d.id}/withdraw`).send({ reason: 'Fee changed' }).expect(201);
    const gone = await ask('zebracode certificate of origin');
    expect(gone.replyText).not.toContain('two passport photographs');
    const audit = await prisma.auditLog.findMany({ where: { organizationId: t.orgId, targetId: d.id } });
    expect(audit.map((a) => a.action).sort()).toEqual(['knowledge.document.approved', 'knowledge.document.withdrawn']);
  });

  it('records source and review metadata, refusing a non-URL source', async () => {
    const d = await doc('Fees', 'Fees list');
    await as(t.token, 'patch', `/api/knowledge/documents/${d.id}/metadata`).send({ sourceUrl: 'not a url' }).expect(400);
    const r = await as(t.token, 'patch', `/api/knowledge/documents/${d.id}/metadata`)
      .send({ sourceUrl: 'https://plateaustate.gov.ng/fees', mdaOwner: 'Ministry of Finance', reviewDueAt: '2027-01-31' })
      .expect(200);
    expect(r.body).toMatchObject({ sourceUrl: 'https://plateaustate.gov.ng/fees', mdaOwner: 'Ministry of Finance' });
  });

  it('collects questions nothing approved could answer, counted per question', async () => {
    await ask('What documents are needed for a quarry permit in Bokkos?');
    await ask('what documents are needed for quarry permit in bokkos');
    await ask('ok thanks');
    await new Promise((r) => setTimeout(r, 300)); // recorded without blocking the reply
    const gaps = await as(t.token, 'get', '/api/knowledge/gaps').expect(200);
    const quarry = gaps.body.find((g: any) => /quarry/.test(g.sampleText));
    expect(quarry.count).toBe(2);
    expect(gaps.body.some((g: any) => /ok thanks/i.test(g.sampleText))).toBe(false);

    await as(t.token, 'patch', `/api/knowledge/gaps/${quarry.id}`).send({ status: 'RESOLVED' }).expect(400);
    await as(t.token, 'patch', `/api/knowledge/gaps/${quarry.id}`).send({ status: 'RESOLVED', resolution: 'FAQ: Quarry licences' }).expect(200);
    const open = await as(t.token, 'get', '/api/knowledge/gaps').expect(200);
    expect(open.body.find((g: any) => g.id === quarry.id)).toBeUndefined();
  });
});
