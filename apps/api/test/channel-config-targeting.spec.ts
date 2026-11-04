/**
 * A settings save must change the line it was shown, and no other.
 *
 * An agency can hold SEVERAL voice lines and several WhatsApp lines. That is
 * the design, not an accident: inbound calls are resolved by dialled number
 * (`@@index([phoneNumber])`), inbound WhatsApp by Meta's `phoneNumberId` — the
 * only tenant identifier Meta sends — `isDefault` picks the outbound line,
 * `verifyStatusCallback` looks a row up by provider, each carrier signs its
 * webhooks differently, and `GET /api/organizations/me` returns both as
 * ARRAYS. One of this repo's own suites seeds five telephony rows for one
 * agency to exercise five signature schemes.
 *
 * Both save paths ignored all of that. Each did an unordered
 * `findFirst({ where: { organizationId } })` and updated whatever came back,
 * so on a three-line agency saving the voice form overwrote an ARBITRARY line
 * — Twilio credentials could land on the Telnyx row — and the line the officer
 * was looking at was not necessarily the line they changed. The read was
 * unordered too, so the screen showed a different line after a refresh.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { OrganizationsService } from '../src/organizations/organizations.service';

describe('channel configuration targeting', () => {
  let app: INestApplication;
  let organizations: OrganizationsService;
  let orgId: string;
  let otherOrgId: string;

  jest.setTimeout(60000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    // Writing a provider credential throws without a key rather than storing
    // it in the clear, so the suite needs one.
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    organizations = app.get(OrganizationsService);

    const mk = async (label: string) =>
      (await prisma.organization.create({
        data: { name: label, slug: `${label.toLowerCase().replace(/\W+/g, '-')}-${randomBytes(4).toString('hex')}`, industry: 'OTHER' },
      })).id;
    orgId = await mk('Multiline Agency');
    otherOrgId = await mk('Other Agency');
  });

  afterAll(async () => {
    for (const id of [orgId, otherOrgId]) {
      await prisma.callLog.deleteMany({ where: { organizationId: id } });
      await prisma.telephonyConfig.deleteMany({ where: { organizationId: id } });
      await prisma.whatsAppConfig.deleteMany({ where: { organizationId: id } });
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    await app.close();
  });

  beforeEach(async () => {
    await prisma.telephonyConfig.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.whatsAppConfig.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
  });

  const threeLines = async () => {
    const twilio = await prisma.telephonyConfig.create({
      data: {
        organizationId: orgId, provider: 'TWILIO', phoneNumber: '+2348030001111',
        accountSid: 'AC_twilio_row', isDefault: true,
      },
    });
    const telnyx = await prisma.telephonyConfig.create({
      data: { organizationId: orgId, provider: 'TELNYX', phoneNumber: '+2348030002222', isDefault: false },
    });
    const forward = await prisma.telephonyConfig.create({
      data: {
        organizationId: orgId, provider: 'NIGERIA_CARRIER_FORWARD',
        phoneNumber: '+2348030003333', isDefault: false,
      },
    });
    return { twilio, telnyx, forward };
  };

  it('keeps every line an agency has', async () => {
    await threeLines();
    // The premise. If a future change makes organizationId unique, five of
    // this repo's signature tests stop being able to exist at all.
    const rows = await prisma.telephonyConfig.findMany({ where: { organizationId: orgId } });
    expect(rows).toHaveLength(3);
  });

  it('shows the same line on every read, default first', async () => {
    const { telnyx } = await threeLines();
    // The settings screen renders telephonyConfigs[0]. Unordered, Postgres may
    // return these in any sequence — and after an UPDATE it commonly returns a
    // different one, which is exactly when an officer reloads the page.
    await prisma.telephonyConfig.update({
      where: { id: telnyx.id },
      data: { phoneNumber: '+2348030002299' },
    });

    const first = await organizations.getOrganization(orgId);
    const second = await organizations.getOrganization(orgId);
    expect(first.telephonyConfigs[0].id).toBe(second.telephonyConfigs[0].id);
    // And it is the default line — the one outbound calls are placed from, so
    // the screen and the behaviour agree.
    expect(first.telephonyConfigs[0].isDefault).toBe(true);
    expect(first.telephonyConfigs[0].phoneNumber).toBe('+2348030001111');
  });

  it('edits the line it was given, leaving the others untouched', async () => {
    const { twilio, telnyx, forward } = await threeLines();

    await organizations.updateTelephonyConfig(orgId, {
      id: telnyx.id,
      provider: 'TELNYX',
      phoneNumber: '+2348030002277',
    } as any);

    const after = await prisma.telephonyConfig.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
    expect(after).toHaveLength(3);

    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get(telnyx.id)!.phoneNumber).toBe('+2348030002277');
    // THE assertion. The Twilio line keeps its number, its provider and its
    // account SID: saving the Telnyx line did not write Telnyx settings over
    // the line that answers the agency's main number.
    expect(byId.get(twilio.id)!.phoneNumber).toBe('+2348030001111');
    expect(byId.get(twilio.id)!.provider).toBe('TWILIO');
    expect(byId.get(twilio.id)!.accountSid).toBe('AC_twilio_row');
    expect(byId.get(forward.id)!.phoneNumber).toBe('+2348030003333');
  });

  it('refuses a line id belonging to another agency', async () => {
    await threeLines();
    const theirs = await prisma.telephonyConfig.create({
      data: { organizationId: otherOrgId, provider: 'TWILIO', phoneNumber: '+2349990001111' },
    });

    await expect(
      organizations.updateTelephonyConfig(orgId, {
        id: theirs.id,
        provider: 'TWILIO',
        phoneNumber: '+2340000000000',
      } as any)
    ).rejects.toBeInstanceOf(NotFoundException);

    // Untouched, and NOT recreated under our agency either — a save that
    // silently fell through to "create" would turn an edit of a line that is
    // not ours into a fourth line that is.
    const unchanged = await prisma.telephonyConfig.findUnique({ where: { id: theirs.id } });
    expect(unchanged!.phoneNumber).toBe('+2349990001111');
    expect(unchanged!.organizationId).toBe(otherOrgId);
    expect(await prisma.telephonyConfig.count({ where: { organizationId: orgId } })).toBe(3);
  });

  it('creates the first line when the agency has none', async () => {
    const saved = await organizations.updateTelephonyConfig(orgId, {
      provider: 'TWILIO',
      phoneNumber: '+2348030009999',
    } as any);
    expect(saved.phoneNumber).toBe('+2348030009999');
    expect(await prisma.telephonyConfig.count({ where: { organizationId: orgId } })).toBe(1);
  });

  it('edits the default line when no id is given', async () => {
    const { twilio, telnyx } = await threeLines();
    await organizations.updateTelephonyConfig(orgId, {
      provider: 'TWILIO',
      phoneNumber: '+2348030001188',
    } as any);

    // The row the READ orders first, which is the row the screen renders —
    // never an arbitrary one.
    const after = await prisma.telephonyConfig.findUnique({ where: { id: twilio.id } });
    expect(after!.phoneNumber).toBe('+2348030001188');
    const untouched = await prisma.telephonyConfig.findUnique({ where: { id: telnyx.id } });
    expect(untouched!.phoneNumber).toBe('+2348030002222');
    expect(await prisma.telephonyConfig.count({ where: { organizationId: orgId } })).toBe(3);
  });

  describe('WhatsApp lines behave the same way', () => {
    const twoLines = async () => {
      const a = await prisma.whatsAppConfig.create({
        data: {
          organizationId: orgId, phoneNumberId: 'pnid_main', whatsappBusinessId: 'waba_main',
          accessToken: 'plain_main_token', displayPhoneNumber: '+234 803 000 1111',
          webhookVerifyToken: 'verify_main', isActive: true,
        },
      });
      const b = await prisma.whatsAppConfig.create({
        data: {
          organizationId: orgId, phoneNumberId: 'pnid_second', whatsappBusinessId: 'waba_second',
          accessToken: 'plain_second_token', displayPhoneNumber: '+234 803 000 2222',
          webhookVerifyToken: 'verify_second', isActive: true,
        },
      });
      return { a, b };
    };

    it('edits the named line and leaves the other alone', async () => {
      const { a, b } = await twoLines();
      await organizations.updateWhatsAppConfig(orgId, {
        id: b.id,
        phoneNumberId: 'pnid_second_updated',
        accessToken: 'EAAsecond_new',
        webhookVerifyToken: 'verify_second_new',
      });

      const after = await prisma.whatsAppConfig.findMany({ where: { organizationId: orgId } });
      expect(after).toHaveLength(2);
      const first = after.find((r) => r.id === a.id)!;
      // Meta routes inbound by phoneNumberId. Overwriting the wrong row's
      // phoneNumberId makes one of the agency's lines unresolvable, and every
      // message to it is logged as "no config found" for a line the dashboard
      // still shows as connected.
      expect(first.phoneNumberId).toBe('pnid_main');
      expect(after.find((r) => r.id === b.id)!.phoneNumberId).toBe('pnid_second_updated');
    });

    it('refuses a line id belonging to another agency', async () => {
      await twoLines();
      const theirs = await prisma.whatsAppConfig.create({
        data: {
          organizationId: otherOrgId, phoneNumberId: 'pnid_theirs', whatsappBusinessId: 'waba_theirs',
          accessToken: 'plain_theirs', displayPhoneNumber: '+234 999 000 1111',
          webhookVerifyToken: 'verify_theirs', isActive: true,
        },
      });

      await expect(
        organizations.updateWhatsAppConfig(orgId, {
          id: theirs.id,
          phoneNumberId: 'hijacked',
          accessToken: 'EAAnope',
          webhookVerifyToken: 'nope',
        })
      ).rejects.toBeInstanceOf(NotFoundException);

      const unchanged = await prisma.whatsAppConfig.findUnique({ where: { id: theirs.id } });
      expect(unchanged!.phoneNumberId).toBe('pnid_theirs');
    });
  });
});
