/**
 * Configuring the agency's voice line.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Two features pointed at settings fields that no form and no endpoint could
 * write, which is the same defect in both cases: a system telling an operator
 * to do something it gives them no way to do.
 *
 *  - `POST /api/agent-provisioning/numbers/import-sip` reads `sipAddress` and
 *    the digest pair off `TelephonyConfig`. Nothing wrote them, so the import
 *    could only ever answer "No SIP trunk is configured for this
 *    organization" — a cutover button that could not fire.
 *  - Both voice handoff paths refuse with "Set one under Settings → Telephony
 *    and try again". `forwardingNumber` was not writable either, so the fix
 *    named in the refusal did not exist.
 *
 * ── And one quieter one ─────────────────────────────────────────────────────
 *
 * There is ONE TelephonyConfig row per organization, so saving a new provider
 * replaces the old arrangement. Prisma ignores `undefined`, so switching
 * Twilio → SIP left `accountSid`/`authToken` on the row: live credentials for
 * an arrangement that no longer exists, in columns that other code reads to
 * decide what a tenant can do. They are cleared now, and this spec is what
 * keeps them cleared.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { prisma, withTelephonyCredentials } from '@ace/database';
import { AppModule } from '../src/app.module';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Telephony settings', () => {
  let app: INestApplication;
  let agency: TestTenant;
  let member: TestTenant;

  jest.setTimeout(90000);

  const save = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/organizations/telephony-config')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const stored = () =>
    prisma.telephonyConfig.findFirstOrThrow({ where: { organizationId: agency.orgId } });

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    agency = await createTenant(app, 'tel-settings', { role: 'OWNER' });
    member = await createTenant(app, 'tel-settings-viewer', { role: 'VIEWER' });
  });

  afterAll(async () => {
    await dropTenant(agency?.orgId);
    await dropTenant(member?.orgId);
    await app?.close();
  });

  describe('a SIP trunk', () => {
    it('saves the trunk the import endpoint then reads', async () => {
      const res = await save(agency.token, {
        provider: 'SIP_TRUNK',
        phoneNumber: '+2348012345670',
        sipAddress: 'sip.carrier.ng',
        sipTransport: 'tls',
        sipUsername: 'ministry',
        sipPassword: 'trunk-secret-value',
      });

      expect(res.status).toBe(201);

      const row = await stored();
      expect(row.provider).toBe('SIP_TRUNK');
      expect(row.sipAddress).toBe('sip.carrier.ng');
      expect(row.sipTransport).toBe('tls');
      expect(row.sipUsername).toBe('ministry');

      // The import reads it back through withTelephonyCredentials, so what
      // matters is that THAT returns the password, not that the column does.
      expect(row.sipPassword).not.toBe('trunk-secret-value');
      expect(row.sipPassword).toMatch(/^v1\./);
      expect(withTelephonyCredentials(row).sipPassword).toBe('trunk-secret-value');
    });

    it('never returns the password it was just given', async () => {
      const res = await save(agency.token, {
        provider: 'SIP_TRUNK',
        phoneNumber: '+2348012345670',
        sipAddress: 'sip.carrier.ng',
        sipUsername: 'ministry',
        sipPassword: 'another-trunk-secret',
      });

      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain('another-trunk-secret');
      // Masked from the DECRYPTED value, so the suffix matches what the
      // operator can compare against their carrier's portal.
      expect(res.body.sipPassword).toBe('••••cret');
      // Identifiers stay readable: they name the trunk, they do not open it.
      expect(res.body.sipAddress).toBe('sip.carrier.ng');
      expect(res.body.sipUsername).toBe('ministry');
    });

    it('keeps a stored password when the form re-saves without one', async () => {
      // The form shows a saved password masked, so it posts nothing for it.
      // Changing the transport must not wipe the credential, and must not be
      // rejected as a username with no password.
      const res = await save(agency.token, {
        provider: 'SIP_TRUNK',
        phoneNumber: '+2348012345670',
        sipAddress: 'sip.carrier.ng',
        sipTransport: 'udp',
        sipUsername: 'ministry',
      });

      expect(res.status).toBe(201);
      const row = await stored();
      expect(row.sipTransport).toBe('udp');
      expect(withTelephonyCredentials(row).sipPassword).toBe('another-trunk-secret');
    });

    it('clears the password when the username goes, rather than keeping half a credential', async () => {
      const res = await save(agency.token, {
        provider: 'SIP_TRUNK',
        phoneNumber: '+2348012345670',
        sipAddress: 'sip.carrier.ng',
      });

      expect(res.status).toBe(201);
      const row = await stored();
      expect(row.sipUsername).toBeNull();
      expect(row.sipPassword).toBeNull();
    });

    it('refuses a trunk with no host address, naming what to copy', async () => {
      const res = await save(agency.token, {
        provider: 'SIP_TRUNK',
        phoneNumber: '+2348012345670',
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/host address/i);
      // "invalid SIP configuration" sends an operator back to their carrier's
      // portal without saying what to look for.
      expect(res.body.message).toMatch(/sip\.carrier/i);
    });

    it('refuses a transport ElevenLabs does not accept', async () => {
      const res = await save(agency.token, {
        provider: 'SIP_TRUNK',
        phoneNumber: '+2348012345670',
        sipAddress: 'sip.carrier.ng',
        sipTransport: 'sctp',
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/auto, udp, tcp, tls/);
    });

    it('refuses half a digest credential', async () => {
      // Half a pair is not partial authentication, it is none — and the import
      // drops it silently, leaving a trunk that is quietly ACL-only.
      const res = await save(agency.token, {
        provider: 'SIP_TRUNK',
        phoneNumber: '+2348012345670',
        sipAddress: 'sip.carrier.ng',
        sipPassword: 'orphan-password',
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/BOTH a username and a password/);
    });
  });

  describe('switching providers', () => {
    it('clears the previous provider\'s credentials', async () => {
      await save(agency.token, {
        provider: 'TWILIO',
        phoneNumber: '+2348012345670',
        accountSid: 'AC_switch_test',
        authToken: 'twilio-token-value',
      });

      let row = await stored();
      expect(row.accountSid).toBe('AC_switch_test');
      expect(withTelephonyCredentials(row).authToken).toBe('twilio-token-value');

      await save(agency.token, {
        provider: 'SIP_TRUNK',
        phoneNumber: '+2348012345670',
        sipAddress: 'sip.carrier.ng',
      });

      row = await stored();
      // Prisma ignores `undefined`, so these used to survive the switch:
      // credentials for an arrangement the agency no longer has, which
      // `ElevenLabsTakeoverService` reads to decide whether a call can be
      // moved.
      expect(row.accountSid).toBeNull();
      expect(row.authToken).toBeNull();
    });

    it('clears the trunk when switching back to a carrier', async () => {
      await save(agency.token, {
        provider: 'TWILIO',
        phoneNumber: '+2348012345670',
        accountSid: 'AC_back_again',
        authToken: 'twilio-token-again',
      });

      const row = await stored();
      expect(row.sipAddress).toBeNull();
      expect(row.sipTransport).toBeNull();
      expect(row.sipUsername).toBeNull();
      expect(row.sipPassword).toBeNull();
    });
  });

  describe('the forwarding number', () => {
    it('can be set, because both handoff paths tell operators to set it', async () => {
      const res = await save(agency.token, {
        provider: 'TWILIO',
        phoneNumber: '+2348012345670',
        accountSid: 'AC_fwd',
        authToken: 'twilio-token-fwd',
        forwardingNumber: ' +2348090000001 ',
      });

      expect(res.status).toBe(201);
      expect((await stored()).forwardingNumber).toBe('+2348090000001');
    });

    it('is left alone by a save that does not mention it', async () => {
      await save(agency.token, {
        provider: 'TWILIO',
        phoneNumber: '+2348012345670',
        accountSid: 'AC_fwd2',
        authToken: 'twilio-token-fwd2',
      });

      expect((await stored()).forwardingNumber).toBe('+2348090000001');
    });

    it('can be cleared deliberately', async () => {
      await save(agency.token, {
        provider: 'TWILIO',
        phoneNumber: '+2348012345670',
        accountSid: 'AC_fwd3',
        authToken: 'twilio-token-fwd3',
        forwardingNumber: '',
      });

      expect((await stored()).forwardingNumber).toBeNull();
    });
  });

  describe('the provider itself', () => {
    it('rejects a value that is not a provider, naming the ones that are', async () => {
      // The dashboard's own list carried AFRICA_TALKING and NIGERIAN_CARRIER,
      // neither of which is an enum member. Both reached Prisma and came back
      // as a bare 500, so two of the five options an operator could choose
      // showed "Failed to save" and saved nothing, every time, with no clue
      // why.
      const res = await save(agency.token, {
        provider: 'AFRICA_TALKING',
        phoneNumber: '+2348012345670',
        apiKey: 'some-key',
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('AFRICAS_TALKING');
      expect(res.body.message).toContain('SIP_TRUNK');
    });

    it('accepts every provider the platform actually implements', async () => {
      for (const provider of [
        'TWILIO',
        'PLIVO',
        'TELNYX',
        'AFRICAS_TALKING',
        'NIGERIA_CARRIER_FORWARD',
        'MTN_ENTERPRISE_SIP',
        'AIRTEL_BUSINESS_SIP',
      ]) {
        const res = await save(agency.token, {
          provider,
          phoneNumber: '+2348012345670',
          apiKey: 'some-key',
        });
        expect([provider, res.status]).toEqual([provider, 201]);
      }
    });
  });

  it('never hands a credential back on the read every member can make', async () => {
    await save(agency.token, {
      provider: 'SIP_TRUNK',
      phoneNumber: '+2348012345670',
      sipAddress: 'sip.carrier.ng',
      sipUsername: 'ministry',
      sipPassword: 'read-back-secret',
    });

    const res = await request(app.getHttpServer())
      .get('/api/organizations/me')
      .set('Authorization', `Bearer ${agency.token}`);

    expect(res.status).toBe(200);
    const cfg = res.body.telephonyConfigs[0];

    // GET /me is open to VIEWER, and the field list it masked was a SECOND
    // copy of the write path's. `sipPassword` was added to one and not the
    // other, so this read returned the stored ciphertext.
    expect(JSON.stringify(res.body)).not.toContain('read-back-secret');
    expect(cfg.sipPassword).toBe('••••cret');
    expect(cfg.sipPassword).not.toMatch(/^v1\./);
  });

  // The settings page prints these for the operator to paste into their
  // carrier's portal, so a wrong one is a citizen's call delivered nowhere. The
  // provider enum says AFRICAS_TALKING while the route is 'africa-talking', and
  // spelling the URL from the enum is a 404 an operator has no way to diagnose.
  it.each(['twilio', 'nigeria-carrier', 'africa-talking', 'telnyx'])(
    'serves the inbound webhook path the dashboard tells operators to use: %s',
    async (path) => {
      const res = await request(app.getHttpServer())
        .post(`/api/telephony/inbound/${path}`)
        .send({});

      // Unauthenticated and unsigned, so a rejection is expected and correct.
      // What must not happen is 404: that is a URL the dashboard invented.
      expect(res.status).not.toBe(404);
    }
  );

  it('is not writable by a member who cannot change how the agency is connected', async () => {
    const res = await save(member.token, {
      provider: 'SIP_TRUNK',
      phoneNumber: '+2348012349999',
      sipAddress: 'sip.attacker.test',
    });

    expect(res.status).toBe(403);
  });
});
