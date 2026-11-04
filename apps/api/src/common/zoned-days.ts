/**
 * Day bucketing in the AGENCY's timezone, not the server's.
 *
 * The dashboard trend was built with `toLocaleDateString()` and
 * `Date.now() - days * 86400000`, both of which read the process timezone.
 * Render runs UTC and `Organization.timezone` defaults to Africa/Lagos, so a
 * conversation at 00:30 in Jos was counted on the previous day and the
 * "last 7 days" window started at whatever time of day the officer happened
 * to open the page. Two officers refreshing an hour apart saw different
 * per-day numbers for days that had long since ended.
 */

/** Milliseconds to add to a UTC instant to get the wall clock in `tz`. */
export function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const f: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') f[p.type] = p.value;

  const asIfUtc = Date.UTC(
    Number(f.year),
    Number(f.month) - 1,
    Number(f.day),
    // Intl emits "24" for midnight in some ICU versions.
    f.hour === '24' ? 0 : Number(f.hour),
    Number(f.minute),
    Number(f.second),
  );
  return asIfUtc - at.getTime();
}

/** `YYYY-MM-DD` for the wall-clock date of `at` in `tz`. Sorts chronologically. */
export function zonedDayKey(at: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD, which is what makes this key sortable.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** The UTC instant at which the local day `key` begins in `tz`. */
export function zonedDayStart(key: string, tz: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  // One correction pass is enough away from a transition; a second settles the
  // case where the first guess landed on the other side of one.
  let instant = new Date(naive - tzOffsetMs(new Date(naive), tz));
  instant = new Date(naive - tzOffsetMs(instant, tz));
  return instant;
}

/** Add `n` days to a `YYYY-MM-DD` key, staying a calendar day in `tz`. */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d + n));
  return moved.toISOString().slice(0, 10);
}

/**
 * The `days` calendar days ending today in `tz`, oldest first, with the UTC
 * instant the window opens — so the window and the buckets cannot disagree.
 */
export function zonedWindow(days: number, tz: string, now: Date = new Date()) {
  const today = zonedDayKey(now, tz);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(addDays(today, -i));
  return { keys, since: zonedDayStart(keys[0], tz) };
}

/** How a day is labelled on the chart axis. */
export function zonedDayLabel(key: string, days: number, tz: string): string {
  const at = zonedDayStart(key, tz);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    ...(days <= 7 ? { weekday: 'short' as const } : { day: 'numeric' as const, month: 'short' as const }),
  }).format(at);
}
