import { useState, type FormEvent, type ReactNode } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import type { Locale } from '../../shared/contracts';
import type {
  StudyHoliday,
  StudyIncompleteDay,
  StudyLesson,
  StudyOccurrence,
  StudyOverride,
  StudyPeriod,
  StudyTerm,
} from '../../shared/study';
import { studyTexts, studyWeekNames } from './texts';

interface Common {
  locale: Locale;
  busy: boolean;
  error: string;
}
function Actions({ locale, busy, error, children }: Common & { children?: ReactNode }) {
  const t = studyTexts(locale);
  return (
    <>
      {error && (
        <p className="study-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary full" disabled={busy}>
        {busy && <LoaderCircle className="spin" size={18} />} {t.save}
      </button>
      {children}
    </>
  );
}
function DeleteAction({
  locale,
  busy,
  onDelete,
  note,
}: {
  locale: Locale;
  busy: boolean;
  onDelete: () => void;
  note?: string;
}) {
  const t = studyTexts(locale);
  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <div className="study-delete-confirm">
      <p>{note ?? t.delete}</p>
      <button type="button" className="danger-button full" disabled={busy} onClick={onDelete}>
        {t.confirmDelete}
      </button>
      <button
        type="button"
        className="text-button full"
        disabled={busy}
        onClick={() => setConfirm(false)}
      >
        {t.cancel}
      </button>
    </div>
  ) : (
    <button
      type="button"
      className="danger-button full"
      disabled={busy}
      onClick={() => setConfirm(true)}
    >
      <Trash2 size={17} />
      {t.delete}
    </button>
  );
}
const text = (d: FormData, key: string) => String(d.get(key) ?? '').trim();
function valueTime(d: FormData) {
  return { startTime: text(d, 'startTime'), endTime: text(d, 'endTime') };
}

export function TermForm({
  term,
  locale,
  busy,
  error,
  onSave,
}: Common & { term?: StudyTerm; onSave: (term: StudyTerm) => void }) {
  const t = studyTexts(locale);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    onSave({
      title: text(d, 'title'),
      institution: text(d, 'institution'),
      course: text(d, 'course'),
      startDate: text(d, 'startDate'),
      endDate: text(d, 'endDate'),
      timeZone: text(d, 'timeZone'),
      remindMinutes: term?.remindMinutes ?? 15,
      roomInPush: term?.roomInPush ?? false,
      periods: term?.periods ?? [],
      holidays: term?.holidays ?? [],
      incompleteDays: term?.incompleteDays ?? [],
    });
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <p className="form-note">{t.termHelp}</p>
      <label>
        {t.termTitle}
        <input
          name="title"
          defaultValue={term?.title ?? ''}
          required
          minLength={1}
          maxLength={120}
          disabled={busy}
        />
      </label>
      <div className="study-form-row">
        <label>
          {t.institution}
          <input
            name="institution"
            defaultValue={term?.institution ?? ''}
            maxLength={120}
            disabled={busy}
          />
        </label>
        <label>
          {t.course}
          <input name="course" defaultValue={term?.course ?? ''} maxLength={30} disabled={busy} />
        </label>
      </div>
      <label>
        {t.startDate}
        <input
          name="startDate"
          type="date"
          required
          min="2000-01-01"
          max="2100-12-31"
          defaultValue={term?.startDate}
          disabled={busy}
        />
      </label>
      <label>
        {t.endDate}
        <input
          name="endDate"
          type="date"
          required
          min="2000-01-01"
          max="2100-12-31"
          defaultValue={term?.endDate}
          disabled={busy}
        />
      </label>
      <label>
        {t.timeZone}
        <input
          name="timeZone"
          required
          maxLength={80}
          defaultValue={term?.timeZone ?? 'Asia/Almaty'}
          disabled={busy}
        />
      </label>
      <Actions locale={locale} busy={busy} error={error} />
    </form>
  );
}

