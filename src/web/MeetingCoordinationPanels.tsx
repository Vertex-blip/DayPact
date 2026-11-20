import { useRef, useState, type FormEvent } from 'react';
import { Check, Clock, Package, Plus, Trash2, Wallet } from 'lucide-react';
import type { Locale, Plan } from '../shared/contracts';
import type { MeetingCoordination, MeetingTimeOption } from '../shared/meetingCoordination';
import { dateLabel, texts } from './i18n';
import { meetingTexts } from './meetingTexts';

export type MeetingAction = (
  path: string,
  method: string,
  body: unknown,
  refreshPlan?: boolean,
) => Promise<boolean>;
interface PanelProps {
  plan: Plan;
  uid: string;
  locale: Locale;
  data: MeetingCoordination;
  disabled: boolean;
  onAction: MeetingAction;
}

export function MeetingTimes({
  plan,
  uid,
  locale,
  data,
  disabled,
  onAction,
  onConfirm,
}: PanelProps & { onConfirm: (optionId: string) => void }) {
  const m = meetingTexts(locale),
    t = texts(locale),
    owner = uid === plan.ownerId;
  const [draft, setDraft] = useState<{
    version: number;
    options: Pick<MeetingTimeOption, 'id' | 'date' | 'time'>[];
  } | null>(null);
  const [error, setError] = useState('');
  const options = data.timeOptions.options;
  function edit() {
    setError('');
    setDraft({
      version: plan.version,
      options: options.length
        ? options.map(({ id, date, time }) => ({ id, date, time }))
        : [
            { id: crypto.randomUUID(), date: plan.date, time: plan.time },
            {
              id: crypto.randomUUID(),
              date: plan.date,
              time: `${String((Number(plan.time.slice(0, 2)) + 1) % 24).padStart(2, '0')}:${plan.time.slice(3)}`,
            },
          ],
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (
      draft.options.length < 2 ||
      new Set(draft.options.map((option) => `${option.date}:${option.time}`)).size !==
        draft.options.length
    ) {
      setError(m.timeLimit);
      return;
    }
    if (await onAction('/time-options', 'PUT', draft, true)) setDraft(null);
  }
  return (
    <section className="meeting-coordination-section">
      <div className="meeting-section-title">
        <Clock size={18} />
        <h3>{m.availability}</h3>
      </div>
      <p className="form-note">{m.availabilityNote}</p>
      {plan.cadence !== 'once' && <p className="meeting-scope-note">{m.seriesNote}</p>}
      {draft ? (
        <form className="meeting-inline-form form-stack" onSubmit={(event) => void submit(event)}>
          {draft.options.map((option, index) => (
            <fieldset key={option.id} className="meeting-time-draft">
              <legend>
                {m.option} {index + 1}
              </legend>
              <div className="form-columns">
                <label>
                  {t.date}
                  <input
                    type="date"
                    required
                    min="2020-01-01"
                    max="2100-12-31"
                    value={option.date}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        options: draft.options.map((value) =>
                          value.id === option.id ? { ...value, date: event.target.value } : value,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  {t.time}
                  <input
                    type="time"
                    required
                    value={option.time}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        options: draft.options.map((value) =>
                          value.id === option.id ? { ...value, time: event.target.value } : value,
                        ),
                      })
                    }
                  />
                </label>
              </div>
              {draft.options.length > 2 && (
                <button
                  type="button"
                  className="text-button danger"
                  disabled={disabled}
                  aria-label={`${m.removeOption} ${index + 1}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      options: draft.options.filter((value) => value.id !== option.id),
                    })
                  }
                >
                  {m.removeOption}
                </button>
              )}
            </fieldset>
          ))}
          {draft.options.length < 6 && (
            <button
              className="secondary full"
              type="button"
              disabled={disabled}
              onClick={() =>
                setDraft({
                  ...draft,
                  options: [
                    ...draft.options,
                    { id: crypto.randomUUID(), date: plan.date, time: plan.time },
                  ],
                })
              }
            >
              <Plus size={17} />
              {m.addTime}
            </button>
          )}
          <p className="form-note">{m.pollReset}</p>
          {draft.version !== plan.version && (
            <div className="inline-message">
              <span>{m.changed}</span>
              <button type="button" className="text-button" disabled={disabled} onClick={edit}>
                {m.refresh}
              </button>
            </div>
          )}
          {error && (
            <p className="inline-message error" role="alert">
              {error}
            </p>
          )}
          <div className="form-columns">
            <button className="primary" disabled={disabled || draft.version !== plan.version}>
              {m.savePoll}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={disabled}
              onClick={() => setDraft(null)}
            >
              {t.cancel}
            </button>
          </div>
        </form>
      ) : (
        <>
          {options.map((option) => {
            const selected = option.availableUserIds.includes(uid);
            return (
              <article className="meeting-time-option" key={option.id}>
                <div className="meeting-time-line">
                  <b>{dateLabel(option.date, locale, { day: 'numeric', month: 'long' })}</b>
                  <strong>{option.time}</strong>
                </div>
                <small className="muted">
                  {option.availableUserIds
                    .map((id) => plan.members.find((member) => member.uid === id)?.displayName)
                    .filter(Boolean)
                    .join(', ') || m.pending}
                </small>
                <div className="meeting-option-footer">
                  <button
                    className={`meeting-vote ${selected ? 'voted' : ''}`}
                    aria-pressed={selected}
                    disabled={disabled || data.planVersion !== plan.version}
                    onClick={() =>
                      void onAction('/time-vote', 'PUT', {
                        version: plan.version,
                        optionIds: options
                          .filter((value) =>
                            value.id === option.id
                              ? !selected
                              : value.availableUserIds.includes(uid),
                          )
                          .map((value) => value.id),
                      })
                    }
                  >
                    <Check size={16} />
                    {m.available} · {option.availableUserIds.length}
                  </button>
                  {owner && (
                    <button
                      className="text-button"
                      disabled={disabled || data.planVersion !== plan.version}
                      onClick={() => onConfirm(option.id)}
                    >
                      {m.confirmTime}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {!options.length && <p className="form-note">{m.noTimes}</p>}
          {owner && (
            <button className="secondary full" disabled={disabled} onClick={edit}>
              <Plus size={17} />
              {options.length ? m.editPoll : m.createPoll}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function MeetingPreparation({ plan, uid, locale, data, disabled, onAction }: PanelProps) {
  const m = meetingTexts(locale),
    t = texts(locale),
    owner = uid === plan.ownerId;
  const [itemTitle, setItemTitle] = useState(''),
    [addItem, setAddItem] = useState(false);
  const itemOperation = useRef<{ title: string; operationId: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [budget, setBudget] = useState<{ version: number; total: string } | null>(null);
  const [error, setError] = useState('');
  const ownShare = data.expense.shares.find((share) => share.uid === uid);
  const money = (amount: number) =>
    `${new Intl.NumberFormat(locale === 'kk' ? 'kk-KZ' : 'ru-RU', { maximumFractionDigits: 0 }).format(amount)} ₸`;
  async function submitItem(event: FormEvent) {
    event.preventDefault();
    const title = itemTitle.trim();
    if (!title) return;
    if (itemOperation.current?.title !== title)
      itemOperation.current = { title, operationId: crypto.randomUUID() };
    if (
      await onAction('/items', 'POST', {
        ...itemOperation.current,
        date: plan.date,
        version: plan.version,
      })
    ) {
      itemOperation.current = null;
      setItemTitle('');
      setAddItem(false);
    }
  }
  async function submitBudget(event: FormEvent) {
    event.preventDefault();
    if (!budget) return;
    const total = Number(budget.total);
    if (
      !/^\d+$/.test(budget.total) ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      total > 1_000_000_000
    ) {
      setError(m.expenseInvalid);
      return;
    }
    if (await onAction('/expense', 'PUT', { date: plan.date, version: budget.version, total })) {
      setBudget(null);
      setError('');
    }
  }
  return (
    <>
      <section className="meeting-coordination-section meeting-supplies">
        <div className="meeting-section-title">
          <Package size={18} />
          <h3>{m.supplies}</h3>
          <span className="meeting-count-badge">
            {data.items.filter((item) => item.claimedBy).length}/{data.items.length}
          </span>
        </div>
        <p className="form-note">{m.suppliesNote}</p>
        {data.items.map((item) => (
          <article className="meeting-supply-row" key={item.id}>
            <div className="meeting-supply-title">
              <b>{item.title}</b>
              <small className={item.claimedBy ? 'blue' : 'muted'}>
                {item.claimedBy
                  ? (plan.members.find((member) => member.uid === item.claimedBy)?.displayName ??
                    m.claim)
                  : m.unclaimed}
              </small>
            </div>
            <div className="meeting-supply-actions">
              {(!item.claimedBy || item.claimedBy === uid) && (
                <button
                  className={`meeting-vote ${item.claimedBy === uid ? 'voted' : ''}`}
                  aria-pressed={item.claimedBy === uid}
                  disabled={disabled}
                  onClick={() =>
                    void onAction(`/items/${encodeURIComponent(item.id)}/claim`, 'PUT', {
                      date: plan.date,
                      version: item.version,
                      claimed: !item.claimedBy,
                    })
                  }
                >
                  {item.claimedBy === uid ? <Check size={16} /> : <Plus size={16} />}
                  {item.claimedBy === uid ? m.release : m.claim}
                </button>
              )}
              {(owner || item.createdBy === uid) && (
                <button
                  className="icon-button"
                  aria-label={`${t.delete}: ${item.title}`}
                  disabled={disabled}
                  onClick={() => setDeleting(deleting === item.id ? null : item.id)}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            {deleting === item.id && (
              <div className="meeting-delete-confirm">
                <button
                  className="text-button danger"
                  disabled={disabled}
                  onClick={() =>
                    void onAction(`/items/${encodeURIComponent(item.id)}`, 'DELETE', {
                      date: plan.date,
                      version: item.version,
                    }).then((ok) => {
                      if (ok) setDeleting(null);
                    })
                  }
                >
                  {t.delete}: {item.title}
                </button>
                <button
                  className="text-button"
                  disabled={disabled}
                  onClick={() => setDeleting(null)}
                >
                  {t.cancel}
                </button>
              </div>
            )}
          </article>
        ))}
        {!data.items.length && <p className="form-note">{m.noSupplies}</p>}
        {addItem ? (
          <form
            className="meeting-inline-form form-stack"
            onSubmit={(event) => void submitItem(event)}
          >
            <label>
              {m.addSupply}
              <input
                autoFocus
                required
                maxLength={80}
                value={itemTitle}
                placeholder={m.supplyExample}
                onChange={(event) => setItemTitle(event.target.value)}
              />
            </label>
            <div className="form-columns">
              <button className="primary" disabled={disabled}>
                {m.add}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={disabled}
                onClick={() => {
                  setAddItem(false);
                  setItemTitle('');
                  itemOperation.current = null;
                }}
              >
                {t.cancel}
              </button>
            </div>
          </form>
        ) : (
          <button
            className="secondary full"
            disabled={disabled || data.items.length >= 30}
            onClick={() => setAddItem(true)}
          >
            <Plus size={17} />
            {m.addSupply}
          </button>
        )}
      </section>
      <section className="meeting-coordination-section meeting-expense">
        <div className="meeting-section-title">
          <Wallet size={18} />
          <h3>{m.expenses}</h3>
        </div>
        <p className="form-note">{m.expenseMembers}</p>
        {data.expense.total > 0 ? (
          <>
            <div className="meeting-budget">
              <span>
                {m.expenseTotal}
                <b>{money(data.expense.total)}</b>
              </span>
              {ownShare && (
                <span>
                  {m.expenseShare}
                  <b>{money(ownShare.amount)}</b>
                </span>
              )}
            </div>
            {!data.expense.shares.length && <p className="form-note">{m.noAccepted}</p>}
            {data.expense.shares.map((share) => (
              <div className="meeting-share" key={share.uid}>
                <span>
                  <b>
                    {share.displayName}
                    {share.uid === uid ? ` · ${t.you}` : ''}
                  </b>
                  <small>{share.paid ? m.markedPaid : m.waitingPayment}</small>
                </span>
                <strong>{money(share.amount)}</strong>
                {share.paid && <Check size={17} className="success" />}
              </div>
            ))}
            {ownShare && (
              <button
                className={`secondary full ${ownShare.paid ? 'meeting-paid' : ''}`}
                aria-pressed={ownShare.paid}
                disabled={disabled}
                onClick={() =>
                  void onAction('/expense/paid', 'PUT', {
                    date: plan.date,
                    version: data.expense.version,
                    paid: !ownShare.paid,
                  })
                }
              >
                <Check size={17} />
                {ownShare.paid ? m.unpaid : m.paid}
              </button>
            )}
          </>
        ) : (
          <p className="form-note">{m.noExpenses}</p>
        )}
        {owner &&
          (budget ? (
            <form
              className="meeting-inline-form form-stack"
              onSubmit={(event) => void submitBudget(event)}
            >
              <label>
                {m.expenseAmount}
                <input
                  type="number"
                  inputMode="numeric"
                  autoFocus
                  required
                  min={0}
                  max={1_000_000_000}
                  step={1}
                  value={budget.total}
                  onChange={(event) => setBudget({ ...budget, total: event.target.value })}
                />
              </label>
              <p className="form-note">{m.expenseReset}</p>
              {budget.version !== data.expense.version && (
                <div className="inline-message">
                  <span>{m.expenseReset}</span>
                  <button
                    type="button"
                    className="text-button"
                    disabled={disabled}
                    onClick={() =>
                      setBudget({
                        version: data.expense.version,
                        total: String(data.expense.total),
                      })
                    }
                  >
                    {m.refresh}
                  </button>
                </div>
              )}
              {error && (
                <p className="inline-message error" role="alert">
                  {error}
                </p>
              )}
              <div className="form-columns">
                <button
                  className="primary"
                  disabled={disabled || budget.version !== data.expense.version}
                >
                  {t.save}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled}
                  onClick={() => {
                    setBudget(null);
                    setError('');
                  }}
                >
                  {t.cancel}
                </button>
              </div>
            </form>
          ) : (
            <button
              className="text-button full"
              disabled={disabled}
              onClick={() =>
                setBudget({ version: data.expense.version, total: String(data.expense.total) })
              }
            >
              {data.expense.total ? m.editExpense : m.addExpense}
            </button>
          ))}
        <p className="meeting-money-note">{m.moneyNote}</p>
      </section>
    </>
  );
}
