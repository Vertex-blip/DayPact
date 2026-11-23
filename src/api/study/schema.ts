import { z } from 'zod';
import type { StudyData } from '../../shared/study';
import { validDate, validZone } from '../domain/dates';

export const STUDY_MAX_BYTES = 48 * 1024;
const date = z.string().refine(validDate, 'Use a valid calendar date.');
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const weekday = z.number().int().min(1).max(7);
const id = z.string().uuid();
const text = (length: number) => z.string().trim().max(length);
const title = text(120).min(1);
const url = text(512).refine((value) => {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password
    );
  } catch {
    return false;
  }
}, 'Use an HTTPS link without embedded credentials.');

export const studyLessonSchema = z
  .object({
    id,
    weekday,
    startTime: time,
    endTime: time,
    title,
    teacher: text(100),
    room: text(80),
    campus: text(120),
    kind: z.enum(['lecture', 'practice', 'lab', 'other']),
    format: z.enum(['campus', 'online']),
    url,
  })
  .strict();
const period = z
  .object({
    id,
    title,
    kind: z.enum(['assessment', 'exams', 'vacation']),
    startDate: date,
    endDate: date,
  })
  .strict();
const holiday = z.object({ date, title }).strict();
const incomplete = z
  .object({
    weekday,
    note: text(400).min(1),
    expectedCount: z.number().int().min(1).max(30).nullable(),
    firstTime: time.nullable(),
  })
  .strict();
const term = z
  .object({
    title,
    institution: text(120),
    course: text(30),
    startDate: date,
    endDate: date,
    timeZone: z.string().min(1).max(80).refine(validZone, 'Unknown timezone.'),
    remindMinutes: z.union([
      z.literal(-1),
      z.literal(5),
      z.literal(10),
      z.literal(15),
      z.literal(30),
    ]),
    roomInPush: z.boolean(),
    periods: z.array(period).max(12),
    holidays: z.array(holiday).max(30),
    incompleteDays: z.array(incomplete).max(7),
  })
  .strict();
const override = z
  .object({
    lessonId: id,
    date,
    cancelled: z.boolean(),
    startTime: time,
    endTime: time,
    room: text(80),
    campus: text(120),
    format: z.enum(['campus', 'online']),
    url,
    note: text(500),
  })
  .strict();
const dayNumber = (value: string) => Date.parse(`${value}T00:00:00Z`) / 86400000;

/** Strict nested parsing is also the canonical serialization boundary for safe retries. */
export const studyDataSchema: z.ZodType<StudyData> = z
  .object({
    term,
    lessons: z.array(studyLessonSchema).max(50),
    overrides: z.array(override).max(120),
  })
  .strict()
  .superRefine((data, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const start = dayNumber(data.term.startDate),
      end = dayNumber(data.term.endDate);
    if (end < start || end - start > 730)
      issue(['term', 'endDate'], 'Teaching dates must be ordered and span at most 730 days.');
    const unique = <T>(values: T[], key: (value: T) => string | number, path: string[]) => {
      const keys = new Set<string | number>();
      values.forEach((value, index) => {
        const current = key(value);
        if (keys.has(current)) issue([...path, index], 'Duplicate entry.');
        keys.add(current);
      });
    };
    unique(data.lessons, (lesson) => lesson.id, ['lessons']);
    unique(data.term.periods, (item) => item.id, ['term', 'periods']);
    unique(data.term.holidays, (item) => item.date, ['term', 'holidays']);
    unique(data.term.incompleteDays, (item) => item.weekday, ['term', 'incompleteDays']);
    unique(data.overrides, (item) => `${item.lessonId}:${item.date}`, ['overrides']);
    const lessons = new Map(data.lessons.map((lesson) => [lesson.id, lesson]));
    data.lessons.forEach((lesson, index) => {
      if (lesson.endTime <= lesson.startTime)
        issue(['lessons', index, 'endTime'], 'Lesson end must follow its start on the same day.');
    });
    data.term.periods.forEach((item, index) => {
      const first = dayNumber(item.startDate),
        last = dayNumber(item.endDate);
      if (last < first || first < start || last - start > 730)
        issue(
          ['term', 'periods', index],
          'Academic periods must fall within 730 days of the teaching start.',
        );
    });
    data.term.holidays.forEach((item, index) => {
      const day = dayNumber(item.date);
      if (day < start || day - start > 730)
        issue(
          ['term', 'holidays', index],
          'Holiday must fall within 730 days of the teaching start.',
        );
    });
    data.overrides.forEach((item, index) => {
      const lesson = lessons.get(item.lessonId);
      const day = new Date(`${item.date}T00:00:00Z`).getUTCDay() || 7;
      if (!lesson || lesson.weekday !== day)
        issue(
          ['overrides', index, 'lessonId'],
          'Override must target an existing lesson on its weekday.',
        );
      if (item.date < data.term.startDate || item.date > data.term.endDate)
        issue(['overrides', index, 'date'], 'Override must be within the teaching period.');
      if (item.endTime <= item.startTime)
        issue(['overrides', index, 'endTime'], 'Lesson end must follow its start on the same day.');
    });
    if (new TextEncoder().encode(JSON.stringify(data)).length > STUDY_MAX_BYTES)
      issue([], 'Study data exceeds the storage limit.');
  });

export const studyWriteSchema = z
  .object({
    version: z.number().int().min(0).max(2147483646),
    data: studyDataSchema,
  })
  .strict();
