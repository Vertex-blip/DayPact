import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Clock, MapPin, Navigation, ThumbsUp, Users } from 'lucide-react';
import type { Locale, MeetingPlaces, Place, Plan } from '../shared/contracts';
import type { MeetingCoordination, MeetingTravelStatus } from '../shared/meetingCoordination';
import { api, ApiError, readableError, writeApi } from './api';
import { currentAuth } from './firebase';
import { dateLabel, localDate, texts } from './i18n';
import { meetingTexts } from './meetingTexts';
import { Avatar, Modal } from './components';
import { MeetingPreparation, MeetingTimes, type MeetingAction } from './MeetingCoordinationPanels';

export interface MeetingProposal {
  operationId: string;
  place: Place;
}
interface Props {
  plan: Plan;
  uid: string;
  locale: Locale;
  online: boolean;
  busy: boolean;
  proposal?: MeetingProposal;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCheckin: () => void;
  onPickPlace: () => void;
  onViewPlace: (place: Place) => void;
  onDiscardProposal: () => void;
  onProposalSaved: () => void;
  onPlanChanged: (plan: Plan) => void;
  onRefresh: () => Promise<void>;
}

export function MeetingDetail({
  plan,
  uid,
  locale,
  online,
  busy,
  proposal,
  onClose,
  onEdit,
  onDelete,
  onCheckin,
  onPickPlace,
  onViewPlace,
  onDiscardProposal,
  onProposalSaved,
  onPlanChanged,
  onRefresh,
}: Props) {
  const t = texts(locale),
    m = meetingTexts(locale);
  const [places, setPlaces] = useState<MeetingPlaces | null>(null);
  const [coordination, setCoordination] = useState<MeetingCoordination | null>(null);
  const [section, setSection] = useState<'overview' | 'coordination' | 'preparation'>(
    proposal ? 'coordination' : 'overview',
  );
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0),
    request = useRef(0),
    actionPending = useRef(false);
  const callbacks = useRef({ onRefresh, onClose });
  callbacks.current = { onRefresh, onClose };
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
      request.current++;
    };
  }, [uid, plan.id, plan.date]);
  const valid = useCallback(
    (epoch: number) => generation.current === epoch && currentAuth()?.currentUser?.uid === uid,
    [uid],
  );
  const load = useCallback(async () => {
    if (!navigator.onLine) return;
    const epoch = generation.current,
      sequence = ++request.current;
    setLoading(true);
    try {
      const [result, nextCoordination] = await Promise.all([
        api<MeetingPlaces>(`/plans/${encodeURIComponent(plan.id)}/places`, { expectedUid: uid }),
        api<MeetingCoordination>(
          `/plans/${encodeURIComponent(plan.id)}/coordination?date=${encodeURIComponent(plan.date)}`,
          { expectedUid: uid },
        ),
      ]);
      if (valid(epoch) && sequence === request.current) {
        setPlaces(result);
        setCoordination(nextCoordination);
      }
    } catch (err) {
      if (valid(epoch) && sequence === request.current) {
        setError(readableError(err, locale));
        if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
          setPlaces(null);
          setCoordination(null);
          await callbacks.current.onRefresh();
          if (valid(epoch)) callbacks.current.onClose();
        }
      }
    } finally {
      if (valid(epoch) && sequence === request.current) setLoading(false);
    }
  }, [plan.id, plan.date, uid, locale, valid]);
  useEffect(() => {
    if (online) void load();
  }, [load, online, plan.version]);
  function message(err: unknown) {
    if (err instanceof ApiError) {
      if (err.code === 'PLACE_LIMIT') return m.limit;
      if (err.code === 'PLACE_NOT_FOUND') return m.placeMissing;
      if (err.code === 'VERSION_CONFLICT') return m.changed;
      if (err.code === 'OPERATION_CONFLICT') return m.proposalConflict;
      if (err.code === 'MEETING_REQUIRED') return m.unavailable;
      if (err.code === 'ITEM_CLAIMED') return m.claimed;
      if (err.code === 'ITEM_NOT_FOUND') return m.placeMissing;
      if (err.code === 'ACCEPTED_REQUIRED') return m.acceptedRequired;
      if (err.code === 'INVALID_OCCURRENCE') return m.occurrenceChanged;
      if (err.code === 'COORDINATION_LIMIT') return m.coordinationLimit;
      if (err.code === 'TRAVEL_TODAY_ONLY') return m.travelToday;
      if (err.code === 'OCCURRENCE_WINDOW') return m.occurrenceWindow;
    }
    return readableError(err, locale);
  }
  async function perform(task: (isCurrent: () => boolean) => Promise<void>) {
    if (actionPending.current || busy) return false;
    if (!online) {
      setError(m.online);
      return false;
    }
    const epoch = generation.current;
    actionPending.current = true;
    setWorking(true);
    setError('');
    try {
      await task(() => valid(epoch));
      return valid(epoch);
    } catch (err) {
      if (valid(epoch)) {
        setError(message(err));
        if (err instanceof ApiError && [401, 403, 404, 409].includes(err.status)) {
          await onRefresh();
          if (valid(epoch) && err.status === 409) {
            await load();
            if (valid(epoch)) setError(message(err));
          }
          if (valid(epoch) && [401, 403, 404].includes(err.status)) onClose();
        }
      }
      return false;
    } finally {
      if (valid(epoch)) {
        actionPending.current = false;
        setWorking(false);
      }
    }
  }
  const coordinate: MeetingAction = (path, method, body, refreshPlan = false) =>
    perform(async (isCurrent) => {
      await writeApi(`/plans/${encodeURIComponent(plan.id)}${path}`, method, body, uid);
      if (!isCurrent()) return;
      if (refreshPlan) await onRefresh();
      if (isCurrent()) await load();
    });
  const own = plan.members.find((member) => member.uid === uid);
  const disabled = busy || working;
  const going = plan.members.filter((member) => member.rsvp === 'accepted').length;
  const declined = plan.members.filter((member) => member.rsvp === 'declined').length;
  const pending = plan.members.length - going - declined;
  const owner = plan.ownerId === uid;
  const canArrive = plan.date <= localDate(plan.timeZone);
  const today = plan.date === localDate(plan.timeZone);
  const ownTravel = coordination?.travel.find((travel) => travel.uid === uid);
  const minimum = plan.minAttendees ?? 2;
  const confirmed = going >= minimum;
  const options = places?.options ?? [];
  const samePlace = (place: Place) =>
    !!plan.place &&
    place.lat === plan.place.lat &&
    place.lng === plan.place.lng &&
    place.label === plan.place.label;
  return (
    <Modal title={plan.title} onClose={onClose} closeLabel={t.close}>
      <div className="meeting-heading-meta">
        <span>
          <Clock size={17} />
          {dateLabel(plan.date, locale, { day: 'numeric', month: 'long' })} · {plan.time}
        </span>
        <span>
          <Users size={17} />
          {plan.members.length}
        </span>
      </div>
      {plan.cadence !== 'once' && (
        <div className="meeting-recurrence">
          <span>{t[plan.cadence]}</span>
          <small>{m.occurrenceNote}</small>
        </div>
      )}
      {plan.description && <p className="detail-description">{plan.description}</p>}
      <nav className="meeting-segments" aria-label={m.meetings}>
        {(['overview', 'coordination', 'preparation'] as const).map((value) => (
          <button key={value} aria-pressed={section === value} onClick={() => setSection(value)}>
            {m[value]}
          </button>
        ))}
      </nav>
      <div className="meeting-update-row">
        <span>
          {loading ? t.loading : dateLabel(plan.date, locale, { day: 'numeric', month: 'long' })}
        </span>
        <button
          className="text-button"
          disabled={disabled || loading || !online}
          onClick={() =>
            void perform(async (isCurrent) => {
              await onRefresh();
              if (isCurrent()) await load();
            })
          }
        >
          {m.refresh}
        </button>
      </div>
      {!online && <p className="form-note">{m.onlineOnly}</p>}
      {error && (
        <div className="inline-message error" role="alert">
          <span>{error}</span>
          <button
            className="text-button"
            disabled={disabled || !online}
            onClick={() => {
              setError('');
              void load();
            }}
          >
            {t.retry}
          </button>
        </div>
      )}
      <section className="meeting-panel" hidden={section !== 'overview'} aria-label={m.overview}>
        <div className={`meeting-threshold ${confirmed ? 'meeting-threshold-met' : ''}`}>
          <div>
            <Users size={18} />
            <b>{confirmed ? m.ready : m.gathering}</b>
            <strong>
              {going}/{minimum}
            </strong>
          </div>
          <div className="meeting-threshold-track">
            <span style={{ width: `${Math.min(100, (going / minimum) * 100)}%` }} />
          </div>
        </div>
        <section className="meeting-response">
          <span className="group-caption">{m.response}</span>
          <div className="meeting-response-buttons">
            {(['accepted', 'declined'] as const).map((status) => (
              <button
                key={status}
                className={`secondary ${own?.rsvp === status ? 'selected-response' : ''}`}
                aria-pressed={own?.rsvp === status}
                disabled={disabled || !online}
                onClick={() =>
                  void perform(async (isCurrent) => {
                    await writeApi(
                      `/plans/${encodeURIComponent(plan.id)}/rsvp`,
                      'POST',
                      { date: plan.date, status, version: plan.version },
                      uid,
                    );
                    if (!isCurrent()) return;
                    onPlanChanged({
                      ...plan,
                      members: plan.members.map((member) =>
                        member.uid === uid ? { ...member, rsvp: status } : member,
                      ),
                    });
                    await onRefresh();
                    if (isCurrent()) await load();
                  })
                }
              >
                {status === 'accepted' && <Check size={18} />}{' '}
                {status === 'accepted' ? m.attending : m.declined}
              </button>
            ))}
          </div>
          <div className="meeting-counts">
            <span>
              <b>{going}</b> {m.going}
            </span>
            <span>
              <b>{pending}</b> {m.pending}
            </span>
            {declined > 0 && (
              <span>
                <b>{declined}</b> {m.notGoing}
              </span>
            )}
          </div>
        </section>
        <div className="meeting-current-place">
          <span className="group-caption">{m.currentPlace}</span>
          {plan.place ? (
            <button className="meeting-place-button" onClick={() => onViewPlace(plan.place!)}>
              <MapPin size={21} />
              <span>
                <b>{plan.place.label}</b>
                <small>{m.viewMap}</small>
              </span>
            </button>
          ) : (
            <p className="muted">{m.noPlace}</p>
          )}
        </div>
        <section className="meeting-travel">
          <span className="group-caption">{m.travel}</span>
          <div className="meeting-travel-options">
            {(['on_way', 'late', 'arrived'] as const).map((status: MeetingTravelStatus) => (
              <button
                key={status}
                className={ownTravel?.status === status ? 'active' : ''}
                aria-pressed={ownTravel?.status === status}
                disabled={
                  disabled || !online || !today || own?.rsvp !== 'accepted' || !coordination
                }
                onClick={() =>
                  void coordinate('/travel', 'PUT', {
                    date: plan.date,
                    version: plan.version,
                    status,
                    ...(status === 'late' ? { lateMinutes: 10 } : {}),
                  })
                }
              >
                {status === 'on_way' ? (
                  <Navigation size={18} />
                ) : status === 'late' ? (
                  <Clock size={18} />
                ) : (
                  <CheckCircle2 size={18} />
                )}
                <span>
                  {status === 'on_way' ? m.onWay : status === 'late' ? m.late : m.arrived}
                </span>
              </button>
            ))}
          </div>
          {!today ? (
            <p className="form-note">{m.travelToday}</p>
          ) : own?.rsvp !== 'accepted' ? (
            <p className="form-note">{m.acceptedRequired}</p>
          ) : null}
        </section>
        <div className="detail-members meeting-members">
          {plan.members.map((member) => {
            const travel = coordination?.travel.find((value) => value.uid === member.uid);
            return (
              <div className="detail-member" key={member.uid}>
                <Avatar name={member.displayName} />
                <div>
                  <b>
                    {member.displayName}
                    {member.uid === uid ? ` · ${t.you}` : ''}
                  </b>
                  <small>
                    {member.uid === plan.ownerId ? `${m.organizer} · ` : ''}
                    {travel
                      ? travel.status === 'on_way'
                        ? m.onWayMember
                        : travel.status === 'late'
                          ? `${m.lateMember}${travel.lateMinutes !== 10 ? ` (${travel.lateMinutes} ${t.minutes})` : ''}`
                          : m.arrivedMember
                      : member.completed
                        ? m.arrivedMember
                        : member.rsvp === 'accepted'
                          ? m.going
                          : member.rsvp === 'declined'
                            ? m.notGoing
                            : m.pending}
                  </small>
                </div>
                {member.completed ? (
                  <CheckCircle2 size={20} className="success" />
                ) : member.rsvp === 'accepted' ? (
                  <Check size={20} className="blue" />
                ) : null}
              </div>
            );
          })}
        </div>
        <button className="text-button full" disabled={disabled || !canArrive} onClick={onCheckin}>
          <CheckCircle2 size={17} />
          {own?.completed ? m.arrivalUndo : m.occurrenceComplete}
        </button>
      </section>
      <section
        className="meeting-panel"
        hidden={section !== 'coordination'}
        aria-label={m.coordination}
      >
        {coordination && (
          <MeetingTimes
            plan={plan}
            uid={uid}
            locale={locale}
            data={coordination}
            disabled={disabled || !online}
            onAction={coordinate}
            onConfirm={(optionId) =>
              void perform(async (isCurrent) => {
                const result = await writeApi<{ plan: Plan }>(
                  `/plans/${encodeURIComponent(plan.id)}/time-confirm`,
                  'POST',
                  { optionId, version: plan.version },
                  uid,
                );
                if (!isCurrent()) return;
                onPlanChanged(result.plan);
                await onRefresh();
                if (isCurrent()) await load();
              })
            }
          />
        )}
        <section className="meeting-places">
          <div className="meeting-panel-heading">
            <h3>{m.chooseTogether}</h3>
          </div>
          <p className="form-note">{m.proposalNote}</p>
          {plan.cadence !== 'once' && <p className="meeting-scope-note">{m.seriesNote}</p>}
          {proposal && (
            <div className="meeting-proposal-draft">
              <span className="card-kicker">{m.proposalDraft}</span>
              <b>
                <MapPin size={17} />
                {proposal.place.label}
              </b>
              <div className="form-columns">
                <button
                  className="primary"
                  disabled={disabled || !online}
                  onClick={() =>
                    void perform(async (isCurrent) => {
                      const result = await writeApi<MeetingPlaces>(
                        `/plans/${encodeURIComponent(plan.id)}/places`,
                        'POST',
                        proposal,
                        uid,
                      );
                      if (!isCurrent()) return;
                      setPlaces(result);
                      onProposalSaved();
                    })
                  }
                >
                  {m.sendProposal}
                </button>
                <button className="secondary" disabled={disabled} onClick={onDiscardProposal}>
                  {t.cancel}
                </button>
              </div>
            </div>
          )}
          {options.map((option) => {
            const voted = option.voterIds.includes(uid),
              selected = samePlace(option.place);
            return (
              <article
                className={`meeting-option ${selected ? 'confirmed-option' : ''}`}
                key={option.id}
              >
                {selected && (
                  <span className="card-kicker">
                    <Check size={14} />
                    {m.confirmed}
                  </span>
                )}
                <button className="meeting-option-title" onClick={() => onViewPlace(option.place)}>
                  <MapPin size={17} />
                  <b>{option.place.label}</b>
                </button>
                <small className="muted">
                  {m.proposedBy}: {option.proposerName}
                </small>
                <div className="meeting-option-footer">
                  <button
                    className={`meeting-vote ${voted ? 'voted' : ''}`}
                    aria-pressed={voted}
                    aria-label={voted ? m.withdraw : `${m.vote}: ${option.place.label}`}
                    disabled={disabled || !online}
                    onClick={() =>
                      void perform(async (isCurrent) => {
                        await writeApi(
                          `/plans/${encodeURIComponent(plan.id)}/place-vote`,
                          'PUT',
                          { optionId: voted ? null : option.id },
                          uid,
                        );
                        if (isCurrent()) await load();
                      })
                    }
                  >
                    <ThumbsUp size={16} />
                    {option.voterIds.length} {m.votes}
                    {voted ? ` · ${m.voted}` : ''}
                  </button>
                  {owner && !selected && (
                    <button
                      className="text-button"
                      disabled={
                        disabled || !online || !places || places.planVersion !== plan.version
                      }
                      onClick={() =>
                        void perform(async (isCurrent) => {
                          const result = await writeApi<{ plan: Plan }>(
                            `/plans/${encodeURIComponent(plan.id)}/place-confirm`,
                            'POST',
                            { optionId: option.id, version: plan.version },
                            uid,
                          );
                          if (!isCurrent()) return;
                          onPlanChanged(result.plan);
                          await onRefresh();
                          if (isCurrent()) await load();
                        })
                      }
                    >
                      {m.confirmPlace}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {places && online && !error && !options.length && !loading && (
            <p className="form-note">{m.noProposals}</p>
          )}
          {loading && <p className="form-note">{t.loading}</p>}
          <button className="secondary full" disabled={disabled || !online} onClick={onPickPlace}>
            <MapPin size={18} />
            {m.propose}
          </button>
        </section>
      </section>
      <section
        className="meeting-panel"
        hidden={section !== 'preparation'}
        aria-label={m.preparation}
      >
        {coordination && (
          <MeetingPreparation
            plan={plan}
            uid={uid}
            locale={locale}
            data={coordination}
            disabled={disabled || !online}
            onAction={coordinate}
          />
        )}
      </section>
      <div className="detail-actions meeting-detail-actions">
        {owner && (
          <div className="form-columns">
            <button className="text-button full" disabled={disabled} onClick={onEdit}>
              {t.edit}
            </button>
            <button className="text-button danger full" disabled={disabled} onClick={onDelete}>
              {t.delete}
            </button>
          </div>
        )}
        <p className="form-note">{m.private}</p>
      </div>
    </Modal>
  );
}
