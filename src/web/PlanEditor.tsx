import { useState, type FormEvent } from 'react';
import { MapPin, Trash2 } from 'lucide-react';
import type {
  Friend,
  Locale,
  Place,
  Plan,
  PlanInput,
  PlanKind,
  Cadence,
} from '../shared/contracts';
import { texts } from './i18n';
import { Modal } from './components';
import { meetingTexts } from './meetingTexts';
import { StudyConflict } from './StudyConflict';

export type EditorValue = { plan?: Plan; draft?: PlanInput; place?: Place; mode?: 'meeting' };
interface Props {
  value: EditorValue;
  date: string;
  timeZone: string;
  friends: Friend[];
  locale: Locale;
  busy: boolean;
  onClose: () => void;
  onSave: (input: PlanInput, plan?: Plan) => Promise<void>;
  onPickPlace: (draft: PlanInput, plan?: Plan) => void;
  onAuthError?: () => void;
}
export function PlanEditor({
  value,
  date,
  timeZone,
  friends,
  locale,
  busy,
  onClose,
  onSave,
  onPickPlace,
  onAuthError,
}: Props) {
  const t = texts(locale);
  const initial = value.draft ?? value.plan;
  const meeting = value.mode === 'meeting' || initial?.kind === 'event';
  const m = meetingTexts(locale);
  const [kind, setKind] = useState<PlanKind>(initial?.kind ?? (meeting ? 'event' : 'habit'));
  const [cadence, setCadence] = useState<Cadence>(initial?.cadence ?? (meeting ? 'once' : 'daily'));
  const [members, setMembers] = useState<string[]>(
    (initial?.memberIds ?? []).filter((uid) => uid !== value.plan?.ownerId),
  );
  const [place, setPlace] = useState<Place | null>(value.place ?? initial?.place ?? null);
  const [error, setError] = useState('');
  const [selectedDate, setSelectedDate] = useState(initial?.startDate ?? date);
  const [selectedTime, setSelectedTime] = useState(initial?.time ?? '09:00');
  function read(form: HTMLFormElement): PlanInput {
    const d = new FormData(form);
    return {
      title: String(d.get('title') ?? '').trim(),
      description: String(d.get('description') ?? '').trim(),
      kind,
      cadence,
      startDate: String(d.get('date') ?? date),
      time: String(d.get('time') ?? '09:00'),
      timeZone: initial?.timeZone ?? timeZone,
      memberIds: members.filter((uid) => uid !== value.plan?.ownerId),
      place,
      targetAmount: kind === 'savings' ? Number(d.get('target')) : null,
      remindMinutes: Number(d.get('reminder') ?? 15),
      ...(kind === 'event' ? { minAttendees: Number(d.get('minimum') ?? 2) } : {}),
    };
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const input = read(e.currentTarget);
    if (meeting && !value.plan && input.memberIds.length === 0) {
      setError(m.pickFriends);
      return;
    }
    if (
      meeting &&
      (!Number.isInteger(input.minAttendees) ||
        Number(input.minAttendees) < 2 ||
        Number(input.minAttendees) > 21)
    ) {
      setError(m.minimumInvalid);
      return;
    }
    if (
      kind === 'savings' &&
      (!Number.isSafeInteger(input.targetAmount) ||
        Number(input.targetAmount) <= 0 ||
        Number(input.targetAmount) > 1_000_000_000)
    ) {
      setError(t.amountMax);
      return;
    }
    await onSave(input, value.plan);
  }
  return (
    <Modal
      title={
        meeting ? (value.plan ? m.editMeeting : m.newMeeting) : value.plan ? t.editPlan : t.newPlan
      }
      onClose={onClose}
      closeLabel={t.close}
    >
      <form className="form-stack" onSubmit={(e) => void submit(e)}>
        {meeting && <p className="meeting-editor-intro">{m.intro}</p>}
        <label>
          {meeting ? m.title : t.title}
          <input
            name="title"
            required
            minLength={2}
            maxLength={120}
            autoFocus
            placeholder={meeting ? m.titleExample : undefined}
            defaultValue={initial?.title ?? ''}
          />
        </label>
        <label>
          {t.description}
          <textarea
            name="description"
            rows={2}
            maxLength={1000}
            defaultValue={initial?.description ?? ''}
          />
        </label>
        {!meeting && (
          <div className="form-columns">
            <label>
              {t.kind}
              <select value={kind} onChange={(e) => setKind(e.target.value as PlanKind)}>
                {(['habit', 'event', 'savings'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.cadence}
              <select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
                {(['once', 'daily', 'weekly', 'monthly'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {meeting && (
          <div className="form-columns">
            <label>
              {t.cadence}
              <select
                name="cadence"
                value={cadence}
                onChange={(e) => setCadence(e.target.value as Cadence)}
              >
                {(['once', 'daily', 'weekly', 'monthly'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t[value]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {m.minimum}
              <input
                name="minimum"
                type="number"
                inputMode="numeric"
                min={2}
                max={21}
                step={1}
                required
                defaultValue={initial?.minAttendees ?? 2}
              />
            </label>
          </div>
        )}
        {meeting && <p className="form-note">{m.minimumNote}</p>}
        <div className="form-columns">
          <label>
            {t.date}
            <input
              name="date"
              type="date"
              required
              min="2020-01-01"
              max="2100-12-31"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
          </label>
          <label>
            {t.time}
            <input
              name="time"
              type="time"
              required
              value={selectedTime}
              onChange={(event) => setSelectedTime(event.target.value)}
            />
          </label>
        </div>
        {kind === 'event' && (
          <StudyConflict
            date={selectedDate}
            time={selectedTime}
            zone={initial?.timeZone ?? timeZone}
            locale={locale}
            onAuthError={onAuthError}
          />
        )}
        <label>
          {t.remindBefore}
          <select name="reminder" defaultValue={initial?.remindMinutes ?? 15}>
            <option value={-1}>{t.noReminder}</option>
            <option value={0}>{t.atTime}</option>
            {[5, 15, 30, 60].map((n) => (
              <option key={n} value={n}>
                {n} {t.minutes}
              </option>
            ))}
          </select>
        </label>
        {kind === 'savings' && (
          <label>
            {t.goalAmount}
            <input
              name="target"
              type="number"
              inputMode="numeric"
              min={1}
              max={1_000_000_000}
              step={1}
              required
              defaultValue={initial?.targetAmount ?? 20000}
            />
          </label>
        )}
        <fieldset>
          <legend>
            {meeting ? m.participants : t.participants} · {members.length}/20
          </legend>
          {meeting && <p className="form-note">{m.participantsNote}</p>}
          {friends.length ? (
            friends.map((friend) => (
              <label className="checkbox-row" key={friend.uid}>
                <input
                  type="checkbox"
                  checked={members.includes(friend.uid)}
                  disabled={members.length >= 20 && !members.includes(friend.uid)}
                  onChange={(e) =>
                    setMembers((prev) =>
                      e.target.checked
                        ? [...prev, friend.uid]
                        : prev.filter((id) => id !== friend.uid),
                    )
                  }
                />
                <span>
                  {friend.displayName}
                  <small>@{friend.username}</small>
                </span>
              </label>
            ))
          ) : (
            <p className="form-note">{t.noFriendsYet}</p>
          )}
        </fieldset>
        <fieldset>
          <legend>{t.place}</legend>
          {meeting && <p className="form-note">{m.placeNote}</p>}
          {place ? (
            <div className="chosen-place">
              <MapPin size={18} />
              <span>{place.label}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={t.removePlace}
                onClick={() => setPlace(null)}
              >
                <Trash2 size={18} />
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="secondary full"
            onClick={(e) => {
              const form = e.currentTarget.form;
              if (form) onPickPlace(read(form), value.plan);
            }}
          >
            <MapPin size={18} />
            {t.chooseOnMap}
          </button>
        </fieldset>
        <p className="form-note">
          {t.timezoneHint} · {timeZone}
        </p>
        {meeting && value.plan && <p className="form-note">{m.changedNote}</p>}
        {meeting && cadence !== 'once' && value.plan && <p className="form-note">{m.seriesNote}</p>}
        {error && <p className="inline-message error">{error}</p>}
        <button className="primary full" disabled={busy}>
          {busy ? t.loading : meeting && !value.plan ? m.create : t.save}
        </button>
      </form>
    </Modal>
  );
}
