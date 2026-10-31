/**
 * The four inbound-call webhooks, and the signatures guarding them.
 *
 * These routes are unauthenticated by necessity — a carrier calls them, not a
 * signed-in operator — so the signature IS the authentication. All four were
 * untested, which meant the verification was unexercised: an attacker who
 * learns the webhook URL can otherwise drive the AI, place the agency's
 * calls and read back whatever the flow says.
 *
 * The property that matters most is the one that is easy to get backwards:
 * when a secret IS configured, a MISSING signature header must be a
 * REJECTION and never a skip. Treating absence as "nothing to check" lets an
 * attacker bypass verification by simply omitting the header, and the Telnyx
 * branch here previously did exactly that — it logged the header and accepted
 * every request.
 *
 * Signatures below are generated with the real algorithms rather than
 * stubbed, so a change to either side of the comparison fails the test.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createHmac,
  randomBytes,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'crypto';
import { prisma, encryptSecret } from '@ace/database';
import { AppModule } from '../src/app.module';

describe('inbound telephony webhook signatures', () => {
  let app: INestApplication;
  let orgId: string;

  const API_BASE = 'http://signature.test';
  const TWILIO_NUMBER = `+2348${String(Date.now()).slice(-9)}`;
  const TELNYX_NUMBER = `+2347${String(Date.now()).slice(-9)}`;
  const AT_NUMBER = `+2349${String(Date.now()).slice(-9)}`;
  const TWILIO_TOKEN = 'twilio_auth_token_for_signature_test';
  const AT_KEY = 'africas_talking_api_key_for_test';
  const CARRIER_NUMBER = `+2346${String(Date.now()).slice(-9)}`;
  const CARRIER_NUMBER_NO_SECRET = `+2345${String(Date.now()).slice(-9)}`;
  const CARRIER_SECRET = 'carrier_forward_shared_secret';

  let telnyxPublicKeyB64: string;
  let telnyxSign: (message: Buffer) => Buffer;

  const realBase = process.env.API_BASE_URL;
  const realTelnyxKey = process.env.TELNYX_PUBLIC_KEY;

  jest.setTimeout(90000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    // The signed callback URL is built from this, so the test and the
    // verifier must agree on it exactly.
    process.env.API_BASE_URL = API_BASE;

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    // Telnyx publishes a raw 32-byte key; the service wraps it in SPKI itself.
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    telnyxPublicKeyB64 = spki.subarray(spki.length - 32).toString('base64');
    telnyxSign = (message: Buffer) => cryptoSign(null, message, privateKey);
    process.env.TELNYX_PUBLIC_KEY = telnyxPublicKeyB64;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // rawBody: true mirrors main.ts. Telnyx and Africa's Talking both verify
    // against the raw buffer, and createNestApplication() does NOT run
    // bootstrap — so without this every signed request fails against an
    // undefined body and reads as a broken signature rather than a test app
    // missing the hook.
    app = moduleFixture.createNestApplication({ rawBody: true });
    await app.init();

    const org = await prisma.organization.create({
      data: {
        name: 'Signature Test Agency',
        slug: `sig-${randomBytes(4).toString('hex')}`,
        industry: 'GOVERNMENT',
      },
    });
    orgId = org.id;

    await prisma.telephonyConfig.createMany({
      data: [
        {
          organizationId: orgId,
          provider: 'TWILIO',
          phoneNumber: TWILIO_NUMBER,
          accountSid: 'AC_sig_test',
          // Stored encrypted, as the application stores it — the inbound path
          // decrypts on read, and a ciphertext here would fail verification
          // in a way that looks like a revoked carrier token.
          authToken: encryptSecret(TWILIO_TOKEN),
        },
        { organizationId: orgId, provider: 'TELNYX', phoneNumber: TELNYX_NUMBER },
        {
          organizationId: orgId,
          provider: 'NIGERIA_CARRIER_FORWARD',
          phoneNumber: CARRIER_NUMBER,
          apiSecret: encryptSecret(CARRIER_SECRET),
        },
        {
          organizationId: orgId,
          provider: 'NIGERIA_CARRIER_FORWARD',
          phoneNumber: CARRIER_NUMBER_NO_SECRET,
        },
        {
          organizationId: orgId,
          provider: 'AFRICAS_TALKING',
          phoneNumber: AT_NUMBER,
          apiKey: encryptSecret(AT_KEY),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    await app?.close();
    if (realBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = realBase;
    if (realTelnyxKey === undefined) delete process.env.TELNYX_PUBLIC_KEY;
    else process.env.TELNYX_PUBLIC_KEY = realTelnyxKey;
  });

  const REJECTED_TWILIO = /could not be authenticated/i;

  // ── Twilio: HMAC-SHA1 over the callback URL plus sorted params ────────────

  describe('Twilio', () => {
    const form = () => ({
      CallSid: `CA${randomBytes(8).toString('hex')}`,
      From: '+2348031111111',
      To: TWILIO_NUMBER,
      CallStatus: 'ringing',
    });

    const signTwilio = (params: Record<string, string>) => {
      const paramString = Object.keys(params)
        .sort()
        .map((k) => `${k}${params[k]}`)
        .join('');
      return createHmac('sha1', TWILIO_TOKEN)
        .update(`${API_BASE}/api/telephony/inbound/twilio${paramString}`)
        .digest('base64');
    };

    it('accepts a correctly signed call', async () => {
      const params = form();

      const res = await request(app.getHttpServer())
        .post('/api/telephony/inbound/twilio')
        .type('form')
        .set('x-twilio-signature', signTwilio(params))
        .send(params)
        .expect(201);

      expect(res.text).not.toMatch(REJECTED_TWILIO);
      expect(res.text).toContain('<Response>');
    });

    it('REJECTS a call with no signature header at all', async () => {
      const params = form();

      // The header's absence must not read as "nothing to verify". Real
      // Twilio always sends it, so omitting it is the cheapest possible
      // bypass attempt.
      const res = await request(app.getHttpServer())
        .post('/api/telephony/inbound/twilio')
        .type('form')
        .send(params)
        .expect(201);

      expect(res.text).toMatch(REJECTED_TWILIO);
      expect(res.text).toContain('<Hangup/>');
    });

    it('rejects a forged signature', async () => {
      const params = form();

      const res = await request(app.getHttpServer())
        .post('/api/telephony/inbound/twilio')
        .type('form')
        .set('x-twilio-signature', Buffer.from('not-the-real-signature').toString('base64'))
        .send(params)
        .expect(201);

      expect(res.text).toMatch(REJECTED_TWILIO);
    });

    it('rejects a signature computed over different parameters', async () => {
      const params = form();
      // Signed for one caller, replayed with another — the params are part of
      // what is signed precisely so this fails.
      const signature = signTwilio(params);

      const res = await request(app.getHttpServer())
        .post('/api/telephony/inbound/twilio')
        .type('form')
        .set('x-twilio-signature', signature)
        .send({ ...params, From: '+2348039999999' })
        .expect(201);

      expect(res.text).toMatch(REJECTED_TWILIO);
    });
  });

  // ── Telnyx: Ed25519 over `timestamp|rawBody`, 5-minute window ────────────

  describe('Telnyx', () => {
    const payload = () => ({
      data: {
        event_type: 'call.initiated',
        payload: {
          call_control_id: `v3:${randomBytes(6).toString('hex')}`,
          from: '+2348031111111',
          to: TELNYX_NUMBER,
        },
      },
    });

    const post = (body: any, timestamp: string, signature?: string) => {
      const raw = Buffer.from(JSON.stringify(body));
      const req = request(app.getHttpServer())
        .post('/api/telephony/inbound/telnyx')
        .set('content-type', 'application/json')
        .set('telnyx-timestamp', timestamp);
      if (signature) req.set('telnyx-signature-ed25519', signature);
      return req.send(raw.toString());
    };

    const sign = (body: any, timestamp: string) =>
      telnyxSign(Buffer.concat([Buffer.from(`${timestamp}|`), Buffer.from(JSON.stringify(body))]))
        .toString('base64');

    it('accepts a correctly signed event', async () => {
      const body = payload();
      const ts = String(Math.floor(Date.now() / 1000));

      const res = await post(body, ts, sign(body, ts)).expect(201);
      expect(res.text).not.toContain('<Reject/>');
    });

    it('REJECTS an event with no signature header', async () => {
      const body = payload();
      const ts = String(Math.floor(Date.now() / 1000));

      // This branch once only LOGGED the header and accepted everything.
      const res = await post(body, ts).expect(201);
      expect(res.text).toContain('<Reject/>');
    });

    it('rejects a replayed event outside the five-minute window', async () => {
      const body = payload();
      // Correctly signed, but for a timestamp long past. Bounding only the
      // past would leave a far-future timestamp replayable forever, which is
      // why the window is checked in both directions.
      const stale = String(Math.floor(Date.now() / 1000) - 600);

      const res = await post(body, stale, sign(body, stale)).expect(201);
      expect(res.text).toContain('<Reject/>');
    });

    it('rejects a signature over a different body', async () => {
      const signed = payload();
      const ts = String(Math.floor(Date.now() / 1000));
      const signature = sign(signed, ts);

      const res = await post(payload(), ts, signature).expect(201);
      expect(res.text).toContain('<Reject/>');
    });
  });

  // ── Africa's Talking: HMAC-SHA256 over the raw body ──────────────────────

  describe("Africa's Talking", () => {
    const form = () =>
      new URLSearchParams({
        sessionId: randomBytes(6).toString('hex'),
        callerNumber: '+2348031111111',
        destinationNumber: AT_NUMBER,
        isActive: '1',
      }).toString();

    it('accepts a correctly signed call', async () => {
      const raw = form();
      const signature = createHmac('sha256', AT_KEY).update(Buffer.from(raw)).digest('hex');

      const res = await request(app.getHttpServer())
        .post('/api/telephony/inbound/africa-talking')
        .set('content-type', 'application/x-www-form-urlencoded')
        .set('x-africastalking-signature', signature)
        .send(raw)
        .expect(201);

      expect(res.text).not.toContain('<Reject/>');
    });

    it('REJECTS a call with no signature header', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/telephony/inbound/africa-talking')
        .set('content-type', 'application/x-www-form-urlencoded')
        .send(form())
        .expect(201);

      expect(res.text).toContain('<Reject/>');
    });

    it('rejects a forged signature', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/telephony/inbound/africa-talking')
        .set('content-type', 'application/x-www-form-urlencoded')
        .set('x-africastalking-signature', 'f'.repeat(64))
        .send(form())
        .expect(201);

      expect(res.text).toContain('<Reject/>');
    });
  });

  // ── A carrier that signs nothing ─────────────────────────────────────────

  describe('a forwarding carrier with no signature scheme', () => {
    const form = (to: string) => ({ From: '+2348031111111', To: to, CallSid: `CF${randomBytes(6).toString('hex')}` });

    it('accepts a call carrying the configured shared secret', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/telephony/inbound/nigeria-carrier')
        .type('form')
        .set('x-carrier-secret', CARRIER_SECRET)
        .send(form(CARRIER_NUMBER))
        .expect(201);

      expect(res.text).not.toMatch(/could not be authenticated/i);
      expect(res.text).toContain('<Response>');
    });

    it('REFUSES a call when no shared secret is configured at all', async () => {
      // This is the branch that differs from every other provider here. The
      // others SKIP verification when their secret is unset, because for them
      // that is a misconfiguration of an otherwise-signed channel. A carrier
      // that signs nothing has no such fallback: skipping would leave the
      // route permanently open, and it drives the AI and can write bookings.
      const res = await request(app.getHttpServer())
        .post('/api/telephony/inbound/nigeria-carrier')
        .type('form')
        .send(form(CARRIER_NUMBER_NO_SECRET))
        .expect(201);

      expect(res.text).toMatch(/not configured for forwarded calls/i);
      expect(res.text).toContain('<Hangup/>');
    });

    it('rejects a call with the wrong secret', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/telephony/inbound/nigeria-carrier')
        .type('form')
        .set('x-carrier-secret', 'not-the-secret')
        .send(form(CARRIER_NUMBER))
        .expect(201);

      expect(res.text).toMatch(/could not be authenticated/i);
    });

    it('rejects a call with no secret header against a configured number', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/telephony/inbound/nigeria-carrier')
        .type('form')
        .send(form(CARRIER_NUMBER))
        .expect(201);

      expect(res.text).toMatch(/could not be authenticated/i);
    });
  });

  // ── A number this platform does not serve ────────────────────────────────

  it('never guesses which agency an unrecognised number belongs to', async () => {
    const params = {
      CallSid: `CA${randomBytes(8).toString('hex')}`,
      From: '+2348031111111',
      To: '+2340000000000',
      CallStatus: 'ringing',
    };

    // Answering with "the first telephony config in the database" once served
    // one tenant's persona, knowledge base and calendar to another tenant's
    // caller. Saying the number is not configured is the honest answer.
    const res = await request(app.getHttpServer())
      .post('/api/telephony/inbound/twilio')
      .type('form')
      .send(params)
      .expect(201);

    expect(res.text).toMatch(/not currently configured/i);
  });
});
