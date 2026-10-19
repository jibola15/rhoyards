/** The time zone that defines the business day. Set once at start-up from BUSINESS_TIMEZONE. */
let timeZone = 'Africa/Lagos';

export function setBusinessTimeZone(tz: string): void {
  // Throws on an unknown zone, so misconfiguration fails at start-up rather than at the first sale.
  new Intl.DateTimeFormat('en-GB', { timeZone: tz });
  timeZone = tz;
}

/** The instant a business day (YYYY-MM-DD) starts, e.g. 2026-10-21 → 2026-10-20T23:00:00Z for Lagos (UTC+1). */
export function startOfBusinessDay(isoDate: string): Date {
  const utcMidnight = new Date(`${isoDate}T00:00:00Z`);
  const wall = (tz: string) => new Date(utcMidnight.toLocaleString('en-US', { timeZone: tz })).getTime();
  return new Date(utcMidnight.getTime() - (wall(timeZone) - wall('UTC')));
}

/** Today's calendar date in the business time zone, as a UTC-midnight Date (for DATE columns). */
export function businessDate(at: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return new Date(`${parts}T00:00:00Z`);
}
