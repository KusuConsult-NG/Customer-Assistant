import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma, encryptSecret } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { handshakeTokenIsAccepted } from '../src/whatsapp/whatsapp.service';

/**
 * Two things an operator could not do without handling a Meta token by hand.
 *
 *  1. Find out which `phoneNumberId` is theirs. The id is not the phone
 *     number and Meta rarely shows them together, so getting it wrong is
 *     silent: the row saves, the dashboard reports the line connected, and
 *     the number that rings is somebody else's. This deployment stored Meta's
 *     sandbox "+1 555-671-9884 / Test Number" that way.
 *  2. Connect a SECOND agency's line. The handshake compared only the
 *     deployment-wide `WHATSAPP_VERIFY_TOKEN`, so a per-agency line meant
 *     sharing one secret or restarting the API for everybody — while the
 *     `webhookVerifyToken` column round tripped through the settings form and
 *     was read by nothing on that path.
 */
describe('WhatsApp line discovery and handshake', () => {
  let app: INestApplication;
  let orgId: string;
  let ownerToken: string;
  let agentToken: string;

  jest.setTimeout(60000);

  const META = `EAA${'t'.repeat(198)}`;
  const WABA = '1568175338085648';
  let realFetch: typeof globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    realFetch = globalThis.fetch;

    app = await createTestApp();
    const org = await prisma.organization.create({
      data: { name: 'Line Agency', slug: `line-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;

    const mk = async (role: 'OWNER' | 'AGENT') => {
      const email = `line.${role.toLowerCase()}.${randomBytes(4).toString('hex')}@line.test`;
      const password = 'LinePassw0rd!';
      await prisma.user.create({
        data: {
          organizationId: orgId, email, fullName: role, role,
          passwordHash: await bcrypt.hash(password, 10), emailVerifiedAt: new Date(),
        },
      });
      return (await request(app.getHttpServer()).post('/api/auth/login').send({ email, password }))
        .body.accessToken as string;
    };
    ownerToken = await mk('OWNER');
    agentToken = await mk('AGENT');
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await prisma.whatsAppConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    globalThis.fetch = realFetch;
    await prisma.whatsAppConfig.deleteMany({ where: { organizationId: orgId } });
  });

  const storeLine = (over: Partial<{ phoneNumberId: string; verify: string; businessId: string }> = {}) =>
    prisma.whatsAppConfig.create({
      data: {
        organizationId: orgId,
        phoneNumberId: over.phoneNumberId ?? '1319842031202307',
        whatsappBusinessId: over.businessId ?? WABA,
        accessToken: encryptSecret(META),
        webhookVerifyToken: encryptSecret(over.verify ?? 'stored_verify_value'),
        displayPhoneNumber: '+1 555-671-9884',
        isActive: true,
      },
    });

  const metaReturns = (numbers: any[], opts: { status?: number; body?: any; throws?: boolean } = {}) => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes('graph.facebook.com')) {
        if (opts.throws) throw new Error('ECONNRESET');
        if (opts.status && opts.status !== 200) {
          return new Response(JSON.stringify(opts.body ?? { error: { message: 'Error validating access token' } }), {
            status: opts.status,
          });
        }
        // The credential must travel in the header, never in the URL.
        expect(String(url)).not.toContain(META);
        expect((init?.headers ?? {}).Authorization).toBe(`Bearer ${META}`);
        return new Response(JSON.stringify({ data: numbers }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as any;
  };

  const numbers = (token = ownerToken) =>
    request(app.getHttpServer())
      .get('/api/organizations/whatsapp-config/numbers')
      .set('Authorization', `Bearer ${token}`);

  describe('listing the account\'s numbers', () => {
    it('asks Meta with the stored credential and marks the connected line', async () => {
      await storeLine();
      metaReturns([
        { id: '1319842031202307', display_phone_number: '+1 555-671-9884', verified_name: 'Test Number' },
        { id: '9988776655443322', display_phone_number: '+234 803 000 1111', verified_name: 'Plaschema' },
      ]);

      const res = await numbers();
      expect(res.status).toBe(200);
      expect(res.body.numbers).toHaveLength(2);

      const connected = res.body.numbers.find((n: any) => n.isConnectedHere);
      expect(connected.phoneNumberId).toBe('1319842031202307');
      // A sandbox number only talks to recipients added by hand, so it is
      // proof the stack works and never a number to publish.
      expect(connected.isMetaTestNumber).toBe(true);

      const real = res.body.numbers.find((n: any) => n.verifiedName === 'Plaschema');
      expect(real.isConnectedHere).toBe(false);
      expect(real.isMetaTestNumber).toBe(false);
    });

    it('never returns the token or its ciphertext', async () => {
      await storeLine();
      metaReturns([{ id: '1319842031202307', display_phone_number: '+1 555-671-9884' }]);
      const raw = JSON.stringify((await numbers()).body);
      expect(raw).not.toContain(META);
      expect(raw).not.toContain('v1.');
    });

    it('quotes Meta when Meta refuses, rather than "it did not work"', async () => {
      await storeLine();
      metaReturns([], { status: 401 });
      const res = await numbers();
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Error validating access token');
    });

    it('says it could not ask, rather than reporting an empty account', async () => {
      await storeLine();
      metaReturns([], { throws: true });
      const res = await numbers();
      // 503, not 200 with []: an account that holds nothing and an account we
      // could not reach are different answers.
      expect(res.status).toBe(503);
      expect(res.body.message).toMatch(/could not reach meta/i);
    });

    it('refuses when there is no stored line to ask with', async () => {
      const res = await numbers();
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/no whatsapp line stored/i);
    });

    it('names the missing half when the line has no business id', async () => {
      // The column is non-nullable, so an absent business id reaches us as an
      // empty string — which is exactly as unusable and reads as "set".
      await storeLine({ businessId: '' });
      const res = await numbers();
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/business id/i);
    });

    it('is OWNER/ADMIN only', async () => {
      await storeLine();
      expect((await numbers(agentToken)).status).toBe(403);
    });
  });

  describe('the verification handshake', () => {
    const handshake = (token: string) =>
      request(app.getHttpServer()).get(
        `/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=chal123`
      );

    it('still accepts WHATSAPP_VERIFY_TOKEN', async () => {
      setEnv('WHATSAPP_VERIFY_TOKEN', 'env_verify_value');
      const res = await handshake('env_verify_value');
      expect(res.status).toBe(200);
      expect(res.text).toBe('chal123');
    });

    it("accepts an active line's OWN stored token, with no env var at all", async () => {
      setEnv('WHATSAPP_VERIFY_TOKEN', undefined);
      await storeLine({ verify: 'per_line_verify_value' });
      const res = await handshake('per_line_verify_value');
      expect(res.status).toBe(200);
      expect(res.text).toBe('chal123');
    });

    it('rejects a wrong token', async () => {
      setEnv('WHATSAPP_VERIFY_TOKEN', 'env_verify_value');
      await storeLine({ verify: 'per_line_verify_value' });
      expect((await handshake('neither_of_them')).status).toBe(403);
    });

    it('does not accept an INACTIVE line\'s token', async () => {
      // The env var is SET on purpose. With it unset, deactivating the only
      // row in a clean database leaves no candidate at all, so the answer is
      // the 500 for "nothing configured" rather than the 403 for "that token
      // is not accepted" — two different behaviours, and the assertion would
      // pass or fail on whether another suite happened to leave a row behind.
      // CI is clean and the dev database is not, which is exactly how this
      // passed locally and failed there.
      setEnv('WHATSAPP_VERIFY_TOKEN', 'env_verify_value');
      const row = await storeLine({ verify: 'retired_line_value' });
      await prisma.whatsAppConfig.update({ where: { id: row.id }, data: { isActive: false } });

      expect((await handshake('retired_line_value')).status).toBe(403);
      // And the deactivation did not break what still works.
      expect((await handshake('env_verify_value')).status).toBe(200);
    });

    /**
     * Tested at the function rather than over HTTP, deliberately.
     *
     * The candidate list is deployment-wide — the webhook is ONE URL and
     * cannot know which agency's line Meta is verifying — so "no line stores
     * a token" is a fact about the whole database, and any other suite's
     * fixture row would make this assertion pass or fail for reasons that
     * have nothing to do with the behaviour.
     */
    it('reports nothing configured when neither the env var nor any line has one', async () => {
      setEnv('WHATSAPP_VERIFY_TOKEN', undefined);
      const spy = jest.spyOn(prisma.whatsAppConfig, 'findMany').mockResolvedValue([] as any);
      try {
        expect(await handshakeTokenIsAccepted('anything')).toEqual({
          accepted: false,
          configured: false,
        });
      } finally {
        spy.mockRestore();
      }
    });

    it('does not ACCEPT when the lookup fails, and does not claim nothing is configured', async () => {
      setEnv('WHATSAPP_VERIFY_TOKEN', 'env_verify_value');
      const spy = jest
        .spyOn(prisma.whatsAppConfig, 'findMany')
        .mockRejectedValue(new Error('connection terminated'));
      try {
        // A database blip must not turn into an accepted handshake, and must
        // not erase the env var that is still perfectly valid.
        expect(await handshakeTokenIsAccepted('env_verify_value')).toEqual({
          accepted: true,
          configured: true,
        });
        expect(await handshakeTokenIsAccepted('wrong')).toEqual({
          accepted: false,
          configured: true,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
  /**
   * Whether a citizen's message can ARRIVE, which nothing asked before.
   *
   * A line can be stored, its token valid and every screen green while Meta
   * delivers nothing — because no app is subscribed to the business account's
   * webhooks, or because the number's override still points at whoever held it
   * before. Both are silent, and both look exactly like a fault here.
   */
  describe('readiness: will Meta actually deliver', () => {
    const WEBHOOK = 'https://api.example.test/api/whatsapp/webhook';

    beforeEach(() => {
      setEnv('API_BASE_URL', 'https://api.example.test');
      setEnv('WHATSAPP_APP_SECRET', 'app_secret_value');
    });

    /** `number` and `subs` each: 'ok' | 'refused' | 'unreachable' | an object. */
    const metaSays = (opts: { number?: any; subs?: any } = {}) => {
      globalThis.fetch = (async (input: any) => {
        const url = String(input);
        const answer = (kind: any, happy: any) => {
          if (kind === 'refused') {
            return new Response(JSON.stringify({ error: { message: 'Error validating access token' } }), { status: 401 });
          }
          if (kind === 'unreachable') throw new Error('ECONNRESET');
          return new Response(JSON.stringify(kind === undefined || kind === 'ok' ? happy : kind), { status: 200 });
        };
        if (url.includes('/subscribed_apps')) {
          return answer(opts.subs, { data: [{ whatsapp_business_api_data: { id: '1', name: 'Plateau Care' } }] });
        }
        if (url.includes('graph.facebook.com')) {
          return answer(opts.number, {
            display_phone_number: '+234 803 000 1111',
            verified_name: 'Plaschema',
            webhook_configuration: { application: WEBHOOK },
          });
        }
        return new Response('{}', { status: 200 });
      }) as any;
    };

    const readiness = (token = ownerToken) =>
      request(app.getHttpServer())
        .get('/api/organizations/whatsapp-config/readiness')
        .set('Authorization', `Bearer ${token}`);

    it('is READY only when Meta confirms both the token and a subscribed app', async () => {
      await storeLine();
      metaSays();
      const res = await readiness();
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('ready');
      expect(res.body.blocked).toEqual([]);
      expect(res.body.ok.join(' ')).toContain('Plateau Care');
      expect(res.body.webhookUrl).toBe(WEBHOOK);
    });

    it('is BLOCKED when no app is subscribed, which has no other symptom', async () => {
      await storeLine();
      metaSays({ subs: { data: [] } });
      const res = await readiness();
      expect(res.body.state).toBe('blocked');
      expect(res.body.blocked.join(' ')).toMatch(/no app is subscribed/i);
      expect(res.body.nextStep).toMatch(/cannot arrive/i);
    });

    it("is BLOCKED when the number's webhook points elsewhere", async () => {
      await storeLine();
      metaSays({
        number: {
          display_phone_number: '+234 803 000 1111',
          webhook_configuration: { application: 'https://someone-else.example/hook' },
        },
      });
      const res = await readiness();
      expect(res.body.state).toBe('blocked');
      expect(res.body.blocked.join(' ')).toContain('someone-else.example');
    });

    it('does not complain when the number carries NO override, which is normal', async () => {
      await storeLine();
      metaSays({ number: { display_phone_number: '+234 803 000 1111' } });
      const res = await readiness();
      expect(res.body.state).toBe('ready');
    });

    it('is BLOCKED without WHATSAPP_APP_SECRET, because Meta then retries forever', async () => {
      setEnv('WHATSAPP_APP_SECRET', undefined);
      await storeLine();
      metaSays();
      const res = await readiness();
      expect(res.body.state).toBe('blocked');
      expect(res.body.blocked.join(' ')).toContain('WHATSAPP_APP_SECRET');
    });

    it('calls a Meta test number DEGRADED, not ready', async () => {
      await storeLine();
      metaSays({
        number: {
          display_phone_number: '+1 555-671-9884',
          webhook_configuration: { application: WEBHOOK },
        },
      });
      const res = await readiness();
      expect(res.body.state).toBe('degraded');
      expect(res.body.degraded.join(' ')).toMatch(/cannot serve the public/i);
    });

    it('is DEGRADED, not ready, when Meta could not be asked', async () => {
      await storeLine();
      metaSays({ number: 'unreachable' });
      const res = await readiness();
      // Unknown stays unknown. Treating "could not check" as "works" is how
      // the voice report once said a call would be answered.
      expect(res.body.state).toBe('degraded');
      expect(res.body.degraded.join(' ')).toMatch(/could not reach meta/i);
    });

    it('is BLOCKED when Meta refuses the token', async () => {
      await storeLine();
      metaSays({ number: 'refused' });
      const res = await readiness();
      expect(res.body.state).toBe('blocked');
      expect(res.body.blocked.join(' ')).toContain('Error validating access token');
    });

    it('does not read a refused SUBSCRIPTION read as nothing subscribed', async () => {
      await storeLine();
      metaSays({ subs: 'refused' });
      const res = await readiness();
      // A token without whatsapp_business_management cannot read this, and
      // that is not the same as no app being subscribed.
      expect(res.body.state).toBe('degraded');
      expect(res.body.degraded.join(' ')).toMatch(/not the same as nothing being subscribed/i);
    });

    it('is BLOCKED with no line at all, and says what to do', async () => {
      const res = await readiness();
      expect(res.body.state).toBe('blocked');
      expect(res.body.nextStep).toMatch(/store a line/i);
    });

    it('returns no credential value', async () => {
      await storeLine();
      metaSays();
      const raw = JSON.stringify((await readiness()).body);
      expect(raw).not.toContain(META);
      expect(raw).not.toContain('v1.');
    });

    it('is OWNER/ADMIN only', async () => {
      await storeLine();
      metaSays();
      expect((await readiness(agentToken)).status).toBe(403);
    });
    describe('and will it ANSWER a call, not just receive a message', () => {
      /**
       * Calling is a separate capability from messaging, and this report said
       * nothing about it. An operator could switch calling on at Meta, see it
       * come back ENABLED, and have every call go unanswered because
       * WHATSAPP_CALL_ANSWER was unset or no TURN relay existed — with the
       * screen showing nothing wrong anywhere.
       */
      beforeEach(() => {
        setEnv('WHATSAPP_CALL_ANSWER', undefined);
        setEnv('TURN_PROVIDER', undefined);
        setEnv('TURN_URL', undefined);
        setEnv('TURN_USERNAME', undefined);
        setEnv('TURN_CREDENTIAL', undefined);
      });

      it('says plainly that calls are answered by message, and what voice would take', async () => {
        await storeLine();
        metaSays();
        const res = await readiness();
        // Not a fault: it is the documented default, and the citizen does get
        // a reply. So it must not read as broken.
        expect(res.body.state).toBe('ready');
        const said = res.body.ok.join(' ');
        expect(said).toMatch(/recorded and answered with a message, not in voice/i);
        expect(said).toContain('WHATSAPP_CALL_ANSWER=1');
        expect(said).toMatch(/TURN_PROVIDER=twilio|TURN_URL/);
      });

      it('is BLOCKED when answering is switched on with no relay to carry the audio', async () => {
        await storeLine();
        metaSays();
        setEnv('WHATSAPP_CALL_ANSWER', '1');
        const res = await readiness();
        // The dangerous combination: the operator believes calls are answered.
        // Answering without a relay consumes the call, has it reported
        // completed, and skips the message fallback.
        expect(res.body.state).toBe('blocked');
        expect(res.body.blocked.join(' ')).toMatch(/switched ON but cannot work/i);
        expect(res.body.blocked.join(' ')).toMatch(/No TURN relay is configured/i);
      });

      it('names the gap when TURN_PROVIDER is twilio but the account credentials are absent', async () => {
        await storeLine();
        metaSays();
        setEnv('WHATSAPP_CALL_ANSWER', '1');
        setEnv('TURN_PROVIDER', 'twilio');
        setEnv('TWILIO_ACCOUNT_SID', undefined);
        setEnv('TWILIO_AUTH_TOKEN', undefined);
        const res = await readiness();
        expect(res.body.state).toBe('blocked');
        expect(res.body.blocked.join(' ')).toMatch(/TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not both set/i);
      });

      it('reports it ready with a static relay, and still does not claim a call has worked', async () => {
        await storeLine();
        metaSays();
        setEnv('WHATSAPP_CALL_ANSWER', '1');
        setEnv('TURN_URL', 'turn:relay.example.test:3478');
        setEnv('TURN_USERNAME', 'relay-user');
        setEnv('TURN_CREDENTIAL', 'relay-secret');
        const res = await readiness();
        expect(res.body.state).toBe('ready');
        const said = res.body.ok.join(' ');
        expect(said).toMatch(/will be answered/i);
        // The honest caveat has to survive: nothing has proven this path.
        expect(said).toMatch(/No real call has proven this path yet/i);
        // And no credential value may appear in a readiness report.
        expect(JSON.stringify(res.body)).not.toContain('relay-secret');
      });
    });
  });
  /**
   * The numbers are not always on the account we hold a credential for.
   *
   * A WhatsApp Business Account is not the business. One Meta portfolio can
   * own several WABAs — a sandbox one from a quickstart and the real one added
   * later — and a number added to the second is invisible from the first. The
   * operator then sees "no numbers" on a verified business and reasonably
   * concludes the verification did not take.
   */
  describe('calling, on an agency holding more than one line', () => {
    /**
     * `updateWhatsAppConfig` takes an optional line id and acts on the row the
     * screen rendered. The calling pair did not: both took `findFirst` ordered
     * by `isActive desc, createdAt asc` and acted on whatever came back.
     *
     * On one line that is the same row either way. On two it is the OLDER one,
     * whatever the operator has on screen — so enabling calling on a newly
     * added Meta test number asked Meta about the agency's original Nigerian
     * number, and the refusal named a number the operator had not touched.
     */
    let oldLineId: string;
    let newLineId: string;
    const asked: string[] = [];

    beforeEach(async () => {
      asked.length = 0;
      await prisma.whatsAppConfig.deleteMany({ where: { organizationId: orgId } });
      const old = await prisma.whatsAppConfig.create({
        data: {
          organizationId: orgId,
          phoneNumberId: 'pn-old-nigerian',
          whatsappBusinessId: WABA,
          displayPhoneNumber: '+234 708 107 8679',
          accessToken: encryptSecret(META),
          webhookVerifyToken: encryptSecret('verify-old'),
          isActive: true,
          createdAt: new Date(Date.now() - 86400000),
        },
      });
      const fresh = await prisma.whatsAppConfig.create({
        data: {
          organizationId: orgId,
          phoneNumberId: 'pn-new-test-number',
          whatsappBusinessId: WABA,
          displayPhoneNumber: '+1 555 342 8409',
          accessToken: encryptSecret(META),
          webhookVerifyToken: encryptSecret('verify-new'),
          isActive: true,
        },
      });
      oldLineId = old.id;
      newLineId = fresh.id;

      globalThis.fetch = (async (input: any) => {
        const url = String(input);
        asked.push(url);
        return new Response(JSON.stringify({ calling: { status: 'ENABLED' } }), { status: 200 });
      }) as any;
    });

    afterEach(async () => {
      await prisma.whatsAppConfig.deleteMany({ where: { organizationId: orgId } });
    });

    it('asks Meta about the line the caller NAMED, not the oldest one', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/organizations/whatsapp-config/calling?configId=${newLineId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect(res.body.phoneNumberId).toBe('pn-new-test-number');
      expect(asked.join(' ')).toContain('pn-new-test-number');
      expect(asked.join(' ')).not.toContain('pn-old-nigerian');
    });

    it('ENABLES calling on the named line, not the oldest one', async () => {
      await request(app.getHttpServer())
        .post('/api/organizations/whatsapp-config/calling')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ enabled: true, configId: newLineId })
        .expect(201);

      expect(asked.join(' ')).toContain('pn-new-test-number');
      expect(asked.join(' ')).not.toContain('pn-old-nigerian');
    });

    it('still falls back to the first line when none is named', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/organizations/whatsapp-config/calling')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      // Unchanged behaviour for an agency holding a single line.
      expect(res.body.phoneNumberId).toBe('pn-old-nigerian');
    });

    it("refuses another agency's line id rather than silently using the default", async () => {
      const other = await prisma.organization.create({
        data: { name: 'Other', slug: `other-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
      });
      const stranger = await prisma.whatsAppConfig.create({
        data: {
          organizationId: other.id,
          phoneNumberId: 'pn-stranger',
          whatsappBusinessId: WABA,
          displayPhoneNumber: '+1 555 000 0000',
          accessToken: encryptSecret(META),
          webhookVerifyToken: encryptSecret('verify-x'),
          isActive: true,
        },
      });
      try {
        await request(app.getHttpServer())
          .get(`/api/organizations/whatsapp-config/calling?configId=${stranger.id}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(404);
        // And it must not have reached Meta about anybody.
        expect(asked.join(' ')).not.toContain('pn-stranger');
        expect(asked).toHaveLength(0);
      } finally {
        await prisma.whatsAppConfig.deleteMany({ where: { organizationId: other.id } });
        await prisma.organization.delete({ where: { id: other.id } }).catch(() => undefined);
      }
    });
  });

  describe('discovering accounts across a business portfolio', () => {
    const graph = (routes: Record<string, any>) => {
      globalThis.fetch = (async (input: any) => {
        const url = String(input);
        for (const [match, value] of Object.entries(routes)) {
          if (url.includes(match)) {
            if (value === 'refused') {
              return new Response(JSON.stringify({ error: { message: 'requires business_management' } }), { status: 403 });
            }
            return new Response(JSON.stringify(value), { status: 200 });
          }
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as any;
    };

    const numbersWith = (q: string) =>
      request(app.getHttpServer())
        .get(`/api/organizations/whatsapp-config/numbers?${q}`)
        .set('Authorization', `Bearer ${ownerToken}`);

    it('finds a number on a DIFFERENT account in the named portfolio', async () => {
      await storeLine();
      graph({
        '/me?fields=id,name': { id: '122', name: 'Employee' },
        '/61596283615722/owned_whatsapp_business_accounts': {
          data: [{ id: WABA, name: 'Sandbox' }, { id: '999', name: 'CustomerCare' }],
        },
        [`/${WABA}/phone_numbers`]: {
          data: [{ id: '1319842031202307', display_phone_number: '+1 555-671-9884', verified_name: 'Test Number' }],
        },
        '/999/phone_numbers': {
          data: [{
            id: '777', display_phone_number: '+234 803 000 1111',
            verified_name: 'Plaschema', code_verification_status: 'VERIFIED',
          }],
        },
      });

      const res = await numbersWith('businessId=61596283615722');
      expect(res.status).toBe(200);

      const other = res.body.discovered.accounts.find((a: any) => a.whatsappBusinessId === '999');
      expect(other.whatsappBusinessName).toBe('CustomerCare');
      expect(other.numbers[0].phoneNumberId).toBe('777');
      expect(other.numbers[0].codeVerificationStatus).toBe('VERIFIED');
      expect(other.numbers[0].isConnectedHere).toBe(false);
      expect(other.numbers[0].isMetaTestNumber).toBe(false);

      // And the account we DO hold is still marked, so the two are comparable.
      const ours = res.body.discovered.accounts.find((a: any) => a.whatsappBusinessId === WABA);
      expect(ours.numbers[0].isConnectedHere).toBe(true);
    });

    it('does not run the wider search unless asked', async () => {
      await storeLine();
      graph({ [`/${WABA}/phone_numbers`]: { data: [] } });
      const res = await numbersWith('');
      // Several rate-limited Graph calls for a question the common case does
      // not ask.
      expect(res.body.discovered).toBeUndefined();
    });

    it('says it could not list businesses, rather than that there are none', async () => {
      await storeLine();
      graph({
        '/me/businesses': 'refused',
        '/me?fields=id,name': { id: '122', name: 'Employee' },
        [`/${WABA}/phone_numbers`]: { data: [] },
      });
      const res = await numbersWith('discover=1');
      expect(res.body.discovered.accounts).toEqual([]);
      expect(res.body.discovered.notes.join(' ')).toMatch(/business_management/);
      expect(res.body.discovered.notes.join(' ')).toMatch(/not the same as there being none/i);
    });

    it('reports a number list it could not read as NULL, not as empty', async () => {
      await storeLine();
      graph({
        '/me?fields=id,name': { id: '122', name: 'Employee' },
        '/me/businesses': { data: [{ id: 'b1', name: 'CustomerCare' }] },
        '/b1/owned_whatsapp_business_accounts': { data: [{ id: '999', name: 'Real' }] },
        '/999/phone_numbers': 'refused',
      });
      const res = await numbersWith('discover=1');
      const acct = res.body.discovered.accounts[0];
      // An account whose numbers could not be read and an account with no
      // numbers are different answers.
      expect(acct.numbers).toBeNull();
      expect(acct.numbersError).toMatch(/business_management/);
    });

    it('asks both the owned and the shared edge', async () => {
      await storeLine();
      const seen: string[] = [];
      globalThis.fetch = (async (input: any) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as any;
      await numbersWith('businessId=61596283615722');
      expect(seen.some((u) => u.includes('owned_whatsapp_business_accounts'))).toBe(true);
      // A line can sit on either, so a failure on one must not hide the other.
      expect(seen.some((u) => u.includes('client_whatsapp_business_accounts'))).toBe(true);
    });

    it('returns no credential value', async () => {
      await storeLine();
      graph({
        '/me?fields=id,name': { id: '122', name: 'Employee' },
        '/me/businesses': { data: [{ id: 'b1' }] },
      });
      const raw = JSON.stringify((await numbersWith('discover=1')).body);
      expect(raw).not.toContain(META);
      expect(raw).not.toContain('v1.');
    });

    /**
     * The wider search was UNREACHABLE from the case it exists for.
     *
     * It is there because a number may not be on the account whose id is
     * stored on the line. The likeliest reason for that is the stored id
     * being wrong — pointing at an account the credential cannot see, which
     * is what Meta answers with "Object with ID '…' does not exist".
     *
     * And the primary listing threw on exactly that, before discovery ran. So
     * the operator asked "which accounts can this credential see?" and was
     * told instead that one account had refused — the dead end the wider
     * search was written to replace.
     *
     * Discovery does not use the stored business id at all; it walks the
     * credential's own portfolios. There was never a reason it could not
     * answer here.
     */
    it('still searches every account when the id saved on the line refuses', async () => {
      await storeLine();
      graph({
        // The saved WABA refuses — the real symptom of a wrong stored id.
        [`/${WABA}/phone_numbers`]: 'refused',
        '/me?fields=id,name': { id: '122', name: 'Employee' },
        '/me/businesses': { data: [{ id: 'b1', name: 'CustomerCare' }] },
        '/b1/owned_whatsapp_business_accounts': { data: [{ id: '999', name: 'Real' }] },
        '/999/phone_numbers': {
          data: [{ id: '777', display_phone_number: '+234 708 107 8679', verified_name: 'Plateau' }],
        },
      });

      const res = await numbersWith('discover=1');

      // Not a 400. The question was answerable.
      expect(res.status).toBe(200);

      // And the answer is there: the number is on another account.
      const found = res.body.discovered.accounts.find((a: any) => a.whatsappBusinessId === '999');
      expect(found.numbers[0].phoneNumberId).toBe('777');
      expect(found.numbers[0].displayPhoneNumber).toBe('+234 708 107 8679');
    });

    it('says the saved account refused, so an empty list is not read as an empty account', async () => {
      // `numbers: []` here means NOTHING WAS READ. Without `primaryError` the
      // screen would render "this business account holds no phone numbers",
      // which is a claim about the account that nothing established.
      await storeLine();
      graph({
        [`/${WABA}/phone_numbers`]: 'refused',
        '/me?fields=id,name': { id: '122', name: 'Employee' },
        '/me/businesses': { data: [] },
      });

      const res = await numbersWith('discover=1');
      expect(res.status).toBe(200);
      expect(res.body.numbers).toEqual([]);
      expect(res.body.primaryError).toMatch(/business_management/);
    });

    it('still refuses outright when there is nothing else to try, and names the retry', async () => {
      // With no wider search asked for, a refused listing is the whole answer
      // and must stay an error — 200 with an empty list would report an
      // account that holds nothing.
      await storeLine();
      graph({ [`/${WABA}/phone_numbers`]: 'refused' });

      const res = await numbersWith('');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/business_management/);
      // The way out, in the message, rather than left to be discovered.
      expect(res.body.message).toMatch(/discover=1/);
      expect(res.body.primaryError).toBeUndefined();
    });

    it('does not claim a primary error when the saved account answered', async () => {
      await storeLine();
      graph({
        [`/${WABA}/phone_numbers`]: { data: [{ id: '1319842031202307', display_phone_number: '+1 555-671-9884' }] },
        '/me?fields=id,name': { id: '122', name: 'Employee' },
        '/me/businesses': { data: [] },
      });

      const res = await numbersWith('discover=1');
      expect(res.status).toBe(200);
      expect(res.body.primaryError).toBeUndefined();
      expect(res.body.numbers).toHaveLength(1);
    });
  });
  /**
   * Asking Meta to deliver here, which is the step that was invisible.
   *
   * A valid token, a correct callback URL and a connected number are not
   * enough: Meta accepts a citizen's message and delivers it NOWHERE unless
   * the app is subscribed to that specific account AND to the `messages`
   * field. Neither is visible from the other, and a portfolio with several
   * accounts subscribes them one at a time — so adding the real line to a
   * second account leaves it unsubscribed while the first still works.
   */
  describe('subscribing to Meta webhooks', () => {
    const APP_ID = '1234567890';
    const APP_SECRET = 'app_secret_value';

    beforeEach(() => {
      setEnv('API_BASE_URL', 'https://api.example.test');
      setEnv('META_APP_ID', APP_ID);
      setEnv('WHATSAPP_APP_SECRET', APP_SECRET);
      setEnv('WHATSAPP_VERIFY_TOKEN', 'verify_value');
    });

    const seen: Array<{ url: string; method: string; auth: string }> = [];
    const graph = (opts: { subscribe?: any; fields?: any; after?: any } = {}) => {
      seen.length = 0;
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        seen.push({ url, method, auth: String((init?.headers ?? {}).Authorization ?? '') });
        const answer = (kind: any, happy: any) => {
          if (kind === 'refused') {
            return new Response(JSON.stringify({ error: { message: 'Object does not exist' } }), { status: 400 });
          }
          if (kind === 'unreachable') throw new Error('ECONNRESET');
          if (kind === 'lying') return new Response(JSON.stringify({ success: false }), { status: 200 });
          return new Response(JSON.stringify(kind ?? happy), { status: 200 });
        };
        if (url.includes('/subscriptions')) return answer(opts.fields, { success: true });
        if (url.includes('/subscribed_apps')) {
          if (method === 'POST') return answer(opts.subscribe, { success: true });
          return answer(opts.after, { data: [{ whatsapp_business_api_data: { id: APP_ID, name: 'Plateau Care' } }] });
        }
        return new Response('{}', { status: 200 });
      }) as any;
    };

    const subscribe = (token = ownerToken) =>
      request(app.getHttpServer())
        .post('/api/organizations/whatsapp-config/subscribe')
        .set('Authorization', `Bearer ${token}`);

    it('does both subscriptions and confirms from a READ-BACK, not from the 200s', async () => {
      await storeLine();
      graph();
      const res = await subscribe();
      expect(res.status).toBe(201);

      expect(res.body.steps).toHaveLength(2);
      expect(res.body.steps.every((s: any) => s.ok)).toBe(true);
      expect(res.body.confirmed).toBe(true);
      expect(res.body.subscribedApps).toContain('Plateau Care');

      // The account edge uses the TENANT's token; the field registration needs
      // an APP access token, which is the id and secret together.
      const post = seen.filter((c) => c.method === 'POST');
      expect(post.find((c) => c.url.includes('subscribed_apps'))!.auth).toBe(`Bearer ${META}`);
      expect(post.find((c) => c.url.includes('/subscriptions'))!.auth).toBe(`Bearer ${APP_ID}|${APP_SECRET}`);
      // And the read-back happened after.
      expect(seen.filter((c) => c.url.includes('subscribed_apps') && c.method === 'GET')).toHaveLength(1);
    });

    it('registers OUR callback url and the messages field', async () => {
      await storeLine();
      graph();
      await subscribe();
      const call = seen.find((c) => c.url.includes('/subscriptions'))!;
      expect(call.url).toContain(encodeURIComponent('https://api.example.test/api/whatsapp/webhook'));
      expect(call.url).toContain('fields=messages');
      expect(call.url).toContain('object=whatsapp_business_account');
    });

    /**
     * `calls` as well as `messages`.
     *
     * Calling can be switched on for a line while this subscription covers only
     * `messages` — and that combination is the worst of both: Meta rings the
     * business, nothing is ever delivered here, and no log records that a
     * citizen tried.
     */
    it('asks for `calls` alongside `messages`', async () => {
      await storeLine();
      graph();
      await subscribe();
      const call = seen.find((c) => c.url.includes('/subscriptions'))!;
      expect(call.url).toContain(`fields=${encodeURIComponent('messages,calls')}`);
    });

    it('keeps `messages` when Meta refuses `calls`', async () => {
      await storeLine();
      // Only the request carrying `calls` is refused: that permission is not
      // granted to every app. Asked for in ONE request, the refusal would have
      // taken the `messages` subscription with it — breaking the channel that
      // was working in order to add one that was not.
      const asked: string[] = [];
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.includes('/subscriptions')) {
          const fields = decodeURIComponent(new URL(url).searchParams.get('fields') ?? '');
          asked.push(fields);
          if (fields.includes('calls')) {
            return new Response(
              JSON.stringify({ error: { message: 'Permission calls is not granted' } }),
              { status: 400 }
            );
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        if (url.includes('/subscribed_apps')) {
          if (method === 'POST') return new Response(JSON.stringify({ success: true }), { status: 200 });
          return new Response(
            JSON.stringify({ data: [{ whatsapp_business_api_data: { id: APP_ID, name: 'Plateau Care' } }] }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      }) as any;

      const res = await subscribe();
      expect(asked).toEqual(['messages,calls', 'messages']);

      const messagesStep = res.body.steps.find((st: any) => /`messages` field$/.test(st.step));
      expect(messagesStep.ok).toBe(true);

      // The gap is reported rather than hidden, in Meta's own words.
      const callsStep = res.body.steps.find((st: any) => st.step.includes('`calls` field'));
      expect(callsStep.ok).toBe(false);
      expect(callsStep.detail).toContain('Permission calls is not granted');
      expect(callsStep.detail).toMatch(/Messaging is unaffected/);
      expect(callsStep.detail).toMatch(/ring the business and reach nobody/);
    });

    it('does NOT confirm when Meta still reports nothing subscribed', async () => {
      await storeLine();
      graph({ after: { data: [] } });
      const res = await subscribe();
      // Both requests answered 200 and the thing still is not true. This is
      // the whole reason the outcome is read back.
      expect(res.body.steps.every((s: any) => s.ok)).toBe(true);
      expect(res.body.confirmed).toBe(false);
      expect(res.body.nextStep).toMatch(/still reports no app subscribed/i);
    });

    it('treats a 200 carrying success:false as a refusal', async () => {
      await storeLine();
      graph({ subscribe: 'lying' });
      const res = await subscribe();
      expect(res.body.steps[0].ok).toBe(false);
      expect(res.body.steps[0].detail).toMatch(/success: false/i);
    });

    it('reports each step independently, so one failure does not hide the other', async () => {
      await storeLine();
      graph({ fields: 'refused' });
      const res = await subscribe();
      expect(res.body.steps[0].ok).toBe(true);
      expect(res.body.steps[1].ok).toBe(false);
      expect(res.body.steps[1].detail).toContain('Object does not exist');
    });

    it('says what is missing when META_APP_ID is unset, instead of skipping', async () => {
      setEnv('META_APP_ID', undefined);
      await storeLine();
      graph();
      const res = await subscribe();
      expect(res.body.steps[1].ok).toBe(false);
      expect(res.body.steps[1].detail).toContain('META_APP_ID');
    });

    it('does not claim UNKNOWN is unsubscribed when the read-back fails', async () => {
      await storeLine();
      graph({ after: 'unreachable' });
      const res = await subscribe();
      expect(res.body.subscribedApps).toBeNull();
      expect(res.body.confirmed).toBe(false);
      expect(res.body.nextStep).toMatch(/unknown — not confirmed/i);
    });

    it('refuses when there is no line to subscribe', async () => {
      graph();
      expect((await subscribe()).status).toBe(404);
    });

    it('returns no credential value', async () => {
      await storeLine();
      graph();
      const raw = JSON.stringify((await subscribe()).body);
      expect(raw).not.toContain(META);
      expect(raw).not.toContain(APP_SECRET);
      expect(raw).not.toContain('v1.');
    });

    it('is OWNER/ADMIN only', async () => {
      await storeLine();
      graph();
      expect((await subscribe(agentToken)).status).toBe(403);
    });
  });
  /**
   * Moving a verified number OUT OF SANDBOX, which has no button anywhere.
   *
   * Meta's documentation is explicit that a business phone number can be
   * registered for Cloud API only through the API — not WhatsApp Manager, not
   * the App Dashboard. So a number can be verified, display-name approved,
   * sitting in the account, and still unusable, with nothing in any Meta
   * screen offering to finish it. It reads as `platform_type:
   * NOT_APPLICABLE`, which looks like a property of the number rather than a
   * step nobody has taken.
   */
  describe('registering a number for Cloud API', () => {
    const NG = '1342529695620296';

    const graph = (opts: { before?: string; post?: any; after?: any } = {}) => {
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.includes('/register')) {
          if (opts.post === 'refused') {
            return new Response(
              JSON.stringify({ error: { message: 'Two-step verification PIN mismatch' } }),
              { status: 400 }
            );
          }
          if (opts.post === 'unreachable') throw new Error('ECONNRESET');
          // The PIN travels in the BODY, never the URL — a URL ends up in logs.
          expect(url).not.toContain('123456');
          expect(JSON.parse(String(init?.body))).toEqual({ messaging_product: 'whatsapp', pin: '123456' });
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        if (url.includes(NG) && method === 'GET') {
          const seq = opts.after === undefined ? 'CLOUD_API' : opts.after;
          if (seq === 'unreachable_after' && (globalThis as any).__seenBefore) throw new Error('ECONNRESET');
          (globalThis as any).__seenBefore = true;
          const platform = (globalThis as any).__afterCall
            ? seq
            : (opts.before ?? 'NOT_APPLICABLE');
          (globalThis as any).__afterCall = true;
          return new Response(
            JSON.stringify({
              display_phone_number: '+234 708 107 8679',
              verified_name: 'Plateau Customer Care',
              code_verification_status: 'VERIFIED',
              platform_type: platform === 'unreachable_after' ? 'NOT_APPLICABLE' : platform,
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      }) as any;
      (globalThis as any).__afterCall = false;
      (globalThis as any).__seenBefore = false;
    };

    const register = (body: any, token = ownerToken) =>
      request(app.getHttpServer())
        .post('/api/organizations/whatsapp-config/register-number')
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    it('registers the number and confirms from platform_type READ BACK', async () => {
      await storeLine();
      graph();
      const res = await register({ phoneNumberId: NG, pin: '123456' });
      expect(res.status).toBe(201);
      expect(res.body.accepted).toBe(true);
      expect(res.body.platformType).toBe('CLOUD_API');
      expect(res.body.registered).toBe(true);
      expect(res.body.wasAlreadyRegistered).toBe(false);
      expect(res.body.nextStep).toMatch(/CLOUD_API/);
    });

    it('does NOT report registered when Meta still says NOT_APPLICABLE', async () => {
      await storeLine();
      graph({ after: 'NOT_APPLICABLE' });
      const res = await register({ phoneNumberId: NG, pin: '123456' });
      // The request answered 200 and the number is still not on Cloud API.
      expect(res.body.accepted).toBe(true);
      expect(res.body.registered).toBe(false);
      expect(res.body.nextStep).toMatch(/still reports platform_type/i);
      // And it warns rather than inviting a retry loop into a 10-per-72h cap.
      expect(res.body.nextStep).toMatch(/10 registration attempts/i);
    });

    it('quotes Meta when the PIN is wrong', async () => {
      await storeLine();
      // A refused registration leaves the number where it was — the fixture
      // must say so, or the test asserts a contradiction.
      graph({ post: 'refused', after: 'NOT_APPLICABLE' });
      const res = await register({ phoneNumberId: NG, pin: '123456' });
      expect(res.body.accepted).toBe(false);
      expect(res.body.requestDetail).toContain('Two-step verification PIN mismatch');
      expect(res.body.registered).toBe(false);
    });

    it('refuses a malformed PIN before spending one of the ten attempts', async () => {
      await storeLine();
      let hitRegister = false;
      globalThis.fetch = (async (input: any) => {
        if (String(input).includes('/register')) hitRegister = true;
        return new Response('{}', { status: 200 });
      }) as any;
      for (const pin of ['12345', '1234567', 'abcdef', '']) {
        expect((await register({ phoneNumberId: NG, pin })).status).toBe(400);
      }
      expect(hitRegister).toBe(false);
    });

    it('says when the number was ALREADY on Cloud API', async () => {
      await storeLine();
      graph({ before: 'CLOUD_API' });
      const res = await register({ phoneNumberId: NG, pin: '123456' });
      expect(res.body.wasAlreadyRegistered).toBe(true);
      expect(res.body.nextStep).toMatch(/already on cloud api/i);
    });

    it('never returns the PIN or the token', async () => {
      await storeLine();
      graph();
      const raw = JSON.stringify((await register({ phoneNumberId: NG, pin: '123456' })).body);
      expect(raw).not.toContain('123456');
      expect(raw).not.toContain(META);
      expect(raw).not.toContain('v1.');
    });

    it('is OWNER/ADMIN only', async () => {
      await storeLine();
      graph();
      expect((await register({ phoneNumberId: NG, pin: '123456' }, agentToken)).status).toBe(403);
    });
  });
  /**
   * WhatsApp CALLING — a citizen phoning the agency from inside WhatsApp.
   *
   * The only route to a voice agent on a Nigerian number with no carrier
   * involved: no number to buy, no international leg, and no toll-free that
   * is only free in another country. Off by default on every business
   * number, and not switchable from the WhatsApp Manager screens an operator
   * would think to look at.
   */
  describe('WhatsApp calling', () => {
    const settings = (over: { post?: any; after?: any } = {}) => {
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.includes('/settings')) {
          if (method === 'POST') {
            if (over.post === 'refused') {
              return new Response(
                JSON.stringify({ error: { message: 'Calling APIs cannot be enabled for this phone number' } }),
                { status: 400 }
              );
            }
            if (over.post === 'unreachable') throw new Error('ECONNRESET');
            expect(JSON.parse(String(init?.body))).toEqual({ calling: { status: 'ENABLED' } });
            return new Response(JSON.stringify({ success: true }), { status: 200 });
          }
          if (over.after === 'unreachable') throw new Error('ECONNRESET');
          return new Response(
            JSON.stringify({ calling: { status: over.after ?? 'ENABLED' } }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      }) as any;
    };

    const setCalling = (body: any, token = ownerToken) =>
      request(app.getHttpServer())
        .post('/api/organizations/whatsapp-config/calling')
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    it('enables calling and confirms from a READ-BACK', async () => {
      await storeLine();
      settings();
      const res = await setCalling({ enabled: true });
      expect(res.status).toBe(201);
      expect(res.body.accepted).toBe(true);
      expect(res.body.callingStatus).toBe('ENABLED');
      expect(res.body.enabled).toBe(true);
      expect(res.body.nextStep).toMatch(/can now call/i);
    });

    it('does NOT report enabled when Meta still says disabled', async () => {
      await storeLine();
      settings({ after: 'DISABLED' });
      const res = await setCalling({ enabled: true });
      // The POST was accepted and the thing is still off. This is why the
      // verdict is read back rather than taken from the 200.
      expect(res.body.accepted).toBe(true);
      expect(res.body.enabled).toBe(false);
      expect(res.body.nextStep).toMatch(/messaging-limit/i);
    });

    it("quotes Meta's refusal verbatim", async () => {
      await storeLine();
      settings({ post: 'refused', after: 'DISABLED' });
      const res = await setCalling({ enabled: true });
      expect(res.body.accepted).toBe(false);
      // The exact error this deployment already hit on an unregistered number.
      expect(res.body.requestDetail).toContain('Calling APIs cannot be enabled');
    });

    it('says UNKNOWN when the setting cannot be read back', async () => {
      await storeLine();
      settings({ after: 'unreachable' });
      const res = await setCalling({ enabled: true });
      expect(res.body.callingStatus).toBeNull();
      expect(res.body.enabled).toBe(false);
      expect(res.body.nextStep).toMatch(/unknown — not confirmed/i);
    });

    it('reads the current setting without changing it', async () => {
      await storeLine();
      let posted = false;
      globalThis.fetch = (async (input: any, init?: any) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') posted = true;
        return new Response(JSON.stringify({ calling: { status: 'DISABLED' } }), { status: 200 });
      }) as any;
      const res = await request(app.getHttpServer())
        .get('/api/organizations/whatsapp-config/calling')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.callingStatus).toBe('DISABLED');
      expect(posted).toBe(false);
    });

    it('does not read "could not ask" as "calling is off"', async () => {
      await storeLine();
      globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as any;
      const res = await request(app.getHttpServer())
        .get('/api/organizations/whatsapp-config/calling')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.callingStatus).toBeNull();
      expect(res.body.error).toMatch(/could not reach meta/i);
    });

    it('returns no credential value', async () => {
      await storeLine();
      settings();
      expect(JSON.stringify((await setCalling({ enabled: true })).body)).not.toContain(META);
    });

    it('is OWNER/ADMIN only', async () => {
      await storeLine();
      settings();
      expect((await setCalling({ enabled: true }, agentToken)).status).toBe(403);
    });
  });
});
