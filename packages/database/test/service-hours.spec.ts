import {
  DEFAULT_SERVICE_HOURS,
  assertUsableServiceHours,
  isWithinServiceHours,
  findAvailableSlots,
  type ServiceHours,
  type BusyPeriod,
} from '../src/availability';
import { serviceHoursFrom } from '../src/service-hours';

/**
 * Serving hours belong to the agency, not the platform.
 *
 * These used to be two constants, so a teaching hospital was never offered a
 * weekend slot it could actually staff and a registry opening at nine had
 * citizens offered eight o'clock. The assertions below are about WHICH times
 * come back, not that some came back: a search that returns "some slots" would
 * pass with the hours ignored entirely.
 */

const noBusy = async (): Promise<BusyPeriod[]> => [];

/** WAT is UTC+1 with no DST, so the hour in WAT is the UTC hour plus one. */
function watHourOf(d: Date): number {
  return (d.getUTCHours() + 1) % 24;
}
function watDayOf(d: Date): number {
  return new Date(d.getTime() + 60 * 60 * 1000).getUTCDay();
}

describe('service hours are the agency’s own', () => {
  it('defaults reproduce the working week the platform used to assume', () => {
    expect(DEFAULT_SERVICE_HOURS).toEqual({ openHour: 8, closeHour: 18, days: [1, 2, 3, 4, 5] });
  });

  it('offers no slot outside a narrow agency’s hours', async () => {
    const registry: ServiceHours = { openHour: 9, closeHour: 13, days: [1, 2, 3, 4, 5] };
    const slots = await findAvailableSlots(noBusy, 30, 40, registry);

    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(registry.days).toContain(watDayOf(s.start));
      expect(watHourOf(s.start)).toBeGreaterThanOrEqual(9);
      // A 30-minute slot starting at 12:30 ends at 13:00, which is allowed;
      // one starting at 13:00 is not.
      expect(watHourOf(s.start)).toBeLessThan(13);
    }
  });

  it('offers weekend slots to an agency that serves at weekends', async () => {
    const hospital: ServiceHours = { openHour: 0, closeHour: 24, days: [0, 1, 2, 3, 4, 5, 6] };
    const slots = await findAvailableSlots(noBusy, 30, 60, hospital);

    const days = new Set(slots.map((s) => watDayOf(s.start)));
    const hasWeekend = days.has(0) || days.has(6);
    expect(hasWeekend).toBe(true);
  });

  it('never offers a weekend slot under the default hours', async () => {
    const slots = await findAvailableSlots(noBusy, 30, 60);
    for (const s of slots) {
      expect([1, 2, 3, 4, 5]).toContain(watDayOf(s.start));
    }
  });

  it('keeps the whole slot inside the hours, not just its start', async () => {
    // A 60-minute appointment cannot start at 17:30 under a 18:00 close.
    const slots = await findAvailableSlots(noBusy, 60, 60);
    for (const s of slots) {
      const lastInstant = new Date(s.end.getTime() - 1);
      expect(isWithinServiceHours(lastInstant)).toBe(true);
    }
  });
});

describe('hours that cannot produce a slot are refused', () => {
  const bad: Array<[string, ServiceHours]> = [
    ['closing before opening', { openHour: 17, closeHour: 9, days: [1] }],
    ['closing at the opening hour', { openHour: 9, closeHour: 9, days: [1] }],
    ['no days at all', { openHour: 9, closeHour: 17, days: [] }],
    ['a day outside 0-6', { openHour: 9, closeHour: 17, days: [7] }],
    ['an hour outside the clock', { openHour: -1, closeHour: 17, days: [1] }],
  ];

  it.each(bad)('rejects %s', (_label, hours) => {
    expect(() => assertUsableServiceHours(hours)).toThrow();
  });

  it('refuses rather than silently falling back, because the fallback would offer times nobody agreed to', async () => {
    await expect(
      findAvailableSlots(noBusy, 30, 5, { openHour: 17, closeHour: 9, days: [1] })
    ).rejects.toThrow(/closeHour/);
  });
});

describe('reading an agency’s hours', () => {
  const reader = (row: any) => ({ organization: { findUnique: async () => row } }) as any;

  it('uses what the agency configured', async () => {
    const hours = await serviceHoursFrom(
      reader({ openingHour: 6, closingHour: 22, serviceDays: [0, 6] }),
      'org-1'
    );
    expect(hours).toEqual({ openHour: 6, closeHour: 22, days: [0, 6] });
  });

  it('falls back to the default for an agency that does not exist', async () => {
    expect(await serviceHoursFrom(reader(null), 'missing')).toEqual(DEFAULT_SERVICE_HOURS);
  });

  it('falls back rather than throwing on an unusable row', async () => {
    // Written directly to the database, bypassing the settings validation.
    const hours = await serviceHoursFrom(
      reader({ openingHour: 20, closingHour: 4, serviceDays: [1] }),
      'org-1'
    );
    expect(hours).toEqual(DEFAULT_SERVICE_HOURS);
  });

  it('never throws into a live conversation when the query itself fails', async () => {
    const exploding = {
      organization: {
        findUnique: async () => {
          throw new Error('connection lost');
        },
      },
    } as any;
    expect(await serviceHoursFrom(exploding, 'org-1')).toEqual(DEFAULT_SERVICE_HOURS);
  });
});
