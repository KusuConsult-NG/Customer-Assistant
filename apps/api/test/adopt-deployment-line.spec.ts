/**
 * Adopting the deployment's own Twilio line.
 *
 * Observed on the live deployment: `ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`,
 * `OPENAI_API_KEY` and `API_BASE_URL` were all correct, the ElevenLabs agent
 * was provisioned — and every caller would still have heard "This number is
 * not currently configured", because no `TelephonyConfig` row existed. The
 * server can hold a complete Twilio line in its environment and nothing ever
 * writes it into a row, while `handleInboundCall`'s fallback to
 * `process.env.TWILIO_AUTH_TOKEN` implies those variables are doing something.
 * They are not: the dialled number is matched FIRST, and with no row the call
 * is already over before any credential is read.
 *
 * The guards are the whole point of these tests. The credentials belong to the
 * DEPLOYMENT and the row belongs to ONE agency, so adopting them decides which
 * agency answers the State's phone number.
 */
import { INestApplication, BadRequestException, ConflictException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { prisma, withTelephonyCredentials } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { VoiceReadinessService } from '../src/telephony/voice-readiness.service';

describe('adopting the deployment line', () => {
  let app: INestApplication;
  let readiness: VoiceReadinessService;
  let orgId: string;

  jest.setTimeout(60000);

  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in saved)) saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  const SID = 'ACdeployment0000000000000000000000';
  const TOKEN = 'deployment_auth_token_0123456789';
  // Deliberately in the LOCAL format an operator types, not E.164: the row
  // must be stored canonically or the inbound lookup cannot match the dialled
  // number, which is the exact bug that once left a configured line dead.
  const NUMBER = '08031234567';

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    app = await createTestApp();
    readiness = app.get(VoiceReadinessService);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app.close();
  });

  beforeEach(async () => {
    const org = await prisma.organization.create({
      data: { name: 'Adopt Agency', slug: `adopt-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;
    setEnv('TWILIO_ACCOUNT_SID', SID);
    setEnv('TWILIO_AUTH_TOKEN', TOKEN);
    setEnv('TWILIO_PHONE_NUMBER', NUMBER);
    // Everything EXCEPT the line is made ready, so the overall verdict moves
    // only when the line does. Without this the report stays blocked on a
    // missing TTS key — correctly — and the assertion about the line proves
    // nothing about the line.
    setEnv('API_BASE_URL', 'https://api.adopt.example');
    setEnv('ELEVENLABS_API_KEY', 'el_adopt_key');
    setEnv('DEEPGRAM_API_KEY', 'dg_adopt_key');
    setEnv('OPENAI_API_KEY', 'sk_adopt_key');
  });

  afterEach(async () => {
    countSpy?.mockRestore();
    countSpy = undefined;
    await prisma.telephonyConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  });

  /**
   * The agency count is MOCKED rather than read.
   *
   * This database carries every other suite's fixtures, so the real count is
   * never 1 and the single-agency tests would skip themselves — silently
   * asserting nothing, which is worse than not having them. The count is the
   * guard under test, so each test states the deployment shape it is testing.
   */
  let countSpy: jest.SpyInstance | undefined;
  const pretendAgencies = (n: number) => {
    countSpy = jest.spyOn(prisma.organization, 'count').mockResolvedValue(n as any);
  };

  it('refuses without the confirmation, and writes nothing', async () => {
    pretendAgencies(1);
    await expect(readiness.adoptDeploymentLine(orgId, {})).rejects.toBeInstanceOf(BadRequestException);
    // THE assertion for this one: a refusal that had already written the row
    // would have handed the State's number to an agency nobody confirmed.
    expect(await prisma.telephonyConfig.count({ where: { organizationId: orgId } })).toBe(0);
  });

  it('names the number in the refusal, so the operator knows what they are confirming', async () => {
    pretendAgencies(1);
    await expect(
      readiness.adoptDeploymentLine(orgId, {})
    ).rejects.toThrow(new RegExp(NUMBER));
  });

  it('refuses when the deployment holds only part of a line', async () => {
    setEnv('TWILIO_AUTH_TOKEN', undefined);
    await expect(
      readiness.adoptDeploymentLine(orgId, { confirmAdoptsDeploymentNumber: true })
    ).rejects.toThrow(/TWILIO_AUTH_TOKEN/);
    // Two of three is not a line. A row with no token cannot verify a webhook
    // signature, so it would answer calls it could not authenticate.
    expect(await prisma.telephonyConfig.count({ where: { organizationId: orgId } })).toBe(0);
  });

  it('refuses when the agency already has a line, naming it', async () => {
    await prisma.telephonyConfig.create({
      data: { organizationId: orgId, provider: 'TWILIO', phoneNumber: '+2348039999999' },
    });
    await expect(
      readiness.adoptDeploymentLine(orgId, { confirmAdoptsDeploymentNumber: true })
    ).rejects.toBeInstanceOf(ConflictException);
    // Untouched: adopting must never overwrite a configured number, and must
    // never quietly add a second one the settings form would then edit at
    // random.
    const rows = await prisma.telephonyConfig.findMany({ where: { organizationId: orgId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].phoneNumber).toBe('+2348039999999');
  });

  it('refuses on a multi-agency deployment', async () => {
    pretendAgencies(3);
    await expect(
      readiness.adoptDeploymentLine(orgId, { confirmAdoptsDeploymentNumber: true })
    ).rejects.toThrow(/serves 3 agencies/);
    // The deployment's own number belongs to no single agency once there is
    // more than one it could have belonged to.
    expect(await prisma.telephonyConfig.count({ where: { organizationId: orgId } })).toBe(0);
  });

  describe('on a single-agency deployment', () => {
    beforeEach(() => {
      pretendAgencies(1);
    });

    it('writes the line canonically and encrypted', async () => {
      const result = await readiness.adoptDeploymentLine(orgId, {
        confirmAdoptsDeploymentNumber: true,
      });

      // Stored in E.164 even though the env held the local form, or the
      // inbound lookup cannot match what Twilio sends.
      expect(result.line.phoneNumber).toBe('+2348031234567');
      expect(result.line.provider).toBe('TWILIO');

      const row = await prisma.telephonyConfig.findFirst({ where: { organizationId: orgId } });
      expect(row!.isDefault).toBe(true);
      // Encrypted at rest, like every other credential — a plaintext token
      // here would be the one row that escaped the rule.
      expect(row!.authToken).toMatch(/^v1\./);
      // And readable through the helper, which is what the carrier path uses.
      expect(withTelephonyCredentials(row)!.authToken).toBe(TOKEN);

      // It claims nothing about a call working: Twilio still has to be told
      // where to send it.
      expect(result.nextStep).toMatch(/api\/telephony\/inbound\/twilio/);
    });

    it('turns the readiness report from blocked to ready', async () => {
      const before = await readiness.forOrganization(orgId);
      expect(before.state).toBe('blocked');
      expect(before.canAdoptDeploymentLine).toBe(true);

      await readiness.adoptDeploymentLine(orgId, { confirmAdoptsDeploymentNumber: true });

      const after = await readiness.forOrganization(orgId);
      // The line blocker is gone, and with every other prerequisite present
      // the verdict moves to degraded — honestly, because the adopted line has
      // no forwarding number, and reduced service is not a broken line.
      expect(after.checks.find((c) => c.id === 'telephony_config')!.state).toBe('ready');
      expect(after.state).toBe('degraded');
      // And the offer withdraws itself, so the button cannot be pressed twice.
      expect(after.canAdoptDeploymentLine).toBe(false);
    });

    it('is not offered a second time', async () => {
      await readiness.adoptDeploymentLine(orgId, { confirmAdoptsDeploymentNumber: true });
      await expect(
        readiness.adoptDeploymentLine(orgId, { confirmAdoptsDeploymentNumber: true })
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await prisma.telephonyConfig.count({ where: { organizationId: orgId } })).toBe(1);
    });
  });

  it('reports env credentials as present or absent, never their values', async () => {
    const report = await readiness.forOrganization(orgId);
    const check = report.checks.find((c) => c.id === 'deployment_carrier');
    expect(check).toBeTruthy();
    const raw = JSON.stringify(report);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(SID);
    // And it says the thing that was not obvious: those variables do not
    // connect a line on their own.
    expect(check!.consequence).toMatch(/do NOT connect a line/i);
  });
});
