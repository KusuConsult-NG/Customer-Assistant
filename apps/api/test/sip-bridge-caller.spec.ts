/**
 * A returning caller is welcomed back by name BEFORE the model says a word.
 *
 * On the live line, recognition depended on the model choosing to call
 * lookup-customer on its first turn, and on 13 of 15 calls it did not: a
 * caller profiled on an earlier call, who had rung 27 times, was greeted as a
 * stranger. Now the SIP bridge asks /api/sip-bridge/caller as the call
 * arrives and forwards the answer as X- SIP headers, which ElevenLabs exposes
 * as {{sip_…}} variables in the first message and the prompt.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, type TestTenant } from './support/tenant';
import { BRIDGE_FIELDS, headerSafe } from '../src/agent-tools/sip-bridge.controller';
import { CALLER_VARIABLE_DEFAULTS, WELCOME_DEFAULT } from '../src/agent-tools/caller-profile';
import { agentDefinitionFor, dynamicVariablesFor, firstMessageFor } from '../src/agent-tools/agent-tool-catalog';

const SECRET = 'sip-bridge-test-secret-0123456789';
const LINE = `+23480${String(Date.now()).slice(-8)}`;
const saved = { ...process.env };
let app: INestApplication;
let tenant: TestTenant;

const ask = (from: string, to = LINE, secret = SECRET) =>
  request(app.getHttpServer()).post('/api/sip-bridge/caller').type('form').send({ secret, from, to });

/** The dialplan's reading of the answer: `ok|status|name|profile|missing|welcome`. */
const fields = (text: string) => {
  const [head, ...rest] = text.split('|');
  return { head, ...Object.fromEntries(BRIDGE_FIELDS.map((f, i) => [f, rest[i]])) } as Record<string, string>;
};

beforeAll(async () => {
  process.env.SIP_BRIDGE_SECRET = SECRET;
  delete process.env.SIP_BRIDGE_ORGANIZATION_SLUG;
  app = await createTestApp();
  tenant = await createTenant(app, 'sip-bridge');
  await prisma.organization.update({
    where: { id: tenant.orgId },
    data: {
      name: 'Plateau State Government Citizen Contact Centre (test)',
      timezone: 'Africa/Lagos',
      welcomeMessage:
        '<governor>{greeting}, and welcome to the Plateau State Government Citizen Contact Centre. Our virtual assistant, {name}, will help you now.</governor> <break time="1.0s" /> I\'m {name}, the virtual assistant. May I have your full name?',
    },
  });
  // The toll-free line, as production holds it: a SIP-trunk TelephonyConfig.
  await prisma.telephonyConfig.create({ data: { organizationId: tenant.orgId, provider: 'SIP_TRUNK', phoneNumber: LINE } });
  await prisma.contact.create({
    data: {
      organizationId: tenant.orgId,
      phoneNumber: '+2348031234001',
      fullName: 'Amina Dachung',
      city: 'Jos North',
      metadata: { ward: 'Naraguta B', community: 'Angwan Rogo', phoneConfirmedForFollowUp: true },
    },
  });
  await prisma.contact.create({
    data: { organizationId: tenant.orgId, phoneNumber: '+2348031234002', fullName: 'Gyang Bot', city: 'Jos South', metadata: {} },
  });
}, 60_000);

afterAll(async () => {
  await dropTenant(tenant?.orgId);
  await app?.close();
  process.env = saved;
});

describe('the bridge asks who is calling before the agent answers', () => {
  it('welcomes a profiled caller back by name and asks only to confirm the location', async () => {
    // The number arrives in the shape the carrier sends it (local form), not as stored.
    const res = await ask('08031234001');
    expect(res.status).toBe(200);
    const f = fields(res.text);
    expect(f.head).toBe('ok');
    expect(f.sip_callerstatus).toBe('returning');
    expect(f.sip_callername).toBe('Amina Dachung');
    expect(f.sip_callerprofile).toContain('Jos North');
    expect(f.sip_callermissing).toBe('none');
    expect(f.sip_welcome).toBe('Welcome back, Amina Dachung. Are you still calling from Angwan Rogo, Naraguta B ward, Jos North?');
  });

  it('greets a partly profiled caller by name and asks only for what is missing', async () => {
    const f = fields((await ask('+2348031234002')).text);
    expect(f.sip_callerstatus).toBe('partial');
    expect(f.sip_welcome).toMatch(/^Welcome back, Gyang Bot\. Could you tell me your ward and community\?$/);
  });

  it('a caller nobody knows hears the default question, and nothing about anyone else', async () => {
    const f = fields((await ask('+2348099999999')).text);
    expect(f.head).toBe('ok');
    expect(f.sip_callerstatus).toBe('new');
    expect(f.sip_callername).toBe('not on file');
    expect(f.sip_welcome).toBe(WELCOME_DEFAULT);
  });

  it('a withheld number, or our own line on a forwarded call, is never welcomed back as somebody', async () => {
    for (const from of ['anonymous', '', LINE]) {
      const f = fields((await ask(from)).text);
      expect(f.sip_callerstatus).toBe('withheld');
      expect(f.sip_welcome).toBe(WELCOME_DEFAULT);
    }
  });

  it('a wrong secret gets no answer the dialplan would use', async () => {
    const res = await ask('08031234001', LINE, 'wrong-secret');
    expect(res.status).toBe(403);
    expect(res.text.startsWith('ok|')).toBe(false);
    expect(res.text).not.toContain('Amina');
  });

  it('a dialled number no agency owns answers the defaults, never another agency’s caller', async () => {
    const f = fields((await ask('08031234001', '+2348000000001')).text);
    expect(f.head).toBe('unknown');
    expect(f.sip_welcome).toBe(WELCOME_DEFAULT);
    expect(f.sip_callername).toBe('not on file');
  });
});

describe('what the agent is configured with', () => {
  const org = {
    name: 'Plateau State Government Citizen Contact Centre',
    slug: 'plateau-contact',
    timezone: 'Africa/Lagos',
    welcomeMessage:
      '<governor>{greeting}, and welcome. Our virtual assistant, {name}, will help you now.</governor> <break time="1.0s" /> I\'m {name}, the virtual assistant. May I have your full name?',
    aiPersonaPrompt: null,
  };

  it('the stored first message ends with the bridge’s welcome line', () => {
    expect(firstMessageFor(org)).toMatch(/the virtual assistant\. \{\{sip_welcome\}\}$/);
  });

  it('every variable in the first message and prompt has a default, so a call without headers still starts', () => {
    const def: any = agentDefinitionFor(org as any, ['tool_1']);
    const text = JSON.stringify(def);
    const used = new Set([...text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)].map((m) => m[1]).filter((v) => !v.startsWith('system__')));
    const defaults = dynamicVariablesFor(org as any);
    const missing = [...used].filter((v) => !(v in defaults));
    expect(missing).toEqual([]);
    for (const k of Object.keys(CALLER_VARIABLE_DEFAULTS)) expect(used.has(k)).toBe(true);
    expect(defaults.sip_welcome).toBe(WELCOME_DEFAULT);
  });

  it('header values cannot break the dialplan’s split or the SIP header', () => {
    expect(headerSafe('Amina | Dachung\r\nX-Injected: 1')).toBe('Amina Dachung X-Injected: 1');
    expect(headerSafe('x'.repeat(500)).length).toBe(300);
  });
});
