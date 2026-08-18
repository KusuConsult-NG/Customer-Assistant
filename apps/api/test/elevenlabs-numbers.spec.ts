/**
 * Attaching a tenant's phone number and WhatsApp line to their agent.
 *
 * Two things are being protected here, and they are different in kind.
 *
 * The first is the CUTOVER. Importing a Twilio number gives ElevenLabs the
 * credentials to answer it, so from that moment the agent picks up instead of
 * the orchestrator. That is a change in who talks to customers, and it must not
 * be reachable by clicking a setup button without saying so.
 *
 * The second is TENANCY. A workspace shared behind ELEVENLABS_API_KEY holds
 * every tenant's numbers and WhatsApp lines. An unfiltered listing is one
 * tenant reading another's; an unchecked attach is one tenant's agent
 * answering another tenant's customers, with nothing in either system looking
 * wrong afterwards.
 */

import { Test } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { ElevenLabsNumbersService } from '../src/agent-tools/elevenlabs-numbers.service';
import { ElevenLabsApi } from '../src/agent-tools/elevenlabs-client';
import { encryptSecret } from '@ace/database';

interface Captured {
  url: string;
  method: string;
  body: any;
}

describe('ElevenLabs numbers and WhatsApp', () => {
  let service: ElevenLabsNumbersService;
  let orgId: string;
  let sent: Captured[];

  const realFetch = global.fetch;
  const realElevenBase = process.env.ELEVENLABS_BASE_URL;
  const realElevenKey = process.env.ELEVENLABS_API_KEY;

  const OUR_AGENT = 'agent_ours';
  const THEIR_AGENT = 'agent_theirs';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ElevenLabsNumbersService, ElevenLabsApi],
    }).compile();
    service = moduleRef.get(ElevenLabsNumbersService);

    const org = await prisma.organization.create({
      data: {
        name: 'Numbers Test Ltd',
        slug: `numbers-${randomBytes(4).toString('hex')}`,
        industry: 'OTHER',
      },
    });
    orgId = org.id;

    // Credentials are encrypted at rest, so these suites need a key to store
    // one with. Fixed rather than random: a failure should be reproducible.
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
    process.env.ELEVENLABS_BASE_URL = 'https://elevenlabs.test';
    process.env.ELEVENLABS_API_KEY = 'xi-test-key';
  }, 60_000);

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    global.fetch = realFetch;
    if (realElevenBase === undefined) delete process.env.ELEVENLABS_BASE_URL;
    else process.env.ELEVENLABS_BASE_URL = realElevenBase;
    if (realElevenKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = realElevenKey;
  });

  beforeEach(async () => {
    sent = [];
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.telephonyConfig.deleteMany({ where: { organizationId: orgId } });
  });

  const provisioned = (extra: Record<string, unknown> = {}) =>
    prisma.hostedAgentConfig.create({
      data: { organizationId: orgId, agentId: OUR_AGENT, ...extra },
    });

  const twilio = (extra: Record<string, unknown> = {}) =>
    prisma.telephonyConfig.create({
      data: {
        organizationId: orgId,
        provider: 'TWILIO',
        phoneNumber: '+2348000000001',
        accountSid: 'AC_test',
        // Encrypted at rest, as the application stores it.
        authToken: encryptSecret('tok_test'),
        ...extra,
      },
    });

  const whatsappAccount = (over: Record<string, unknown> = {}) => ({
    business_account_id: 'ba_1',
    phone_number_id: 'wa_1',
    business_account_name: 'Numbers Test Ltd',
    phone_number_name: 'Main line',
    phone_number: '+2348000000001',
    enable_messaging: true,
    ...over,
  });

  const stubWorkspace = (
    overrides: (req: Captured) => { status: number; body: any } | undefined = () => undefined
  ) => {
    global.fetch = (async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(init.body) : undefined;
      const req: Captured = { url, method, body };
      sent.push(req);

      const override = overrides(req);
      if (override) return new Response(JSON.stringify(override.body), { status: override.status });

      const path = new URL(url).pathname;
      const reply = (status: number, payload: any) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (path === '/v1/convai/phone-numbers' && method === 'POST') {
        return reply(200, { phone_number_id: 'phnum_new' });
      }
      if (path === '/v1/convai/phone-numbers' && method === 'GET') {
        return reply(200, [
          twilioNumber('phnum_ours', '+2348000000001', OUR_AGENT),
          twilioNumber('phnum_theirs', '+2348000000002', THEIR_AGENT),
        ]);
      }
      if (path.startsWith('/v1/convai/phone-numbers/') && method === 'PATCH') {
        return reply(200, twilioNumber(path.split('/').pop()!, '+2348000000001', OUR_AGENT));
      }
      if (path.startsWith('/v1/convai/phone-numbers/') && method === 'GET') {
        return reply(200, twilioNumber(path.split('/').pop()!, '+2348000000001', OUR_AGENT));
      }
      if (path.startsWith('/v1/convai/phone-numbers/') && method === 'DELETE') {
        return reply(200, {});
      }
      if (path === '/v1/convai/whatsapp-accounts' && method === 'GET') {
        return reply(200, {
          items: [
            whatsappAccount({ phone_number_id: 'wa_ours', assigned_agent_id: OUR_AGENT }),
            whatsappAccount({ phone_number_id: 'wa_theirs', assigned_agent_id: THEIR_AGENT }),
            whatsappAccount({ phone_number_id: 'wa_free' }),
          ],
        });
      }
      if (path.startsWith('/v1/convai/whatsapp-accounts/') && method === 'GET') {
        return reply(200, whatsappAccount({ phone_number_id: path.split('/').pop()! }));
      }
      if (path.startsWith('/v1/convai/whatsapp-accounts/') && method === 'PATCH') {
        return reply(200, {});
      }
      return reply(404, { detail: `stub has no route for ${method} ${path}` });
    }) as any;
  };

  const twilioNumber = (id: string, number: string, agentId: string | null) => ({
    provider: 'twilio',
    phone_number_id: id,
    phone_number: number,
    label: 'label',
    ...(agentId ? { assigned_agent: { agent_id: agentId, agent_name: 'agent' } } : {}),
  });

  // ── The cutover ────────────────────────────────────────────────────────────

  describe('importing a Twilio number', () => {
    it('refuses without an explicit cutover confirmation, and contacts nobody', async () => {
      await provisioned();
      await twilio();
      stubWorkspace();

      await expect(
        service.importTwilioNumber(orgId, { confirmVoiceCutover: false })
      ).rejects.toThrow(/confirm the cutover/i);
      expect(sent).toHaveLength(0);
    });

    it('refuses before an agent has been provisioned', async () => {
      await twilio();
      stubWorkspace();

      // A number pointed at no agent rings and answers with nothing.
      await expect(
        service.importTwilioNumber(orgId, { confirmVoiceCutover: true })
      ).rejects.toThrow(/no provisioned agent/i);
      expect(sent).toHaveLength(0);
    });

    it('names the Twilio fields that are missing', async () => {
      await provisioned();
      await twilio({ accountSid: null, authToken: null });
      stubWorkspace();

      await expect(
        service.importTwilioNumber(orgId, { confirmVoiceCutover: true })
      ).rejects.toThrow(/account SID and auth token/i);
      expect(sent).toHaveLength(0);
    });

    it('sends the tenant credentials and assigns the agent', async () => {
      await provisioned();
      await twilio();
      stubWorkspace();

      const result = await service.importTwilioNumber(orgId, { confirmVoiceCutover: true });

      const post = sent.find((r) => r.method === 'POST');
      expect(post!.body.provider).toBe('twilio');
      expect(post!.body.phone_number).toBe('+2348000000001');
      expect(post!.body.sid).toBe('AC_test');
      // Decrypted on the way out. A ciphertext here would be rejected by
      // ElevenLabs as a bad Twilio token, pointing the operator at the wrong
      // system entirely.
      expect(post!.body.token).toBe('tok_test');
      expect(post!.body.token).not.toMatch(/^v1\./);
      expect(post!.body.agent_id).toBe(OUR_AGENT);
      expect(result.phoneNumberId).toBe('phnum_new');

      const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: orgId } });
      expect(config?.phoneNumberId).toBe('phnum_new');
    });

    it('leaves inbound SMS alone unless asked', async () => {
      await provisioned();
      await twilio();
      stubWorkspace();

      await service.importTwilioNumber(orgId, { confirmVoiceCutover: true });
      // Defaults to true upstream. This platform consumes no inbound SMS, so
      // taking the route would change a tenant's Twilio config for nothing.
      expect(sent.find((r) => r.method === 'POST')!.body.enable_sms).toBe(false);

      sent = [];
      await prisma.hostedAgentConfig.update({
        where: { organizationId: orgId },
        data: { phoneNumberId: null },
      });
      await service.importTwilioNumber(orgId, { confirmVoiceCutover: true, enableSms: true });
      expect(sent.find((r) => r.method === 'POST')!.body.enable_sms).toBe(true);
    });

    it('re-points a number it already imported instead of importing it twice', async () => {
      await provisioned({ phoneNumberId: 'phnum_existing' });
      await twilio();
      stubWorkspace();

      const result = await service.importTwilioNumber(orgId, { confirmVoiceCutover: true });

      // Two ElevenLabs records for one Twilio number is a coin flip over which
      // configuration wins.
      expect(sent.filter((r) => r.method === 'POST')).toHaveLength(0);
      expect(sent.some((r) => r.method === 'PATCH' && r.url.endsWith('/phnum_existing'))).toBe(true);
      expect(result.phoneNumberId).toBe('phnum_existing');
    });

    it('re-imports when the number was deleted from the workspace', async () => {
      await provisioned({ phoneNumberId: 'phnum_gone' });
      await twilio();
      stubWorkspace((req) =>
        req.method === 'PATCH' && req.url.endsWith('/phnum_gone')
          ? { status: 404, body: { detail: 'gone' } }
          : undefined
      );

      const result = await service.importTwilioNumber(orgId, { confirmVoiceCutover: true });
      expect(result.phoneNumberId).toBe('phnum_new');
    });
  });

  describe('releasing a number', () => {
    it('clears the record and says what is left to do in Twilio', async () => {
      await provisioned({ phoneNumberId: 'phnum_ours' });
      stubWorkspace();

      const result = await service.releaseNumber(orgId);

      expect(sent.some((r) => r.method === 'DELETE')).toBe(true);
      expect(result.note).toMatch(/twilio/i);
      const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: orgId } });
      expect(config?.phoneNumberId).toBeNull();
    });

    it('still clears the record when the number is already gone upstream', async () => {
      await provisioned({ phoneNumberId: 'phnum_ours' });
      stubWorkspace((req) =>
        req.method === 'DELETE' ? { status: 404, body: { detail: 'gone' } } : undefined
      );

      await expect(service.releaseNumber(orgId)).resolves.toMatchObject({ released: true });
      const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: orgId } });
      expect(config?.phoneNumberId).toBeNull();
    });
  });

  // ── Tenancy ────────────────────────────────────────────────────────────────

  describe('a workspace shared between tenants', () => {
    it('lists only numbers assigned to this tenant', async () => {
      await provisioned();
      stubWorkspace();

      const numbers = await service.listNumbers(orgId);
      expect(numbers.map((n) => n.phoneNumberId)).toEqual(['phnum_ours']);
    });

    it('hides WhatsApp lines belonging to another agent, but shows unclaimed ones', async () => {
      await provisioned();
      stubWorkspace();

      const accounts = await service.listWhatsAppAccounts(orgId);
      expect(accounts.map((a) => a.phoneNumberId).sort()).toEqual(['wa_free', 'wa_ours']);
    });

    it("refuses to take a WhatsApp line that is already another agent's", async () => {
      await provisioned();
      stubWorkspace((req) =>
        req.method === 'GET' && req.url.includes('/whatsapp-accounts/')
          ? {
              status: 200,
              body: whatsappAccount({ phone_number_id: 'wa_theirs', assigned_agent_id: THEIR_AGENT }),
            }
          : undefined
      );

      // Taking it would redirect another tenant's conversations onto this
      // agent, with nothing in either system looking wrong afterwards.
      await expect(service.attachWhatsAppAccount(orgId, 'wa_theirs')).rejects.toThrow(
        /already assigned to agent/i
      );
      expect(sent.some((r) => r.method === 'PATCH')).toBe(false);
    });
  });

  // ── WhatsApp attachment ────────────────────────────────────────────────────

  describe('attaching a WhatsApp line', () => {
    it('assigns the agent and records the id the outbound service needs', async () => {
      await provisioned();
      stubWorkspace();

      const result = await service.attachWhatsAppAccount(orgId, 'wa_free');

      const patch = sent.find((r) => r.method === 'PATCH');
      expect(patch!.body.assigned_agent_id).toBe(OUR_AGENT);
      expect(result.isOurs).toBe(true);

      const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: orgId } });
      expect(config?.whatsappPhoneNumberId).toBe('wa_free');
    });

    it('refuses a line whose Meta token has expired', async () => {
      await provisioned();
      stubWorkspace((req) =>
        req.method === 'GET' && req.url.includes('/whatsapp-accounts/')
          ? { status: 200, body: whatsappAccount({ is_token_expired: true }) }
          : undefined
      );

      // Assigning it would report success and then answer nothing.
      await expect(service.attachWhatsAppAccount(orgId, 'wa_1')).rejects.toThrow(/expired/i);
      expect(sent.some((r) => r.method === 'PATCH')).toBe(false);
    });

    it('explains that connecting a line is a dashboard step, not an API one', async () => {
      await provisioned();
      stubWorkspace((req) =>
        req.method === 'GET' && req.url.includes('/whatsapp-accounts/')
          ? { status: 404, body: { detail: 'no such account' } }
          : undefined
      );

      // There is no create endpoint: Meta's embedded signup needs a human.
      // Saying so beats a bare 404.
      await expect(service.attachWhatsAppAccount(orgId, 'wa_missing')).rejects.toThrow(
        /dashboard first/i
      );
    });

    it('detaching stops messaging and clears the record', async () => {
      await provisioned({ whatsappPhoneNumberId: 'wa_ours' });
      stubWorkspace();

      await service.detachWhatsAppAccount(orgId);

      expect(sent.find((r) => r.method === 'PATCH')!.body.enable_messaging).toBe(false);
      const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: orgId } });
      expect(config?.whatsappPhoneNumberId).toBeNull();
    });
  });
});
