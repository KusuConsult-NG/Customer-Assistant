/**
 * The post-call webhook: signature verification, then ingestion.
 *
 * Unverified, this endpoint lets anyone who learns the URL write call
 * transcripts and contacts into any tenant's CRM by posting an agent id. So the
 * signature tests are not about the happy path — they are about every way a
 * forged or replayed delivery might slip through, and about the two places the
 * SDK's own verifier is weaker than it should be.
 *
 * The ingestion tests are about attribution and redelivery. Webhook delivery is
 * at-least-once, and a transcript written twice is a conversation history that
 * shows the customer saying everything twice.
 */

import { Test } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import {
  MAX_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  signPayload,
  verifyElevenLabsSignature,
} from '../src/agent-tools/elevenlabs-signature';
import { ElevenLabsWebhookService } from '../src/agent-tools/elevenlabs-webhook.service';

const SECRET = 'wsec_test_secret';

const sign = (body: Buffer, atSecs: number, secret = SECRET) =>
  `t=${atSecs},${signPayload(body, atSecs, secret)}`;

describe('ElevenLabs webhook signature', () => {
  const body = Buffer.from(JSON.stringify({ type: 'post_call_transcription', data: {} }));
  const now = 1_760_000_000_000; // fixed, so the window tests are not flaky
  const nowSecs = Math.floor(now / 1000);

  it('accepts a correctly signed body', () => {
    expect(verifyElevenLabsSignature(body, sign(body, nowSecs), SECRET, now)).toEqual({ ok: true });
  });

  it('rejects a body that changed after signing', () => {
    const header = sign(body, nowSecs);
    const tampered = Buffer.from(
      JSON.stringify({ type: 'post_call_transcription', data: { agent_id: 'agent_attacker' } })
    );
    const verdict = verifyElevenLabsSignature(tampered, header, SECRET, now);
    expect(verdict).toMatchObject({ ok: false });
  });

  it('rejects a signature made with a different secret', () => {
    const header = sign(body, nowSecs, 'not-our-secret');
    expect(verifyElevenLabsSignature(body, header, SECRET, now)).toMatchObject({ ok: false });
  });

  it('rejects a missing header, and says so distinctly', () => {
    expect(verifyElevenLabsSignature(body, undefined, SECRET, now)).toEqual({
      ok: false,
      reason: 'missing signature header',
    });
  });

  it('rejects when no secret is configured rather than skipping the check', () => {
    // An empty secret must never mean "allow" — that is the failure that turns
    // an authenticated endpoint into an open one.
    //
    // The header here is signed WITH the empty secret, which is the whole
    // point: an attacker who knows the secret is unset can compute a valid
    // HMAC over an empty key. Signing with the real secret instead would make
    // this test pass on a mismatch, proving nothing about the guard — which is
    // exactly what it did until a mutation run caught it.
    const forgeable = `t=${nowSecs},${signPayload(body, nowSecs, '')}`;
    expect(verifyElevenLabsSignature(body, forgeable, '', now)).toEqual({
      ok: false,
      reason: 'no webhook secret configured',
    });
  });

  it.each([
    ['no scheme', 'abcdef'],
    ['timestamp only', `t=${nowSecs}`],
    ['signature only', signPayload(body, nowSecs, SECRET)],
    ['non-numeric timestamp', `t=yesterday,${signPayload(body, nowSecs, SECRET)}`],
  ])('rejects a malformed header (%s)', (_label, header) => {
    expect(verifyElevenLabsSignature(body, header, SECRET, now)).toMatchObject({ ok: false });
  });

  it('reads the parts by prefix, not by position', () => {
    const swapped = `${signPayload(body, nowSecs, SECRET)},t=${nowSecs}`;
    expect(verifyElevenLabsSignature(body, swapped, SECRET, now)).toEqual({ ok: true });
  });

  describe('the replay window', () => {
    it('rejects a delivery older than the tolerance', () => {
      const old = Math.floor((now - MAX_AGE_MS - 1000) / 1000);
      expect(verifyElevenLabsSignature(body, sign(body, old), SECRET, now)).toMatchObject({
        ok: false,
        reason: 'signature timestamp is too old',
      });
    });

    it('accepts one inside it', () => {
      const recent = Math.floor((now - MAX_AGE_MS + 60_000) / 1000);
      expect(verifyElevenLabsSignature(body, sign(body, recent), SECRET, now)).toEqual({ ok: true });
    });

    it('rejects a timestamp far in the future', () => {
      // The SDK's own verifier bounds only the past, so a delivery signed with
      // a far-future timestamp stays replayable forever. This is the one place
      // this implementation is deliberately stricter than upstream.
      const ahead = Math.floor((now + MAX_FUTURE_SKEW_MS + 60_000) / 1000);
      expect(verifyElevenLabsSignature(body, sign(body, ahead), SECRET, now)).toMatchObject({
        ok: false,
        reason: 'signature timestamp is too far in the future',
      });
    });

    it('tolerates a small forward clock skew', () => {
      const ahead = Math.floor((now + 60_000) / 1000);
      expect(verifyElevenLabsSignature(body, sign(body, ahead), SECRET, now)).toEqual({ ok: true });
    });
  });
});

