import {
  DEFAULT_SERVICE_HOURS,
  assertUsableServiceHours,
  type ServiceHours,
} from './availability';

/**
 * Just enough of a Prisma client to read an agency's hours.
 *
 * ── Why the caller passes this in ───────────────────────────────────────────
 *
 * The same reason `findAvailableSlots` takes a `BusyLoader`. Both engines
 * already hold a client, and the orchestrator's suites replace `@ace/database`
 * wholesale — so a helper that reached for its own client would be undefined
 * in exactly the tests that cover the booking flow, and in production would be
 * a second client reference nobody expects.
 *
 * The first version did reach for its own, and every orchestrator booking test
 * failed with the flow silently falling back: the helper was not in the test
 * mock, calling it threw, and the engine reported BOOK_APPOINTMENT instead of
 * offering times. Passing the client in is what makes one implementation
 * usable from both engines.
 */
export interface OrganizationHoursReader {
  organization: {
    findUnique: (args: {
      where: { id: string };
      select: { openingHour: true; closingHour: true; serviceDays: true };
    }) => Promise<{ openingHour: number; closingHour: number; serviceDays: number[] } | null>;
  };
}

/**
 * One agency's serving hours, or the platform default if it has none.
 *
 * Never throws. This is called from inside a live conversation, and an
 * exception here would mean a citizen gets no reply at all — the same contract
 * every other tool in that path holds.
 */
export async function serviceHoursFrom(
  db: OrganizationHoursReader,
  organizationId: string
): Promise<ServiceHours> {
  let row: { openingHour: number; closingHour: number; serviceDays: number[] } | null = null;
  try {
    row = await db.organization.findUnique({
      where: { id: organizationId },
      select: { openingHour: true, closingHour: true, serviceDays: true },
    });
  } catch {
    return DEFAULT_SERVICE_HOURS;
  }

  if (!row) return DEFAULT_SERVICE_HOURS;

  const hours: ServiceHours = {
    openHour: row.openingHour,
    closeHour: row.closingHour,
    days: row.serviceDays,
  };

  // Columns have defaults and the settings endpoint validates, so an unusable
  // row means something wrote it directly. Offering the standard working week
  // beats telling a citizen the diary is empty for a fortnight.
  try {
    assertUsableServiceHours(hours);
  } catch {
    return DEFAULT_SERVICE_HOURS;
  }

  return hours;
}
