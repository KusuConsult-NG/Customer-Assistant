/**
 * A confidential report's call is withheld wherever a call can be read.
 *
 * The Cases screen withheld an anonymous report's reporter and a sensitive
 * case from those not entitled to it — and every other way to the same facts
 * went round it: the call list showed each call's transcript, caller and
 * number to every member; so did the dashboard's recent calls; a contact's page
 * and timeline listed every case they had filed, anonymous ones included; and
 * the call's transcript, mirrored into a VOICE thread, was readable on the
 * Conversations screen. One rule now (common/case-visibility.ts), and this
 * walks every one of those reads as each kind of viewer.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, type TestTenant } from './support/tenant';
import { WITHHELD_TEXT } from '../src/common/case-visibility';

const hex = (n = 4) => randomBytes(n).toString('hex');

describe('A confidential report’s call is withheld wherever a call can be read', () => {
  let app: INestApplication;
  let owner: TestTenant;
  const tokens: Record<'agent' | 'assignee' | 'viewer' | 'liaison', string> = {} as any;
  let reporterId: string;
  const call: Record<'anon' | 'sensitive' | 'open', string> = {} as any;
  const ticket: Record<'anon' | 'sensitive' | 'open', string> = {} as any;
  let voiceThreadId: string;
  const REPORTER_PHONE = `+23480${String(Date.now()).slice(-8)}`;

  const as = (who: keyof typeof tokens | 'owner') => (path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${who === 'owner' ? owner.token : tokens[who]}`)
      .expect(200);

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createTenant(app, 'confidential', { role: 'OWNER' });
    const org = owner.orgId;
    const jwt = app.get(JwtService);
    const member = async (role: string, mdaName: string | null = null) => {
      const u = await prisma.user.create({
        data: { organizationId: org, email: `${role.toLowerCase()}-${hex()}@tenant.test`, passwordHash: 'x', fullName: `${role} Officer`, role: role as any, mdaName },
      });
      return { id: u.id, token: jwt.sign({ userId: u.id, organizationId: org, email: u.email, fullName: u.fullName, role, tokenVersion: u.tokenVersion }) };
    };
    const agent = await member('AGENT');
    const assignee = await member('AGENT');
    tokens.agent = agent.token;
    tokens.assignee = assignee.token;
    tokens.viewer = (await member('VIEWER')).token;
    tokens.liaison = (await member('AGENT', 'Ministry of Works')).token;

    const reporter = await prisma.contact.create({
      data: { organizationId: org, phoneNumber: REPORTER_PHONE, fullName: 'Whistle Blower', city: 'Jos North' },
    });
    reporterId = reporter.id;

    const seedCase = async (key: 'anon' | 'sensitive' | 'open', flags: { isAnonymous?: boolean; isSensitive?: boolean; assignedUserId?: string }) => {
      const conv = `conv_${key}_${hex()}`;
      const log = await prisma.callLog.create({
        data: {
          organizationId: org, contactId: reporter.id, callSid: `CA${key}${hex(6)}`, fromNumber: REPORTER_PHONE,
          toNumber: '+2348000000001', direction: 'INBOUND', status: 'COMPLETED', durationSeconds: 120,
          transcript: `user: secret words about ${key}`, summary: `Summary of the ${key} report`,
          recordingUrl: `elevenlabs:${conv}`,
        },
      });
      const t = await prisma.ticket.create({
        data: {
          organizationId: org, contactId: reporter.id, ticketNumber: `TCK-${key}-${hex()}`, subject: `The ${key} report`,
          description: `What the ${key} caller said`, caseStage: 'CLASSIFIED', channel: 'VOICE', ...flags,
          events: {
            create: [
              { organizationId: org, type: 'CREATED', actorLabel: 'system:voice-agent', body: `Opened from a phone call. Call reference: ${conv}.` },
              { organizationId: org, type: 'CALL_RECORDED', actorLabel: 'system:voice-agent', body: `Call recorded: ${log.id} (2m 0s). The transcript and recording are on the call record.` },
            ],
          },
        },
      });
      call[key] = log.id;
      ticket[key] = t.id;
      return conv;
    };
    const anonConv = await seedCase('anon', { isAnonymous: true });
    await seedCase('sensitive', { isSensitive: true, assignedUserId: assignee.id });
    const openConv = await seedCase('open', {});

    // The post-call mirror: each call's transcript as a VOICE thread under the contact.
    const thread = await prisma.conversation.create({ data: { organizationId: org, contactId: reporter.id, channel: 'VOICE' } });
    voiceThreadId = thread.id;
    await prisma.message.createMany({
      data: [
        { conversationId: thread.id, sender: 'CUSTOMER', content: 'Ordinary question about a road', externalId: `${openConv}:0`, sentAt: new Date(Date.now() - 60_000) },
        { conversationId: thread.id, sender: 'CUSTOMER', content: 'The secret words of an anonymous report', externalId: `${anonConv}:0`, sentAt: new Date() },
      ],
    });
  }, 90_000);

  afterAll(async () => {
    await dropTenant(owner?.orgId);
    await app?.close();
  }, 60_000);

  const callsAs = async (who: keyof typeof tokens | 'owner') => {
    const res = await as(who)('/api/telephony/calls?limit=50');
    return Object.fromEntries(res.body.data.map((r: any) => [r.id, r]));
  };
  const expectWithheld = (row: any) => {
    expect(row).toMatchObject({ confidential: true, transcript: null, summary: null, contact: null, contactId: null, fromNumber: null, recordingPlayable: false });
    expect(JSON.stringify(row)).not.toMatch(/secret words|Whistle Blower|Summary of/);
    expect(JSON.stringify(row)).not.toContain(REPORTER_PHONE);
    // What a supervisor needs to count stays.
    expect(row).toMatchObject({ durationSeconds: 120, status: 'COMPLETED', direction: 'INBOUND' });
  };

  describe('the call list', () => {
    it('withholds who called and what was said on a confidential report’s call, and nothing else', async () => {
      const rows = await callsAs('agent');
      expectWithheld(rows[call.anon]);
      expectWithheld(rows[call.sensitive]);
      expect(rows[call.open]).toMatchObject({ transcript: 'user: secret words about open', fromNumber: REPORTER_PHONE });
      expect(rows[call.open].confidential).toBeUndefined();
    });

    it('a VIEWER is held to the same rule', async () => {
      const rows = await callsAs('viewer');
      expectWithheld(rows[call.anon]);
      expect(rows[call.open].transcript).toBeTruthy();
    });

    it('the officer assigned to a sensitive case reads its call; not the anonymous one', async () => {
      const rows = await callsAs('assignee');
      expect(rows[call.sensitive].transcript).toBe('user: secret words about sensitive');
      expectWithheld(rows[call.anon]);
    });

    it('an administrator reads every call', async () => {
      const rows = await callsAs('owner');
      for (const id of Object.values(call)) expect(rows[id].confidential).toBeUndefined();
      expect(rows[call.anon].transcript).toBe('user: secret words about anon');
    });

    it('an MDA liaison reads no call record at all', async () => {
      const rows = await callsAs('liaison');
      for (const id of Object.values(call)) expectWithheld(rows[id]);
    });
  });

  it('the dashboard’s recent calls follow the same rule', async () => {
    const recent = (await as('agent')('/api/analytics/dashboard')).body.recentCalls;
    const byId = Object.fromEntries(recent.map((r: any) => [r.id, r]));
    expectWithheld(byId[call.anon]);
    expect(byId[call.open].transcript).toBeTruthy();
  });

  describe('the reporter’s contact page', () => {
    it('does not list the anonymous report under its reporter, nor a sensitive case not assigned', async () => {
      const seen = (await as('agent')(`/api/crm/contacts/${reporterId}`)).body.tickets.map((t: any) => t.id);
      expect(seen).toEqual([ticket.open]);
      const assignee = (await as('assignee')(`/api/crm/contacts/${reporterId}`)).body.tickets.map((t: any) => t.id).sort();
      expect(assignee).toEqual([ticket.open, ticket.sensitive].sort());
      const all = (await as('owner')(`/api/crm/contacts/${reporterId}`)).body.tickets.map((t: any) => t.id).sort();
      expect(all).toEqual(Object.values(ticket).sort());
    });

    it('the timeline lists the same cases, and no word of a confidential call', async () => {
      const res = (await as('agent')(`/api/crm/contacts/${reporterId}/timeline`)).body;
      expect(res.contact.tickets.map((t: any) => t.id)).toEqual([ticket.open]);
      const text = JSON.stringify(res.timeline);
      expect(text).not.toMatch(/The anon report|The sensitive report|Summary of the anon|Summary of the sensitive/);
      expect(res.timeline.find((i: any) => i.id === call.anon).description).toContain(WITHHELD_TEXT);
      expect(res.timeline.find((i: any) => i.id === call.open).description).toContain('Summary of the open report');

      const ownerView = JSON.stringify((await as('owner')(`/api/crm/contacts/${reporterId}/timeline`)).body.timeline);
      expect(ownerView).toMatch(/Summary of the anon report/);
    });
  });

  describe('the call’s transcript mirrored into a VOICE thread', () => {
    it('reads as withheld in the thread and in the inbox preview', async () => {
      const messages = (await as('agent')(`/api/conversations/${voiceThreadId}/messages`)).body;
      expect(messages.map((m: any) => m.content)).toEqual(['Ordinary question about a road', WITHHELD_TEXT]);

      const inbox = (await as('agent')('/api/conversations')).body.find((c: any) => c.id === voiceThreadId);
      expect(inbox.messages[0].content).toBe(WITHHELD_TEXT);
      expect(inbox.messages[0].externalId).toBeUndefined();
    });

    it('an administrator reads it', async () => {
      const messages = (await as('owner')(`/api/conversations/${voiceThreadId}/messages`)).body;
      expect(messages.map((m: any) => m.content)).toContain('The secret words of an anonymous report');
    });
  });

  it('the case’s own screen still decides the same way (one rule, not two)', async () => {
    const agentView = (await as('agent')(`/api/cases/${ticket.anon}`)).body;
    expect(agentView.calls).toEqual({ withheld: true, items: [] });
    expect(agentView.contact.fullName).toBe('Anonymous reporter');
    await request(app.getHttpServer()).get(`/api/cases/${ticket.sensitive}`).set('Authorization', `Bearer ${tokens.agent}`).expect(404);
    const assigneeView = (await as('assignee')(`/api/cases/${ticket.sensitive}`)).body;
    expect(assigneeView.calls.items.map((c: any) => c.id)).toEqual([call.sensitive]);
  });
});