export function LessonForm({
  lesson,
  weekday,
  locale,
  busy,
  error,
  onSave,
  onDelete,
  hasOverrides = false,
}: Common & {
  lesson?: StudyLesson;
  weekday: number;
  hasOverrides?: boolean;
  onSave: (lesson: StudyLesson) => void;
  onDelete?: () => void;
}) {
  const t = studyTexts(locale);
  const names = studyWeekNames(locale);
  const [format, setFormat] = useState(lesson?.format ?? 'campus');
  const [selectedDay, setSelectedDay] = useState(lesson?.weekday ?? weekday);
  const [localError, setLocalError] = useState('');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const times = valueTime(d);
    if (times.endTime <= times.startTime) {
      setLocalError(t.invalidTime);
      return;
    }
    setLocalError('');
    onSave({
      id: lesson?.id ?? crypto.randomUUID(),
      weekday: Number(d.get('weekday')),
      ...times,
      title: text(d, 'title'),
      teacher: text(d, 'teacher'),
      room: text(d, 'room'),
      campus: text(d, 'campus'),
      kind: text(d, 'kind') as StudyLesson['kind'],
      format,
      url: text(d, 'url'),
    });
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>
        {t.lessonTitle}
        <input name="title" required maxLength={120} defaultValue={lesson?.title} disabled={busy} />
      </label>
      <label>
        {t.weekday}
        <select
          name="weekday"
          aria-label={t.weekday}
          value={selectedDay}
          onChange={(event) => setSelectedDay(Number(event.target.value))}
          disabled={busy}
        >
          {names.map((n, i) => (
            <option key={n} value={i + 1}>
              {n}
            </option>
          ))}
        </select>
      </label>
      {hasOverrides && lesson && selectedDay !== lesson.weekday && (
        <label className="study-checkbox">
          <input type="checkbox" required disabled={busy} />
          {t.weekdayReset}
        </label>
      )}
      <div className="study-form-row">
        <label>
          {t.starts}
          <input
            name="startTime"
            type="time"
            required
            defaultValue={lesson?.startTime ?? '09:00'}
            disabled={busy}
          />
        </label>
        <label>
          {t.ends}
          <input
            name="endTime"
            type="time"
            required
            defaultValue={lesson?.endTime ?? '09:50'}
            disabled={busy}
          />
        </label>
      </div>
      <div className="study-form-row">
        <label>
          {t.kind}
          <select
            name="kind"
            aria-label={t.kind}
            defaultValue={lesson?.kind ?? 'practice'}
            disabled={busy}
          >
            {(['lecture', 'practice', 'lab', 'other'] as const).map((k) => (
              <option key={k} value={k}>
                {t[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.format}
          <select
            aria-label={t.format}
            value={format}
            onChange={(e) => setFormat(e.target.value as StudyLesson['format'])}
            disabled={busy}
          >
            <option value="campus">{t.campusFormat}</option>
            <option value="online">{t.onlineFormat}</option>
          </select>
        </label>
      </div>
      <div className="study-form-row">
        <label>
          {t.room}
          <input name="room" maxLength={80} defaultValue={lesson?.room} disabled={busy} />
        </label>
        <label>
          {t.campus}
          <input name="campus" maxLength={120} defaultValue={lesson?.campus} disabled={busy} />
        </label>
      </div>
      <label>
        {t.teacher}
        <input name="teacher" maxLength={100} defaultValue={lesson?.teacher} disabled={busy} />
      </label>
      <label>
        {t.url}
        <input
          name="url"
          type="url"
          placeholder="https://"
          maxLength={512}
          defaultValue={lesson?.url}
          disabled={busy}
        />
      </label>
      <p className="form-note">{t.urlNote}</p>
      <Actions locale={locale} busy={busy} error={localError || error}>
        {onDelete && (
          <DeleteAction locale={locale} busy={busy} onDelete={onDelete} note={t.deleteLessonNote} />
        )}
      </Actions>
    </form>
  );
}

export function OverrideForm({
  occurrence,
  locale,
  busy,
  error,
  onSave,
  onRestore,
}: Common & {
  occurrence: StudyOccurrence;
  onSave: (value: StudyOverride) => void;
  onRestore?: () => void;
}) {
  const t = studyTexts(locale);
  const [cancelled, setCancelled] = useState(occurrence.cancelled);
  const [localError, setLocalError] = useState('');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const times = valueTime(d);
    if (times.endTime <= times.startTime) {
      setLocalError(t.invalidTime);
      return;
    }
    setLocalError('');
    onSave({
      lessonId: occurrence.id,
      date: occurrence.date,
      cancelled,
      ...times,
      room: text(d, 'room'),
      campus: text(d, 'campus'),
      format: text(d, 'format') as StudyOverride['format'],
      url: text(d, 'url'),
      note: text(d, 'note'),
    });
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="study-modal-subject">
        <strong>{occurrence.title}</strong>
        <span>{occurrence.date}</span>
      </div>
      <p className="form-note">{t.occurrenceNote}</p>
      <label className="study-checkbox">
        <input
          type="checkbox"
          checked={cancelled}
          onChange={(e) => setCancelled(e.target.checked)}
          disabled={busy}
        />
        {t.cancelLesson}
      </label>
      <div className="study-form-row">
        <label>
          {t.starts}
          <input
            name="startTime"
            type="time"
            required
            defaultValue={occurrence.startTime}
            disabled={busy}
          />
        </label>
        <label>
          {t.ends}
          <input
            name="endTime"
            type="time"
            required
            defaultValue={occurrence.endTime}
            disabled={busy}
          />
        </label>
      </div>
      <div className="study-form-row">
        <label>
          {t.room}
          <input name="room" maxLength={80} defaultValue={occurrence.room} disabled={busy} />
        </label>
        <label>
          {t.campus}
          <input name="campus" maxLength={120} defaultValue={occurrence.campus} disabled={busy} />
        </label>
      </div>
      <label>
        {t.format}
        <select
          name="format"
          aria-label={t.format}
          defaultValue={occurrence.format}
          disabled={busy}
        >
          <option value="campus">{t.campusFormat}</option>
          <option value="online">{t.onlineFormat}</option>
        </select>
      </label>
      <label>
        {t.url}
        <input
          name="url"
          type="url"
          placeholder="https://"
          maxLength={512}
          defaultValue={occurrence.url}
          disabled={busy}
        />
      </label>
      <label>
        {t.note}
        <textarea
          name="note"
          maxLength={500}
          rows={3}
          defaultValue={occurrence.note}
          disabled={busy}
        />
      </label>
      <Actions locale={locale} busy={busy} error={localError || error}>
        {onRestore && (
          <button className="text-button full" type="button" disabled={busy} onClick={onRestore}>
            {t.restore}
          </button>
        )}
      </Actions>
    </form>
  );
}

export function PeriodForm({
  period,
  locale,
  busy,
  error,
  onSave,
  onDelete,
}: Common & {
  period?: StudyPeriod;
  onSave: (period: StudyPeriod) => void;
  onDelete?: () => void;
}) {
  const t = studyTexts(locale);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    onSave({
      id: period?.id ?? crypto.randomUUID(),
      title: text(d, 'title'),
      kind: text(d, 'kind') as StudyPeriod['kind'],
      startDate: text(d, 'startDate'),
      endDate: text(d, 'endDate'),
    });
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>
        {t.periodTitle}
        <input name="title" required maxLength={120} defaultValue={period?.title} disabled={busy} />
      </label>
      <label>
        {t.periodKind}
        <select
          name="kind"
          aria-label={t.periodKind}
          defaultValue={period?.kind ?? 'assessment'}
          disabled={busy}
        >
          {(['assessment', 'exams', 'vacation'] as const).map((k) => (
            <option key={k} value={k}>
              {t[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.periodStart}
        <input
          name="startDate"
          type="date"
          required
          min="2000-01-01"
          max="2100-12-31"
          defaultValue={period?.startDate}
          disabled={busy}
        />
      </label>
      <label>
        {t.periodEnd}
        <input
          name="endDate"
          type="date"
          required
          min="2000-01-01"
          max="2100-12-31"
          defaultValue={period?.endDate}
          disabled={busy}
        />
      </label>
      <p className="form-note">{t.periodNote}</p>
      <Actions locale={locale} busy={busy} error={error}>
        {onDelete && <DeleteAction locale={locale} busy={busy} onDelete={onDelete} />}
      </Actions>
    </form>
  );
}

export function HolidayForm({
  holiday,
  locale,
  busy,
  error,
  onSave,
  onDelete,
}: Common & {
  holiday?: StudyHoliday;
  onSave: (holiday: StudyHoliday) => void;
  onDelete?: () => void;
}) {
  const t = studyTexts(locale);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    onSave({ date: text(d, 'date'), title: text(d, 'title') });
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>
        {t.holidayTitle}
        <input
          name="title"
          required
          maxLength={120}
          defaultValue={holiday?.title}
          disabled={busy}
        />
      </label>
      <label>
        {t.date}
        <input
          name="date"
          type="date"
          required
          min="2000-01-01"
          max="2100-12-31"
          defaultValue={holiday?.date}
          disabled={busy}
        />
      </label>
      <p className="form-note">{t.holidayNote}</p>
      <Actions locale={locale} busy={busy} error={error}>
        {onDelete && <DeleteAction locale={locale} busy={busy} onDelete={onDelete} />}
      </Actions>
    </form>
  );
}

export function IncompleteForm({
  value,
  locale,
  busy,
  error,
  onSave,
}: Common & { value: StudyIncompleteDay; onSave: (day: StudyIncompleteDay | null) => void }) {
  const t = studyTexts(locale);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    onSave({
      weekday: value.weekday,
      note: text(d, 'note'),
      expectedCount: text(d, 'expectedCount') ? Number(d.get('expectedCount')) : null,
      firstTime: text(d, 'firstTime') || null,
    });
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <p className="form-note">{t.incompleteNote}</p>
      <label>
        {t.note}
        <textarea
          name="note"
          required
          maxLength={400}
          rows={3}
          defaultValue={value.note}
          disabled={busy}
        />
      </label>
      <div className="study-form-row">
        <label>
          {t.expectedCount}
          <input
            name="expectedCount"
            type="number"
            min={1}
            max={30}
            defaultValue={value.expectedCount ?? ''}
            disabled={busy}
          />
        </label>
        <label>
          {t.firstTime}
          <input
            name="firstTime"
            type="time"
            defaultValue={value.firstTime ?? ''}
            disabled={busy}
          />
        </label>
      </div>
      <Actions locale={locale} busy={busy} error={error}>
        <button
          type="button"
          className="secondary full"
          disabled={busy}
          onClick={() => onSave(null)}
        >
          {t.markComplete}
        </button>
      </Actions>
    </form>
  );
}

export function ReminderForm({
  term,
  locale,
  busy,
  error,
  onSave,
}: Common & { term: StudyTerm; onSave: (term: StudyTerm) => void }) {
  const t = studyTexts(locale);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    onSave({
      ...term,
      remindMinutes: Number(d.get('minutes')),
      roomInPush: d.get('roomInPush') === 'on',
    });
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <label>
        {t.remindBefore}
        <select
          name="minutes"
          aria-label={t.remindBefore}
          defaultValue={term.remindMinutes}
          disabled={busy}
        >
          <option value={-1}>{t.off}</option>
          {[5, 10, 15, 30].map((n) => (
            <option key={n} value={n}>
              {n} {t.minute}
            </option>
          ))}
        </select>
      </label>
      <label className="study-checkbox">
        <input type="checkbox" name="roomInPush" defaultChecked={term.roomInPush} disabled={busy} />
        {t.roomInPush}
      </label>
      <p className="form-note">{t.roomPrivacy}</p>
      <p className="form-note">{t.pushHelp}</p>
      <Actions locale={locale} busy={busy} error={error} />
    </form>
  );
}
