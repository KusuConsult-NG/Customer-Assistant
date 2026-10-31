/**
 * What the public selfie link tells anyone who holds it.
 *
 * `GET /api/public/selfie/:token` is unauthenticated by design: a citizen
 * opens it from a WhatsApp message, on a phone that is not signed in to
 * anything. That makes its response body public, and a WhatsApp link does not
 * stay with the person it was sent to — it survives in forwarded chats, on a
 * shared handset, and in a screenshot long after the photo was taken.
 *
 * The budget is therefore a first name and the agency's name: enough that the
 * citizen can tell the request is genuine and meant for them, and not enough
 * to identify them to somebody who merely came across the link.
 *
 * It did not hold that line. The response returned `fullName` directly beneath
 * the comment saying first name only, and `planType` naming the citizen's
 * enrollment category. The page that is the ONLY consumer declared both on its
 * type and rendered neither — so the disclosure bought nothing whatsoever. The
 * HTTP harness had been reporting it as SEL-010 (CRITICAL) throughout.
 *
 * These assertions are about what is ABSENT. A test that checked the fields it
 * expects to see would pass no matter what else was added beside them, and
 * "what else was added beside them" is precisely how this happened.
 */
import { randomBytes } from 'crypto';
import { prisma, createSelfieRequest } from '@ace/database';
import { OnboardingService } from '../src/onboarding/onboarding.service';

describe('the public selfie link discloses no more than it must', () => {
  const onboarding = new OnboardingService();

  let orgId: string;
  let contactId: string;
  let phoneNumber: string;

  const FULL_NAME = 'Amina Bello Danladi';
  const EMAIL = 'amina.danladi@example.test';
  const PLAN = 'Informal Sector Family';

  jest.setTimeout(60000);

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'Public Link Agency', slug: `plink-${randomBytes(4).toString('hex')}`, industry: 'OTHER' },
    });
    orgId = org.id;

    phoneNumber = `+2348${Date.now().toString().slice(-9)}`;
    const contact = await prisma.contact.create({
      data: {
        organizationId: orgId,
        phoneNumber,
        fullName: FULL_NAME,
        email: EMAIL,
        metadata: { planType: PLAN, lga: 'Jos North', policyId: 'POL-99887' },
      },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  });

  const describeLink = async (purpose = 'enrollment photo') => {
    const { token } = await createSelfieRequest({
      organizationId: orgId,
      contactId,
      channel: 'WHATSAPP',
      purpose,
      uploadUrl: 'https://example.test/selfie/placeholder',
    });
    return { token, info: await onboarding.describeUploadLink(token) };
  };

  it('names the citizen only by their first name', async () => {
    const { info } = await describeLink();

    expect(info.firstName).toBe('Amina');
    expect(info).not.toHaveProperty('fullName');
  });

  it('carries nothing that identifies the citizen to a stranger', async () => {
    const { info } = await describeLink();
    const serialized = JSON.stringify(info);

    for (const [label, value] of [
      ['family name', 'Bello'],
      ['last name', 'Danladi'],
      ['phone number', phoneNumber],
      ['email', EMAIL],
      ['contact id', contactId],
      ['organization id', orgId],
      ['policy id', 'POL-99887'],
      ['plan name', PLAN],
    ] as const) {
      expect(`${label}: ${serialized}`).not.toContain(value);
    }
  });

  it('still says which agency is asking, so the citizen can tell it is genuine', async () => {
    const { info } = await describeLink();

    // The one identifying thing that belongs here: a photo request from
    // nobody in particular is a phishing link.
    expect(info.organizationName).toBe('Public Link Agency');
  });

  it('keeps the dependants form working without naming the plan', async () => {
    const { info } = await describeLink();

    // Derived from the plan rather than disclosing it. Removing this would
    // have taken a working feature with the leak.
    expect(info.isFamilyPlan).toBe(true);
    expect(JSON.stringify(info)).not.toContain('Informal');
  });

  it('offers no dependants form to a citizen who is not on a family plan', async () => {
    const solo = await prisma.contact.create({
      data: {
        organizationId: orgId,
        phoneNumber: `+2347${Date.now().toString().slice(-9)}`,
        fullName: 'Tanko Musa',
        metadata: { planType: 'Formal Sector' },
      },
    });
    const { token } = await createSelfieRequest({
      organizationId: orgId,
      contactId: solo.id,
      channel: 'WHATSAPP',
      uploadUrl: 'https://example.test/selfie/placeholder',
    });

    const info = await onboarding.describeUploadLink(token);
    expect(info.isFamilyPlan).toBe(false);
    expect(info.firstName).toBe('Tanko');
  });
});
