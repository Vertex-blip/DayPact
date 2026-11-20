import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Clock, MapPin, ThumbsUp, Users } from 'lucide-react';
import type { Locale, MeetingPlaces, Place, Plan } from '../shared/contracts';
import { api, ApiError, readableError, writeApi } from './api';
import { currentAuth } from './firebase';
import { dateLabel, localDate, texts } from './i18n';
import { meetingTexts } from './meetingTexts';
import { Avatar, Modal } from './components';

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
  }, [uid, plan.id]);
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
      const result = await api<MeetingPlaces>(`/plans/${encodeURIComponent(plan.id)}/places`, {
        expectedUid: uid,
      });
      if (valid(epoch) && sequence === request.current) {
        setPlaces(result);
      }
    } catch (err) {
      if (valid(epoch) && sequence === request.current) {
        setError(readableError(err, locale));
        if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
          setPlaces(null);
          await callbacks.current.onRefresh();
          if (valid(epoch)) callbacks.current.onClose();
        }
      }
    } finally {
      if (valid(epoch) && sequence === request.current) setLoading(false);
    }
  }, [plan.id, uid, locale, valid]);
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
    }
    return readableError(err, locale);
  }
  async function perform(task: (isCurrent: () => boolean) => Promise<void>) {
    if (actionPending.current || busy) return;
    if (!online) {
      setError(m.online);
      return;
    }
    const epoch = generation.current;
    actionPending.current = true;
    setWorking(true);
    setError('');
    try {
      await task(() => valid(epoch));
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
    } finally {
      if (valid(epoch)) {
        actionPending.current = false;
        setWorking(false);
      }
    }
  }
  const own = plan.members.find((member) => member.uid === uid);
  const disabled = busy || working;
  const going = plan.members.filter((member) => member.rsvp === 'accepted').length;
  const declined = plan.members.filter((member) => member.rsvp === 'declined').length;
  const pending = plan.members.length - going - declined;
  const owner = plan.ownerId === uid;
  const canArrive = plan.date <= localDate(plan.timeZone);
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
      {plan.description && <p className="detail-description">{plan.description}</p>}
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
      <div className="detail-members meeting-members">
        {plan.members.map((member) => (
          <div className="detail-member" key={member.uid}>
            <Avatar name={member.displayName} />
            <div>
              <b>
                {member.displayName}
                {member.uid === uid ? ` · ${t.you}` : ''}
              </b>
              <small>
                {member.uid === plan.ownerId ? `${m.organizer} · ` : ''}
                {member.completed
                  ? m.arrived
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
        ))}
      </div>
      <section className="meeting-places">
        <div className="meeting-panel-heading">
          <h3>{m.chooseTogether}</h3>
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
        <p className="form-note">{m.proposalNote}</p>
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
                    disabled={disabled || !online || !places || places.planVersion !== plan.version}
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
        {!online && <p className="form-note">{m.online}</p>}
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
      </section>
      <div className="detail-actions meeting-detail-actions">
        <button className="secondary full" disabled={disabled || !canArrive} onClick={onCheckin}>
          <CheckCircle2 size={18} />
          {own?.completed ? m.arrivalUndo : m.arrival}
        </button>
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
