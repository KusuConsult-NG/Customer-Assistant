/**
 * The citizen premium payment path.
 *
 * This suite exists because there was none. `PRODUCTION_READINESS_AUDIT.md`
 * DEF-06 records that no test in the repository referenced `public/pay` or
 * `confirmEnrolleePayment` — while those two endpoints were unauthenticated,
 * unscoped across tenants, and able to mark any enrollee PAID for any amount
 * with no payment gateway involved.
 *
 * So these are not happy-path tests. Each one is an abuse case that used to
 * work:
 *
 *   - reading and paying against another tenant's contact  (DEF-02)
 *   - enumerating the contact table by uuid prefix         (DEF-03)
 *   - harvesting a full record from a phone number         (DEF-03)
 *   - naming your own price                                (DEF-01)
 *   - replaying a settlement to overwrite the record       (DEF-04)
 *   - being enrolled by a browser request at all           (DEF-01)
 */

import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { OnboardingService } from '../src/onboarding/onboarding.service';

const PAYSTACK_CHECKOUT = 'https://checkout.paystack.com/test-authorization';

describe('citizen premium payment', () => {
  const service = new OnboardingService();

  let orgId: string;
  let otherOrgId: string;
  let orgSlug: string;
  let contactId: string;
  let otherContactId: string;

  // The same person's number on two tenants. Before scoping, `findFirst` picked
  // whichever row it happened to reach first.
  const phone = `+23480${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  const realFetch = global.fetch;
  let fetchCalls: Array<{ url: string; body: any }> = [];

  beforeAll(async () => {
    orgSlug = `pay-${randomBytes(4).toString('hex')}`;
    const org = await prisma.organization.create({
      data: { name: 'Premium Portal Tenant', slug: orgSlug, industry: 'OTHER' },
    });
    orgId = org.id;

    const other = await prisma.organization.create({
      data: {
        name: 'Unrelated Tenant',
        slug: `pay-other-${randomBytes(4).toString('hex')}`,
        industry: 'OTHER',
      },
    });
    otherOrgId = other.id;

    const contact = await prisma.contact.create({
      data: {
        organizationId: orgId,
        fullName: 'Musa Abubakar',
        phoneNumber: phone,
        metadata: {
          planType: 'Informal Sector Individual Plan',
          lga: 'Jos North',
          preferredHospital: 'Plateau Specialist Hospital',
          dependents: [{ fullName: 'Amina Abubakar', relationship: 'Spouse' }],
        },
      },
    });
    contactId = contact.id;

    const otherContact = await prisma.contact.create({
      data: {
        organizationId: otherOrgId,
        fullName: 'Someone Else',
        phoneNumber: phone,
        metadata: { planType: 'Informal Sector Individual Plan' },
      },
    });
    otherContactId = otherContact.id;

    process.env.PUBLIC_PAYMENT_ORG_SLUG = orgSlug;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_not_a_real_key';

    // No real transaction is created. What matters is what we SEND, which the
    // amount-tampering test reads back.
    global.fetch = (async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { authorization_url: PAYSTACK_CHECKOUT } }),
      };
    }) as unknown as typeof global.fetch;
  }, 60_000);

  beforeEach(() => {
    fetchCalls = [];
  });

  afterAll(async () => {
    global.fetch = realFetch;
    // Payment→Organization is onDelete: Restrict on purpose, so financial rows
    // must be cleared explicitly. An organization cannot be deleted out from
    // under its own payment history by accident — including here.
    await prisma.payment.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
  });

  // ── DEF-02: tenant isolation ────────────────────────────────────────────
  it('resolves the enrollee in the portal tenant, never another tenant sharing the number', async () => {
    const found = await service.lookupEnrolleeForPayment(phone);
    expect(found.enrollee).toBe('Musa A.');

    const rows = await prisma.contact.findMany({
      where: { phoneNumber: phone },
      select: { id: true, organizationId: true },
    });
    expect(rows.map((r) => r.id).sort()).toEqual([contactId, otherContactId].sort());
    // Both rows exist; the lookup reached only the portal tenant's.
    expect(found.enrollee).not.toBe('Someone E.');
  });

  // ── DEF-03: enumeration oracle ──────────────────────────────────────────
  it('does not resolve a contact by a prefix of its uuid', async () => {
    await expect(service.lookupEnrolleeForPayment(contactId.slice(0, 3))).rejects.toThrow(
      /No enrollee found/i
    );
    await expect(service.lookupEnrolleeForPayment(contactId)).rejects.toThrow(/No enrollee found/i);
  });

  // ── DEF-03: response surface ────────────────────────────────────────────
  it('returns a masked name and no dependants, LGA, hospital or contact id', async () => {
    const found: Record<string, unknown> = await service.lookupEnrolleeForPayment(phone);

    expect(found.enrollee).toBe('Musa A.');
    expect(JSON.stringify(found)).not.toContain('Abubakar');
    for (const leaked of ['dependents', 'lga', 'preferredHospital', 'contactId', 'phoneNumber']) {
      expect(found).not.toHaveProperty(leaked);
    }
  });

  // ── DEF-01: the server prices the plan ──────────────────────────────────
  it('prices the plan server-side and sends that amount to the gateway', async () => {
    const started = await service.initializeEnrolleePayment(phone, 'FAMILY');

    expect(started.authorizationUrl).toBe(PAYSTACK_CHECKOUT);
    expect(started.amountNgn).toBe(50_000);

    // The amount reaching Paystack came from the price table, not from a caller.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.amount).toBe(50_000 * 100);

    const row = await prisma.payment.findUnique({
      where: { gatewayReference: started.reference },
    });
    expect(row?.amountKobo).toBe(50_000 * 100);
    expect(row?.status).toBe('PENDING');
    expect(row?.organizationId).toBe(orgId);
  });

  it('starting a payment enrolls nobody — only the gateway can do that', async () => {
    const started = await service.initializeEnrolleePayment(phone, 'INDIVIDUAL');

    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    const meta = (contact?.metadata as Record<string, any>) ?? {};
    expect(meta.paymentStatus).toBeUndefined();
    expect(meta.enrollmentStatus).toBeUndefined();
    expect(contact?.tags ?? []).not.toContain('enrolled-active');

    const row = await prisma.payment.findUnique({
      where: { gatewayReference: started.reference },
    });
    expect(row?.status).toBe('PENDING');
    expect(row?.paidAt).toBeNull();
  });

  // ── DEF-01: amount tampering at settlement ──────────────────────────────
  it('refuses to settle when the gateway reports less than the plan price', async () => {
    const started = await service.initializeEnrolleePayment(phone, 'FAMILY');

    const result = await service.settleEnrolleePayment(started.reference, { amount: 100 });
    expect(result).toEqual({ settled: false, reason: 'amount_mismatch' });

    const row = await prisma.payment.findUnique({
      where: { gatewayReference: started.reference },
    });
    expect(row?.status).toBe('FAILED');
    expect(row?.paidAt).toBeNull();

    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    expect(contact?.tags ?? []).not.toContain('enrolled-active');
  });

  // ── DEF-04: replay ──────────────────────────────────────────────────────
  it('settles a replayed webhook exactly once', async () => {
    const started = await service.initializeEnrolleePayment(phone, 'INDIVIDUAL');
    const payload = { amount: 12_000 * 100, reference: started.reference };

    const first = await service.settleEnrolleePayment(started.reference, payload);
    expect(first).toEqual({ settled: true, reason: 'settled' });

    const afterFirst = await prisma.payment.findUnique({
      where: { gatewayReference: started.reference },
    });
    expect(afterFirst?.status).toBe('SUCCEEDED');
    const firstPaidAt = afterFirst?.paidAt?.toISOString();

    const second = await service.settleEnrolleePayment(started.reference, payload);
    expect(second).toEqual({ settled: true, reason: 'already_settled' });

    const afterSecond = await prisma.payment.findUnique({
      where: { gatewayReference: started.reference },
    });
    // paidAt is the thing a replay used to overwrite, silently, every time.
    expect(afterSecond?.paidAt?.toISOString()).toBe(firstPaidAt);

    const settlements = await prisma.auditLog.count({
      where: { targetId: started.reference, action: 'payment.settled' },
    });
    expect(settlements).toBe(1);
  });

  it('records one payment row per reference, and the reference is unique', async () => {
    const started = await service.initializeEnrolleePayment(phone, 'INDIVIDUAL');
    await expect(
      prisma.payment.create({
        data: {
          organizationId: orgId,
          contactId,
          gatewayReference: started.reference,
          amountKobo: 1,
          purpose: 'plaschema_premium',
        },
      })
    ).rejects.toThrow();
  });

  it('ignores a settlement for a reference it never issued', async () => {
    const result = await service.settleEnrolleePayment('PLS-never-issued', { amount: 999_999 });
    expect(result).toEqual({ settled: false, reason: 'unknown_reference' });
  });

  // ── Equity is an application, not a purchase ────────────────────────────
  it('files equity coverage as pending review and never as active cover', async () => {
    const filed = await service.applyForEquityCoverage(phone, 'Pregnant Mother');
    expect(filed.status).toBe('PENDING_EQUITY_REVIEW');

    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    const meta = (contact?.metadata as Record<string, any>) ?? {};
    expect(meta.enrollmentStatus).toBe('PENDING_EQUITY_REVIEW');
    expect(meta.paymentStatus).not.toBe('PAID');
    expect(contact?.tags ?? []).toContain('equity-applicant');

    const payments = await prisma.payment.count({ where: { contactId, purpose: 'equity' } });
    expect(payments).toBe(0);
  });

  // ── DEF-01: the endpoint that did all of this is gone ───────────────────
  it('no longer exposes a browser-authoritative confirmation method', () => {
    expect((service as unknown as Record<string, unknown>).confirmEnrolleePayment).toBeUndefined();
  });
});
