import type {
  StudyData,
  StudyHoliday,
  StudyLesson,
  StudyOccurrence,
  StudyOverride,
  StudyPeriod,
  StudyTerm,
} from './study';

const dayMillis = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function studyValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const value = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date;
}

export function studyAddDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMillis).toISOString().slice(0, 10);
}

/** Monday=1, Sunday=7. All date-only arithmetic is independent of the device timezone. */
export function studyWeekday(date: string): number {
  const value = new Date(`${date}T00:00:00Z`).getUTCDay();
  return value === 0 ? 7 : value;
}

export function studyWeekDates(date: string): string[] {
  if (!studyValidDate(date)) return [];
  const monday = studyAddDays(date, 1 - studyWeekday(date));
  return Array.from({ length: 7 }, (_, index) => studyAddDays(monday, index));
}

export function studyLocalParts(at: Date, zone: string): { date: string; time: string } {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= 32) formatters.clear();
    formatters.set(zone, formatter);
  }
  const values = formatter.formatToParts(at);
  const part = (name: string) => values.find((value) => value.type === name)!.value;
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}

/** Resolve IANA wall time; DST gaps move forward to the next representable wall minute. */
export function studyWallInstant(date: string, time: string, zone: string): Date {
  const wall = Date.parse(`${date}T${time}:00Z`);
  let guess = wall;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = studyLocalParts(new Date(guess), zone);
    const adjustment = wall - Date.parse(`${parts.date}T${parts.time}:00Z`);
    if (adjustment === 0) return new Date(guess);
    guess += adjustment;
  }
  const candidates = [guess, guess + 3_600_000, guess - 3_600_000].sort((a, b) => a - b);
  return new Date(
    candidates.find((candidate) => {
      const parts = studyLocalParts(new Date(candidate), zone);
      return `${parts.date}T${parts.time}` >= `${date}T${time}`;
    }) ?? guess,
  );
}

/** Week one is the calendar week containing the teaching start; holidays never reset it. */
export function studyWeekNumber(term: StudyTerm, date: string): number | null {
  if (!studyValidDate(date) || date < term.startDate || date > term.endDate) return null;
  const monday = studyAddDays(term.startDate, 1 - studyWeekday(term.startDate));
  return (
    Math.floor(
      (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / (7 * dayMillis),
    ) + 1
  );
}

export interface StudyDayState {
  withinTerm: boolean;
  holiday: StudyHoliday | null;
  period: StudyPeriod | null;
  suppressed: boolean;
}

export function studyDayState(data: StudyData, date: string): StudyDayState {
  const valid = studyValidDate(date);
  const withinTerm = valid && date >= data.term.startDate && date <= data.term.endDate;
  const holiday = data.term.holidays.find((item) => item.date === date) ?? null;
  const periods = data.term.periods.filter(
    (item) => date >= item.startDate && date <= item.endDate,
  );
  const period =
    periods.find((item) => item.kind === 'vacation') ??
    periods.find((item) => item.kind === 'exams') ??
    periods[0] ??
    null;
  return {
    withinTerm,
    holiday,
    period,
    suppressed: !withinTerm || !!holiday || period?.kind === 'exams' || period?.kind === 'vacation',
  };
}

function occurrence(
  data: StudyData,
  lesson: StudyLesson,
  date: string,
  override: StudyOverride | undefined,
  state = studyDayState(data, date),
): StudyOccurrence | null {
  if (!state.withinTerm || lesson.weekday !== studyWeekday(date)) return null;
  // An explicit dated entry represents a confirmed exception, even on a holiday.
  if (state.suppressed && !override) return null;
  return {
    ...lesson,
    ...(override
      ? {
          startTime: override.startTime,
          endTime: override.endTime,
          room: override.room,
          campus: override.campus,
          format: override.format,
          url: override.url,
        }
      : {}),
    date,
    cancelled: override?.cancelled ?? false,
    modified: !!override,
    note: override?.note ?? '',
  };
}

export function studyOccurrences(data: StudyData, date: string): StudyOccurrence[] {
  const state = studyDayState(data, date);
  if (!state.withinTerm) return [];
  const overrides = new Map(
    data.overrides.filter((item) => item.date === date).map((item) => [item.lessonId, item]),
  );
  return data.lessons
    .map((lesson) => occurrence(data, lesson, date, overrides.get(lesson.id), state))
    .filter((lesson): lesson is StudyOccurrence => lesson !== null)
    .sort(
      (a, b) =>
        a.startTime.localeCompare(b.startTime) ||
        a.endTime.localeCompare(b.endTime) ||
        a.id.localeCompare(b.id),
    );
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

export interface StudyOccurrenceGroup extends StudyOccurrence {
  items: StudyOccurrence[];
  count: number;
}

export function studyGroupOccurrences(items: StudyOccurrence[]): StudyOccurrenceGroup[] {
  const groups: StudyOccurrenceGroup[] = [];
  const sorted = [...items].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.startTime.localeCompare(b.startTime) ||
      a.id.localeCompare(b.id),
  );
  for (const item of sorted) {
    const last = groups.at(-1);
    const gap = last ? minutes(item.startTime) - minutes(last.endTime) : Infinity;
    const matches =
      last &&
      [
        'date',
        'title',
        'teacher',
        'room',
        'campus',
        'kind',
        'format',
        'url',
        'cancelled',
        'modified',
        'note',
      ].every((key) => last[key as keyof StudyOccurrence] === item[key as keyof StudyOccurrence]);
    if (last && matches && gap >= 0 && gap <= 15) {
      last.items.push(item);
      last.count++;
      last.endTime = item.endTime;
    } else groups.push({ ...item, items: [item], count: 1 });
  }
  return groups;
}

function searchable(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[\s._–—-]+/g, '')
    .trim();
}

