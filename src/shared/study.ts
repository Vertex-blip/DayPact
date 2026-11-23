export type StudyKind = 'lecture' | 'practice' | 'lab' | 'other';
export interface StudyLesson {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  title: string;
  teacher: string;
  room: string;
  campus: string;
  kind: StudyKind;
  format: 'campus' | 'online';
  url: string;
}
export interface StudyPeriod {
  id: string;
  title: string;
  kind: 'assessment' | 'exams' | 'vacation';
  startDate: string;
  endDate: string;
}
export interface StudyHoliday { date: string; title: string }
export interface StudyIncompleteDay {
  weekday: number;
  note: string;
  expectedCount: number | null;
  firstTime: string | null;
}
export interface StudyTerm {
  title: string;
  institution: string;
  course: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  remindMinutes: number;
  roomInPush: boolean;
  periods: StudyPeriod[];
  holidays: StudyHoliday[];
  incompleteDays: StudyIncompleteDay[];
}
/** An override changes one dated occurrence. A cancelled occurrence retains its original slot. */
export interface StudyOverride {
  lessonId: string;
  date: string;
  cancelled: boolean;
  startTime: string;
  endTime: string;
  room: string;
  campus: string;
  format: 'campus' | 'online';
  url: string;
  note: string;
}
export interface StudyData { term: StudyTerm; lessons: StudyLesson[]; overrides: StudyOverride[] }
export interface StudyDocument extends StudyData { version: number; updatedAt: string }
export interface StudyResponse { study: StudyDocument | null }
export interface StudyOccurrence extends StudyLesson {
  date: string;
  cancelled: boolean;
  modified: boolean;
  note: string;
}
