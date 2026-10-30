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
import { loadServiceCatalogue, locationsInLga, resolveLocation, resolveServiceOption } from './service-catalogue';

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

/**
 * Whether a service costs the citizen nothing.
 *
 * This used to be a regex over the service NAME (/equity|bhcpf|free/), so
 * whether somebody owed money was decided by pattern-matching a label — an
 * agency naming a paid service "Freehold Title" would have had it waived. The
 * agency now states it on the `ServiceOption` row, and the name is just a
 * name. The regex survives only as a fallback for records written before the
 * catalogue existed.
 */
export function isNoCostService(serviceName: string, known?: { isNoCost: boolean } | null): boolean {
  if (known) return known.isNoCost;
  return /equity|bhcpf|vulnerable|free/i.test(serviceName);
}

/**
 * Resolve what the customer said into an accredited facility for their LGA.
 *
 * Returns null when nothing in the LGA matches, so the caller can ask again
 * rather than silently enrolling somebody at a hospital that is not on the
 * accredited list — which is a card that gets refused at the desk.
 */
export async function resolveFacility(
  organizationId: string,
  lga: string,
  requested?: string
): Promise<string | null> {
  if (!requested?.trim()) return null;
  const catalogue = await loadServiceCatalogue(prisma, organizationId);
  return resolveLocation(catalogue, lga, requested)?.name ?? null;
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

  // The agency's own catalogue decides what this service is called and whether
  // it costs anything, rather than a regex over the label.
  const catalogue = await loadServiceCatalogue(prisma, organizationId);
  const option = resolveServiceOption(catalogue, input.planType);
  const isEquity = isNoCostService(input.planType, option);
  const planType = option?.name ?? input.planType.trim();

  // Whatever the caller resolved, falling back to the agency's first location
  // in that LGA rather than a free-text name no desk would recognise. Null
  // when the agency has nowhere there: a human assigns one, which is honest,
  // where inventing a placeholder put a name on a card that means nothing.
  const here = locationsInLga(catalogue, input.lga);
  const facility =
    resolveLocation(catalogue, input.lga, input.preferredHospital)?.name ??
    here[0]?.name ??
    null;

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
