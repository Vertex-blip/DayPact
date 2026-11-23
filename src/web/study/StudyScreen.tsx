import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  WifiOff,
  X,
} from 'lucide-react';
import type { Locale } from '../../shared/contracts';
import type {
  StudyData,
  StudyDocument,
  StudyHoliday,
  StudyIncompleteDay,
  StudyLesson,
  StudyOccurrence,
  StudyPeriod,
  StudyResponse,
  StudyTerm,
} from '../../shared/study';
import {
  studyAddDays,
  studyLocalParts,
  studyValidDate,
  studyWeekDates,
  studyWeekday,
  studyWeekNumber,
  type StudyOccurrenceGroup,
} from '../../shared/studyTime';
import { api, ApiError, readableError, writeApi } from '../api';
import { currentAuth } from '../firebase';
import {
  isPrivateSessionPaused,
  loadStudyCache,
  saveStudyCache,
  pausePrivateSession,
} from '../offline';
import { Empty, Modal } from '../components';
import {
  HolidayForm,
  IncompleteForm,
  LessonForm,
  OverrideForm,
  PeriodForm,
  ReminderForm,
  TermForm,
} from './StudyForms';
import {
  ActualStudyStatus,
  StudyCalendar,
  StudyDay,
  StudyLessonDetails,
  StudySearch,
  StudyWeek,
} from './StudySchedule';
import { studyDateLabel, studyTexts, studyWeekNames } from './texts';
import './study.css';

type Panel =
  | { kind: 'settings' }
  | { kind: 'term' }
  | { kind: 'lesson'; lesson?: StudyLesson }
  | { kind: 'details'; group: StudyOccurrenceGroup }
  | { kind: 'override'; occurrence: StudyOccurrence }
  | { kind: 'period'; period?: StudyPeriod }
  | { kind: 'holiday'; holiday?: StudyHoliday }
  | { kind: 'incomplete'; day: StudyIncompleteDay }
  | { kind: 'reminders' };
interface Props {
  uid: string;
  locale: Locale;
  online: boolean;
  initialDate?: string;
  onAuthError?: (error: unknown) => void;
}
const privateFailure = (error: unknown) =>
  error instanceof ApiError &&
  (error.status === 401 ||
    ['ACCOUNT_SUSPENDED', 'ACCOUNT_DELETED', 'AUTH_DELETE_PENDING', 'REAUTH_REQUIRED'].includes(
      error.code,
    ));
const getData = (doc: StudyDocument): StudyData => ({
  term: doc.term,
  lessons: doc.lessons,
  overrides: doc.overrides,
});

