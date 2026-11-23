import { useState } from 'react';
import {
  ArrowUpRight,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  GraduationCap,
  MapPin,
  Pencil,
  Plus,
  ShieldCheck,
  TriangleAlert,
  Video,
} from 'lucide-react';
import type { Locale } from '../../shared/contracts';
import type {
  StudyData,
  StudyHoliday,
  StudyIncompleteDay,
  StudyOccurrence,
  StudyPeriod,
} from '../../shared/study';
import {
  nextStudyOccurrence,
  studyDayState,
  studyGroupOccurrences,
  studyLocalParts,
  studyMatchesQuery,
  studyOccurrences,
  studyWeekDates,
  studyWeekday,
  studyWeekNumber,
  type StudyOccurrenceGroup,
} from '../../shared/studyTime';
import { studyDateLabel, studyTexts, studyWeekNames } from './texts';

export function studySafeLink(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function ActualStudyStatus({
  data,
  now,
  locale,
}: {
  data: StudyData;
  now: Date;
  locale: Locale;
}) {
  const t = studyTexts(locale),
    today = studyLocalParts(now, data.term.timeZone).date;
  const week = studyWeekNumber(data.term, today),
    state = studyDayState(data, today);
  const title = week
    ? `${t.actualWeek} ${week}${t.weekSuffix}`
    : (state.period?.title ??
      (today < data.term.startDate
        ? `${t.termBefore} ${studyDateLabel(data.term.startDate, locale)}`
        : t.termAfter));
  return (
    <div className="study-actual" data-testid="study-actual-status">
      <span className="study-status-dot" />
      <strong>{title}</strong>
      {week && state.period && <span className="study-phase-pill">{state.period.title}</span>}
      {state.holiday && <span className="study-status-holiday">{state.holiday.title}</span>}
    </div>
  );
}

function LessonRow({
  group,
  locale,
  onOpen,
  showDate = false,
}: {
  group: StudyOccurrenceGroup;
  locale: Locale;
  onOpen: (item: StudyOccurrenceGroup) => void;
  showDate?: boolean;
}) {
  const t = studyTexts(locale);
  return (
    <button
      className={`study-lesson ${group.cancelled ? 'is-cancelled' : ''}`}
      onClick={() => onOpen(group)}
    >
      <div className="study-lesson-time">
        <strong>{group.startTime}</strong>
        <span>{group.endTime}</span>
      </div>
      <div className="study-lesson-body">
        {showDate && (
          <span className="study-result-date">
            {studyWeekNames(locale)[group.weekday - 1]} · {studyDateLabel(group.date, locale)}
          </span>
        )}
        <div className="study-lesson-caption">
          <span>
            {t[group.kind]}
            {group.count > 1 ? ` · ${group.count} ${t.lessons}` : ''}
          </span>
          {group.cancelled ? (
            <span className="study-cancelled-label">{t.cancelled}</span>
          ) : group.modified ? (
            <span>{t.changed}</span>
          ) : group.format === 'online' ? (
            <span className="study-online-label">{t.onlineFormat}</span>
          ) : null}
        </div>
        <strong className="study-lesson-title">{group.title}</strong>
        <span className={`study-room-line ${group.format === 'online' ? 'is-online' : ''}`}>
          {group.format === 'online' ? <Video size={15} /> : <MapPin size={15} />}
          <span>{group.format === 'online' ? t.onlineFormat : group.room || t.roomMissing}</span>
          <ChevronRight size={15} />
        </span>
        {group.teacher && (
          <span className="study-teacher">
            <GraduationCap size={14} />
            {group.teacher}
          </span>
        )}
      </div>
    </button>
  );
}

export function LessonList({
  items,
  locale,
  onOpen,
  showDate = false,
}: {
  items: StudyOccurrence[];
  locale: Locale;
  onOpen: (item: StudyOccurrenceGroup) => void;
  showDate?: boolean;
}) {
  const t = studyTexts(locale),
    groups = studyGroupOccurrences(items);
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  return (
    <div className="study-lesson-list">
      {groups.map((group, index) => {
        const previous = groups[index - 1];
        const gap =
          previous && !previous.cancelled && !group.cancelled && previous.date === group.date
            ? minutes(group.startTime) - minutes(previous.endTime)
            : 0;
        return (
          <div key={`${group.date}:${group.id}`}>
            {gap >= 30 && (
              <div className="study-gap">
                <Clock3 size={14} />
                <span>
                  {t.gap} · {Math.floor(gap / 60) > 0 ? `${Math.floor(gap / 60)} ${t.hour} ` : ''}
                  {gap % 60 ? `${gap % 60} ${t.minute}` : ''}
                </span>
                <small>
                  {previous.endTime}–{group.startTime}
                </small>
              </div>
            )}
            <LessonRow group={group} locale={locale} onOpen={onOpen} showDate={showDate} />
          </div>
        );
      })}
    </div>
  );
}

function IncompleteNotice({
  value,
  locale,
  editable,
  onEdit,
}: {
  value: StudyIncompleteDay;
  locale: Locale;
  editable: boolean;
  onEdit: () => void;
}) {
  const t = studyTexts(locale);
  return (
    <div className="study-incomplete">
      <TriangleAlert size={16} />
      <div>
        <strong>{t.incomplete}</strong>
        <p>{value.note}</p>
        {value.firstTime && (
          <small>
            {t.firstTime}: {value.firstTime}
          </small>
        )}
      </div>
      {editable && (
        <button className="study-icon-button" aria-label={t.edit} onClick={onEdit}>
          <Pencil size={16} />
        </button>
      )}
    </div>
  );
}

function DayNotice({ data, date, locale }: { data: StudyData; date: string; locale: Locale }) {
  const t = studyTexts(locale),
    state = studyDayState(data, date);
  if (!state.withinTerm && !state.period) return <p className="study-day-note">{t.dateOutside}</p>;
  if (state.holiday || state.period)
    return (
      <p className="study-day-note">
        <CalendarDays size={16} />
        {state.holiday?.title ?? state.period?.title}
        {state.holiday && state.period ? ` · ${state.period.title}` : ''}
      </p>
    );
  return null;
}

export function StudyWeek({
  data,
  date,
  now,
  locale,
  expanded,
  onExpanded,
  onDay,
  onOpen,
  onIncomplete,
  editable,
}: {
  data: StudyData;
  date: string;
  now: Date;
  locale: Locale;
  expanded: boolean;
  onExpanded: () => void;
  onDay: (date: string) => void;
  onOpen: (group: StudyOccurrenceGroup) => void;
  onIncomplete: (value: StudyIncompleteDay) => void;
  editable: boolean;
}) {
  const t = studyTexts(locale),
    today = studyLocalParts(now, data.term.timeZone).date;
  return (
    <>
      <div className="study-section-heading">
        <h2>{t.week}</h2>
        <button className="text-button" onClick={onExpanded}>
          {expanded ? t.collapseAll : t.showAll}
        </button>
      </div>
      <div className={`study-week-list ${expanded ? 'is-expanded' : ''}`}>
        {studyWeekDates(date).map((day) => {
          const weekday = studyWeekday(day),
            items = studyOccurrences(data, day),
            active = items.filter((x) => !x.cancelled),
            state = studyDayState(data, day);
          const partial =
            state.withinTerm && !state.suppressed
              ? data.term.incompleteDays.find((x) => x.weekday === weekday)
              : undefined;
          const range = active.length
            ? `${active[0].startTime}–${active.at(-1)!.endTime}`
            : (partial?.firstTime ?? '—');
          const subjects = [...new Set(active.map((item) => item.title))].join(' · ');
          const note =
            state.holiday?.title ??
            (state.suppressed
              ? (state.period?.title ?? t.dateOutside)
              : partial
                ? t.incomplete
                : active.length
                  ? `${active.length} ${t.lessons}`
                  : t.noLessons);
          return (
            <section
              className={`study-week-day ${day === today ? 'is-today' : ''} ${partial ? 'is-partial' : ''}`}
              key={day}
            >
              <button className="study-week-summary" onClick={() => onDay(day)}>
                <span className="study-week-date">
                  <strong>{studyWeekNames(locale, true)[weekday - 1]}</strong>
                  <span>{Number(day.slice(8, 10))}</span>
                </span>
                <span className="study-week-overview">
                  <strong>
                    {studyWeekNames(locale)[weekday - 1]}
                    {day === today && <small>{t.today}</small>}
                  </strong>
                  <span>{note}</span>
                  {subjects && (
                    <span className="study-week-subjects" title={subjects}>
                      {subjects}
                    </span>
                  )}
                </span>
                <span className="study-week-range">
                  {range}
                  <ChevronRight size={17} />
                </span>
              </button>
              {expanded && (
                <div className="study-week-expanded">
                  <DayNotice data={data} date={day} locale={locale} />
                  {items.length > 0 && <LessonList items={items} locale={locale} onOpen={onOpen} />}
                  {partial && (
                    <IncompleteNotice
                      value={partial}
                      locale={locale}
                      editable={editable}
                      onEdit={() => onIncomplete(partial)}
                    />
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

export function StudyDay({
  data,
  date,
  now,
  locale,
  onOpen,
  onIncomplete,
  editable,
}: {
  data: StudyData;
  date: string;
  now: Date;
  locale: Locale;
  onOpen: (group: StudyOccurrenceGroup) => void;
  onIncomplete: (value: StudyIncompleteDay) => void;
  editable: boolean;
}) {
  const t = studyTexts(locale),
    local = studyLocalParts(now, data.term.timeZone),
    state = studyDayState(data, date);
  const items = studyOccurrences(data, date),
    next = date === local.date ? nextStudyOccurrence(data, now) : items.find((x) => !x.cancelled);
  const partial =
    state.withinTerm && !state.suppressed
      ? data.term.incompleteDays.find((x) => x.weekday === studyWeekday(date))
      : undefined;
  const live =
    next?.date === local.date && next.startTime <= local.time && next.endTime > local.time;
  const nextGroup = next
    ? studyGroupOccurrences(studyOccurrences(data, next.date)).find((x) =>
        x.items.some((item) => item.id === next.id),
      )
    : null;
  return (
    <>
      {next && nextGroup && (
        <button className="study-next-card" onClick={() => onOpen(nextGroup)}>
          <span className="study-next-top">
            <span>
              <span className="study-status-dot" />
              {live ? t.inProgress : t.nextLesson}
            </span>
            <ArrowUpRight size={19} />
          </span>
          <strong className="study-next-subject">{next.title}</strong>
          <span className="study-next-room">
            {next.format === 'online' ? <Video size={22} /> : <MapPin size={22} />}
            <strong>
              {next.format === 'online' ? t.onlineFormat : next.room || t.roomMissing}
            </strong>
          </span>
          <span className="study-next-footer">
            <span>
              {next.startTime}–{next.endTime}
            </span>
            <span>
              {studyDateLabel(next.date, locale)} · {t[next.kind]}
            </span>
          </span>
          {next.campus && next.format !== 'online' && <small>{next.campus}</small>}
        </button>
      )}
      <div className="study-section-heading">
        <h2>{studyWeekNames(locale)[studyWeekday(date) - 1]}</h2>
        <span>
          {items.filter((x) => !x.cancelled).length} {t.lessons}
        </span>
      </div>
      <DayNotice data={data} date={date} locale={locale} />
      {items.length > 0 ? (
        <LessonList items={items} locale={locale} onOpen={onOpen} />
      ) : (
        <div className="study-small-empty">
          <BookOpen size={23} />
          <p>
            {state.suppressed
              ? (state.holiday?.title ?? state.period?.title ?? t.dateOutside)
              : t.noLessons}
          </p>
        </div>
      )}
      {partial && (
        <IncompleteNotice
          value={partial}
          locale={locale}
          editable={editable}
          onEdit={() => onIncomplete(partial)}
        />
      )}
    </>
  );
}

export function StudySearch({
  data,
  date,
  query,
  locale,
  onOpen,
}: {
  data: StudyData;
  date: string;
  query: string;
  locale: Locale;
  onOpen: (group: StudyOccurrenceGroup) => void;
}) {
  const t = studyTexts(locale),
    items = studyWeekDates(date)
      .flatMap((day) => studyOccurrences(data, day))
      .filter((item) => studyMatchesQuery(item, query));
  return (
    <>
      <p className="study-search-note">{t.searchNote}</p>
      {items.length ? (
        <LessonList items={items} locale={locale} onOpen={onOpen} showDate />
      ) : (
        <div className="study-small-empty">
          <BookOpen size={24} />
          <p>{t.noResults}</p>
        </div>
      )}
    </>
  );
}

export function StudyCalendar({
  data,
  now,
  locale,
  editable,
  onTerm,
  onPeriod,
  onHoliday,
  onIncomplete,
  onReminders,
  onDate,
}: {
  data: StudyData;
  now: Date;
  locale: Locale;
  editable: boolean;
  onTerm: () => void;
  onPeriod: (period?: StudyPeriod) => void;
  onHoliday: (holiday?: StudyHoliday) => void;
  onIncomplete: (day: StudyIncompleteDay) => void;
  onReminders: () => void;
  onDate: (date: string) => void;
}) {
  const t = studyTexts(locale),
    today = studyLocalParts(now, data.term.timeZone).date,
    term = data.term;
  const periods = [...term.periods].sort((a, b) => a.startDate.localeCompare(b.startDate));
  return (
    <div className="study-calendar">
      <div className="study-term-card">
        <div className="study-section-heading">
          <span>
            <GraduationCap size={19} />
            {term.institution}
          </span>
          {editable && (
            <button className="study-icon-button" aria-label={t.edit} onClick={onTerm}>
              <Pencil size={17} />
            </button>
          )}
        </div>
        <h2>{term.title}</h2>
        {term.course && <p>{term.course}</p>}
        <button className="study-term-dates" onClick={() => onDate(term.startDate)}>
          {studyDateLabel(term.startDate, locale, true)}
          <span>—</span>
          {studyDateLabel(term.endDate, locale, true)}
          <ChevronRight size={17} />
        </button>
        <span className="study-term-meta">
          {studyWeekNumber(term, term.endDate)} {t.weeks} · {term.timeZone}
        </span>
      </div>
      <div className="study-section-heading">
        <h2>{t.periods}</h2>
        {editable && (
          <button className="study-icon-button" aria-label={t.addPeriod} onClick={() => onPeriod()}>
            <Plus size={19} />
          </button>
        )}
      </div>
      <div className="study-period-list">
        {periods.map((period) => (
          <button
            key={period.id}
            className={`study-period ${today >= period.startDate && today <= period.endDate ? 'is-active' : ''}`}
            onClick={() => (editable ? onPeriod(period) : onDate(period.startDate))}
          >
            <span className={`study-period-marker ${period.kind}`} />
            <span>
              <strong>{period.title}</strong>
              <span>
                {studyDateLabel(period.startDate, locale)} —{' '}
                {studyDateLabel(period.endDate, locale, true)}
              </span>
            </span>
            {today >= period.startDate && today <= period.endDate && (
              <small>{t.currentPhase}</small>
            )}
            <ChevronRight size={17} />
          </button>
        ))}
        {!periods.length && <p className="study-search-note">{t.noCalendar}</p>}
      </div>
      <div className="study-section-heading">
        <h2>{t.holidays}</h2>
        {editable && (
          <button
            className="study-icon-button"
            aria-label={t.addHoliday}
            onClick={() => onHoliday()}
          >
            <Plus size={19} />
          </button>
        )}
      </div>
      <div className="study-simple-list">
        {[...term.holidays]
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((holiday) => (
            <button
              key={holiday.date}
              onClick={() => (editable ? onHoliday(holiday) : onDate(holiday.date))}
            >
              <CalendarDays size={17} />
              <span>
                <strong>{holiday.title}</strong>
                <small>{studyDateLabel(holiday.date, locale, true)}</small>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
      </div>
      {term.incompleteDays.length > 0 && (
        <>
          <div className="study-section-heading">
            <h2>{t.incompleteDays}</h2>
          </div>
          <div className="study-simple-list">
            {term.incompleteDays.map((day) => (
              <button key={day.weekday} disabled={!editable} onClick={() => onIncomplete(day)}>
                <TriangleAlert size={17} />
                <span>
                  <strong>{studyWeekNames(locale)[day.weekday - 1]}</strong>
                  <small>{day.note}</small>
                </span>
                <ChevronRight size={17} />
              </button>
            ))}
          </div>
        </>
      )}
      <button className="study-reminder-row" disabled={!editable} onClick={onReminders}>
        <Bell size={18} />
        <span>
          {t.reminders}
          <small>{term.remindMinutes < 0 ? t.off : `${term.remindMinutes} ${t.minute}`}</small>
        </span>
        <ChevronRight size={17} />
      </button>
      <p className="study-privacy">
        <ShieldCheck size={15} />
        {t.private}
      </p>
    </div>
  );
}

export function StudyLessonDetails({
  group,
  locale,
  editable,
  onWeekly,
  onOccurrence,
}: {
  group: StudyOccurrenceGroup;
  locale: Locale;
  editable: boolean;
  onWeekly: (item: StudyOccurrence) => void;
  onOccurrence: (item: StudyOccurrence) => void;
}) {
  const t = studyTexts(locale),
    [copied, setCopied] = useState(''),
    url = studySafeLink(group.url);
  async function copy() {
    try {
      await navigator.clipboard.writeText([group.room, group.campus].filter(Boolean).join(' · '));
      setCopied(t.copied);
    } catch {
      setCopied(t.copyFailed);
    }
  }
  return (
    <div className="study-detail">
      <span className="study-result-date">
        {studyWeekNames(locale)[group.weekday - 1]} · {studyDateLabel(group.date, locale, true)}
      </span>
      <h3>{group.title}</h3>
      <div className="study-detail-room">
        {group.format === 'online' ? <Video size={23} /> : <MapPin size={23} />}
        <strong>{group.format === 'online' ? t.onlineFormat : group.room || t.roomMissing}</strong>
        {group.room && group.format !== 'online' && (
          <button className="study-icon-button" aria-label={t.copyRoom} onClick={() => void copy()}>
            {copied === t.copied ? <Check size={19} /> : <Copy size={19} />}
          </button>
        )}
      </div>
      {copied && (
        <p className="form-note" role="status">
          {copied}
        </p>
      )}
      {group.campus && <p>{group.campus}</p>}
      <p>
        <GraduationCap size={17} />
        {group.teacher || t.teacherMissing}
      </p>
      <p>
        <BookOpen size={17} />
        {t[group.kind]}
      </p>
      {group.note && <p className="study-day-note">{group.note}</p>}
      {group.cancelled && <p className="study-error">{t.cancelled}</p>}
      {url && group.format === 'online' && (
        <a className="primary full" href={url} target="_blank" rel="noopener noreferrer">
          {t.openOnline}
          <ArrowUpRight size={18} />
        </a>
      )}
      <div className="study-detail-slots">
        {group.items.map((item) => (
          <div key={item.id}>
            <strong>
              <Clock3 size={16} />
              {item.startTime}–{item.endTime}
            </strong>
            {editable && (
              <div>
                <button className="secondary" onClick={() => onOccurrence(item)}>
                  {t.changeDate}
                </button>
                <button className="text-button" onClick={() => onWeekly(item)}>
                  {t.changeWeekly}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
