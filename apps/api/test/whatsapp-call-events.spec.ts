import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { WhatsappService } from '../src/whatsapp/whatsapp.service';

/**
 * A citizen phoning the agency from inside WhatsApp.
 *
 * Calling can be switched on for a business line from Settings → WhatsApp, and
 * the other half was missing: Meta delivers call activity on the `calls`
 * webhook field, the handler read only `messages` and `statuses`, and a call
 * event therefore fell into the "no message in payload" branch and was dropped
 * at debug level. Somebody who needed help got nothing and nothing recorded
 * that it had happened.
 *
 * These tests pin the things that make the branch worth having rather than the
 * fact that it runs:
 *
 *  - the call is RECORDED, against the right agency, with a status that does
 *    not claim it was answered;
 *  - the citizen is TOLD something, over the line the call arrived on;
 *  - a refused send is recorded as a refusal, so staff can tell "handled" from
 *    "nobody has contacted this person";
 *  - Meta's redelivery and its connect/terminate pair do not produce two
 *    explanations to the same citizen.
 *
 * `processIncomingWebhook` is awaited directly in most cases: the HTTP route
 * ACKs Meta before processing (deliberately — see the controller), so a test
 * that only posted would be racing the work it means to assert on. One test
 * goes through the real signed route to prove a `calls` payload reaches the
 * branch at all.
 */
