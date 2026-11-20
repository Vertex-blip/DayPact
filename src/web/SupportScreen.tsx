import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronRight, LoaderCircle, MessageSquare, Send } from 'lucide-react';
import type { Locale } from '../shared/contracts';
import type { SupportTicket } from '../shared/admin';
import { api, readableError, writeApi } from './api';
import { currentAuth } from './firebase';
import { Empty, Modal, PageHeader } from './components';
import { adminTexts } from './admin/texts';
import './admin/admin.css';

export function SupportScreen({ locale, onBack }: { locale: Locale; onBack: () => void }) {
  const t = adminTexts(locale);
  const [uid] = useState(() => currentAuth()?.currentUser?.uid ?? '');
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selected, setSelected] = useState<SupportTicket | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const current = useCallback(
    () => active.current && !!uid && currentAuth()?.currentUser?.uid === uid,
    [uid],
  );
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ tickets: SupportTicket[] }>('/support', { expectedUid: uid });
      if (current()) setTickets(result.tickets);
    } catch (value) {
      if (current()) setError(readableError(value, locale));
    } finally {
      if (current()) setLoading(false);
    }
  }, [uid, current, locale]);
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
    };
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !current()) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await writeApi<{ ticket: SupportTicket }>(
        '/support',
        'POST',
        {
          category: String(data.get('category')),
          subject: String(data.get('subject') ?? '').trim(),
          message: String(data.get('message') ?? '').trim(),
        },
        uid,
      );
      if (!current()) return;
      setTickets((items) => [result.ticket, ...items].slice(0, 50));
      form.reset();
      setNotice(t.ticketSent);
    } catch (value) {
      if (current()) setError(readableError(value, locale));
    } finally {
      if (current()) setBusy(false);
    }
  }
  const dateLabel = (value: string) =>
    Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat(locale === 'kk' ? 'kk-KZ' : 'ru-RU', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(value))
      : '—';
  return (
    <section className="support-page">
      <PageHeader title={t.supportTitle} onBack={onBack} backLabel={t.back} />
      {error && (
        <p className="admin-message error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="admin-message" role="status">
          {notice}
        </p>
      )}
      <div className="support-compose">
        <p className="form-note">{t.supportIntro}</p>
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <label>
            {t.category}
            <select name="category" disabled={busy}>
              <option value="help">{t.help}</option>
              <option value="report">{t.report}</option>
            </select>
          </label>
          <label>
            {t.subject}
            <input name="subject" required minLength={3} maxLength={120} disabled={busy} />
          </label>
          <label>
            {t.message}
            <textarea
              name="message"
              required
              minLength={10}
              maxLength={2000}
              rows={5}
              disabled={busy}
            />
          </label>
          <button className="primary full" disabled={busy}>
            {busy ? <LoaderCircle size={18} className="spin" /> : <Send size={18} />}
            {t.send}
          </button>
        </form>
      </div>
      <div className="admin-section-heading">
        <h2>{t.yourTickets}</h2>
        <button className="text-button" disabled={busy || loading} onClick={() => void load()}>
          {t.refresh}
        </button>
      </div>
      {loading && (
        <div className="admin-loading" role="status">
          <LoaderCircle size={20} className="spin" />
          {t.loading}
        </div>
      )}
      {tickets.map((item) => (
        <button className="admin-ticket-card" key={item.id} onClick={() => setSelected(item)}>
          <div className="admin-ticket-top">
            <span className={`admin-status ${item.status === 'open' ? 'warning' : ''}`}>
              {t[item.status]}
            </span>
            <small>{dateLabel(item.createdAt)}</small>
          </div>
          <h3>{item.subject}</h3>
          <div className="admin-ticket-category">
            <span>{item.reply ? t.reply : t.awaitingReply}</span>
            <ChevronRight size={18} />
          </div>
        </button>
      ))}
      {!loading && !tickets.length && <Empty icon={MessageSquare} title={t.noOwnTickets} />}
      {selected && (
        <Modal title={selected.subject} closeLabel={t.close} onClose={() => setSelected(null)}>
          <div className="admin-ticket-detail">
            <p className="muted">
              {dateLabel(selected.createdAt)} · {t[selected.category]}
            </p>
            <p>{selected.message}</p>
          </div>
          {selected.reply ? (
            <div className="support-reply">
              <strong>{t.reply}</strong>
              <p>{selected.reply}</p>
            </div>
          ) : (
            <p className="form-note">{t.awaitingReply}</p>
          )}
        </Modal>
      )}
    </section>
  );
}