export function studyMatchesQuery(item: StudyLesson, query: string): boolean {
  const terms = query.trim().split(/\s+/).filter(Boolean).map(searchable);
  const haystack = [item.title, item.teacher, item.room, item.campus].map(searchable).join(' ');
  return terms.every((term) => haystack.includes(term));
}

/** Meeting time is interpreted in its own zone, then compared with actual study instants. */
export function studyConflictsAt(
  data: StudyData,
  date: string,
  time: string,
  zone: string,
): StudyOccurrence[] {
  if (!studyValidDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return [];
  const instant = studyWallInstant(date, time, zone);
  const studyDate = studyLocalParts(instant, data.term.timeZone).date;
  return studyOccurrences(data, studyDate).filter(
    (item) =>
      !item.cancelled &&
      instant >= studyWallInstant(studyDate, item.startTime, data.term.timeZone) &&
      instant < studyWallInstant(studyDate, item.endTime, data.term.timeZone),
  );
}

function eachNextCandidate(
  data: StudyData,
  baseDate: string,
  accept: (item: StudyOccurrence) => boolean,
): StudyOccurrence[] {
  const start = baseDate < data.term.startDate ? data.term.startDate : baseDate;
  if (start > data.term.endDate) return [];
  const overrideIndex = new Map(
    data.overrides.map((item) => [`${item.date}:${item.lessonId}`, item]),
  );
  const stateCache = new Map<string, StudyDayState>();
  const candidates: StudyOccurrence[] = [];
  for (const lesson of data.lessons) {
    const offset = (lesson.weekday - studyWeekday(start) + 7) % 7;
    let date = studyAddDays(start, offset);
    // Validated terms span at most 730 days. The cap also bounds damaged cached input.
    for (
      let attempts = 0;
      date <= data.term.endDate && attempts <= 105;
      attempts++, date = studyAddDays(date, 7)
    ) {
      let state = stateCache.get(date);
      if (!state) {
        state = studyDayState(data, date);
        stateCache.set(date, state);
      }
      const item = occurrence(data, lesson, date, overrideIndex.get(`${date}:${lesson.id}`), state);
      if (item && !item.cancelled && accept(item)) {
        candidates.push(item);
        break;
      }
    }
  }
  return candidates;
}

/** Includes a lesson currently in progress; callers can label it using start/end instants. */
export function nextStudyOccurrence(data: StudyData, after: Date): StudyOccurrence | null {
  const local = studyLocalParts(after, data.term.timeZone);
  const candidates = eachNextCandidate(
    data,
    local.date,
    (item) => studyWallInstant(item.date, item.endTime, data.term.timeZone) > after,
  );
  return (
    candidates.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.startTime.localeCompare(b.startTime) ||
        a.id.localeCompare(b.id),
    )[0] ?? null
  );
}

export interface StudyReminderCursor {
  at: string;
  date: string;
  lessonId: string;
}

/** Strictly after `after`. A dispatcher must enqueue all occurrences sharing the returned time. */
export function nextStudyReminder(data: StudyData, after: Date): StudyReminderCursor | null {
  if (data.term.remindMinutes < 0) return null;
  const base = studyLocalParts(
    new Date(after.getTime() + data.term.remindMinutes * 60_000),
    data.term.timeZone,
  ).date;
  const reminderAt = (item: StudyOccurrence) =>
    new Date(
      studyWallInstant(item.date, item.startTime, data.term.timeZone).getTime() -
        data.term.remindMinutes * 60_000,
    );
  const candidates = eachNextCandidate(data, base, (item) => reminderAt(item) > after).map(
    (item) => ({ at: reminderAt(item).toISOString(), date: item.date, lessonId: item.id }),
  );
  return (
    candidates.sort(
      (a, b) => a.at.localeCompare(b.at) || a.lessonId.localeCompare(b.lessonId),
    )[0] ?? null
  );
}
