import { describe, expect, it } from 'vitest';
import { createStudySeed } from '../fixtures/study';
import type { StudyData, StudyOverride } from '../../src/shared/study';
import {
  nextStudyOccurrence,
  nextStudyReminder,
  studyConflictsAt,
  studyDayState,
  studyGroupOccurrences,
  studyLocalParts,
  studyMatchesQuery,
  studyOccurrences,
  studyWeekDates,
  studyWeekNumber,
  studyWeekday,
  studyWallInstant,
} from '../../src/shared/studyTime';

function exception(
  data: StudyData,
  date: string,
  lessonId: string,
  changes: Partial<StudyOverride> = {},
): StudyOverride {
  const lesson = data.lessons.find((item) => item.id === lessonId)!;
  return {
    lessonId,
    date,
    cancelled: false,
    startTime: lesson.startTime,
    endTime: lesson.endTime,
    room: lesson.room,
    campus: lesson.campus,
    format: lesson.format,
    url: lesson.url,
    note: '',
    ...changes,
  };
}

describe('study timetable domain', () => {
  it('preserves lesson fields and marks incomplete days without inventing classes', () => {
    const data = createStudySeed();
    expect(data.lessons).toHaveLength(23);
    expect(
      [1, 2, 3, 4, 5, 6, 7].map(
        (day) => data.lessons.filter((item) => item.weekday === day).length,
      ),
    ).toEqual([9, 3, 4, 6, 1, 0, 0]);
    expect(data.term.incompleteDays.map((item) => item.weekday)).toEqual([3, 6, 7]);
    expect(data.term.incompleteDays[0].expectedCount).toBe(6);
    expect(data.term.incompleteDays[1].firstTime).toBe('11:00');
    expect(
      data.lessons.filter((item) => item.weekday === 3).every((item) => item.startTime < '18:00'),
    ).toBe(true);
    const monday = studyOccurrences(data, '2026-12-07');
    expect(monday[2]).toMatchObject({ startTime: '13:05', endTime: '13:55', room: 'A1.1.101' });
    expect(monday[8].endTime).toBe('19:50');
    expect(data.term.roomInPush).toBe(false);
  });

  it('uses academic dates and the requested Midterm, Endterm, Finals labels', () => {
    const data = createStudySeed();
    expect(data.term).toMatchObject({ startDate: '2026-12-07', endDate: '2027-02-13' });
    expect(
      data.term.periods
        .slice(0, 3)
        .map((period) => [period.title, period.startDate, period.endDate]),
    ).toEqual([
      ['Midterm', '2027-01-04', '2027-01-09'],
      ['Endterm', '2027-02-08', '2027-02-13'],
      ['Finals', '2027-02-15', '2027-02-27'],
    ]);
    expect(data.term.periods[3]).toMatchObject({
      startDate: '2027-03-01',
      endDate: '2027-03-13',
      kind: 'vacation',
    });
  });

  it('makes Monday-based week ranges and keeps week numbering across holidays', () => {
    const term = createStudySeed().term;
    expect(studyWeekday('2026-12-07')).toBe(1);
    expect(studyWeekday('2026-12-13')).toBe(7);
    expect(studyWeekDates('2026-12-09')).toEqual([
      '2026-12-07',
      '2026-12-08',
      '2026-12-09',
      '2026-12-10',
      '2026-12-11',
      '2026-12-12',
      '2026-12-13',
    ]);
    expect(studyWeekNumber(term, '2026-11-23')).toBeNull();
    expect(studyWeekNumber(term, '2026-12-07')).toBe(1);
    expect(studyWeekNumber(term, '2026-12-14')).toBe(2);
    expect(studyWeekNumber(term, '2027-01-04')).toBe(5);
    expect(studyWeekNumber(term, '2027-02-13')).toBe(10);
    expect(studyWeekNumber(term, '2027-02-15')).toBeNull();
  });

  it('does not repeat classes outside teaching dates or on holidays; assessment keeps classes', () => {
    const data = createStudySeed();
    expect(studyOccurrences(data, '2026-11-23')).toEqual([]);
    expect(studyOccurrences(data, '2026-12-16')).toEqual([]);
    expect(studyOccurrences(data, '2027-01-07')).toEqual([]);
    expect(studyOccurrences(data, '2027-02-15')).toEqual([]);
    expect(studyOccurrences(data, '2027-03-01')).toEqual([]);
    expect(studyOccurrences(data, '2027-01-04')).toHaveLength(9);
    expect(studyDayState(data, '2027-01-04').period?.title).toBe('Midterm');
    expect(studyDayState(data, '2027-02-08').period?.title).toBe('Endterm');
    expect(studyDayState(data, '2027-02-15')).toMatchObject({
      withinTerm: false,
      suppressed: true,
      period: { title: 'Finals' },
    });
  });

  it('suppresses configured exams or vacation even if those dates overlap teaching range', () => {
    const data = createStudySeed();
    data.term.periods.push({
      id: 'extra',
      kind: 'exams',
      title: 'Exam day',
      startDate: '2026-12-08',
      endDate: '2026-12-08',
    });
    expect(studyOccurrences(data, '2026-12-08')).toEqual([]);
    data.term.periods[4].kind = 'vacation';
    expect(studyOccurrences(data, '2026-12-08')).toEqual([]);
  });

  it('applies changes or cancellation only to the requested dated occurrence', () => {
    const data = createStudySeed(),
      lesson = data.lessons[2];
    data.overrides.push(
      exception(data, '2026-12-07', lesson.id, { room: 'C1.1.999', note: 'Room changed' }),
    );
    expect(
      studyOccurrences(data, '2026-12-07').find((item) => item.id === lesson.id),
    ).toMatchObject({ room: 'C1.1.999', modified: true });
    expect(
      studyOccurrences(data, '2026-12-14').find((item) => item.id === lesson.id),
    ).toMatchObject({ room: 'A1.1.101', modified: false });
    data.overrides[0].cancelled = true;
    expect(
      studyOccurrences(data, '2026-12-07').find((item) => item.id === lesson.id)?.cancelled,
    ).toBe(true);
    expect(studyConflictsAt(data, '2026-12-07', '13:10', 'Asia/Almaty')).toEqual([]);
  });

  it('allows an explicit confirmed holiday exception but never extends the teaching range', () => {
    const data = createStudySeed(),
      lesson = data.lessons.find((item) => item.weekday === 3)!;
    data.overrides.push(
      exception(data, '2026-12-16', lesson.id, { note: 'Confirmed make-up class' }),
    );
    expect(studyOccurrences(data, '2026-12-16')).toHaveLength(1);
    data.overrides.push(exception(data, '2027-02-17', lesson.id));
    expect(studyOccurrences(data, '2027-02-17')).toEqual([]);
  });

  it('groups adjacent identical lessons without concealing individual periods or mutating input', () => {
    const input = studyOccurrences(createStudySeed(), '2026-12-07');
    const before = JSON.stringify(input),
      groups = studyGroupOccurrences(input);
    expect(groups.map((item) => item.count)).toEqual([2, 1, 2, 2, 2]);
    expect(groups[2]).toMatchObject({ startTime: '14:00', endTime: '15:50', room: 'A1.3.202 lab' });
    expect(groups[2].items.map((item) => item.startTime)).toEqual(['14:00', '15:00']);
    expect(JSON.stringify(input)).toBe(before);
    input[4].room = 'changed';
    expect(studyGroupOccurrences(input)).toHaveLength(6);
  });

  it('searches title, teacher and room using case-insensitive normalized terms', () => {
    const data = createStudySeed();
    expect(studyMatchesQuery(data.lessons[3], '202')).toBe(true);
    expect(studyMatchesQuery(data.lessons[3], 'a1 3 202')).toBe(true);
    expect(studyMatchesQuery(data.lessons[2], 'ПРЕПОДАВАТЕЛЬ А')).toBe(true);
    expect(studyMatchesQuery(data.lessons[2], 'математика 101')).toBe(true);
    expect(studyMatchesQuery(data.lessons[2], 'несуществующий')).toBe(false);
    expect(studyMatchesQuery(data.lessons[2], '')).toBe(true);
  });

  it('compares meeting instants across zones and treats the end minute as free', () => {
    const data = createStudySeed();
    expect(studyWallInstant('2026-12-07', '13:05', 'Asia/Almaty').toISOString()).toBe(
      '2026-12-07T08:05:00.000Z',
    );
    expect(studyLocalParts(new Date('2026-12-07T08:05:00Z'), 'Asia/Almaty')).toEqual({
      date: '2026-12-07',
      time: '13:05',
    });
    expect(studyConflictsAt(data, '2026-12-07', '08:05', 'UTC')).toHaveLength(1);
    expect(studyConflictsAt(data, '2026-12-07', '13:55', 'Asia/Almaty')).toHaveLength(0);
    expect(studyConflictsAt(data, '2026-12-06', '22:05', 'America/New_York')).toHaveLength(1);
    expect(studyConflictsAt(data, '2026-12-07', '12:50', 'Asia/Almaty')).toHaveLength(0);
  });

  it('finds the current or next class and skips cancelled entries', () => {
    const data = createStudySeed();
    expect(nextStudyOccurrence(data, new Date('2026-11-23T10:00:00Z'))).toMatchObject({
      date: '2026-12-07',
      startTime: '08:00',
    });
    expect(nextStudyOccurrence(data, new Date('2026-12-07T08:10:00Z'))).toMatchObject({
      startTime: '13:05',
    });
    expect(nextStudyOccurrence(data, new Date('2026-12-07T08:55:00Z'))).toMatchObject({
      startTime: '14:00',
    });
    data.overrides.push(exception(data, '2026-12-07', data.lessons[0].id, { cancelled: true }));
    expect(nextStudyOccurrence(data, new Date('2026-12-07T02:00:00Z'))).toMatchObject({
      startTime: '09:00',
    });
    expect(nextStudyOccurrence(data, new Date('2027-02-14T00:00:00Z'))).toBeNull();
  });

  it('schedules reminders strictly after the cursor and stops at the trimester end', () => {
    const data = createStudySeed();
    expect(nextStudyReminder(data, new Date('2026-11-23T10:00:00Z'))).toMatchObject({
      at: '2026-12-07T02:45:00.000Z',
      date: '2026-12-07',
      lessonId: data.lessons[0].id,
    });
    expect(nextStudyReminder(data, new Date('2026-12-07T02:45:00Z'))).toMatchObject({
      at: '2026-12-07T03:45:00.000Z',
      lessonId: data.lessons[1].id,
    });
    expect(nextStudyReminder(data, new Date('2027-01-07T00:00:00Z'))).toMatchObject({
      date: '2027-01-08',
    });
    expect(nextStudyReminder(data, new Date('2027-02-13T00:00:00Z'))).toBeNull();
    data.term.remindMinutes = -1;
    expect(nextStudyReminder(data, new Date('2026-12-07T00:00:00Z'))).toBeNull();
  });

  it('resolves equal-time reminders deterministically without changing the lesson IDs', () => {
    const data = createStudySeed();
    data.lessons.push({ ...data.lessons[0], id: '00000000-0000-4000-8000-000000000001' });
    expect(nextStudyReminder(data, new Date('2026-12-07T00:00:00Z'))?.lessonId).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(
      studyOccurrences(data, '2026-12-07').filter((item) => item.startTime === '08:00'),
    ).toHaveLength(2);
  });
});
