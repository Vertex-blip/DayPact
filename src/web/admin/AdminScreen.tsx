import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { EmailAuthProvider, reauthenticateWithCredential, type User } from 'firebase/auth';
import {
  Bell,
  Check,
  ChevronRight,
  Copy,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  History,
} from 'lucide-react';
import type { Locale } from '../../shared/contracts';
import type {
  AdminAccess,
  AdminAction,
  AdminAudit,
  AdminOverview,
  AdminPendingAction,
  AdminSetup,
  AdminSupportTicket,
  AdminUser,
  AdminUsers,
} from '../../shared/admin';
import { ApiError } from '../api';
import { currentAuth } from '../firebase';
import { Avatar, Empty, Modal, PageHeader } from '../components';
import { PasswordInput } from '../PasswordInput';
import { adminApi, adminError } from './client';
import { adminTexts } from './texts';
import './admin.css';

type Tab = 'overview' | 'users' | 'support' | 'push' | 'audit';
type Target = Pick<
  AdminUser,
  'uid' | 'email' | 'displayName' | 'disabled' | 'moderation' | 'protected'
>;
interface Props {
  locale: Locale;
  user: User;
  onBack: () => void;
}

export function AdminScreen({ locale, user, onBack }: Props) {
  const t = adminTexts(locale);
  const [access, setAccess] = useState<AdminAccess | null>(null);
  const [setup, setSetup] = useState<AdminSetup | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUsers | null>(null);
  const [tickets, setTickets] = useState<AdminSupportTicket[]>([]);
  const [audit, setAudit] = useState<AdminAudit[]>([]);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [pageTokens, setPageTokens] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [target, setTarget] = useState<Target | null>(null);
  const [chosenAction, setChosenAction] = useState<AdminAction | null>(null);
  const [ticket, setTicket] = useState<AdminSupportTicket | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const requestSequence = useRef(0);
  const securityEpoch = useRef(0);
  const current = useCallback(
    () => mounted.current && currentAuth()?.currentUser?.uid === user.uid,
    [user.uid],
  );
  const isUnlocked = !!access?.eligible && access.unlocked;

  const clearPrivateView = useCallback(() => {
    requestSequence.current++;
    securityEpoch.current++;
    setOverview(null);
    setUsers(null);
    setTickets([]);
    setAudit([]);
    setQuery('');
    setActiveQuery('');
    setPageTokens([null]);
    setPageIndex(0);
    setTarget(null);
    setChosenAction(null);
    setTicket(null);
    setSetup(null);
    setDeadline(null);
    setNotice('');
    setBusy(false);
  }, []);
  const reportError = useCallback(
    (value: unknown) => {
      if (!current()) return;
      if (
        value instanceof ApiError &&
        [
          'ADMIN_UNLOCK_REQUIRED',
          'ADMIN_SETUP_REQUIRED',
          'ADMIN_FORBIDDEN',
          'RECENT_LOGIN_REQUIRED',
          'AUTH_REVOKED',
          'AUTH_INVALID',
          'UNAUTHENTICATED',
        ].includes(value.code)
      ) {
        clearPrivateView();
        setAccess((previous) =>
          value.code === 'ADMIN_FORBIDDEN'
            ? { eligible: false }
            : previous?.eligible
              ? { ...previous, unlocked: false }
              : previous,
        );
      }
      setError(adminError(value, locale));
    },
    [current, clearPrivateView, locale],
  );

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    setLoading(true);
    void adminApi<AdminAccess>(user, '/access')
      .then((result) => {
        if (stopped || !current()) return;
        setAccess(result);
        if (result.eligible && result.unlocked) {
          const expiresAt = (result as AdminAccess & { expiresAt?: string }).expiresAt;
          setDeadline(expiresAt ? Date.parse(expiresAt) : Date.now() + 15 * 60_000);
        }
      })
      .catch((value) => {
        if (!stopped) reportError(value);
      })
      .finally(() => {
        if (!stopped && current()) setLoading(false);
      });
    return () => {
      stopped = true;
      mounted.current = false;
      requestSequence.current++;
      securityEpoch.current++;
    };
  }, [user, current]);

  useEffect(() => {
    if (!deadline || !isUnlocked) return;
    const expire = () => {
      clearPrivateView();
      setAccess((previous) => (previous?.eligible ? { ...previous, unlocked: false } : previous));
      setError(t.sessionExpired);
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  }, [deadline, isUnlocked, clearPrivateView, t.sessionExpired]);

  useEffect(() => {
    if (!setup) return;
    const expire = () => {
      clearPrivateView();
      setError(t.setupExpired);
    };
    const remaining = Date.parse(setup.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  }, [setup, clearPrivateView, t.setupExpired]);

  const load = useCallback(
    async (view: Tab, search = '', pageToken: string | null = null) => {
      const sequence = ++requestSequence.current;
      setLoading(true);
      try {
        if (view === 'overview' || view === 'push') {
          const result = await adminApi<AdminOverview>(user, '/overview');
          if (current() && sequence === requestSequence.current) setOverview(result);
        } else if (view === 'users') {
          const params = new URLSearchParams();
          if (search) params.set('query', search);
          if (pageToken) params.set('pageToken', pageToken);
          const result = await adminApi<AdminUsers>(
            user,
            `/users${params.size ? `?${params}` : ''}`,
          );
          if (current() && sequence === requestSequence.current) setUsers(result);
        } else if (view === 'support') {
          const result = await adminApi<{ tickets: AdminSupportTicket[] }>(user, '/support');
          if (current() && sequence === requestSequence.current) setTickets(result.tickets);
        } else {
          const result = await adminApi<{ events: AdminAudit[] }>(user, '/audit');
          if (current() && sequence === requestSequence.current) setAudit(result.events);
        }
      } catch (value) {
        if (sequence === requestSequence.current) reportError(value);
      } finally {
        if (current() && sequence === requestSequence.current) setLoading(false);
      }
    },
    [user, current, reportError],
  );

  useEffect(() => {
    if (isUnlocked) void load(tab, activeQuery, pageTokens[pageIndex]);
  }, [isUnlocked, tab, activeQuery, pageIndex, pageTokens, load]);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !user.email || !access?.eligible) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const password = String(fields.get('password') ?? '');
    const code = String(fields.get('code') ?? '');
    const epoch = securityEpoch.current;
    const stillCurrent = () => current() && epoch === securityEpoch.current;
    form.reset();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      if (!stillCurrent()) return;
      await user.getIdToken(true);
      if (!stillCurrent()) return;
      if (access.setupRequired) {
        const result = await adminApi<AdminSetup>(user, '/security/setup', 'POST', {});
        if (stillCurrent()) setSetup(result);
      } else {
        const result = await adminApi<{ unlocked: true; expiresAt?: string }>(
          user,
          '/security/unlock',
          'POST',
          { code },
        );
        if (!stillCurrent()) return;
        setDeadline(result.expiresAt ? Date.parse(result.expiresAt) : Date.now() + 15 * 60_000);
        setAccess({ eligible: true, setupRequired: false, unlocked: true });
      }
    } catch (value) {
      if (stillCurrent()) reportError(value);
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  }
  async function confirmSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !setup) return;
    const form = event.currentTarget;
    const code = String(new FormData(form).get('code') ?? '');
    const epoch = securityEpoch.current;
    const stillCurrent = () => current() && epoch === securityEpoch.current;
    form.reset();
    setBusy(true);
    setError('');
    try {
      const result = await adminApi<{ unlocked: true; expiresAt?: string }>(
        user,
        '/security/confirm',
        'POST',
        { code },
      );
      if (!stillCurrent()) return;
      setSetup(null);
      setDeadline(result.expiresAt ? Date.parse(result.expiresAt) : Date.now() + 15 * 60_000);
      setAccess({ eligible: true, setupRequired: false, unlocked: true });
    } catch (value) {
      if (stillCurrent()) reportError(value);
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  }
  async function lock(leave = false) {
    if (busy) return;
    clearPrivateView();
    setBusy(true);
    setAccess((previous) => (previous?.eligible ? { ...previous, unlocked: false } : previous));
    try {
      await adminApi(user, '/security/lock', 'POST', {});
    } catch (value) {
      if (!leave) reportError(value);
    } finally {
      if (current()) {
        setBusy(false);
        if (leave) onBack();
      }
    }
  }
  async function submitAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || !chosenAction || busy || target.protected || target.uid === user.uid) return;
    const input = {
      action: chosenAction,
      confirmEmail: String(new FormData(event.currentTarget).get('email') ?? ''),
    };
    const epoch = securityEpoch.current;
    const stillCurrent = () => current() && epoch === securityEpoch.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await adminApi(user, `/users/${encodeURIComponent(target.uid)}/action`, 'POST', input);
      if (!stillCurrent()) return;
      setTarget(null);
      setChosenAction(null);
      setNotice(t.actionDone);
      await load('users', activeQuery, pageTokens[pageIndex]);
    } catch (value) {
      if (stillCurrent()) reportError(value);
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  }
  async function saveTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ticket || busy) return;
    const fields = new FormData(event.currentTarget);
    const epoch = securityEpoch.current;
    const stillCurrent = () => current() && epoch === securityEpoch.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await adminApi(user, `/support/${encodeURIComponent(ticket.id)}`, 'PATCH', {
        status: String(fields.get('status')),
        reply: String(fields.get('reply') ?? ''),
      });
      if (!stillCurrent()) return;
      setTicket(null);
      setNotice(t.ticketSaved);
      await load('support');
    } catch (value) {
      if (stillCurrent()) reportError(value);
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  }
  function manage(account: Target, action: AdminAction | null = null) {
    setError('');
    setNotice('');
    setTarget(account);
    setChosenAction(action);
  }
  function retryAction(item: AdminPendingAction) {
    manage(
      {
        uid: item.uid,
        email: item.email,
        displayName: '',
        disabled: true,
        moderation: item.action === 'delete' ? 'delete_pending' : 'suspended',
        protected: item.uid === user.uid,
      },
      item.action,
    );
  }
  const formatDate = (value: string | null) =>
    value && Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat(locale === 'kk' ? 'kk-KZ' : 'ru-RU', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(value))
      : '—';
  const tabs = [
    { id: 'overview', label: t.overview, icon: LayoutDashboard },
    { id: 'users', label: t.users, icon: Users },
    { id: 'support', label: t.support, icon: MessageSquare },
    { id: 'push', label: t.push, icon: Bell },
    { id: 'audit', label: t.audit, icon: History },
  ] as const;

  return (
    <section className="admin-page">
      <PageHeader title={t.title} onBack={() => void lock(true)} backLabel={t.back}>
        {isUnlocked && (
          <button
            className="icon-button"
            aria-label={t.lock}
            disabled={busy}
            onClick={() => void lock()}
          >
            <LockKeyhole size={21} />
          </button>
        )}
      </PageHeader>
      {error && (
        <div className="admin-message error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="admin-message" role="status">
          {notice}
        </div>
      )}
      {!access && loading ? (
        <div className="admin-loading">
          <LoaderCircle className="spin" size={24} />
          <span>{t.loading}</span>
        </div>
      ) : !access?.eligible ? (
        <Empty icon={ShieldCheck} title={t.noAccess} />
      ) : !isUnlocked ? (
        <div className="admin-security">
          <div className="admin-security-icon">
            <ShieldCheck size={30} />
          </div>
          <p className="admin-eyebrow">{t.ownerOnly}</p>
          <h2>
            {setup ? t.addAuthenticator : access.setupRequired ? t.setupTitle : t.securityTitle}
          </h2>
          <p className="muted">
            {setup ? t.setupNote : access.setupRequired ? t.setupIntro : t.securityNote}
          </p>
          {setup ? (
            <>
              <div className="admin-setup-key">
                <span>{t.setupKey}</span>
                <code>{setup.secret}</code>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    const epoch = securityEpoch.current;
                    void navigator.clipboard
                      .writeText(setup.secret)
                      .then(() => {
                        if (current() && epoch === securityEpoch.current) setNotice(t.copied);
                      })
                      .catch(() => {
                        if (current() && epoch === securityEpoch.current) setError(t.copyFailed);
                      });
                  }}
                >
                  <Copy size={17} />
                  {t.copyKey}
                </button>
              </div>
              <p className="form-note">{t.setupExpires}</p>
              <form className="form-stack" onSubmit={(event) => void confirmSetup(event)}>
                <label>
                  {t.code}
                  <input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    minLength={6}
                    maxLength={6}
                    required
                    disabled={busy}
                  />
                </label>
                <button className="primary full" disabled={busy}>
                  {busy ? <LoaderCircle className="spin" size={19} /> : <ShieldCheck size={19} />}
                  {t.confirmSetup}
                </button>
              </form>
            </>
          ) : (
            <form className="form-stack" onSubmit={(event) => void authenticate(event)}>
              <PasswordInput
                label={t.password}
                locale={locale}
                name="password"
                autoComplete="current-password"
                required
                maxLength={128}
                disabled={busy}
              />
              {!access.setupRequired && (
                <label>
                  {t.code}
                  <input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    minLength={6}
                    maxLength={6}
                    required
                    disabled={busy}
                  />
                </label>
              )}
              <button className="primary full" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={19} /> : <LockKeyhole size={19} />}
                {access.setupRequired ? t.continue : t.unlock}
              </button>
            </form>
          )}
        </div>
      ) : (
        <>
          <nav className="admin-tabs" aria-label={t.title}>
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={tab === id ? 'selected' : ''}
                aria-current={tab === id ? 'page' : undefined}
                disabled={busy}
                onClick={() => {
                  setTab(id);
                  setError('');
                  setNotice('');
                }}
              >
                <Icon size={19} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="admin-section-heading">
            <h2>{tabs.find((item) => item.id === tab)?.label}</h2>
            <button
              className="text-button"
              disabled={busy || loading}
              onClick={() => void load(tab, activeQuery, pageTokens[pageIndex])}
            >
              <RefreshCw size={16} className={loading ? 'spin' : ''} />
              {loading ? t.refreshing : t.refresh}
            </button>
          </div>
          {loading && (
            <div className="admin-loading" role="status">
              <LoaderCircle className="spin" size={20} />
              <span>{t.loading}</span>
            </div>
          )}
          {tab === 'overview' && overview && (
            <>
              <div className="admin-metrics">
                <Metric label={t.appUsers} value={overview.appUsers} />
                <Metric label={t.openTickets} value={overview.openTickets} />
                <Metric label={t.suspended} value={overview.suspendedUsers} />
                <Metric label={t.pending} value={overview.push.pending} />
              </div>
              <div className="admin-card">
                <h3>{t.database}</h3>
                <p className="admin-storage-value">
                  {(overview.databaseBytes / 1024 / 1024).toLocaleString(locale, {
                    maximumFractionDigits: 2,
                  })}{' '}
                  /{' '}
                  {(overview.databaseLimitBytes / 1024 / 1024).toLocaleString(locale, {
                    maximumFractionDigits: 0,
                  })}{' '}
                  MB
                </p>
                <progress
                  max={overview.databaseLimitBytes}
                  value={Math.min(overview.databaseBytes, overview.databaseLimitBytes)}
                  aria-label={t.database}
                />
                <p className="form-note">{t.quotaNote}</p>
              </div>
              <div className="admin-card">
                <h3>{t.services}</h3>
                <ServiceStatus
                  label={t.authService}
                  ready={overview.accountManagementConfigured}
                  readyLabel={t.configured}
                  missingLabel={t.notConfigured}
                />
                <ServiceStatus
                  label={t.pushService}
                  ready={overview.pushConfigured}
                  readyLabel={t.configured}
                  missingLabel={t.notConfigured}
                />
              </div>
            </>
          )}
          {tab === 'users' && (
            <>
              <form
                className="admin-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  setPageTokens([null]);
                  setPageIndex(0);
                  setActiveQuery(query.trim());
                }}
              >
                <label className="sr-only" htmlFor="admin-user-query">
                  {t.searchLabel}
                </label>
                <input
                  id="admin-user-query"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t.searchPlaceholder}
                  maxLength={254}
                  autoCapitalize="none"
                  disabled={busy}
                />
                <button className="secondary" disabled={busy || loading}>
                  <Search size={18} />
                  <span>{t.search}</span>
                </button>
              </form>
              {activeQuery && (
                <button
                  className="text-button admin-clear"
                  disabled={busy}
                  onClick={() => {
                    setQuery('');
                    setActiveQuery('');
                    setPageIndex(0);
                    setPageTokens([null]);
                  }}
                >
                  {t.clear}
                </button>
              )}
              <p className="admin-section-note">{t.userListNote}</p>
              {!!users?.pendingActions.length && (
                <div className="admin-card">
                  <h3>{t.pendingActions}</h3>
                  {users.pendingActions.map((item) => (
                    <div className="admin-pending" key={item.uid}>
                      <div>
                        <strong>{item.email || item.uid}</strong>
                        <small>
                          {t[item.action]} · {formatDate(item.updatedAt)}
                        </small>
                      </div>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => retryAction(item)}
                      >
                        {t.retry}
                        <ChevronRight size={17} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {users?.users.map((account) => (
                <article className="admin-user-card" key={account.uid}>
                  <div className="admin-user-head">
                    <Avatar name={account.displayName || account.email || account.uid} />
                    <div>
                      <h3>{account.displayName || t.unnamed}</h3>
                      <p>{account.email || t.noEmail}</p>
                    </div>
                    {account.protected && (
                      <ShieldCheck className="admin-owner-icon" aria-label={t.owner} size={21} />
                    )}
                  </div>
                  <div className="admin-user-badges">
                    <span
                      className={`admin-status ${account.disabled || account.moderation !== 'active' ? 'warning' : ''}`}
                    >
                      {account.moderation === 'delete_pending' || account.moderation === 'deleted'
                        ? t.deleting
                        : account.disabled || account.moderation === 'suspended'
                          ? t.suspended
                          : t.active}
                    </span>
                    <span className="admin-status">
                      {account.emailVerified ? t.verified : t.unverified}
                    </span>
                  </div>
                  <dl className="admin-detail-list">
                    <div>
                      <dt>{t.registered}</dt>
                      <dd>{formatDate(account.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>{t.lastSignIn}</dt>
                      <dd>{formatDate(account.lastSignInAt)}</dd>
                    </div>
                    <div>
                      <dt>UID</dt>
                      <dd className="admin-uid">{account.uid}</dd>
                    </div>
                  </dl>
                  <button
                    className="secondary full"
                    disabled={busy || account.protected || account.uid === user.uid}
                    onClick={() => manage(account)}
                  >
                    {account.protected || account.uid === user.uid ? (
                      <ShieldCheck size={17} />
                    ) : (
                      <Users size={17} />
                    )}
                    {account.protected || account.uid === user.uid ? t.owner : t.manage}
                  </button>
                </article>
              ))}
              {!loading && users && !users.users.length && <Empty icon={Users} title={t.noUsers} />}
              <div className="admin-pagination">
                <button
                  className="text-button"
                  disabled={busy || loading || pageIndex === 0}
                  onClick={() => setPageIndex((value) => value - 1)}
                >
                  {t.previous}
                </button>
                <button
                  className="text-button"
                  disabled={busy || loading || !users?.nextPageToken}
                  onClick={() => {
                    const next = users?.nextPageToken;
                    if (!next) return;
                    setPageTokens((values) => [...values.slice(0, pageIndex + 1), next]);
                    setPageIndex((value) => value + 1);
                  }}
                >
                  {t.next}
                  <ChevronRight size={17} />
                </button>
              </div>
            </>
          )}
          {tab === 'support' && (
            <>
              {tickets.map((item) => (
                <button
                  className="admin-ticket-card"
                  key={item.id}
                  onClick={() => {
                    setTicket(item);
                    setError('');
                  }}
                  disabled={busy}
                >
                  <div className="admin-ticket-top">
                    <span className={`admin-status ${item.status === 'open' ? 'warning' : ''}`}>
                      {t[item.status]}
                    </span>
                    <small>{formatDate(item.createdAt)}</small>
                  </div>
                  <h3>{item.subject}</h3>
                  <p>{item.email || item.displayName || item.userId}</p>
                  <div className="admin-ticket-category">
                    <span>{t[item.category]}</span>
                    <ChevronRight size={18} />
                  </div>
                </button>
              ))}
              {!loading && !tickets.length && <Empty icon={MessageSquare} title={t.noTickets} />}
            </>
          )}
          {tab === 'push' && overview && (
            <>
              <div className="admin-metrics">
                {(['pending', 'delivered', 'failed', 'skipped'] as const).map((state) => (
                  <Metric key={state} label={t[state]} value={overview.push[state]} />
                ))}
              </div>
              <p className="admin-section-note">{t.pushNote}</p>
              <div className="admin-card">
                <h3>{t.latestPush}</h3>
                {overview.recentPushFailures.map((item) => (
                  <div className="admin-log-row" key={item.id}>
                    <div>
                      <strong>
                        {item.state === 'failed'
                          ? t.failed
                          : item.state === 'skipped'
                            ? t.skipped
                            : t.pending}
                      </strong>
                      <small>
                        {formatDate(item.createdAt)} · {t.attempts}: {item.attempts}
                      </small>
                    </div>
                    <span className="admin-uid">{item.userId}</span>
                  </div>
                ))}
                {!overview.recentPushFailures.length && <p className="form-note">{t.noPush}</p>}
              </div>
            </>
          )}
          {tab === 'audit' && (
            <>
              <p className="admin-section-note">{t.auditNote}</p>
              <div className="admin-card">
                {audit.map((item) => (
                  <div className="admin-log-row" key={item.id}>
                    <div>
                      <strong>{auditLabel(item.action, locale)}</strong>
                      <small>{formatDate(item.createdAt)}</small>
                    </div>
                    <span className={`admin-status ${item.outcome === 'failure' ? 'warning' : ''}`}>
                      {item.outcome === 'success' ? t.actionDone : t.failed}
                    </span>
                    {item.targetUid && <span className="admin-uid">{item.targetUid}</span>}
                  </div>
                ))}
                {!loading && !audit.length && <p className="form-note">{t.noRecords}</p>}
              </div>
            </>
          )}
        </>
      )}
      {target && (
        <Modal
          title={t.chooseAction}
          closeLabel={t.close}
          onClose={() => {
            if (!busy) {
              setTarget(null);
              setChosenAction(null);
            }
          }}
        >
          <div className="admin-target">
            <strong>{target.displayName || target.email}</strong>
            <span>{target.email}</span>
          </div>
          {!chosenAction ? (
            <div className="form-stack">
              <button
                className="secondary full"
                onClick={() =>
                  setChosenAction(
                    target.disabled || target.moderation === 'suspended' ? 'restore' : 'suspend',
                  )
                }
              >
                <LockKeyhole size={18} />
                {target.disabled || target.moderation === 'suspended' ? t.restore : t.suspend}
              </button>
              <button className="danger-button full" onClick={() => setChosenAction('delete')}>
                <Trash2 size={18} />
                {t.delete}
              </button>
            </div>
          ) : (
            <form className="form-stack" onSubmit={(event) => void submitAction(event)}>
              <h3>{t[chosenAction]}</h3>
              <p className="form-note">
                {chosenAction === 'delete'
                  ? t.deleteNote
                  : chosenAction === 'suspend'
                    ? t.suspendNote
                    : t.restoreNote}
              </p>
              <label>
                {t.confirmEmail}
                <input
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
              {error && (
                <p className="admin-dialog-error" role="alert">
                  {error}
                </p>
              )}
              <button
                className={`${chosenAction === 'delete' ? 'danger-button' : 'primary'} full`}
                disabled={busy}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={18} />
                ) : chosenAction === 'delete' ? (
                  <Trash2 size={18} />
                ) : (
                  <Check size={18} />
                )}
                {t[chosenAction]}
              </button>
              <button
                type="button"
                className="text-button full"
                disabled={busy}
                onClick={() => setChosenAction(null)}
              >
                {t.cancel}
              </button>
            </form>
          )}
        </Modal>
      )}
      {ticket && (
        <Modal
          title={ticket.subject}
          closeLabel={t.close}
          onClose={() => {
            if (!busy) setTicket(null);
          }}
        >
          <div className="admin-ticket-detail">
            <p className="muted">{ticket.email || ticket.userId}</p>
            <p>{ticket.message}</p>
          </div>
          <form className="form-stack" onSubmit={(event) => void saveTicket(event)}>
            <label>
              {t.reply}
              <textarea
                name="reply"
                maxLength={2000}
                defaultValue={ticket.reply}
                rows={5}
                disabled={busy}
              />
            </label>
            <p className="form-note">{t.replyHint}</p>
            <label>
              {t.status}
              <select name="status" defaultValue={ticket.status} disabled={busy}>
                <option value="open">{t.open}</option>
                <option value="closed">{t.closed}</option>
              </select>
            </label>
            {error && (
              <p className="admin-dialog-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary full" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}
              {t.save}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="admin-metric">
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}
function ServiceStatus({
  label,
  ready,
  readyLabel,
  missingLabel,
}: {
  label: string;
  ready: boolean;
  readyLabel: string;
  missingLabel: string;
}) {
  return (
    <div className="admin-service-row">
      <span>{label}</span>
      <span className={`admin-status ${ready ? '' : 'warning'}`}>
        {ready ? readyLabel : missingLabel}
      </span>
    </div>
  );
}
function auditLabel(action: string, locale: Locale) {
  const t = adminTexts(locale);
  const labels: Record<string, string> = {
    suspend: t.suspend,
    restore: t.restore,
    delete: t.delete,
    'user.suspend': t.suspend,
    'user.restore': t.restore,
    'user.delete': t.delete,
    'mfa.setup': t.setupTitle,
    'mfa.confirm': t.confirmSetup,
    'mfa.unlock': t.unlock,
    'mfa.lock': t.lock,
    'security.setup': t.setupTitle,
    'security.confirm': t.confirmSetup,
    'security.unlock': t.unlock,
    'security.lock': t.lock,
    'support.reply': t.reply,
    'support.update': t.ticketSaved,
  };
  return labels[action] ?? t.audit;
}
