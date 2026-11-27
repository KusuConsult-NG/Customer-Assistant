/**
 * The returning-caller headers on a REAL Asterisk running the REAL bridge
 * dialplan (infra/sip-bridge). Skipped unless SIP_BRIDGE_E2E=1: it needs an
 * Asterisk reachable through `ASTERISK_RX` whose dialplan was rendered with
 * BRIDGE_API_URL=http://127.0.0.1:4556, SIP_BRIDGE_SECRET as below,
 * TOLLFREE_E164=+2348000009456, ELEVENLABS_SIP_HOST=<FAKE_SIP_HOST>, and a
 * `[test-entry]` context that sets the caller id from the extension and goes
 * to bridge,s,1. "ElevenLabs" is a TCP listener that records the INVITE.
 *
 * What it proves: the dialplan asks the platform, and the INVITE that reaches
 * ElevenLabs carries X-Welcome / X-Callerstatus / … — and when the platform
 * does not answer, the call still goes through, with no headers.
 */
import { execSync } from 'child_process';
import * as net from 'net';
import { INestApplication } from '@nestjs/common';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, type TestTenant } from './support/tenant';

const run = process.env.SIP_BRIDGE_E2E === '1' ? describe : describe.skip;
const RX = process.env.ASTERISK_RX || 'asterisk -rx';
const SECRET = 'sip-bridge-e2e-secret-0123456789';
const LINE = '+2348000009456';
const rx = (cmd: string) => execSync(`${RX} ${JSON.stringify(cmd)}`, { encoding: 'utf8' });

run('returning-caller headers through a real Asterisk', () => {
  let app: INestApplication;
  let tenant: TestTenant;
  let sip: net.Server;
  let invites: string[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.SIP_BRIDGE_SECRET = SECRET;
    app = await createTestApp();
    tenant = await createTenant(app, 'bridge-e2e');
    await prisma.telephonyConfig.deleteMany({ where: { phoneNumber: LINE } });
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
    await app.listen(4556, '127.0.0.1');
    // "ElevenLabs": records each INVITE's headers and never answers.
    sip = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        const end = buf.indexOf('\r\n\r\n');
        if (end >= 0 && buf.startsWith('INVITE')) {
          invites.push(buf.slice(0, end));
          buf = '';
        }
      });
      sock.on('error', () => undefined);
    });
    await new Promise<void>((r) => sip.listen(5060, process.env.FAKE_SIP_HOST || '172.17.0.1', r));
  }, 60_000);

  afterAll(async () => {
    sip?.close();
    await prisma.telephonyConfig.deleteMany({ where: { phoneNumber: LINE } }).catch(() => undefined);
    await dropTenant(tenant?.orgId);
    await app?.close();
    process.env = saved;
  });

  beforeEach(() => {
    invites = [];
  });

  const call = async (from: string) => {
    rx(`channel originate Local/${from}@test-entry application Wait 6`);
    const until = Date.now() + 15_000;
    while (!invites.length && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    expect(invites.length).toBeGreaterThan(0);
    rx('channel request hangup all');
    return invites[0];
  };
  const header = (invite: string, name: string) =>
    invite.split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();

  it('a profiled caller reaches ElevenLabs already welcomed back by name', async () => {
    const invite = await call('08031234001');
    expect(header(invite, 'X-Callerstatus')).toBe('returning');
    expect(header(invite, 'X-Callername')).toBe('Amina Dachung');
    expect(header(invite, 'X-Welcome')).toBe('Welcome back, Amina Dachung. Are you still calling from Angwan Rogo, Naraguta B ward, Jos North?');
    expect(header(invite, 'X-Callerprofile')).toContain('Jos North');
  }, 30_000);

  it('a caller nobody knows gets the default question', async () => {
    const invite = await call('08039999999');
    expect(header(invite, 'X-Callerstatus')).toBe('new');
    expect(header(invite, 'X-Welcome')).toBe('How may I help you today?');
  }, 30_000);

  it('when the platform does not answer, the call still goes to the agent, with no headers', async () => {
    process.env.SIP_BRIDGE_SECRET = 'a-different-secret-entirely-0123456';
    try {
      const invite = await call('08031234001');
      expect(header(invite, 'X-Welcome')).toBeUndefined();
      expect(invite).not.toContain('Amina');
    } finally {
      process.env.SIP_BRIDGE_SECRET = SECRET;
    }
  }, 30_000);
});