describe('WhatsApp call events', () => {
  let app: INestApplication;
  let service: WhatsappService;
  let orgId: string;
  let otherOrgId: string;
  let phoneNumberId: string;
  let realFetch: typeof globalThis.fetch;

  jest.setTimeout(60000);

  const CITIZEN = '+2348012345678';
  const AGENCY = '+2349876543210';
  const APP_SECRET = 'whatsapp_app_secret_for_call_event_tests';
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  /** Every send Meta would have received, so a test can assert on the request. */
  let sent: Array<{ url: string; body: any }> = [];
  /** When set, the next Meta send is refused with this body — an expired token,
   * a closed service window, anything the provider actually answers with. */
  let refuseSendWith: string | null = null;

  const stubMeta = () => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.includes('/messages')) {
        sent.push({ url, body });
        if (refuseSendWith) {
          return new Response(refuseSendWith, { status: 400 });
        }
        return new Response(
          JSON.stringify({ messages: [{ id: `wamid.${randomBytes(6).toString('hex')}` }] }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as any;
  };

  /**
   * Meta's `calls` payload. Shaped from the documented fields, and read
   * defensively by the handler — the exact envelope has never been confirmed
   * against a live delivery on this deployment.
   */
  const callPayload = (over: Record<string, any> = {}, meta: Record<string, any> = {}) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1568175338085648',
        changes: [
          {
            field: 'calls',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: AGENCY,
                phone_number_id: phoneNumberId,
                ...meta,
              },
              contacts: [{ profile: { name: 'Amina Bello' }, wa_id: CITIZEN.replace('+', '') }],
              calls: [
                {
                  id: `wacid.${randomBytes(8).toString('hex')}`,
                  from: CITIZEN.replace('+', ''),
                  to: AGENCY.replace('+', ''),
                  event: 'connect',
                  direction: 'USER_INITIATED',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...over,
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const deliver = (payload: any) =>
    service.processIncomingWebhook(payload, `test-${randomBytes(4).toString('hex')}`);

  const callIdOf = (payload: any) => payload.entry[0].changes[0].value.calls[0].id;

  const logFor = (callId: string) => prisma.callLog.findUnique({ where: { callSid: callId } });

  const messagesFor = async (callId: string) =>
    prisma.message.findMany({
      where: { externalId: { startsWith: callId } },
      orderBy: { sentAt: 'asc' },
    });

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    setEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    realFetch = globalThis.fetch;

    app = await createTestApp();
    service = app.get(WhatsappService);

    const mkOrg = async (name: string) =>
      (
        await prisma.organization.create({
          data: { name, slug: `calls-${randomBytes(5).toString('hex')}`, industry: 'GOVERNMENT' },
        })
      ).id;

    orgId = await mkOrg('Calling Agency');
    otherOrgId = await mkOrg('Other Agency');

    phoneNumberId = `pn_${randomBytes(6).toString('hex')}`;
    await prisma.whatsAppConfig.create({
      data: {
        organizationId: orgId,
        phoneNumberId,
        displayPhoneNumber: AGENCY,
        whatsappBusinessId: '1568175338085648',
        accessToken: `EAA${'t'.repeat(60)}`,
        webhookVerifyToken: `verify_${randomBytes(6).toString('hex')}`,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await prisma.message.deleteMany({
      where: { conversation: { organizationId: { in: [orgId, otherOrgId] } } },
    });
    await prisma.conversation.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.callLog.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.contact.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.whatsAppConfig.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await app.close();
  });

  beforeEach(() => {
    sent = [];
    refuseSendWith = null;
    stubMeta();
  });

  describe('the call is recorded', () => {
    it('records an unanswered inbound call against the owning agency', async () => {
      const payload = callPayload();
      await deliver(payload);

      const row = await logFor(callIdOf(payload));
      expect(row).toBeTruthy();
      expect(row!.organizationId).toBe(orgId);
      expect(row!.direction).toBe('INBOUND');
      // The one thing this must never say is that somebody was helped.
      expect(row!.status).toBe('NO_ANSWER');
      expect(row!.durationSeconds).toBe(0);
      expect(row!.summary).toMatch(/NOT answered/i);
    });

    it('stores the caller in the canonical phone format', async () => {
      const payload = callPayload();
      await deliver(payload);

      const row = await logFor(callIdOf(payload));
      // Meta sends a wa_id with no plus. Stored raw, this row would say
      // `2348012345678` for a citizen whose contact and bookings all say
      // `+2348012345678` — so the screen an officer checks after a missed call
      // would show a number matching nothing they can search for.
      expect(row!.fromNumber).toBe(CITIZEN);
      expect(row!.toNumber).toBe(AGENCY);
    });

    it('does not claim a carrier that never saw the call', async () => {
      const payload = callPayload();
      await deliver(payload);

      const row = await logFor(callIdOf(payload));
      // `provider` defaults to TWILIO. A WhatsApp call involves no carrier at
      // all, and recording one as Twilio sends whoever investigates it to a
      // console that has no trace of it.
      expect(row!.provider).toBe('WHATSAPP_CLOUD');
      expect(row!.telephonyConfigId).toBeNull();
    });

    it('links the caller to a contact, matching across phone formats', async () => {
      // Meta sends the number without a plus; the contact is stored canonical.
      const payload = callPayload();
      await deliver(payload);

      const row = await logFor(callIdOf(payload));
      expect(row!.contactId).toBeTruthy();
      const contact = await prisma.contact.findUnique({ where: { id: row!.contactId! } });
      expect(contact!.organizationId).toBe(orgId);
      expect(contact!.phoneNumber).toBe(CITIZEN);
      // Meta's own profile name beats a generated placeholder.
      expect(contact!.fullName).toBe('Amina Bello');
    });

    it('refuses to attribute a call for an unknown phoneNumberId', async () => {
      const payload = callPayload({}, { phone_number_id: `pn_${randomBytes(6).toString('hex')}` });
      await deliver(payload);

      // No "fall back to any active config" branch: that files one agency's
      // caller under another agency's CRM.
      expect(await logFor(callIdOf(payload))).toBeNull();
      expect(await prisma.callLog.count({ where: { organizationId: otherOrgId } })).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it('records the call but writes no thread for a withheld number', async () => {
      const payload = callPayload({ from: 'unknown' });
      await deliver(payload);

      const row = await logFor(callIdOf(payload));
      // A contact keyed on "unknown" is one row every withheld caller shares.
      expect(row).toBeTruthy();
      expect(row!.contactId).toBeNull();
      expect(sent).toHaveLength(0);
    });

    it('drops a payload with no caller number rather than inventing one', async () => {
      const payload = callPayload({ from: undefined });
      await deliver(payload);
      expect(await logFor(callIdOf(payload))).toBeNull();
    });
  });

  describe('the citizen is told what happened', () => {
    it('sends an explanation over the line the call arrived on', async () => {
      const payload = callPayload();
      await deliver(payload);

      expect(sent).toHaveLength(1);
      expect(sent[0].url).toContain(phoneNumberId);
      // WhatsApp identifies users by E.164 with NO leading plus, which is the
      // form Meta itself sent — the stored form carries the plus.
      expect(sent[0].body.to).toBe(CITIZEN.replace('+', ''));
      expect(sent[0].body.text.body).toMatch(/cannot answer WhatsApp calls yet/i);
      // Nothing is promised that this platform cannot do: no transfer, no
      // callback, and no phone number this handler has not verified.
      expect(sent[0].body.text.body).not.toMatch(/\d{7}/);
      expect(sent[0].body.text.body).not.toMatch(/call you back|transferring|hold/i);
    });

    it('puts the call attempt in the citizen thread, and the reply beside it', async () => {
      const payload = callPayload();
      const callId = callIdOf(payload);
      await deliver(payload);

      const messages = await messagesFor(callId);
      expect(messages).toHaveLength(2);

      const note = messages.find((m) => m.externalId === `${callId}:whatsapp-call`)!;
      expect(note.sender).toBe('SYSTEM');
      expect(note.content).toMatch(/tried to call on WhatsApp and was not answered/i);

      const reply = messages.find((m) => m.externalId === `${callId}:whatsapp-call-reply`)!;
      expect(reply.sender).toBe('AI');
      expect(reply.content).toBe(sent[0].body.text.body);
    });

    it('leaves the AI answering the thread', async () => {
      const payload = callPayload();
      await deliver(payload);

      const row = await logFor(callIdOf(payload));
      const conversation = await prisma.conversation.findFirst({
        where: { organizationId: orgId, contactId: row!.contactId! },
      });
      // Handing off would stop the orchestrator answering this citizen's next
      // message, so a missed call at an agency with nobody at the console would
      // cost them the one channel that does work.
      expect(conversation!.isHumanHandoffActive).toBe(false);
      expect(conversation!.lastMessageAt).toBeTruthy();
    });

    it('records a refused send as a refusal, in the provider\'s words', async () => {
      refuseSendWith = JSON.stringify({
        error: { message: 'Message failed to send because more than 24 hours have passed' },
      });
      const payload = callPayload();
      const callId = callIdOf(payload);
      await deliver(payload);

      const messages = await messagesFor(callId);
      // No reply message: the thread must never show the citizen an
      // explanation they did not receive.
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toMatch(/could NOT be delivered/i);
      expect(messages[0].content).toMatch(/24 hours/);
      expect(messages[0].content).toMatch(/has not been contacted/i);
      // The call itself is still recorded — a failed follow-up must not turn a
      // recorded call into an unrecorded one.
      expect(await logFor(callId)).toBeTruthy();
    });
  });

  describe('Meta delivers each call more than once', () => {
    it('writes to the citizen once across a redelivery', async () => {
      const payload = callPayload();
      await deliver(payload);
      await deliver(payload);

      expect(sent).toHaveLength(1);
      expect(await messagesFor(callIdOf(payload))).toHaveLength(2);
    });

    it('lets terminate refine the status without a second explanation', async () => {
      const payload = callPayload();
      const callId = callIdOf(payload);
      await deliver(payload);
      expect((await logFor(callId))!.status).toBe('NO_ANSWER');

      const terminate = callPayload({
        id: callId,
        event: 'terminate',
        status: 'FAILED',
        duration: 0,
      });
      await deliver(terminate);

      const row = await logFor(callId);
      expect(row!.status).toBe('FAILED');
      expect(row!.endedAt).toBeTruthy();
      // Meta's own word for it, kept verbatim.
      expect(row!.summary).toMatch(/Meta reported FAILED/);
      // One call, one explanation.
      expect(sent).toHaveLength(1);
    });

    it('does not let a late connect undo a terminate', async () => {
      const payload = callPayload();
      const callId = callIdOf(payload);

      // Meta retries both events of a call, so they can arrive out of order.
      await deliver(callPayload({ id: callId, event: 'terminate', status: 'FAILED', duration: 0 }));
      await deliver(payload);

      const row = await logFor(callId);
      // Written on every event, a redelivered `connect` put this row back to
      // NO_ANSWER with a null endedAt — a call still ringing in the history,
      // long after Meta had said how it ended.
      expect(row!.status).toBe('FAILED');
      expect(row!.endedAt).toBeTruthy();
    });

    it('takes Meta\'s word when it reports a call as completed', async () => {
      const payload = callPayload({ event: 'terminate', status: 'COMPLETED', duration: 42 });
      await deliver(payload);

      const row = await logFor(callIdOf(payload));
      expect(row!.status).toBe('COMPLETED');
      expect(row!.durationSeconds).toBe(42);
      // Nobody is told the call failed when the provider says it did not.
      expect(sent).toHaveLength(0);
    });
  });

  describe('the signed route reaches the branch', () => {
    it('accepts a signed `calls` delivery and records the call', async () => {
      const payload = callPayload();
      const raw = JSON.stringify(payload);
      const signature = createHmac('sha256', APP_SECRET).update(raw).digest('hex');

      await request(app.getHttpServer())
        .post('/api/whatsapp/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', `sha256=${signature}`)
        .send(raw)
        .expect(200);

      // The route ACKs before processing, so the work is in flight here.
      const callId = callIdOf(payload);
      for (let i = 0; i < 50 && !(await logFor(callId)); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await logFor(callId)).toBeTruthy();
    });
  });

  describe('the record fails and the citizen is still answered', () => {
    /**
     * The CallLog upsert is written first because it is the durable record, but
     * it used to be awaited bare — so ANY failure there aborted the handler and
     * the citizen got nothing.
     *
     * This is how `WHATSAPP_CLOUD` cost a citizen their reply. The enum value
     * was deployed before the database had it, PostgreSQL rejected the upsert,
     * and the message explaining the unanswered call never sent — from the
     * commit written to stop exactly that. The enum gap is closed elsewhere
     * (a preDeployCommand and a boot check); this pins the ORDERING, because
     * a pool timeout or a constraint would have done the same thing.
     */
    it('still tells the citizen when the call log cannot be written', async () => {
      const upsert = jest
        .spyOn(prisma.callLog, 'upsert')
        .mockRejectedValueOnce(
          Object.assign(new Error('invalid input value for enum "TelephonyProviderType": "WHATSAPP_CLOUD"'), {
            code: 'P2010',
          })
        );

      try {
        const payload = callPayload();
        await deliver(payload);
        const callId = callIdOf(payload);

        // The record really did fail.
        expect(upsert).toHaveBeenCalled();
        expect(await logFor(callId)).toBeNull();

        // And the citizen was answered anyway — the whole point of the handler.
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toContain(phoneNumberId);

        // Including the thread note, so staff can see what happened.
        const messages = await messagesFor(callId);
        expect(messages.length).toBeGreaterThan(0);
      } finally {
        upsert.mockRestore();
      }
    });
  });
});
