/**
 * Taking a live conversation away from the hosted agent.
 *
 * The rule this whole file exists to hold is the platform's oldest one: a
 * handoff must MOVE the call, not merely say it did. So every test below asks
 * the same question in a different way — when the answer is "taken", did a
 * redirect actually happen; and when it did not, was the operator told the
 * truth about why.
 *
 * ElevenLabs offers nothing that stops a conversation in progress. The only
 * real lever is the carrier: they answer a Twilio number using the tenant's own
 * credentials, so the call can be redirected out from under them. WhatsApp has
 * no equivalent, and pretending otherwise is the failure being guarded against.
 */

import { Test } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { ElevenLabsTakeoverService } from '../src/agent-tools/elevenlabs-takeover.service';
import { ElevenLabsApi } from '../src/agent-tools/elevenlabs-client';
import { VoiceAiService } from '../src/telephony/voice-ai.service';
import { encryptSecret } from '@ace/database';

describe('ElevenLabs takeover', () => {
  let service: ElevenLabsTakeoverService;
  let orgId: string;
  let otherAgentOrgId: string;
  let transfers: Array<{ callSid: string; forwardingNumber: string; creds: any }>;
  let transferResult: 'TRANSFERRED' | 'FAILED';
  let sent: Array<{ url: string; method: string; body: any }>;

  const agentId = `agent_${randomBytes(4).toString('hex')}`;
  const realFetch = global.fetch;
  const realBase = process.env.ELEVENLABS_BASE_URL;
  const realKey = process.env.ELEVENLABS_API_KEY;
  const realSharedFlag = process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE;

  const voiceStub = {
    transferCallToHuman: async (
      callSid: string,
      creds: any,
      forwardingNumber: string
    ): Promise<'TRANSFERRED' | 'FAILED'> => {
      transfers.push({ callSid, forwardingNumber, creds });
      return transferResult;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ElevenLabsTakeoverService,
        ElevenLabsApi,
        { provide: VoiceAiService, useValue: voiceStub },
      ],
    }).compile();
    service = moduleRef.get(ElevenLabsTakeoverService);

    // Credentials are encrypted at rest, so these suites need a key to store
    // one with. Fixed rather than random: a failure should be reproducible.
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
    process.env.ELEVENLABS_BASE_URL = 'https://elevenlabs.test';
    process.env.ELEVENLABS_API_KEY = 'xi-test-key';
    // These tenants deliberately have no workspace key of their own, so every
    // call here runs through the shared-workspace fallback. That fallback is
    // refused unless a deployment has opted in — see elevenlabs-workspace.ts —
    // so the opt-in is set here rather than the tests quietly proving that a
    // security refusal does not fire.
    process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE = '1';

    const org = await prisma.organization.create({
      data: {
        name: 'Takeover Test Ltd',
        slug: `takeover-${randomBytes(4).toString('hex')}`,
        industry: 'OTHER',
      },
    });
    orgId = org.id;

    const other = await prisma.organization.create({
      data: {
        name: 'Takeover Other',
        slug: `takeover-other-${randomBytes(4).toString('hex')}`,
        industry: 'OTHER',
      },
    });
    otherAgentOrgId = other.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherAgentOrgId] } } });
    global.fetch = realFetch;
    if (realBase === undefined) delete process.env.ELEVENLABS_BASE_URL;
    else process.env.ELEVENLABS_BASE_URL = realBase;
    if (realSharedFlag === undefined) delete process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE;
    else process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE = realSharedFlag;
    if (realKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = realKey;
  });

  beforeEach(async () => {
    transfers = [];
    sent = [];
    transferResult = 'TRANSFERRED';
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.telephonyConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.hostedAgentConfig.create({ data: { organizationId: orgId, agentId } });
  });

  /**
   * Stores the auth token ENCRYPTED, as the application does.
   *
   * That is the point of these assertions: a stored ciphertext must arrive at
   * Twilio as the real token. If a read site ever forgets to decrypt, Twilio
   * rejects `v1.…` as a bad credential and the failure reads as the tenant's
   * Twilio account being broken rather than as our bug.
   */
  const withTelephony = (over: Record<string, unknown> = {}) =>
    prisma.telephonyConfig.create({
      data: {
        organizationId: orgId,
        provider: 'TWILIO',
        phoneNumber: '+2348000000001',
        accountSid: 'AC_test',
        authToken: encryptSecret('tok_test'),
        forwardingNumber: '+2348099999999',
        ...over,
      },
    });

  const conversation = (over: Record<string, any> = {}) => ({
    agent_id: agentId,
    conversation_id: 'conv_live',
    status: 'in-progress',
    has_audio: false,
    has_user_audio: false,
    has_response_audio: false,
    has_auxiliary_audio: false,
    metadata: {
      start_time_unix_secs: 1_760_000_000,
      call_duration_secs: 30,
      phone_call: {
        type: 'twilio',
        direction: 'inbound',
        call_sid: 'CA_live_call',
        stream_sid: 'MZ1',
        phone_number_id: 'phnum_1',
        agent_number: '+2348000000001',
        external_number: '+2348111111111',
      },
    },
    transcript: [],
    ...over,
  });

  const stub = (body: any, status = 200) => {
    global.fetch = (async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      sent.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;
  };

  // ── The call actually moves ────────────────────────────────────────────────

  describe('a live voice call', () => {
    it('redirects the carrier call and only then reports success', async () => {
      await withTelephony();
      stub(conversation());

      const outcome = await service.takeOverConversation(orgId, 'conv_live');

      // The redirect is the deliverable. A "taken" with no transfer behind it is
      // the exact failure this platform has a rule against.
      expect(transfers).toHaveLength(1);
      expect(transfers[0].callSid).toBe('CA_live_call');
      expect(transfers[0].forwardingNumber).toBe('+2348099999999');
      expect(outcome).toMatchObject({ taken: true, channel: 'voice' });
    });

    it("uses the tenant's own Twilio credentials, decrypted", async () => {
      await withTelephony();
      stub(conversation());

      await service.takeOverConversation(orgId, 'conv_live');

      // Stored as ciphertext, presented as the real token.
      expect(transfers[0].creds).toMatchObject({ accountSid: 'AC_test', authToken: 'tok_test' });
      expect(transfers[0].creds.authToken).not.toMatch(/^v1\./);
    });

    it('still works for a tenant whose token predates encryption', async () => {
      // Turning encryption on must not break a live phone line.
      await withTelephony({ authToken: 'legacy_plaintext_token' });
      stub(conversation());

      await service.takeOverConversation(orgId, 'conv_live');
      expect(transfers[0].creds.authToken).toBe('legacy_plaintext_token');
    });

    it('reports failure — not success — when the carrier refuses', async () => {
      await withTelephony();
      transferResult = 'FAILED';
      stub(conversation());

      const outcome = await service.takeOverConversation(orgId, 'conv_live');

      // The caller is still with the agent. Saying otherwise leaves an operator
      // believing a customer was rescued when they were not.
      expect(outcome).toMatchObject({ taken: false });
      expect((outcome as any).reason).toMatch(/still with the agent/i);
    });
  });

  // ── Refusals that tell the truth ───────────────────────────────────────────

  describe('when it cannot be done', () => {
    it('refuses with the fix when no forwarding number is set', async () => {
      await withTelephony({ forwardingNumber: null });
      stub(conversation());

      const outcome = await service.takeOverConversation(orgId, 'conv_live');

      expect(outcome).toMatchObject({ taken: false });
      expect((outcome as any).reason).toMatch(/no forwarding number/i);
      // Nothing was attempted, so nothing can have half-happened.
      expect(transfers).toHaveLength(0);
    });

    it('explains why a WhatsApp conversation cannot be taken over', async () => {
      await withTelephony();
      stub(
        conversation({
          metadata: {
            start_time_unix_secs: 1_760_000_000,
            call_duration_secs: 0,
            whatsapp: { direction: 'inbound', whatsapp_user_id: '2348111111111' },
          },
        })
      );

      const outcome = await service.takeOverConversation(orgId, 'conv_live');

      expect(outcome).toMatchObject({ taken: false });
      // The obvious next question is "why not", so the answer includes it.
      expect((outcome as any).reason).toMatch(/every conversation on that number/i);
      expect(transfers).toHaveLength(0);
    });

    it('says the call has already ended rather than failing obscurely', async () => {
      await withTelephony();
      stub(conversation({ status: 'done' }));

      const outcome = await service.takeOverConversation(orgId, 'conv_live');

      // Calls end while an operator is reaching for the button. That is an
      // answer, not an error.
      expect(outcome).toEqual({ taken: false, reason: 'That conversation has already ended.' });
    });

    it('distinguishes a call that is still being finalised', async () => {
      await withTelephony();
      stub(conversation({ status: 'processing' }));

      const outcome = await service.takeOverConversation(orgId, 'conv_live');
      expect((outcome as any).reason).toMatch(/just ended/i);
    });

    it('never redirects on a payload with no carrier id, because the SDK rejects one first', async () => {
      await withTelephony();
      const c = conversation();
      delete (c.metadata.phone_call as any).call_sid;
      stub(c);

      // This pins the assumption the service relies on rather than defending
      // against it: every phone-call variant in the SDK declares callSid as
      // required, and response validation rejects a payload without one before
      // our code sees it. If that ever stops being true this fails here, which
      // is where the decision to omit a fallback branch is recorded.
      await expect(service.takeOverConversation(orgId, 'conv_live')).rejects.toThrow(/call_sid/);
      expect(transfers).toHaveLength(0);
    });
  });

  // ── Tenancy ────────────────────────────────────────────────────────────────

  describe('isolation', () => {
    it("refuses a conversation belonging to another organization's agent", async () => {
      await withTelephony();
      stub(conversation({ agent_id: 'agent_someone_else' }));

      // Without this an operator could redirect a stranger's live call to their
      // own office by pasting an id.
      await expect(service.takeOverConversation(orgId, 'conv_live')).rejects.toThrow(
        /does not belong to this organization/i
      );
      expect(transfers).toHaveLength(0);
    });

    it('refuses when the conversation does not exist', async () => {
      await withTelephony();
      stub({ detail: 'not found' }, 404);

      await expect(service.takeOverConversation(orgId, 'conv_missing')).rejects.toThrow(
        /does not exist/i
      );
    });

    it('refuses before an agent is provisioned', async () => {
      await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
      stub(conversation());

      await expect(service.takeOverConversation(orgId, 'conv_live')).rejects.toThrow(
        /no provisioned agent/i
      );
      expect(sent).toHaveLength(0);
    });
  });

  // ── The line-wide pause, which is not a takeover ───────────────────────────

  describe('pausing a WhatsApp line', () => {
    beforeEach(async () => {
      await prisma.hostedAgentConfig.update({
        where: { organizationId: orgId },
        data: { whatsappPhoneNumberId: 'wa_1' },
      });
    });

    it('refuses without an explicit acknowledgement of the blast radius', async () => {
      stub({});

      await expect(service.setWhatsAppLinePaused(orgId, true, false)).rejects.toThrow(
        /EVERY customer/i
      );
      expect(sent).toHaveLength(0);
    });

    it('pauses the line once confirmed, and says what that means', async () => {
      stub({});

      const result = await service.setWhatsAppLinePaused(orgId, true, true);

      expect(sent[0].body.enable_messaging).toBe(false);
      // Inbound messages keep arriving with nothing answering them. An operator
      // who does not know that will leave customers unanswered.
      expect(result.note).toMatch(/somebody needs to/i);
    });

    it('needs no confirmation to switch the agent back on', async () => {
      stub({});

      const result = await service.setWhatsAppLinePaused(orgId, false, false);

      expect(sent[0].body.enable_messaging).toBe(true);
      expect(result.paused).toBe(false);
    });

    it('refuses when no WhatsApp line is attached', async () => {
      await prisma.hostedAgentConfig.update({
        where: { organizationId: orgId },
        data: { whatsappPhoneNumberId: null },
      });
      stub({});

      await expect(service.setWhatsAppLinePaused(orgId, true, true)).rejects.toThrow(
        /No WhatsApp line/i
      );
    });
  });
});