describe('ElevenLabs webhook ingestion', () => {
  let service: ElevenLabsWebhookService;
  let orgId: string;
  let otherOrgId: string;
  const agentId = `agent_${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ElevenLabsWebhookService],
    }).compile();
    service = moduleRef.get(ElevenLabsWebhookService);

    const org = await prisma.organization.create({
      data: {
        name: 'Webhook Test Ltd',
        slug: `webhook-${randomBytes(4).toString('hex')}`,
        industry: 'OTHER',
      },
    });
    orgId = org.id;

    const other = await prisma.organization.create({
      data: {
        name: 'Other Tenant',
        slug: `webhook-other-${randomBytes(4).toString('hex')}`,
        industry: 'OTHER',
      },
    });
    otherOrgId = other.id;

    await prisma.hostedAgentConfig.create({ data: { organizationId: orgId, agentId } });
  }, 60_000);

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
  });

  beforeEach(async () => {
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: otherOrgId } });
    await prisma.callLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
    await prisma.contact.deleteMany({ where: { organizationId: orgId } });
  });

  const callPayload = (over: Record<string, any> = {}) => ({
    type: 'post_call_transcription',
    data: {
      agent_id: agentId,
      conversation_id: `conv_${randomBytes(4).toString('hex')}`,
      status: 'done',
      transcript: [
        { role: 'agent', message: 'Thank you for calling. How can I help?', time_in_call_secs: 0 },
        { role: 'user', message: 'I want to move my appointment.', time_in_call_secs: 4 },
        { role: 'agent', message: null, time_in_call_secs: 6 },
      ],
      metadata: {
        start_time_unix_secs: 1_760_000_000,
        call_duration_secs: 92,
        phone_call: {
          type: 'twilio',
          direction: 'inbound',
          call_sid: `CA${randomBytes(6).toString('hex')}`,
          agent_number: '+2348000000001',
          external_number: '+2348111111111',
        },
      },
      analysis: { transcript_summary: 'Caller asked to reschedule.', call_successful: 'success' },
      ...over,
    },
  });

  const whatsappPayload = (over: Record<string, any> = {}) => ({
    type: 'post_call_transcription',
    data: {
      agent_id: agentId,
      conversation_id: `conv_${randomBytes(4).toString('hex')}`,
      status: 'done',
      transcript: [
        { role: 'user', message: 'Are you open on Saturday?', time_in_call_secs: 0 },
        { role: 'agent', message: 'We are open 9 to 2 on Saturdays.', time_in_call_secs: 2 },
      ],
      metadata: {
        start_time_unix_secs: 1_760_000_000,
        call_duration_secs: 0,
        whatsapp: { direction: 'inbound', whatsapp_user_id: '2348111111111' },
      },
      ...over,
    },
  });

  // ── Attribution ────────────────────────────────────────────────────────────

  describe('deciding whose conversation this is', () => {
    it('drops a delivery for an agent no organization claims', async () => {
      const payload = callPayload();
      payload.data.agent_id = 'agent_nobody';

      const outcome = await service.ingest(payload, 'test');

      expect(outcome).toMatchObject({ handled: false });
      // Guessing would file a stranger's transcript, and the caller's number,
      // into someone's CRM.
      expect(await prisma.callLog.count({ where: { organizationId: orgId } })).toBe(0);
    });

    it('refuses to guess when two organizations claim the same agent', async () => {
      await prisma.hostedAgentConfig.create({ data: { organizationId: otherOrgId, agentId } });

      const outcome = await service.ingest(callPayload(), 'test');

      expect(outcome).toMatchObject({ handled: false });
      expect((outcome as any).reason).toMatch(/more than one organization/i);
      expect(await prisma.callLog.count({ where: { organizationId: orgId } })).toBe(0);
      expect(await prisma.callLog.count({ where: { organizationId: otherOrgId } })).toBe(0);
    });

    it('ignores event types it does not handle, without erroring', async () => {
      const outcome = await service.ingest({ type: 'post_call_audio', data: {} } as any, 'test');
      expect(outcome).toEqual({ handled: false, reason: 'unhandled event type "post_call_audio"' });
    });

    it('stores nothing for a conversation with no phone or WhatsApp identity', async () => {
      const payload = callPayload();
      delete (payload.data.metadata as any).phone_call;

      const outcome = await service.ingest(payload, 'test');

      // A placeholder contact here would invent a customer who does not exist.
      expect(outcome).toMatchObject({ handled: false });
      expect(await prisma.contact.count({ where: { organizationId: orgId } })).toBe(0);
    });
  });

  // ── Voice ──────────────────────────────────────────────────────────────────

  describe('a finished call', () => {
    it('records the transcript, summary and duration against the caller', async () => {
      const payload = callPayload();
      const outcome = await service.ingest(payload, 'test');

      expect(outcome).toMatchObject({ handled: true, kind: 'voice', organizationId: orgId });

      const call = await prisma.callLog.findUnique({
        where: { callSid: payload.data.metadata.phone_call.call_sid },
      });
      expect(call!.organizationId).toBe(orgId);
      expect(call!.durationSeconds).toBe(92);
      expect(call!.status).toBe('COMPLETED');
      expect(call!.direction).toBe('INBOUND');
      expect(call!.fromNumber).toBe('+2348111111111');
      expect(call!.toNumber).toBe('+2348000000001');
      expect(call!.summary).toBe('Caller asked to reschedule.');
      expect(call!.transcript).toContain('Customer: I want to move my appointment.');
      expect(call!.transcript).toContain('Agent: Thank you for calling.');

      const contact = await prisma.contact.findFirst({ where: { organizationId: orgId } });
      expect(contact!.phoneNumber).toBe('+2348111111111');
      expect(call!.contactId).toBe(contact!.id);
    });

    it('swaps the ends for an outbound call', async () => {
      const payload = callPayload();
      payload.data.metadata.phone_call.direction = 'outbound';

      await service.ingest(payload, 'test');

      const call = await prisma.callLog.findUnique({
        where: { callSid: payload.data.metadata.phone_call.call_sid },
      });
      expect(call!.direction).toBe('OUTBOUND');
      expect(call!.fromNumber).toBe('+2348000000001');
      expect(call!.toNumber).toBe('+2348111111111');
    });

    it('writes one record however many times the delivery arrives', async () => {
      const payload = callPayload();
      await service.ingest(payload, 'test');
      await service.ingest(payload, 'test');
      await service.ingest(payload, 'test');

      // Delivery is at-least-once. Three call records for one call would show
      // up as three calls in every report the business runs.
      expect(await prisma.callLog.count({ where: { organizationId: orgId } })).toBe(1);
    });

    it('falls back to the conversation id when the carrier gave no call sid', async () => {
      const payload = callPayload();
      delete (payload.data.metadata.phone_call as any).call_sid;

      await service.ingest(payload, 'test');

      const call = await prisma.callLog.findUnique({
        where: { callSid: payload.data.conversation_id },
      });
      expect(call).not.toBeNull();
    });

    it('marks a failed conversation failed rather than completed', async () => {
      const payload = callPayload();
      payload.data.status = 'failed';

      await service.ingest(payload, 'test');

      const call = await prisma.callLog.findUnique({
        where: { callSid: payload.data.metadata.phone_call.call_sid },
      });
      expect(call!.status).toBe('FAILED');
    });
  });

  // ── WhatsApp ───────────────────────────────────────────────────────────────

  describe('a finished WhatsApp thread', () => {
    it('writes the turns into a conversation the dashboard can read', async () => {
      const payload = whatsappPayload();
      const outcome = await service.ingest(payload, 'test');

      expect(outcome).toMatchObject({ handled: true, kind: 'whatsapp' });

      const conversation = await prisma.conversation.findFirst({
        where: { organizationId: orgId },
        include: { messages: { orderBy: { sentAt: 'asc' } } },
      });
      expect(conversation!.channel).toBe('WHATSAPP');
      expect(conversation!.messages.map((m) => [m.sender, m.content])).toEqual([
        ['CUSTOMER', 'Are you open on Saturday?'],
        ['AI', 'We are open 9 to 2 on Saturdays.'],
      ]);
    });

    it('does not duplicate the transcript when the delivery is replayed', async () => {
      const payload = whatsappPayload();
      await service.ingest(payload, 'test');
      await service.ingest(payload, 'test');

      const count = await prisma.message.count({
        where: { conversation: { organizationId: orgId } },
      });
      // A replay that duplicated would render as the customer saying everything
      // twice — indistinguishable from them actually repeating themselves.
      expect(count).toBe(2);
    });

    it('reuses the contact an inbound Meta message would have created', async () => {
      // Meta's webhook gives E.164 without the "+", and so does ElevenLabs'
      // whatsapp_user_id, so both paths land on one contact rather than two.
      const existing = await prisma.contact.create({
        data: { organizationId: orgId, phoneNumber: '2348111111111', fullName: 'Known Customer' },
      });

      await service.ingest(whatsappPayload(), 'test');

      expect(await prisma.contact.count({ where: { organizationId: orgId } })).toBe(1);
      const conversation = await prisma.conversation.findFirst({ where: { organizationId: orgId } });
      expect(conversation!.contactId).toBe(existing.id);
    });

    it('skips turns that carry no text', async () => {
      const payload = whatsappPayload();
      payload.data.transcript.push({ role: 'agent', message: null, time_in_call_secs: 9 } as any);

      await service.ingest(payload, 'test');

      // Tool-call-only turns have nothing to show a human.
      expect(
        await prisma.message.count({ where: { conversation: { organizationId: orgId } } })
      ).toBe(2);
    });
  });
});
