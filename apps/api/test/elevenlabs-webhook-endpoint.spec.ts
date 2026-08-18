/**
 * The HTTP contract of POST /api/webhooks/elevenlabs.
 *
 * The service-level suite proves what gets written. This one proves the thing
 * that has to hold BEFORE any of that: an unverified delivery never reaches the
 * database, whatever it claims about itself.
 *
 * It runs the real app so it also exercises the wiring that has broken this
 * before — rawBody capture. A second body parser registered anywhere consumes
 * the request without the rawBody hook, and then every signature check fails
 * against an undefined buffer. That bug shipped once on the Meta webhook, and
 * the only thing that catches it is booting the app and posting to it.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { signPayload } from '../src/agent-tools/elevenlabs-signature';

const SECRET = 'wsec_endpoint_test';

describe('POST /api/webhooks/elevenlabs', () => {
  let app: INestApplication;
  let orgId: string;
  const agentId = `agent_${randomBytes(4).toString('hex')}`;
  const realSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;

  jest.setTimeout(30000);

  const payload = () => ({
    type: 'post_call_transcription',
    data: {
      agent_id: agentId,
      conversation_id: `conv_${randomBytes(4).toString('hex')}`,
      status: 'done',
      transcript: [{ role: 'user', message: 'Hello there.', time_in_call_secs: 0 }],
      metadata: {
        start_time_unix_secs: Math.floor(Date.now() / 1000),
        call_duration_secs: 10,
        phone_call: {
          type: 'twilio',
          direction: 'inbound',
          call_sid: `CA${randomBytes(6).toString('hex')}`,
          agent_number: '+2348000000009',
          external_number: '+2348222222222',
        },
      },
      analysis: { transcript_summary: 'A short call.', call_successful: 'success' },
    },
  });

  /**
   * Sign exactly as ElevenLabs would, over the bytes actually sent.
   *
   * The body travels as a STRING, not a Buffer. supertest JSON-stringifies a
   * Buffer body — the wire then carries `{"type":"Buffer","data":[…]}`, which
   * is not what was signed, and every one of these tests fails 403 for a reason
   * that has nothing to do with the code under test.
   */
  const signed = (body: any, secret = SECRET, atSecs = Math.floor(Date.now() / 1000)) => {
    const raw = JSON.stringify(body);
    return {
      raw,
      header: `t=${atSecs},${signPayload(Buffer.from(raw, 'utf8'), atSecs, secret)}`,
    };
  };

  const post = (raw: string, header?: string) => {
    const req = request(app.getHttpServer())
      .post('/api/webhooks/elevenlabs')
      .set('Content-Type', 'application/json');
    if (header) req.set('ElevenLabs-Signature', header);
    return req.send(raw);
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ELEVENLABS_WEBHOOK_SECRET = SECRET;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // rawBody: true mirrors main.ts. Without it every check below fails at the
    // "server misconfiguration" branch instead of the one under test.
    app = moduleFixture.createNestApplication({ rawBody: true });
    await app.init();

    const org = await prisma.organization.create({
      data: {
        name: 'Endpoint Test Ltd',
        slug: `endpoint-${randomBytes(4).toString('hex')}`,
        industry: 'OTHER',
      },
    });
    orgId = org.id;
    await prisma.hostedAgentConfig.create({ data: { organizationId: orgId, agentId } });
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    if (app) await app.close();
    if (realSecret === undefined) delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    else process.env.ELEVENLABS_WEBHOOK_SECRET = realSecret;
  });

  beforeEach(async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = SECRET;
    await prisma.callLog.deleteMany({ where: { organizationId: orgId } });
  });

  const settle = () => new Promise((r) => setTimeout(r, 250));

  it('accepts a correctly signed delivery and stores it', async () => {
    const body = payload();
    const { raw, header } = signed(body);

    await post(raw, header).expect(200);
    await settle();

    const call = await prisma.callLog.findUnique({
      where: { callSid: body.data.metadata.phone_call.call_sid },
    });
    expect(call).not.toBeNull();
    expect(call!.organizationId).toBe(orgId);
  });

  it('rejects an unsigned delivery with 403 and writes nothing', async () => {
    const body = payload();
    const { raw } = signed(body);

    await post(raw).expect(403);
    await settle();

    // Without this check the endpoint is an open write into any tenant's CRM
    // for anyone who learns the URL.
    expect(await prisma.callLog.count({ where: { organizationId: orgId } })).toBe(0);
  });

  it('rejects a forged signature with 403', async () => {
    const body = payload();
    const { raw } = signed(body, 'the-wrong-secret');
    const { header } = signed(body, 'the-wrong-secret');

    await post(raw, header).expect(403);
    await settle();
    expect(await prisma.callLog.count({ where: { organizationId: orgId } })).toBe(0);
  });

  it('rejects a body edited after it was signed', async () => {
    const body = payload();
    const { header } = signed(body);

    // Same signature, different bytes — the shape a replay-and-edit attack takes.
    body.data.metadata.phone_call.external_number = '+2340000000000';

    await post(JSON.stringify(body), header).expect(403);
    await settle();
    expect(await prisma.callLog.count({ where: { organizationId: orgId } })).toBe(0);
  });

  it('rejects a delivery replayed from outside the time window', async () => {
    const body = payload();
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    const { raw, header } = signed(body, SECRET, hourAgo);

    await post(raw, header).expect(403);
    await settle();
    expect(await prisma.callLog.count({ where: { organizationId: orgId } })).toBe(0);
  });

  it('answers 500, not 403, when the secret is not configured', async () => {
    delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    const { raw, header } = signed(payload());

    // 500 makes ElevenLabs retry, so the transcript is delayed while the
    // configuration is fixed rather than lost. A 403 would look to them like a
    // permanent rejection and the conversation would be gone for good.
    await post(raw, header).expect(500);
  });

  it('answers 400 for a signed body that is not JSON', async () => {
    const raw = 'this is not json';
    const at = Math.floor(Date.now() / 1000);

    await post(raw, `t=${at},${signPayload(Buffer.from(raw, 'utf8'), at, SECRET)}`).expect(400);
  });

  it('ACKs a signed delivery for an agent nobody claims, and stores nothing', async () => {
    const body = payload();
    body.data.agent_id = 'agent_belongs_to_no_one';
    const { raw, header } = signed(body);

    // 200 because the signature was genuine and there is nothing to retry —
    // retrying would not make the agent belong to anyone.
    await post(raw, header).expect(200);
    await settle();

    expect(await prisma.callLog.count({ where: { organizationId: orgId } })).toBe(0);
  });
});
