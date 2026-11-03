/**
 * Dialling out on the agency's own SIP trunk.
 *
 * ── Why this path exists ────────────────────────────────────────────────────
 *
 * A State toll-free number already in service cannot be handed to Twilio, so
 * it reaches this platform over a carrier SIP trunk. That gave us inbound and
 * nothing else — the platform holds no SIP stack, so it cannot originate on a
 * trunk itself — and a promised callback could therefore never be placed on
 * the one number the agency publishes.
 *
 * ElevenLabs already holds the trunk, so the agent that ANSWERS the number
 * places the call too. One number, both directions, no SIP stack here.
 *
 * ── What these tests are actually about ─────────────────────────────────────
 *
 * Almost all of it is the difference between a call that happened and a call
 * that did not. `POST /v1/convai/sip-trunk/outbound-call` answers 200 with a
 * body carrying its own `success` flag, so HTTP 200 does not mean the phone
 * rang. Treating it as success is exactly how a callback gets marked COMPLETED
 * for a call nobody made — the one thing this platform must never do.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { prisma, encryptSecret } from '@ace/database';
import { AppModule } from '../src/app.module';
import { SipTrunkOriginationService } from '../src/telephony/sip-trunk-origination.service';
import { TelephonyService } from '../src/telephony/telephony.service';
import { CallbackDispatcherService } from '../src/telephony/callback-dispatcher.service';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('SIP trunk outbound', () => {
  let app: INestApplication;
  let agency: TestTenant;
  let sip: SipTrunkOriginationService;
  let telephony: TelephonyService;
  let contactId: string;

  const TRUNK_NUMBER = '+2348000000001';
  const CITIZEN = '+2348031119999';

  const realFetch = global.fetch;
  jest.setTimeout(120000);

  /** Stand in for ElevenLabs, so the whole path runs with no network. */
  function carrier(reply: { status?: number; body?: any; throws?: any }) {
    const calls: any[] = [];
    global.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}'), headers: init?.headers });
      if (reply.throws) throw reply.throws;
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
      return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, text: async () => text } as any;
    }) as any;
    return calls;
  }

  async function provision(over: Record<string, any> = {}) {
    await prisma.hostedAgentConfig.upsert({
      where: { organizationId: agency.orgId },
      update: { agentId: 'agent_sip_0001', phoneNumberId: 'phnum_sip_0001', isActive: true, ...over },
      create: {
        organizationId: agency.orgId,
        agentId: 'agent_sip_0001',
        phoneNumberId: 'phnum_sip_0001',
        apiKey: encryptSecret('sk_test_workspace_key'),
        isActive: true,
        ...over,
      },
    });
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    agency = await createTenant(app, 'sip-agency', { role: 'OWNER' });
    sip = app.get(SipTrunkOriginationService);
    telephony = app.get(TelephonyService);

    await prisma.telephonyConfig.create({
      data: {
        organizationId: agency.orgId,
        provider: 'SIP_TRUNK',
        phoneNumber: TRUNK_NUMBER,
        sipAddress: 'sip.carrier.ng',
        isDefault: true,
      },
    });
    contactId = (await prisma.contact.create({
      data: { organizationId: agency.orgId, phoneNumber: CITIZEN, fullName: 'Amina Yusuf' },
    })).id;
  });

  afterEach(() => { global.fetch = realFetch; });

  afterAll(async () => {
    global.fetch = realFetch;
    await dropTenant(agency?.orgId);
    await app?.close();
  });

  describe('placing the call', () => {
    it('dials the citizen from the agency trunk, through the agent that answers it', async () => {
      await provision();
      const calls = carrier({ body: { success: true, message: 'ok', sip_call_id: 'sip_abc123', conversation_id: 'conv_1' } });

      const placed = await sip.placeCall(agency.orgId, CITIZEN, { fromNumber: TRUNK_NUMBER });

      expect(placed.callId).toBe('sip_abc123');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/v1/convai/sip-trunk/outbound-call');
      // The agent and the imported trunk number identify what to call FROM.
      expect(calls[0].body).toMatchObject({
        agent_id: 'agent_sip_0001',
        agent_phone_number_id: 'phnum_sip_0001',
        to_number: CITIZEN,
      });
      // The tenant's own workspace key, decrypted — never the ciphertext.
      expect(calls[0].headers['xi-api-key']).toBe('sk_test_workspace_key');
    });

    it('falls back to the conversation id when no SIP call id comes back', async () => {
      await provision();
      carrier({ body: { success: true, message: 'ok', conversation_id: 'conv_only' } });
      await expect(sip.placeCall(agency.orgId, CITIZEN, { fromNumber: TRUNK_NUMBER }))
        .resolves.toMatchObject({ callId: 'conv_only' });
    });
  });

  describe('a call that did not happen is never reported as one', () => {
    it('treats HTTP 200 with success:false as a failure, and keeps the reason', async () => {
      // The trap. A 200 does not mean the phone rang.
      await provision();
      carrier({ status: 200, body: { success: false, message: 'trunk rejected the destination' } });

      await expect(sip.placeCall(agency.orgId, CITIZEN, { fromNumber: TRUNK_NUMBER }))
        .rejects.toThrow(/was not placed: trunk rejected the destination/i);
    });

    it('refuses an accepted call that carries no identifier', async () => {
      // Nothing to reconcile against later; an invented id would make a
      // missing call look like a completed one.
      await provision();
      carrier({ body: { success: true, message: 'queued' } });

      await expect(sip.placeCall(agency.orgId, CITIZEN, { fromNumber: TRUNK_NUMBER }))
        .rejects.toThrow(/no call identifier/i);
    });

    it('says a network failure is not a rejected key', async () => {
      await provision();
      carrier({ throws: Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }) });

      await expect(sip.placeCall(agency.orgId, CITIZEN, { fromNumber: TRUNK_NUMBER }))
        .rejects.toThrow(/NOT placed.*not a rejected key/is);
    });

    it('keeps the provider status when ElevenLabs refuses outright', async () => {
      await provision();
      carrier({ status: 401, body: { detail: 'invalid api key' } });

      await expect(sip.placeCall(agency.orgId, CITIZEN, { fromNumber: TRUNK_NUMBER }))
        .rejects.toThrow(/HTTP 401.*invalid api key/s);
    });
  });

  describe('refusing when there is nothing to call with', () => {
    it('refuses when the agent has not been provisioned', async () => {
      await provision({ agentId: null });
      await expect(sip.placeCall(agency.orgId, CITIZEN, { fromNumber: TRUNK_NUMBER }))
        .rejects.toThrow(/no provisioned ElevenLabs agent/i);
    });

    it('refuses when the trunk number was never imported', async () => {
      await provision({ phoneNumberId: null });
      await expect(sip.placeCall(agency.orgId, CITIZEN, { fromNumber: TRUNK_NUMBER }))
        .rejects.toThrow(/has not been imported/i);
    });

    it('reports whether an agency can originate at all', async () => {
      await provision();
      expect(await sip.canOriginate(agency.orgId)).toBe(true);
      await provision({ phoneNumberId: null });
      expect(await sip.canOriginate(agency.orgId)).toBe(false);
    });
  });

  describe('the rest of the platform does not need to know which carrier placed it', () => {
    it('routes a SIP_TRUNK agency through the trunk and writes one CallLog', async () => {
      await provision();
      carrier({ body: { success: true, message: 'ok', sip_call_id: 'sip_via_service' } });

      const record: any = await telephony.initiateOutboundCall(agency.orgId, CITIZEN);

      expect(record.callId).toBe('sip_via_service');
      const logged = await prisma.callLog.findFirst({ where: { callSid: 'sip_via_service' } });
      expect(logged).toBeTruthy();
      expect(logged!.direction).toBe('OUTBOUND');
      expect(logged!.fromNumber).toBe(TRUNK_NUMBER);
      expect(logged!.provider).toBe('SIP_TRUNK');
    });

    it('lets a promised callback be placed on the trunk number', async () => {
      // The whole point: before this, a callback on a SIP-only agency failed
      // honestly and never rang.
      await provision();
      carrier({ body: { success: true, message: 'ok', sip_call_id: 'sip_callback_1' } });

      const row = await prisma.callbackRequest.create({
        data: {
          organizationId: agency.orgId,
          contactId,
          phoneNumber: CITIZEN,
          reason: 'borehole repair',
          promisedText: 'Within the hour',
          dueAt: new Date(Date.now() - 60_000),
        },
      });

      await app.get(CallbackDispatcherService).placeOne(row.id);

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after!.status).toBe('COMPLETED');
      expect(after!.callSid).toBe('sip_callback_1');
    });

    it('leaves a callback unplaced, with the reason, when the trunk refuses', async () => {
      await provision();
      carrier({ status: 200, body: { success: false, message: 'destination unreachable' } });

      const row = await prisma.callbackRequest.create({
        data: {
          organizationId: agency.orgId,
          contactId,
          phoneNumber: CITIZEN,
          reason: 'land title',
          promisedText: 'Later today',
          dueAt: new Date(Date.now() - 60_000),
        },
      });

      await app.get(CallbackDispatcherService).placeOne(row.id);

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after!.status).not.toBe('COMPLETED');
      expect(after!.completedAt).toBeNull();
      expect(after!.failureReason).toMatch(/destination unreachable/i);
    });
  });
});
