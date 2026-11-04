/**
 * When the platform may contact a citizen.
 *
 * ── What went wrong without this ────────────────────────────────────────────
 *
 * Callbacks were clamped into the agency's SERVING hours — the hours an
 * appointment may be offered. That worked by accident, because serving hours
 * happened to be 08:00–18:00.
 *
 * The moment an agency set serving hours to 0–24 for a round-the-clock
 * helpline, the clamp went inert: a promise made at 02:00 for "within the
 * hour" fell due at 03:00, and the dispatcher would have dialled it. Nobody
 * decided that; it fell out of conflating two different questions.
 *
 * So the two are separate, and the defaults are chosen so that nothing
 * changes for an agency that configures nothing.
 */
import {
  outboundHoursOf,
  mayContactNow,
  assertUsableOutboundHours,
} from '../src/outbound-hours';

const SERVING = { openingHour: 8, closingHour: 18, serviceDays: [1, 2, 3, 4, 5] };
const UNSET = { outboundOpeningHour: null, outboundClosingHour: null, outboundDays: [] };

/** 2026-11-03 is a Tuesday. WAT is UTC+1. */
const watAt = (hour: number, day = 3) => new Date(Date.UTC(2026, 10, day, hour - 1, 0));

describe('falling back to serving hours', () => {
  it('uses serving hours when no window is configured', () => {
    expect(outboundHoursOf({ ...SERVING, ...UNSET })).toEqual({
      openHour: 8,
      closeHour: 18,
      days: [1, 2, 3, 4, 5],
    });
  });

  it('still falls back when only the opening hour was set', () => {
    // A half-filled configuration is not a configuration. The closing hour is
    // the flag; a stray opening hour from an abandoned edit must not apply a
    // window nobody chose.
    expect(
      outboundHoursOf({ ...SERVING, outboundOpeningHour: 7, outboundClosingHour: null, outboundDays: [] })
    ).toEqual({ openHour: 8, closeHour: 18, days: [1, 2, 3, 4, 5] });
  });

  it('falls back rather than stranding the queue on an impossible window', () => {
    // The settings endpoint rejects these, so a row holding one was written
    // directly. Honouring it would stop every callback, silently and forever.
    expect(
      outboundHoursOf({ ...SERVING, outboundOpeningHour: 9, outboundClosingHour: 9, outboundDays: [1] })
    ).toEqual({ openHour: 8, closeHour: 18, days: [1, 2, 3, 4, 5] });
  });
});

describe('a configured window', () => {
  const NIGHT_SAFE = { outboundOpeningHour: 8, outboundClosingHour: 20, outboundDays: [1, 2, 3, 4, 5] };

  it('is used instead of serving hours', () => {
    expect(outboundHoursOf({ ...SERVING, ...NIGHT_SAFE })).toEqual({
      openHour: 8,
      closeHour: 20,
      days: [1, 2, 3, 4, 5],
    });
  });

  it('borrows the serving days when no days are chosen', () => {
    expect(
      outboundHoursOf({ ...SERVING, outboundOpeningHour: 8, outboundClosingHour: 20, outboundDays: [] })
    ).toEqual({ openHour: 8, closeHour: 20, days: [1, 2, 3, 4, 5] });
  });

  it('survives the 24/7 serving hours that caused this', () => {
    // The real case: the agency answers around the clock, but may only ring
    // between 08:00 and 20:00.
    const roundTheClock = { openingHour: 0, closingHour: 24, serviceDays: [0, 1, 2, 3, 4, 5, 6] };
    const hours = outboundHoursOf({ ...roundTheClock, ...NIGHT_SAFE });

    expect(mayContactNow(hours, watAt(3))).toBe(false);   // 03:00 — asleep
    expect(mayContactNow(hours, watAt(9))).toBe(true);    // 09:00 — fine
    expect(mayContactNow(hours, watAt(19))).toBe(true);   // 19:00 — fine
    expect(mayContactNow(hours, watAt(21))).toBe(false);  // 21:00 — too late
  });

  it('refuses a day the agency does not take calls on', () => {
    const hours = outboundHoursOf({ ...SERVING, ...NIGHT_SAFE });
    expect(mayContactNow(hours, watAt(10, 8))).toBe(false); // Sunday
    expect(mayContactNow(hours, watAt(10, 3))).toBe(true);  // Tuesday
  });
});

describe('what the settings endpoint will accept', () => {
  it('allows clearing it back to "same as serving hours"', () => {
    // An agency must be able to undo this without knowing what its serving
    // hours are.
    expect(() => assertUsableOutboundHours({ outboundClosingHour: null })).not.toThrow();
    expect(() => assertUsableOutboundHours({})).not.toThrow();
  });

  it('accepts a sane window', () => {
    expect(() =>
      assertUsableOutboundHours({ outboundOpeningHour: 8, outboundClosingHour: 20, outboundDays: [1, 2, 3] })
    ).not.toThrow();
  });

  it('refuses a window that can never open', () => {
    expect(() =>
      assertUsableOutboundHours({ outboundOpeningHour: 20, outboundClosingHour: 8 })
    ).toThrow(/must be after/i);
  });

  it('refuses hours outside the clock', () => {
    expect(() => assertUsableOutboundHours({ outboundOpeningHour: -1, outboundClosingHour: 20 })).toThrow();
    expect(() => assertUsableOutboundHours({ outboundOpeningHour: 8, outboundClosingHour: 25 })).toThrow();
  });

  it('refuses a day that is not a day', () => {
    expect(() =>
      assertUsableOutboundHours({ outboundOpeningHour: 8, outboundClosingHour: 20, outboundDays: [7] })
    ).toThrow(/0-6/);
  });
});
