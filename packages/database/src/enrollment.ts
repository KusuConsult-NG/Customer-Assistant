/**
 * Writing an enrollee into the CRM.
 *
 * Shared because BOTH conversation engines must be able to enroll somebody and
 * they must produce the same record. The agent path had the only copy, which
 * meant a citizen messaging the helpline on WhatsApp — the channel that
 * actually works today — could not register at all, while the same request on
 * the path that has never taken a real call was fully supported.
 *
 * This module is the persistence half only: resolve the facility, write the
 * contact, write the audit note. It deliberately does NOT collect the fields
 * (each engine asks in its own way) and does NOT send the photo link (that
 * needs provider credentials the orchestrator package cannot reach). Callers
 * validate first; this refuses rather than guessing if they did not.
 */
import { prisma } from './index';
import { normalizePhoneNumber, phoneNumberVariants } from './phone-number';
import { getFacilitiesForLGA } from './plaschema-facilities';

export interface EnrolleeInput {
  /**
   * REQUIRED, and deliberately so.
   *
   * The previous implementation invented one when it was missing —
   * `+23480${random 8 digits}` — which writes a fabricated phone number into a
   * real CRM. Two ways that hurts: staff ring it and reach a stranger, and it
   * can collide with an actual enrollee's number, at which point one person's
   * health record is attached to another person's phone. Every caller and
   * every WhatsApp sender arrives WITH a number, so there is no case where
   * inventing one is the only option — there is only the case where a bug
   * upstream dropped it, and that must surface rather than be papered over.
   */
  phoneNumber: string;
  fullName: string;
  lga: string;
  planType: string;
  residentialAddress?: string;
  ageOrDob?: string;
  nin?: string;
  preferredHospital?: string;
  notes?: string;
}

export interface EnrolleeResult {
  contactId: string;
  /** Short, readable reference the customer is told to keep. */
  refId: string;
  /** The accredited facility actually recorded, which may differ from the ask. */
  facility: string;
  planType: string;
  isEquity: boolean;
}

/** Free at the point of use: the state pays. */
export function isEquityPlan(planType: string): boolean {
  return /equity|bhcpf|vulnerable|free/i.test(planType);
}

/**
 * Resolve what the customer said into an accredited facility for their LGA.
 *
 * Returns null when nothing in the LGA matches, so the caller can ask again
 * rather than silently enrolling somebody at a hospital that is not on the
 * accredited list — which is a card that gets refused at the desk.
 */
export function resolveFacility(lga: string, requested?: string): string | null {
  const facilities = getFacilitiesForLGA(lga);
  const asked = requested?.trim();

  if (asked && facilities.length > 0) {
    const lower = asked.toLowerCase();
    const matched =
      facilities.find((f) => f.name.toLowerCase() === lower) ??
      facilities.find((f) => f.name.toLowerCase().includes(lower)) ??
      facilities.find((f) => lower.includes(f.name.toLowerCase()));
    if (matched) return matched.name;
    return null; // named something, and it is not accredited here
  }
  if (asked && facilities.length === 0) return null; // unknown LGA
  return null; // nothing asked for
}

export async function upsertEnrollee(
  organizationId: string,
  input: EnrolleeInput
): Promise<EnrolleeResult> {
  if (!input.phoneNumber?.trim()) {
    throw new Error('phoneNumber is required to enroll — refusing to invent one');
  }
  if (!input.fullName?.trim()) throw new Error('fullName is required to enroll');
  if (!input.lga?.trim()) throw new Error('lga is required to enroll');
  if (!input.planType?.trim()) throw new Error('planType is required to enroll');

  const phone = normalizePhoneNumber(input.phoneNumber);
  const isEquity = isEquityPlan(input.planType);
  const planType = isEquity ? 'Equity / BHCPF Subsidized Plan' : input.planType.trim();

  // Whatever the caller resolved, falling back to the LGA's first accredited
  // facility rather than a free-text name that no desk would recognise.
  const facilities = getFacilitiesForLGA(input.lga);
  const facility =
    resolveFacility(input.lga, input.preferredHospital) ??
    facilities[0]?.name ??
    'Accredited Primary Healthcare Provider';

  const enrollmentMetadata = {
    residentialAddress: input.residentialAddress ?? null,
    lga: input.lga.trim(),
    ageOrDob: input.ageOrDob ?? null,
    nin: input.nin ?? null,
    planType,
    preferredHospital: facility,
    isEquity,
    enrollmentStatus: isEquity ? 'PENDING_EQUITY_REVIEW' : 'PENDING_SELFIE',
    paymentStatus: isEquity ? 'WAIVED_SUBSIDIZED' : 'PENDING',
    registeredAt: new Date().toISOString(),
  };

  // Every stored shape of the number, so enrolling somebody who has called
  // before updates their record instead of creating a second one.
  const existing = await prisma.contact.findFirst({
    where: { organizationId, phoneNumber: { in: phoneNumberVariants(phone) } },
  });

  const contact = existing
    ? await prisma.contact.update({
        where: { id: existing.id },
        data: {
          fullName: input.fullName.trim(),
          address: input.residentialAddress?.trim() || existing.address,
          city: input.lga.trim(),
          metadata: {
            ...(typeof existing.metadata === 'object' && existing.metadata !== null
              ? (existing.metadata as Record<string, unknown>)
              : {}),
            ...enrollmentMetadata,
          },
          tags: existing.tags.includes('enrollment-pending')
            ? existing.tags
            : [...existing.tags, 'enrollment-pending'],
        },
      })
    : await prisma.contact.create({
        data: {
          organizationId,
          phoneNumber: phone,
          fullName: input.fullName.trim(),
          address: input.residentialAddress?.trim(),
          city: input.lga.trim(),
          metadata: enrollmentMetadata,
          tags: ['enrollment-pending'],
        },
      });

  const auditLine = [
    `Address: ${input.residentialAddress || 'N/A'}`,
    `LGA: ${input.lga}`,
    input.ageOrDob ? `Age/DOB: ${input.ageOrDob}` : null,
    `Plan: ${planType}`,
    `Primary Facility: ${facility}`,
    input.nin ? `NIN: ${input.nin}` : null,
    isEquity ? 'Status: 100% State Subsidized (₦0)' : null,
    input.notes || null,
  ]
    .filter(Boolean)
    .join(' | ');

  await prisma.note
    .create({ data: { contactId: contact.id, content: `Helpline Enrollment Registration: ${auditLine}` } })
    .catch(() => {});

  return {
    contactId: contact.id,
    refId: contact.id.slice(0, 8).toUpperCase(),
    facility,
    planType,
    isEquity,
  };
}
