/**
 * Privacy notice, consent records and citizens' data rights (PRD §18).
 *
 * Pinned: the agency's notice reaches each citizen ONCE, before their first
 * WhatsApp answer, and is recorded with its exact wording; export returns what
 * is held; erasure removes the personal content but keeps the record that
 * service happened, needs a typed confirmation and a reason, cancels callbacks
 * to the erased number, and is OWNER/ADMIN only.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, TestTenant } from './support/tenant';
import { WhatsappService } from '../src/whatsapp/whatsapp.service';

describe('Privacy notice and data rights', () => {
  let app: INestApplication;
  let t: TestTenant;
  let agentToken: string;
  let agentId: string;
  let service: WhatsappService;
  let phoneNumberId: string;
  let realFetch: typeof fetch;
  const sent: string[] = [];
  const CITIZEN = `23480${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const NOTICE = 'This line is run by the Plateau State Government. We keep what you tell us to answer you.';
  jest.setTimeout(60000);

  const as = (token: string, m: 'get' | 'post', path: string) =>
    (request(app.getHttpServer()) as any)[m](path).set('Authorization', `Bearer ${token}`);

  const inbound = (body: string) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '2349000000001', phone_number_id: phoneNumberId },
      contacts: [{ profile: { name: 'Privacy Citizen' }, wa_id: CITIZEN }],
      messages: [{ from: CITIZEN, id: `wamid.p.${randomBytes(6).toString('hex')}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
    } }] }],
  });

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    delete process.env.OPENAI_API_KEY;
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.endsWith('/messages')) {
        const b = JSON.parse(String(init?.body ?? '{}'));
        if (b.text?.body) sent.push(b.text.body);
        return new Response(JSON.stringify({ messages: [{ id: `wamid.${randomBytes(5).toString('hex')}` }] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as any;
    app = await createTestApp();
    service = app.get(WhatsappService);
    t = await createTenant(app, 'privacy', { role: 'OWNER', industry: 'GOVERNMENT' });
    await prisma.organization.update({ where: { id: t.orgId }, data: { privacyNotice: NOTICE, welcomeMessage: 'Hello, welcome.' } });
    phoneNumberId = `pn_${randomBytes(6).toString('hex')}`;
    await prisma.whatsAppConfig.create({
      data: { organizationId: t.orgId, phoneNumberId, displayPhoneNumber: '+2349000000001', whatsappBusinessId: 'waba-p', accessToken: `EAA${'t'.repeat(60)}`, webhookVerifyToken: 'v_privacy_token', isActive: true },
    });
    const agent = await prisma.user.create({
      data: { organizationId: t.orgId, email: `privacy-agent-${randomBytes(3).toString('hex')}@tenant.test`, passwordHash: 'x', fullName: 'Agent', role: 'AGENT' },
    });
    agentId = agent.id;
    agentToken = app.get(JwtService).sign({ userId: agent.id, organizationId: t.orgId, email: agent.email, fullName: agent.fullName, role: agent.role, tokenVersion: 0 });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await prisma.consentRecord.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.message.deleteMany({ where: { conversation: { organizationId: t.orgId } } });
    await prisma.conversation.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.callbackRequest.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.ticket.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.callLog.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.contact.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.whatsAppConfig.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.user.deleteMany({ where: { id: agentId } });
    await dropTenant(t?.orgId);
    await app?.close();
  });

  let contactId: string;

  it('sends the notice once, before the first answer, and records its exact wording', async () => {
    await service.processIncomingWebhook(inbound('Hello'), 'p1');
    await service.processIncomingWebhook(inbound('What are your opening hours?'), 'p2');
    expect(sent.length).toBe(2);
    expect(sent[0].startsWith(NOTICE)).toBe(true);
    expect(sent[1]).not.toContain(NOTICE);
    const contact = await prisma.contact.findFirst({ where: { organizationId: t.orgId } });
    contactId = contact!.id;
    const consents = await prisma.consentRecord.findMany({ where: { contactId } });
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ purpose: 'PRIVACY_NOTICE', granted: true, channel: 'WHATSAPP', evidence: NOTICE });
  });

  it('exports what is held, to OWNER/ADMIN only', async () => {
    await as(agentToken, 'get', `/api/crm/contacts/${contactId}/export`).expect(403);
    const res = await as(t.token, 'get', `/api/crm/contacts/${contactId}/export`).expect(200);
    expect(res.body.contact.phoneNumber).toContain(CITIZEN.slice(-6));
    expect(res.body.conversations[0].messages.map((m: any) => m.content)).toEqual(expect.arrayContaining(['Hello', 'What are your opening hours?']));
    expect(res.body.consents[0].text).toBe(NOTICE);
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: t.orgId, action: 'citizen.data_exported' } });
    expect(audit).toBeTruthy();
  });

  it('erases personal content, keeps that service happened, and cancels callbacks', async () => {
    await prisma.callbackRequest.create({
      data: { organizationId: t.orgId, contactId, phoneNumber: `+${CITIZEN}`, reason: 'pension', promisedText: 'soon', dueAt: new Date(), status: 'DUE' },
    });
    await as(t.token, 'post', `/api/crm/contacts/${contactId}/erase`).send({ reason: 'request' }).expect(400);
    await as(t.token, 'post', `/api/crm/contacts/${contactId}/erase`).send({ confirm: 'ERASE' }).expect(400);
    await as(agentToken, 'post', `/api/crm/contacts/${contactId}/erase`).send({ confirm: 'ERASE', reason: 'x' }).expect(403);
    const res = await as(t.token, 'post', `/api/crm/contacts/${contactId}/erase`).send({ confirm: 'ERASE', reason: 'Citizen request by phone' }).expect(201);
    expect(res.body.erased).toBe(true);

    const c = await prisma.contact.findUnique({ where: { id: contactId } });
    expect(c!.fullName).toBe('Erased citizen');
    expect(c!.phoneNumber).not.toContain(CITIZEN.slice(-6));
    const msgs = await prisma.message.findMany({ where: { conversation: { contactId } } });
    expect(msgs.length).toBeGreaterThan(0); // the record of service stays…
    expect(msgs.every((m) => !m.content.includes('opening hours') && !m.content.includes(NOTICE))).toBe(true); // …its content does not
    const cb = await prisma.callbackRequest.findFirst({ where: { contactId } });
    expect(cb!.status).toBe('CANCELLED');
    expect(cb!.phoneNumber).toBe('erased');
    const withdrawn = await prisma.consentRecord.findFirst({ where: { contactId, purpose: 'DATA_PROCESSING' } });
    expect(withdrawn).toMatchObject({ granted: false });
    await as(t.token, 'post', `/api/crm/contacts/${contactId}/erase`).send({ confirm: 'ERASE', reason: 'again' }).expect(400);
  });
});
