import { useState, type FormEvent } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  updateProfile,
  signOut,
  reload,
  validatePassword,
  type Auth,
  type User,
} from 'firebase/auth';
import { ArrowLeft, ArrowRight, Check, Mail, Settings, ShieldCheck } from 'lucide-react';
import type { Locale } from '../shared/contracts';
import { texts } from './i18n';
import { readableError } from './api';
import { Modal } from './components';

interface Props {
  auth: Auth | null;
  user: User | null;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  onVerified: () => Promise<void>;
}
export function AuthScreen({ auth, user, locale, onLocale, onVerified }: Props) {
  const t = texts(locale);
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    setError('');
    setNotice('');
    setBusy(true);
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    try {
      auth.languageCode = locale;
      if (mode === 'reset') {
        try {
          await sendPasswordResetEmail(auth, email);
        } catch (error) {
          if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
        }
        setNotice(t.resetSent);
      } else if (mode === 'signup') {
        if (password.length < 12) throw new Error('PASSWORD_TOO_SHORT');
        if (password !== data.get('repeat')) throw new Error('PASSWORDS_MISMATCH');
        const policy = await validatePassword(auth, password);
        if (!policy.isValid) throw new Error('PASSWORD_POLICY');
        const result = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(result.user, {
          displayName: String(data.get('name') ?? '')
            .trim()
            .slice(0, 70),
        });
        await sendEmailVerification(result.user);
        setCooldown(Date.now() + 60000);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      setError(readableError(err, locale));
    } finally {
      setBusy(false);
    }
  }
  async function verification(resend = false) {
    if (!user || !auth) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (resend) {
        if (Date.now() < cooldown) {
          setNotice(t.rateLimit);
          return;
        }
        auth.languageCode = locale;
        await sendEmailVerification(user);
        setCooldown(Date.now() + 60000);
        setNotice(t.verifySent);
      } else {
        await reload(user);
        if (!user.emailVerified) {
          setError(t.emailUnverified);
          return;
        }
        await user.getIdToken(true);
        await onVerified();
      }
    } catch (err) {
      setError(readableError(err, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <header className="auth-header">
        <span className="brand">DayPact</span>
        <button
          className="icon-button"
          aria-label={t.settings}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={22} />
        </button>
      </header>
      <section className="auth-card">
        <img
          className="auth-logo"
          src="/brand/logo.webp"
          alt="DayPact"
          onError={(e) => {
            e.currentTarget.hidden = true;
          }}
        />
        {!auth ? (
          <>
            <h1>{t.setupTitle}</h1>
            <p className="muted auth-copy">{t.setupNote}</p>
            <ShieldCheck className="setup-icon" size={34} />
          </>
        ) : user && !user.emailVerified ? (
          <>
            <div className="auth-symbol">
              <Mail size={30} />
            </div>
            <h1>{t.verifyEmail}</h1>
            <p className="muted auth-copy">{t.verifyNote}</p>
            <p className="email-label">{user.email}</p>
            <button className="primary full" disabled={busy} onClick={() => void verification()}>
              {busy ? t.loading : t.verified}
              <ArrowRight size={19} />
            </button>
            <button
              className="text-button full"
              disabled={busy}
              onClick={() => void verification(true)}
            >
              {t.resend}
            </button>
            <button
              className="text-button full muted"
              disabled={busy}
              onClick={() => void signOut(auth)}
            >
              {t.logout}
            </button>
          </>
        ) : (
          <>
            <h1>{mode === 'login' ? t.signIn : mode === 'signup' ? t.signUp : t.resetPassword}</h1>
            <p className="muted auth-copy">{mode === 'signup' ? t.signupIntro : t.authIntro}</p>
            <form onSubmit={(e) => void submit(e)} className="form-stack">
              {mode === 'signup' && (
                <label>
                  {t.name}
                  <input
                    name="name"
                    autoComplete="given-name"
                    required
                    minLength={2}
                    maxLength={70}
                  />
                </label>
              )}
              <label>
                {t.email}
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  autoCapitalize="none"
                  required
                  maxLength={254}
                />
              </label>
              {mode !== 'reset' && (
                <label>
                  {t.password}
                  <input
                    name="password"
                    type="password"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    required
                    minLength={mode === 'signup' ? 12 : 1}
                    maxLength={128}
                  />
                  {mode === 'signup' && <small>{t.passwordHint}</small>}
                </label>
              )}
              {mode === 'signup' && (
                <label>
                  {t.passwordAgain}
                  <input
                    name="repeat"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                  />
                </label>
              )}
              <button className="primary full" disabled={busy}>
                {busy
                  ? t.loading
                  : mode === 'login'
                    ? t.signIn
                    : mode === 'signup'
                      ? t.signUp
                      : t.resetPassword}
                <ArrowRight size={19} />
              </button>
              {mode === 'signup' && <p className="form-note">{t.consent}</p>}
            </form>
            {mode === 'login' && (
              <button
                className="text-button full"
                onClick={() => {
                  setMode('reset');
                  setError('');
                  setNotice('');
                }}
              >
                {t.forgotPassword}
              </button>
            )}
            <div className="auth-switch">
              {mode === 'reset' ? (
                <button
                  className="text-button"
                  onClick={() => {
                    setMode('login');
                    setNotice('');
                    setError('');
                  }}
                >
                  <ArrowLeft size={17} />
                  {t.signIn}
                </button>
              ) : (
                <>
                  <span className="muted">{mode === 'login' ? t.noAccount : t.hasAccount}</span>
                  <button
                    className="text-button"
                    onClick={() => {
                      setMode(mode === 'login' ? 'signup' : 'login');
                      setError('');
                      setNotice('');
                    }}
                  >
                    {mode === 'login' ? t.signUp : t.signIn}
                  </button>
                </>
              )}
            </div>
          </>
        )}
        {error && (
          <p className="inline-message error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="inline-message" role="status">
            {notice}
          </p>
        )}
      </section>
      <footer className="auth-footer">
        <ShieldCheck size={15} />
        <span>{t.dataNote}</span>
      </footer>
      {settingsOpen && (
        <Modal title={t.settings} closeLabel={t.close} onClose={() => setSettingsOpen(false)}>
          <p className="group-caption">{t.appLanguage}</p>
          {(['kk', 'ru'] as const).map((language) => (
            <button
              key={language}
              className={`choice-row ${language === locale ? 'selected' : ''}`}
              onClick={() => {
                onLocale(language);
                setSettingsOpen(false);
              }}
            >
              <span>{language === 'kk' ? 'Қазақша' : 'Русский'}</span>
              {language === locale && <Check size={22} />}
            </button>
          ))}
        </Modal>
      )}
    </main>
  );
}