export function StudyScreen({ uid, locale, online, initialDate, onAuthError }: Props) {
  const t = studyTexts(locale);
  const [snapshot, setSnapshot] = useState<{ uid: string; study: StudyDocument | null } | null>(
    null,
  );
  const study = snapshot?.uid === uid ? snapshot.study : undefined;
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [formError, setFormError] = useState(''),
    [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0),
    [panel, setPanel] = useState<Panel | null>(null);
  const [view, setView] = useState<'day' | 'week' | 'calendar'>(initialDate ? 'day' : 'week');
  const [selectedDate, setSelectedDate] = useState(
      initialDate && studyValidDate(initialDate) ? initialDate : '',
    ),
    [query, setQuery] = useState(''),
    [expanded, setExpanded] = useState(false),
    [now, setNow] = useState(() => new Date());
  const epoch = useRef(0),
    mounted = useRef(false),
    saving = useRef(false),
    initializedUid = useRef(''),
    authErrorRef = useRef(onAuthError),
    localeRef = useRef(locale);
  authErrorRef.current = onAuthError;
  localeRef.current = locale;
  const isCurrent = useCallback(
    () => mounted.current && currentAuth()?.currentUser?.uid === uid,
    [uid],
  );
  const allowed = useCallback(
    async () => isCurrent() && !(await isPrivateSessionPaused(uid)) && isCurrent(),
    [isCurrent, uid],
  );

  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => {
      mounted.current = false;
      epoch.current++;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (initialDate && studyValidDate(initialDate)) {
      setSelectedDate(initialDate);
      setView('day');
      setQuery('');
    }
  }, [initialDate]);

  useEffect(() => {
    const request = ++epoch.current;
    const valid = () => isCurrent() && request === epoch.current;
    if (initializedUid.current !== uid) {
      initializedUid.current = uid;
      setSnapshot(null);
      setPanel(null);
      setSelectedDate(initialDate && studyValidDate(initialDate) ? initialDate : '');
      setQuery('');
    }
    setLoading(true);
    setError('');
    async function read() {
      try {
        if (!(await allowed()) || !valid()) return;
        let cached: StudyDocument | null | undefined;
        try {
          cached = await loadStudyCache(uid);
        } catch {
          /* Online reads can recover without a local cache. */
        }
        if (!(await allowed()) || !valid()) return;
        if (cached !== undefined) setSnapshot({ uid, study: cached });
        if (!online) return;
        const response = await api<StudyResponse>('/study', { expectedUid: uid });
        if (!(await allowed()) || !valid()) return;
        setSnapshot({ uid, study: response.study });
        try {
          await saveStudyCache(uid, response.study);
        } catch {
          if (valid()) setNotice(studyTexts(localeRef.current).cacheFailed);
        }
      } catch (caught) {
        if (!valid()) return;
        if (privateFailure(caught)) {
          setSnapshot(null);
          setPanel(null);
          try {
            await pausePrivateSession(uid);
          } catch {
            /* The private session stays closed in memory if storage fails. */
          }
          if (valid()) authErrorRef.current?.(caught);
        }
        setError(readableError(caught, localeRef.current));
      } finally {
        if (valid()) setLoading(false);
      }
    }
    void read();
    return () => {
      if (epoch.current === request) epoch.current++;
    };
  }, [uid, online, reload, allowed, isCurrent, initialDate]);

  useEffect(() => {
    if (!study || selectedDate) return;
    const today = studyLocalParts(new Date(), study.term.timeZone).date;
    setSelectedDate(today < study.term.startDate ? study.term.startDate : today);
  }, [study, selectedDate]);

  function open(value: Panel) {
    setFormError('');
    setNotice('');
    setPanel(value);
  }
  function close() {
    if (!saving.current) {
      setPanel(null);
      setFormError('');
    }
  }
  function refresh() {
    if (saving.current) return;
    setPanel(null);
    setFormError('');
    setReload((value) => value + 1);
  }
  async function save(data: StudyData) {
    if (saving.current) return;
    if (!online) {
      setFormError(t.offlineWrite);
      return;
    }
    if (
      data.lessons.length > 50 ||
      data.overrides.length > 120 ||
      data.term.periods.length > 12 ||
      data.term.holidays.length > 30
    ) {
      setFormError(t.limits);
      return;
    }
    saving.current = true;
    setBusy(true);
    setFormError('');
    setNotice('');
    const request = epoch.current;
    const valid = () => isCurrent() && epoch.current === request;
    try {
      if (!(await allowed()) || !valid()) return;
      const response = await writeApi<StudyResponse>(
        '/study',
        'PUT',
        { version: study?.version ?? 0, data },
        uid,
      );
      if (!(await allowed()) || !valid()) return;
      setSnapshot({ uid, study: response.study });
      setPanel(null);
      setError('');
      setNotice(t.saved);
      try {
        await saveStudyCache(uid, response.study);
      } catch {
        if (valid()) setNotice(t.cacheFailed);
      }
    } catch (caught) {
      if (!valid()) return;
      if (privateFailure(caught)) {
        setSnapshot(null);
        setPanel(null);
        try {
          await pausePrivateSession(uid);
        } catch {
          /* Memory is already closed; still hide the parent view. */
        }
        if (valid()) authErrorRef.current?.(caught);
        setError(readableError(caught, locale));
      } else
        setFormError(
          caught instanceof ApiError && caught.code === 'VERSION_CONFLICT'
            ? t.conflict
            : caught instanceof ApiError &&
                ['VALIDATION_ERROR', 'INVALID_INPUT', 'INVALID_STUDY'].includes(caught.code)
              ? t.invalid
              : readableError(caught, locale),
        );
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function saveTerm(term: StudyTerm) {
    const finalDate = studyAddDays(term.startDate, 730);
    if (term.endDate < term.startDate || term.endDate > finalDate) {
      setFormError(t.invalid);
      return;
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: term.timeZone }).format();
    } catch {
      setFormError(t.invalid);
      return;
    }
    if (
      study?.overrides.some((item) => item.date < term.startDate || item.date > term.endDate) ||
      term.periods.some(
        (item) =>
          item.startDate < term.startDate ||
          item.endDate > finalDate ||
          item.endDate < item.startDate,
      ) ||
      term.holidays.some((item) => item.date < term.startDate || item.date > finalDate)
    ) {
      setFormError(t.termBounds);
      return;
    }
    void save({ term, lessons: study?.lessons ?? [], overrides: study?.overrides ?? [] });
  }
  function saveLesson(lesson: StudyLesson) {
    if (!study) return;
    void save({
      ...getData(study),
      lessons: [...study.lessons.filter((x) => x.id !== lesson.id), lesson],
      overrides: study.overrides.filter(
        (item) => item.lessonId !== lesson.id || studyWeekday(item.date) === lesson.weekday,
      ),
    });
  }
  const editable = online && !loading && !busy;
  const today = study ? studyLocalParts(now, study.term.timeZone).date : '';
  const date = selectedDate || study?.term.startDate || '';
  const dates = date ? studyWeekDates(date) : [];
  const viewedWeek =
    study && dates.length
      ? dates.map((day) => studyWeekNumber(study.term, day)).find((n) => n !== null)
      : null;
  const formProps = { locale, busy, error: formError };
  function chooseDate(value: string) {
    if (studyValidDate(value)) {
      setSelectedDate(value);
      setQuery('');
    }
  }
  function goDay(value: string) {
    chooseDate(value);
    setView('day');
  }
  const panelTitle =
    panel?.kind === 'settings'
      ? t.settings
      : panel?.kind === 'term'
        ? t.term
        : panel?.kind === 'lesson'
          ? panel.lesson
            ? t.editLesson
            : t.addLesson
          : panel?.kind === 'details'
            ? t.details
            : panel?.kind === 'override'
              ? t.occurrence
              : panel?.kind === 'period'
                ? panel.period
                  ? t.edit
                  : t.addPeriod
                : panel?.kind === 'holiday'
                  ? panel.holiday
                    ? t.edit
                    : t.addHoliday
                  : panel?.kind === 'incomplete'
                    ? studyWeekNames(locale)[panel.day.weekday - 1]
                    : t.reminders;

  // The parent also unmounts private routes; this prevents a render during an identity transition.
  if (currentAuth()?.currentUser?.uid !== uid) return null;
  return (
    <section className="study-screen" data-testid="study-screen">
      <header className="study-header">
        <div>
          <h1>{t.title}</h1>
          <p>
            {study
              ? [study.term.institution, study.term.course, study.term.title]
                  .filter(Boolean)
                  .join(' · ')
              : t.empty}
          </p>
        </div>
        <div>
          {study && (
            <button
              className="study-icon-button"
              aria-label={t.settings}
              onClick={() => open({ kind: 'settings' })}
            >
              <Settings2 size={21} />
            </button>
          )}
          <button
            className="study-icon-button"
            aria-label={study ? t.addLesson : t.create}
            disabled={!editable}
            onClick={() => open(study ? { kind: 'lesson' } : { kind: 'term' })}
          >
            <Plus size={23} />
          </button>
        </div>
      </header>
      {!online && (
        <div className="study-offline">
          <WifiOff size={17} />
          <span>
            <strong>{t.offline}</strong>
            <small>{t.offlineNote}</small>
          </span>
        </div>
      )}
      {error && (
        <div className="study-error" role="alert">
          {error}
          {online && (
            <button className="text-button" onClick={refresh}>
              {t.refresh}
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className="study-notice" role="status">
          {notice}
        </p>
      )}
      {loading && study === undefined ? (
        <div className="study-loading">
          <LoaderCircle className="spin" size={24} />
          {t.loading}
        </div>
      ) : study === undefined ? (
        <Empty icon={BookOpen} title={t.title} note={online ? t.noAccess : t.noCache}>
          {online && (
            <button className="secondary" onClick={refresh}>
              {t.refresh}
            </button>
          )}
        </Empty>
      ) : study === null ? (
        <Empty icon={GraduationCap} title={t.empty} note={t.emptyNote}>
          <button className="primary" disabled={!editable} onClick={() => open({ kind: 'term' })}>
            <Plus size={18} />
            {t.create}
          </button>
        </Empty>
      ) : (
        <>
          <ActualStudyStatus data={study} now={now} locale={locale} />
          <nav className="study-tabs" aria-label={t.title}>
            {(['day', 'week', 'calendar'] as const).map((tab) => (
              <button
                key={tab}
                className={view === tab ? 'is-active' : ''}
                aria-current={view === tab ? 'page' : undefined}
                onClick={() => {
                  setView(tab);
                  setQuery('');
                }}
              >
                {t[tab]}
              </button>
            ))}
          </nav>
          {view !== 'calendar' && (
            <>
              <div className="study-date-toolbar">
                <button
                  className="study-icon-button"
                  aria-label={t.previous}
                  onClick={() => chooseDate(studyAddDays(date, -7))}
                >
                  <ChevronLeft size={21} />
                </button>
                <label className="study-date-picker">
                  <strong>
                    {view === 'day'
                      ? studyDateLabel(date, locale)
                      : `${studyDateLabel(dates[0], locale)} — ${studyDateLabel(dates[6], locale)}`}
                  </strong>
                  <small>
                    {viewedWeek
                      ? `${t.viewedWeek}: ${viewedWeek}${t.weekSuffix}`
                      : date.slice(0, 4)}
                  </small>
                  <input
                    aria-label={t.date}
                    type="date"
                    value={date}
                    min="2000-01-01"
                    max="2100-12-31"
                    onChange={(event) => chooseDate(event.target.value)}
                  />
                </label>
                <button
                  className="study-icon-button"
                  aria-label={t.next}
                  onClick={() => chooseDate(studyAddDays(date, 7))}
                >
                  <ChevronRight size={21} />
                </button>
                <button className="text-button study-today-button" onClick={() => goDay(today)}>
                  {t.today}
                </button>
              </div>
              {view === 'day' && (
                <div className="study-day-strip">
                  {dates.map((day, index) => (
                    <button
                      className={day === date ? 'is-active' : ''}
                      key={day}
                      onClick={() => chooseDate(day)}
                      aria-label={`${studyWeekNames(locale)[index]}, ${studyDateLabel(day, locale)}`}
                      aria-pressed={day === date}
                    >
                      <span>{studyWeekNames(locale, true)[index]}</span>
                      <strong>{Number(day.slice(8, 10))}</strong>
                      {day === today && <i />}
                    </button>
                  ))}
                </div>
              )}
              <div className="study-search">
                <Search size={19} />
                <input
                  aria-label={t.search}
                  placeholder={t.search}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  maxLength={120}
                />
                {query && (
                  <button
                    className="study-icon-button"
                    aria-label={t.clear}
                    onClick={() => setQuery('')}
                  >
                    <X size={17} />
                  </button>
                )}
              </div>
            </>
          )}
          {query.trim() ? (
            <StudySearch
              data={study}
              date={date}
              query={query}
              locale={locale}
              onOpen={(group) => open({ kind: 'details', group })}
            />
          ) : view === 'week' ? (
            <StudyWeek
              data={study}
              date={date}
              now={now}
              locale={locale}
              expanded={expanded}
              onExpanded={() => setExpanded((x) => !x)}
              onDay={goDay}
              onOpen={(group) => open({ kind: 'details', group })}
              onIncomplete={(day) => open({ kind: 'incomplete', day })}
              editable={editable}
            />
          ) : view === 'day' ? (
            <StudyDay
              data={study}
              date={date}
              now={now}
              locale={locale}
              onOpen={(group) => open({ kind: 'details', group })}
              onIncomplete={(day) => open({ kind: 'incomplete', day })}
              editable={editable}
            />
          ) : (
            <StudyCalendar
              data={study}
              now={now}
              locale={locale}
              editable={editable}
              onTerm={() => open({ kind: 'term' })}
              onPeriod={(period) => open({ kind: 'period', period })}
              onHoliday={(holiday) => open({ kind: 'holiday', holiday })}
              onIncomplete={(day) => open({ kind: 'incomplete', day })}
              onReminders={() => open({ kind: 'reminders' })}
              onDate={goDay}
            />
          )}
          <footer className="study-footer">
            <ShieldCheck size={14} />
            <span>
              {t.private} {t.cacheNote}
            </span>
            {loading && <LoaderCircle className="spin" size={16} />}
          </footer>
        </>
      )}
      {panel && (
        <Modal title={panelTitle} onClose={close} closeLabel={t.close}>
          {panel.kind === 'term' && (
            <TermForm {...formProps} term={study?.term} onSave={saveTerm} />
          )}
          {study && panel.kind === 'settings' && (
            <div className="study-settings-list">
              <button onClick={() => open({ kind: 'term' })} disabled={!editable}>
                <GraduationCap size={20} />
                <span>
                  {t.term}
                  <small>{study.term.title}</small>
                </span>
                <ChevronRight size={17} />
              </button>
              <button onClick={() => open({ kind: 'reminders' })} disabled={!editable}>
                <Bell size={20} />
                <span>
                  {t.reminders}
                  <small>
                    {study.term.remindMinutes < 0
                      ? t.off
                      : `${study.term.remindMinutes} ${t.minute}`}
                  </small>
                </span>
                <ChevronRight size={17} />
              </button>
              <button
                onClick={() => {
                  close();
                  setView('calendar');
                  setQuery('');
                }}
              >
                <CalendarDays size={20} />
                <span>{t.academicCalendar}</span>
                <ChevronRight size={17} />
              </button>
              <button disabled={!online || loading} onClick={refresh}>
                <RefreshCw size={19} />
                <span>{t.refresh}</span>
              </button>
              <p className="form-note">
                {t.private} {t.cacheNote}
              </p>
            </div>
          )}
          {study && panel.kind === 'lesson' && (
            <LessonForm
              {...formProps}
              lesson={panel.lesson}
              hasOverrides={
                !!panel.lesson && study.overrides.some((item) => item.lessonId === panel.lesson!.id)
              }
              weekday={studyWeekday(date)}
              onSave={saveLesson}
              onDelete={
                panel.lesson
                  ? () =>
                      void save({
                        ...getData(study),
                        lessons: study.lessons.filter((x) => x.id !== panel.lesson!.id),
                        overrides: study.overrides.filter((x) => x.lessonId !== panel.lesson!.id),
                      })
                  : undefined
              }
            />
          )}
          {study && panel.kind === 'details' && (
            <StudyLessonDetails
              group={panel.group}
              locale={locale}
              editable={editable}
              onWeekly={(item) =>
                open({ kind: 'lesson', lesson: study.lessons.find((x) => x.id === item.id) })
              }
              onOccurrence={(occurrence) => open({ kind: 'override', occurrence })}
            />
          )}
          {study && panel.kind === 'override' && (
            <OverrideForm
              {...formProps}
              occurrence={panel.occurrence}
              onSave={(value) =>
                void save({
                  ...getData(study),
                  overrides: [
                    ...study.overrides.filter(
                      (x) => x.lessonId !== value.lessonId || x.date !== value.date,
                    ),
                    value,
                  ],
                })
              }
              onRestore={
                study.overrides.some(
                  (x) => x.lessonId === panel.occurrence.id && x.date === panel.occurrence.date,
                )
                  ? () =>
                      void save({
                        ...getData(study),
                        overrides: study.overrides.filter(
                          (x) =>
                            x.lessonId !== panel.occurrence.id || x.date !== panel.occurrence.date,
                        ),
                      })
                  : undefined
              }
            />
          )}
          {study && panel.kind === 'period' && (
            <PeriodForm
              {...formProps}
              period={panel.period}
              onSave={(value) =>
                saveTerm({
                  ...study.term,
                  periods: [...study.term.periods.filter((x) => x.id !== value.id), value],
                })
              }
              onDelete={
                panel.period
                  ? () =>
                      saveTerm({
                        ...study.term,
                        periods: study.term.periods.filter((x) => x.id !== panel.period!.id),
                      })
                  : undefined
              }
            />
          )}
          {study && panel.kind === 'holiday' && (
            <HolidayForm
              {...formProps}
              holiday={panel.holiday}
              onSave={(value) =>
                saveTerm({
                  ...study.term,
                  holidays: [
                    ...study.term.holidays.filter(
                      (x) => x.date !== value.date && x.date !== panel.holiday?.date,
                    ),
                    value,
                  ],
                })
              }
              onDelete={
                panel.holiday
                  ? () =>
                      saveTerm({
                        ...study.term,
                        holidays: study.term.holidays.filter((x) => x.date !== panel.holiday!.date),
                      })
                  : undefined
              }
            />
          )}
          {study && panel.kind === 'incomplete' && (
            <IncompleteForm
              {...formProps}
              value={panel.day}
              onSave={(value) =>
                saveTerm({
                  ...study.term,
                  incompleteDays: [
                    ...study.term.incompleteDays.filter((x) => x.weekday !== panel.day.weekday),
                    ...(value ? [value] : []),
                  ],
                })
              }
            />
          )}
          {study && panel.kind === 'reminders' && (
            <ReminderForm {...formProps} term={study.term} onSave={saveTerm} />
          )}
          {formError === t.conflict && (
            <button className="secondary full" disabled={busy} onClick={refresh}>
              <RefreshCw size={17} />
              {t.refresh}
            </button>
          )}
        </Modal>
      )}
    </section>
  );
}

export default StudyScreen;
