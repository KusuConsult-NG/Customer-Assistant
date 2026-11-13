/**
 * A call's record: kept on the case it opened, and played back.
 *
 * The State's script ends: "The call record, transcript, classification,
 * reference number and case routing information should be saved in the case
 * management platform." And the dashboard's Play button had never once been
 * enabled: ElevenLabs keeps every call's audio, and nothing here ever recorded
 * where. These drive the real app — routes, guards, queries, ingestion — with
 * only the ElevenLabs client replaced, since no sandbox holds a recorded call.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import type { AuthUser } from '@ace/shared-types';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, type TestTenant } from './support/tenant';
import { AgentToolsService } from '../src/agent-tools/agent-tools.service';
import { ElevenLabsWebhookService } from '../src/agent-tools/elevenlabs-webhook.service';
import { ElevenLabsApi } from '../src/agent-tools/elevenlabs-client';
import { CasesService } from '../src/cases/cases.service';
import { CALL_RECORDED_EVENT } from '../src/common/call-case-link';

const hex = (n = 4) => randomBytes(n).toString('hex');
const AUDIO = Buffer.from('ID3\u0004fake-mp3-bytes-for-a-recorded-call');
const audioStream = (bytes: Buffer) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });

describe('Call records: on the case, and played back', () => {
  let app: INestApplication;
  let owner: TestTenant;
  let other: TestTenant;
  let agentToken: string;
  let ownerUser: AuthUser;
  let agentUser: AuthUser;
  let tools: AgentToolsService;
  let webhooks: ElevenLabsWebhookService;
  let cases: CasesService;
  const agentId = `agent_${hex()}`;
  let seq = 0;
  const phone = () => `+2348031${String(Date.now() % 1000).padStart(3, '0')}${String((seq += 1)).padStart(3, '0')}`;

  const fake = {
    conversationalAi: {
      conversations: {
        audio: { get: jest.fn() },
        list: jest.fn(),
        get: jest.fn(),
      },
    },
  };

  const callPayload = (conversationId: string, callSid: string, over: Record<string, any> = {}, call: Record<string, any> = {}) => ({
    type: 'post_call_transcription',
    data: {
      agent_id: agentId,
      conversation_id: conversationId,
      status: 'done',
      has_audio: true,
      transcript: [
        { role: 'agent', message: 'Good morning, and welcome to the Contact Centre.', time_in_call_secs: 0 },
        { role: 'user', message: 'The culvert at Vom Junction has collapsed.', time_in_call_secs: 5 },
      ],
      metadata: {
        start_time_unix_secs: Math.floor(Date.now() / 1000) - 120,
        call_duration_secs: 95,
        phone_call: {
          type: 'twilio',
          direction: 'inbound',
          call_sid: callSid,
          agent_number: '+2348000000001',
          external_number: '+2348031119999',
          ...call,
        },
      },
      analysis: { transcript_summary: 'Caller reported a collapsed culvert.' },
      ...over,
    },
  });

  const report = (over: Record<string, any> = {}) => ({
    phoneNumber: phone(),
    fullName: 'Ladi Gyang',
    subject: 'Collapsed culvert',
    description: 'The culvert on the main road has collapsed and cars cannot pass.',
    category: 'infrastructure',
    lga: 'Jos South',
    ward: 'Vom',
    community: 'Vom Junction',
    summary: 'A collapsed culvert at Vom Junction, Vom ward, Jos South.',
    summaryConfirmed: true,
    ...over,
  });

  const recording = (id: string, token: string | null = owner.token) => {
    const r = request(app.getHttpServer()).get(`/api/calls/${id}/recording`);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createTenant(app, 'callrec', { role: 'OWNER' });
    other = await createTenant(app, 'callrec-other', { role: 'OWNER' });
    const agentRow = await prisma.user.create({
      data: { organizationId: owner.orgId, email: `agent-${hex()}@tenant.test`, passwordHash: 'not-a-login-path', fullName: 'Desk Officer', role: 'AGENT' },
    });
    agentToken = app.get(JwtService).sign({
      userId: agentRow.id, organizationId: owner.orgId, email: agentRow.email, fullName: agentRow.fullName, role: 'AGENT', tokenVersion: agentRow.tokenVersion,
    });
    ownerUser = { userId: owner.userId, organizationId: owner.orgId, email: owner.email, role: 'OWNER' } as AuthUser;
    agentUser = { userId: agentRow.id, organizationId: owner.orgId, email: agentRow.email, role: 'AGENT' } as AuthUser;

    await prisma.hostedAgentConfig.create({ data: { organizationId: owner.orgId, agentId } });

    const api = app.get(ElevenLabsApi);
    jest.spyOn(api, 'for').mockReturnValue(fake as any);
    jest.spyOn(api, 'keyFor').mockReturnValue('test-workspace-key');

    tools = app.get(AgentToolsService);
    webhooks = app.get(ElevenLabsWebhookService);
    cases = app.get(CasesService);
  }, 90_000);

  afterAll(async () => {
    await dropTenant(owner?.orgId);
    await dropTenant(other?.orgId);
    await app?.close();
  }, 60_000);

  beforeEach(() => {
    fake.conversationalAi.conversations.audio.get.mockReset().mockImplementation(async () => audioStream(AUDIO));
    fake.conversationalAi.conversations.list.mockReset();
    fake.conversationalAi.conversations.get.mockReset();
  });

  /** File a report during "a call", then deliver that call's post-call record. */
  const reportAndEndCall = async (over: Record<string, any> = {}, call: Record<string, any> = {}) => {
    const conv = `conv_${hex(6)}`;
    const sid = `CA${hex(8)}`;
    const filed = await tools.createTicket(owner.orgId, report({ conversationId: conv, ...over }) as any);
    expect(filed.ok).toBe(true);
    const outcome = await webhooks.ingest(callPayload(conv, sid, {}, call) as any, 'test');
    expect(outcome).toMatchObject({ handled: true, kind: 'voice' });
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketNumber: String((filed.data as any).ticketNumber) } });
    const callLog = await prisma.callLog.findUniqueOrThrow({ where: { callSid: sid } });
    return { conv, sid, ticket, callLog, payload: callPayload(conv, sid, {}, call) };
  };

  // ── On the case ────────────────────────────────────────────────────────────
  describe('the case keeps the call it was opened on', () => {
    it('attaches the call record once the call ends, and the case shows its transcript', async () => {
      const { ticket, callLog, conv } = await reportAndEndCall();

      const created = await prisma.caseEvent.findFirstOrThrow({ where: { ticketId: ticket.id, type: 'CREATED' } });
      expect(created.body).toContain(`Call reference: ${conv}.`);
      const attached = await prisma.caseEvent.findMany({ where: { ticketId: ticket.id, type: CALL_RECORDED_EVENT } });
      expect(attached).toHaveLength(1);
      expect(attached[0].body).toMatch(new RegExp(`^Call recorded: ${callLog.id} \\(1m 35s\\)`));

      const seen: any = await cases.get(ownerUser, ticket.id);
      expect(seen.calls.withheld).toBe(false);
      expect(seen.calls.items).toHaveLength(1);
      expect(seen.calls.items[0]).toMatchObject({ id: callLog.id, durationSeconds: 95, recordingPlayable: true });
      expect(seen.calls.items[0].transcript).toMatch(/culvert at Vom Junction has collapsed/);
    });

    it('a redelivered call adds nothing', async () => {
      const { ticket, payload } = await reportAndEndCall();
      await webhooks.ingest(payload as any, 'redelivery');
      expect(await prisma.caseEvent.count({ where: { ticketId: ticket.id, type: CALL_RECORDED_EVENT } })).toBe(1);
    });

    it('a call that opened no case attaches to none', async () => {
      const before = await prisma.caseEvent.count({ where: { organizationId: owner.orgId, type: CALL_RECORDED_EVENT } });
      await webhooks.ingest(callPayload(`conv_${hex(6)}`, `CA${hex(8)}`) as any, 'test');
      expect(await prisma.caseEvent.count({ where: { organizationId: owner.orgId, type: CALL_RECORDED_EVENT } })).toBe(before);
    });

    it('withholds an anonymous report’s call from an officer who cannot see the reporter', async () => {
      const { ticket } = await reportAndEndCall({ anonymous: true });
      expect(((await cases.get(agentUser, ticket.id)) as any).calls).toEqual({ withheld: true, items: [] });
      expect(((await cases.get(ownerUser, ticket.id)) as any).calls.items).toHaveLength(1);
    });

    it('files a hidden-number caller’s call under the reporter, within reach of their erasure', async () => {
      const given = phone();
      const { ticket, callLog } = await reportAndEndCall(
        { phoneNumber: 'anonymous', alternativePhone: given, alternativePhoneConfirmed: true },
        { external_number: '' }
      );
      const reporter = await prisma.contact.findUniqueOrThrow({ where: { id: ticket.contactId } });
      expect(reporter.phoneNumber).toBe(given);
      expect(callLog.contactId).toBe(reporter.id);
    });
  });

  // ── Played back ─────────────────────────────────────────────────────────────
  describe('playing a call back', () => {
    it('streams the audio of a call stored from now on', async () => {
      const { callLog, conv } = await reportAndEndCall();
      expect(callLog.recordingUrl).toBe(`elevenlabs:${conv}`);

      const res = await recording(callLog.id).expect(200);
      expect(res.headers['content-type']).toMatch(/^audio\/mpeg/);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(Buffer.from(res.body).equals(AUDIO)).toBe(true);
      expect(fake.conversationalAi.conversations.audio.get).toHaveBeenCalledWith(conv);
    });

    it('finds the recording of a call stored before this existed, once, by its call SID', async () => {
      const sid = `CA${hex(8)}`;
      const startedAt = new Date(Date.now() - 3600_000);
      const old = await prisma.callLog.create({
        data: {
          organizationId: owner.orgId, callSid: sid, fromNumber: '+2348031110000', toNumber: '+2348000000001',
          status: 'COMPLETED', durationSeconds: 61, startedAt, transcript: 'agent: hello',
        },
      });
      fake.conversationalAi.conversations.list.mockResolvedValue({
        conversations: [{ conversationId: 'conv_someone_else' }, { conversationId: 'conv_the_one' }],
        hasMore: false,
      });
      fake.conversationalAi.conversations.get.mockImplementation(async (id: string) => ({
        conversationId: id,
        hasAudio: true,
        metadata: { phoneCall: { callSid: id === 'conv_the_one' ? sid : 'CAnotit' } },
      }));

      await recording(old.id).expect(200);
      const list = fake.conversationalAi.conversations.list.mock.calls[0][0];
      expect(list).toMatchObject({ agentId });
      expect(list.callStartAfterUnix).toBeLessThan(Math.floor(startedAt.getTime() / 1000));
      expect(list.callStartBeforeUnix).toBeGreaterThan(Math.floor(startedAt.getTime() / 1000));
      expect(fake.conversationalAi.conversations.audio.get).toHaveBeenCalledWith('conv_the_one');
      expect((await prisma.callLog.findUniqueOrThrow({ where: { id: old.id } })).recordingUrl).toBe('elevenlabs:conv_the_one');

      // Saved: the second play does not search again.
      fake.conversationalAi.conversations.list.mockClear();
      await recording(old.id).expect(200);
      expect(fake.conversationalAi.conversations.list).not.toHaveBeenCalled();
    });

    it('says plainly when ElevenLabs holds no audio', async () => {
      const { callLog } = await reportAndEndCall();
      fake.conversationalAi.conversations.audio.get.mockRejectedValue(
        Object.assign(new (require('@elevenlabs/elevenlabs-js/errors').ElevenLabsError)({ statusCode: 404, body: { detail: 'not found' } }))
      );
      const res = await recording(callLog.id).expect(404);
      expect(res.body.message).toMatch(/ElevenLabs has no audio for it/);
    });

    it('says where to connect the workspace when the agency has none', async () => {
      const { callLog } = await reportAndEndCall();
      const api = app.get(ElevenLabsApi);
      const keyFor = jest.spyOn(api, 'keyFor').mockImplementationOnce(() => {
        throw new (require('@nestjs/common').BadRequestException)('This agency has no ElevenLabs workspace yet. Add it on this page.');
      });
      const res = await recording(callLog.id).expect(400);
      expect(res.body.message).toMatch(/Agent Provisioning → Credentials/);
      expect(res.body.message).not.toMatch(/this page/);
      keyFor.mockReturnValue('test-workspace-key');
    });

    it('never plays an erased call, even though ElevenLabs may still hold it', async () => {
      const erased = await prisma.callLog.create({
        data: {
          organizationId: owner.orgId, callSid: `CA${hex(8)}`, fromNumber: 'erased', toNumber: 'erased',
          status: 'COMPLETED', durationSeconds: 40, summary: '[erased at the citizen’s request]',
        },
      });
      const res = await recording(erased.id).expect(404);
      expect(res.body.message).toMatch(/erased/);
      expect(fake.conversationalAi.conversations.list).not.toHaveBeenCalled();
      expect(fake.conversationalAi.conversations.audio.get).not.toHaveBeenCalled();
    });

    it('a redelivered call does not write an erased call back', async () => {
      const sid = `CA${hex(8)}`;
      await prisma.callLog.create({
        data: { organizationId: owner.orgId, callSid: sid, fromNumber: 'erased', toNumber: 'erased', status: 'COMPLETED', summary: '[erased]' },
      });
      await webhooks.ingest(callPayload(`conv_${hex(6)}`, sid) as any, 'redelivery');
      const row = await prisma.callLog.findUniqueOrThrow({ where: { callSid: sid } });
      expect(row).toMatchObject({ fromNumber: 'erased', transcript: null, recordingUrl: null });
    });

    it('an anonymous report’s call is played only to those who can see the reporter', async () => {
      const { callLog } = await reportAndEndCall({ anonymous: true });
      const refused = await recording(callLog.id, agentToken).expect(403);
      expect(refused.body.message).toMatch(/confidential report/);
      await recording(callLog.id, owner.token).expect(200);
    });

    it('another agency’s call does not exist, and nobody signed out hears anything', async () => {
      const { callLog } = await reportAndEndCall();
      await recording(callLog.id, other.token).expect(404);
      await recording(callLog.id, null).expect(401);
      expect(fake.conversationalAi.conversations.audio.get).not.toHaveBeenCalled();
    });

    it('the call list says which calls can be played', async () => {
      const { callLog } = await reportAndEndCall();
      const res = await request(app.getHttpServer())
        .get('/api/telephony/calls')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      const row = res.body.data.find((r: any) => r.id === callLog.id);
      expect(row.recordingPlayable).toBe(true);
      const erased = res.body.data.find((r: any) => r.fromNumber === 'erased');
      expect(erased?.recordingPlayable ?? false).toBe(false);
    });
  });
});
