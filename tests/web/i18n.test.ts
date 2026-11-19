import { describe, expect, it } from 'vitest';
import { dateLabel, localDate, shiftDate } from '../../src/web/i18n';

describe('localized calendar', () => {
  it('always supplies Kazakh weekday/month text even on browsers without Kazakh date data', () => {
    expect(dateLabel('2026-11-19', 'kk')).toBe('Бейсенбі, 19 қараша');
    expect(dateLabel('2026-11-19', 'kk', { weekday: 'short' })).toBe('Бс');
    expect(dateLabel('2026-11-19', 'ru')).toBe('Четверг, 19 ноября');
  });
  it('keeps occurrence dates stable across month and local midnight boundaries', () => {
    expect(shiftDate('2026-11-30', 1)).toBe('2026-12-01');
    expect(localDate('Asia/Almaty', new Date('2026-11-19T19:30:00Z'))).toBe('2026-11-20');
  });
});
