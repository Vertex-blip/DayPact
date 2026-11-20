import { useState, type FormEvent } from 'react';
import { Bell, Check, Download, LogOut, RefreshCw, Send, Shield, Trash2 } from 'lucide-react';
import type { Locale, Profile, Settings as SettingsData } from '../shared/contracts';
import { texts } from './i18n';
import { Modal, PageHeader, Row, Toggle } from './components';
import { PasswordInput } from './PasswordInput';
import { pushAvailability } from './firebase';

interface Props {
  profile: Profile;
  locale: Locale;
  busy: boolean;
  pushReady: boolean;
  pushChecking: boolean;
  onBack: () => void;
  onSettings: (settings: Partial<SettingsData>) => Promise<void>;
  onEditProfile: () => void;
  onOfflineMaps: () => void;
  onPush: () => Promise<void>;
  onTestPush: () => Promise<void>;
  onExport: () => Promise<void>;
  onDelete: (password: string) => Promise<void>;
  onLogout: () => void;
  onInfo: (kind: 'privacy' | 'help' | 'about') => void;
  adminEligible: boolean;
  onAdmin: () => void;
}
export function SettingsScreen({
  profile,
  locale,
  busy,
  pushReady,
  pushChecking,
  onBack,
  onSettings,
  onEditProfile,
  onOfflineMaps,
  onPush,
  onTestPush,
  onExport,
  onDelete,
  onLogout,
  onInfo,
  adminEligible,
  onAdmin,
}: Props) {
  const t = texts(locale);
  const [sheet, setSheet] = useState<'language' | 'theme' | 'quiet' | 'delete' | 'push' | null>(
    null,
  );
  const s = profile.settings;
  const availability = pushAvailability();
  const pushBusy = busy || pushChecking;
  async function quiet(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    await onSettings({ quietStart: String(data.get('start')), quietEnd: String(data.get('end')) });
    setSheet(null);
  }
  async function remove(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    await onDelete(String(data.get('password')));
  }
  return (
    <section className="settings-page">
      <PageHeader title={t.settings} onBack={onBack} backLabel={t.back} />
      <div className="group-caption">{t.account}</div>
      <div className="settings-group">
        <Row label={t.editProfile} onClick={onEditProfile} />
        <Row label={t.privacy} onClick={() => onInfo('privacy')} />
      </div>
      <div className="group-caption">{t.application}</div>
      <div className="settings-group">
        <Row
          label={t.language}
          value={locale === 'kk' ? 'Қазақша' : 'Русский'}
          onClick={() => setSheet('language')}
        />
        <Row
          label={t.notifications}
          value={
            pushChecking
              ? t.pushChecking
              : s.notificationsEnabled && pushReady
                ? t.notificationsOn
                : t.notificationsOff
          }
          onClick={() => setSheet('push')}
        />
        <Row
          label={t.offlineMaps}
          value={locale === 'kk' ? 'Астана' : 'Астана'}
          onClick={onOfflineMaps}
        />
        <Row label={t.theme} value={t[s.theme]} onClick={() => setSheet('theme')} />
      </div>
      {!pushReady && (
        <button className="text-button full" onClick={() => setSheet('push')}>
          <Bell size={17} />
          {t.enableNotifications}
        </button>
      )}
      <div className="group-caption">{t.reminders}</div>
      <div className="settings-group">
        <Row label={t.plansReminders}>
          <Toggle
            label={t.plansReminders}
            checked={s.notificationsEnabled && pushReady}
            disabled={pushBusy}
            onChange={(v) => {
              if (v && !pushReady) void onPush();
              else void onSettings({ notificationsEnabled: v });
            }}
          />
        </Row>
        <Row label={t.friendReminders}>
          <Toggle
            label={t.friendReminders}
            checked={s.friendNudges}
            disabled={busy}
            onChange={(v) => void onSettings({ friendNudges: v })}
          />
        </Row>
        <Row
          label={t.quietHours}
          value={`${s.quietStart}–${s.quietEnd}`}
          onClick={() => setSheet('quiet')}
        />
      </div>
      <p className="group-note">{t.quietNote}</p>
      <div className="group-caption">{t.other}</div>
      <div className="settings-group">
        <Row label={t.about} onClick={() => onInfo('about')} />
        <Row label={t.help} onClick={() => onInfo('help')} />
        {adminEligible && <Row label={t.adminPanel} icon={Shield} onClick={onAdmin} />}
        <Row label={t.exportData} icon={Download} onClick={() => void onExport()} />
        <Row label={t.logout} icon={LogOut} onClick={onLogout} />
        {!adminEligible && (
          <Row label={t.deleteAccount} icon={Trash2} danger onClick={() => setSheet('delete')} />
        )}
      </div>
      <p className="version">DayPact · 1.0</p>
      {sheet === 'push' && (
        <Modal title={t.notifications} closeLabel={t.close} onClose={() => setSheet(null)}>
          <div className="form-stack push-settings">
            <div className="push-device-status" role="status">
              {pushChecking ? <RefreshCw size={22} className="spin" /> : <Bell size={22} />}
              <div>
                <strong>{t.pushThisDevice}</strong>
                <p>
                  {pushChecking
                    ? t.pushChecking
                    : availability === 'blocked'
                      ? t.pushBlocked
                      : pushReady
                        ? t.pushDeviceReady
                        : t.pushDeviceDisconnected}
                </p>
              </div>
            </div>
            {availability === 'install' && <p className="form-note">{t.pushInstallHelp}</p>}
            {availability === 'unsupported' && (
              <p className="form-note">{t.unsupportedNotifications}</p>
            )}
            {availability === 'blocked' && <p className="form-note">{t.pushDeniedHelp}</p>}
            <button
              className="primary full"
              disabled={pushBusy || availability !== 'available'}
              onClick={() => void onPush()}
            >
              <RefreshCw size={18} />
              {pushChecking ? t.pushChecking : pushReady ? t.pushReconnect : t.enableNotifications}
            </button>
            <button
              className="secondary full"
              disabled={pushBusy || !pushReady || availability !== 'available'}
              onClick={() => void onTestPush()}
            >
              <Send size={18} />
              {t.pushSendTest}
            </button>
            <p className="form-note">{t.pushTestNote}</p>
            <p className="form-note">{t.pushSystemHelp}</p>
            <p className="form-note">{t.pushTimingNote}</p>
          </div>
        </Modal>
      )}
      {sheet === 'language' && (
        <Modal title={t.appLanguage} closeLabel={t.close} onClose={() => setSheet(null)}>
          {(['kk', 'ru'] as const).map((lang) => (
            <button
              className={`choice-row ${lang === locale ? 'selected' : ''}`}
              key={lang}
              onClick={() => {
                void onSettings({ locale: lang });
                setSheet(null);
              }}
            >
              <span>{lang === 'kk' ? 'Қазақша' : 'Русский'}</span>
              {lang === locale && <Check size={22} />}
            </button>
          ))}
          <p className="form-note">{t.languageNote}</p>
        </Modal>
      )}
      {sheet === 'theme' && (
        <Modal title={t.theme} closeLabel={t.close} onClose={() => setSheet(null)}>
          {(['system', 'dark', 'light'] as const).map((theme) => (
            <button
              className={`choice-row ${theme === s.theme ? 'selected' : ''}`}
              key={theme}
              onClick={() => {
                void onSettings({ theme });
                setSheet(null);
              }}
            >
              <span>{t[theme]}</span>
              {theme === s.theme && <Check size={22} />}
            </button>
          ))}
        </Modal>
      )}
      {sheet === 'quiet' && (
        <Modal title={t.quietHours} closeLabel={t.close} onClose={() => setSheet(null)}>
          <form className="form-stack" onSubmit={(e) => void quiet(e)}>
            <div className="form-columns">
              <label>
                {t.from}
                <input name="start" type="time" required defaultValue={s.quietStart} />
              </label>
              <label>
                {t.to}
                <input name="end" type="time" required defaultValue={s.quietEnd} />
              </label>
            </div>
            <p className="form-note">{t.quietNote}</p>
            <button className="primary full" disabled={busy}>
              {t.save}
            </button>
          </form>
        </Modal>
      )}
      {sheet === 'delete' && (
        <Modal title={t.deleteAccount} closeLabel={t.close} onClose={() => setSheet(null)}>
          <form className="form-stack" onSubmit={(e) => void remove(e)}>
            <p className="form-note">{t.deleteAccountNote}</p>
            <PasswordInput
              label={t.currentPassword}
              locale={locale}
              name="password"
              autoComplete="current-password"
              required
            />
            <button className="danger-button full" disabled={busy}>
              {busy ? t.deleting : t.deleteAccount}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
