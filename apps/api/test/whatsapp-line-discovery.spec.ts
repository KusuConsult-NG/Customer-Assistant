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
      setEnv('WHATSAPP_VERIFY_TOKEN', undefined);
      const row = await storeLine({ verify: 'retired_line_value' });
      await prisma.whatsAppConfig.update({ where: { id: row.id }, data: { isActive: false } });
      expect((await handshake('retired_line_value')).status).toBe(403);
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
});
