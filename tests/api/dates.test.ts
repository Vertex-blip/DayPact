import { describe, expect, it } from 'vitest';
import { validDate, occurs, wallTime, nextReminder, isQuiet } from '../../src/api/domain/dates';
describe('calendar recurrence', () => {
  it('validates actual leap days', () => {
    expect(validDate('2024-02-29')).toBe(true);
    expect(validDate('2025-02-29')).toBe(false);
    expect(validDate('2026-04-31')).toBe(false);
  });
  it('clamps monthly plans to the last day in short months', () => {
    expect(occurs('2026-01-31', 'monthly', '2026-02-28')).toBe(true);
    expect(occurs('2026-01-31', 'monthly', '2026-03-28')).toBe(false);
    expect(occurs('2026-01-31', 'monthly', '2026-03-31')).toBe(true);
  });
  it('does not shift weekly recurrence', () => {
    expect(occurs('2026-11-19', 'weekly', '2026-11-26')).toBe(true);
    expect(occurs('2026-11-19', 'weekly', '2026-11-25')).toBe(false);
  });
  it('uses current Kazakhstan timezone and overnight quiet hours', () => {
    expect(wallTime('2026-11-19', '19:00', 'Asia/Almaty').toISOString()).toBe(
      '2026-11-19T14:00:00.000Z',
    );
    expect(
      isQuiet(new Date('2026-11-19T19:00:00Z'), {
        timeZone: 'Asia/Almaty',
        quietStart: '22:00',
        quietEnd: '08:00',
      }),
    ).toBe(true);
  });
  it('advances a due occurrence and respects disabled reminders', () => {
    const p = {
      start_date: '2026-11-19',
      cadence: 'daily' as const,
      time: '19:00',
      time_zone: 'Asia/Almaty',
      remind_minutes: 15,
    };
    expect(nextReminder(p, new Date('2026-11-19T13:45:00Z'))).toEqual({
      at: '2026-11-20T13:45:00.000Z',
      date: '2026-11-20',
    });
    expect(nextReminder({ ...p, remind_minutes: -1 }, new Date())).toBeNull();
  });
});
