import { describe, expect, it } from 'vitest';
import { DASHBOARD_PERIODS, dashboardPeriodRange } from './reporting';

describe('dashboard periods', () => {
  // A Wednesday in the middle of a quarter.
  const wed = '2026-11-18';

  it('covers days and weeks, with weeks starting on Monday', () => {
    expect(dashboardPeriodRange('today', wed)).toEqual({ from: wed, to: wed });
    expect(dashboardPeriodRange('yesterday', wed)).toEqual({ from: '2026-11-17', to: '2026-11-17' });
    expect(dashboardPeriodRange('this_week', wed)).toEqual({ from: '2026-11-16', to: wed });
    expect(dashboardPeriodRange('last_week', wed)).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    // On a Monday "this week" is just today; on a Sunday it is the whole week.
    expect(dashboardPeriodRange('this_week', '2026-11-16')).toEqual({ from: '2026-11-16', to: '2026-11-16' });
    expect(dashboardPeriodRange('this_week', '2026-11-22')).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(dashboardPeriodRange('last_30_days', wed)).toEqual({ from: '2026-10-20', to: wed });
  });

  it('covers months, quarters and years, across a year boundary', () => {
    expect(dashboardPeriodRange('this_month', wed)).toEqual({ from: '2026-11-01', to: wed });
    expect(dashboardPeriodRange('last_month', wed)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(dashboardPeriodRange('this_quarter', wed)).toEqual({ from: '2026-10-01', to: wed });
    expect(dashboardPeriodRange('last_quarter', wed)).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(dashboardPeriodRange('this_year', wed)).toEqual({ from: '2026-01-01', to: wed });
    expect(dashboardPeriodRange('last_year', wed)).toEqual({ from: '2025-01-01', to: '2025-12-31' });

    const jan = '2027-01-05';
    expect(dashboardPeriodRange('last_month', jan)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(dashboardPeriodRange('last_quarter', jan)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(dashboardPeriodRange('last_week', '2027-01-01')).toEqual({ from: '2026-12-21', to: '2026-12-27' });
    // February in a leap year.
    expect(dashboardPeriodRange('last_month', '2028-03-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('never ends after today', () => {
    for (const p of DASHBOARD_PERIODS) {
      const r = dashboardPeriodRange(p, wed);
      expect(r.from <= r.to && r.to <= wed).toBe(true);
    }
  });
});
