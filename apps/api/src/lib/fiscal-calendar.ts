import type { Db } from './prisma';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

/** FY2026 for a calendar year; FY2026/27 when the year starts in another month. */
export function fiscalYearName(startYear: number, startMonth: number): string {
  return startMonth === 1 ? `FY${startYear}` : `FY${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Creates a fiscal year with 12 monthly periods if it does not exist. */
export async function ensureFiscalYear(db: Db, startYear: number, startMonth: number) {
  const start = utcDate(startYear, startMonth - 1, 1);
  const end = utcDate(startYear + 1, startMonth - 1, 0);
  const name = fiscalYearName(startYear, startMonth);
  const existing = await db.fiscalYear.findUnique({ where: { name } });
  if (existing) return existing;

  return db.fiscalYear.create({
    data: {
      name,
      startDate: start,
      endDate: end,
      periods: {
        create: Array.from({ length: 12 }, (_, i) => {
          const m = startMonth - 1 + i;
          const pStart = utcDate(startYear, m, 1);
          const pEnd = utcDate(startYear, m + 1, 0);
          return {
            name: `${MONTHS[pStart.getUTCMonth()]} ${pStart.getUTCFullYear()}`,
            startDate: pStart,
            endDate: pEnd,
          };
        }),
      },
    },
  });
}
