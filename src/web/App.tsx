import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  onAuthStateChanged,
  signOut,
  reauthenticateWithCredential,
  EmailAuthProvider,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  Bell,
  Bookmark,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  Home,
  GraduationCap,
  Info,
  LoaderCircle,
  Map as MapIcon,
  MapPin,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  Trash2,
  UserRound,
  Users,
  Wallet,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  AppNotification,
  Friend,
  Invitation,
  Locale,
  Place,
  Plan,
  PlanInput,
  Profile,
  Settings as SettingsData,
} from '../shared/contracts';
import type { AdminAccess } from '../shared/admin';
import type { StudyResponse } from '../shared/study';
import { studyValidDate } from '../shared/studyTime';
import { AuthScreen } from './AuthScreen';
import { PasswordInput } from './PasswordInput';
import {
  api as unscopedApi,
  ApiError,
  readableError,
  writeApi as unscopedWriteApi,
  type ApiOptions,
} from './api';
import {
  initializeAuth,
  currentAuth,
  deviceId,
  registerPush,
  unregisterPush,
  setActivePushUser,
  isPushRegistered,
  hasPushRegistration,
  markPushRegistration,
} from './firebase';
import {
  activatePrivateSession,
  applyPending,
  clearPrivateData,
  enqueueCheckin,
  enqueuePlan,
  fetchSnapshot,
  forgetPending,
  forgetPendingPlan,
  loadSnapshot,
  pendingCheckins,
  pendingPlans,
  pausePrivateSession,
  isPrivateSessionPaused,
  resumePrivateSession,
  saveSnapshot,
  syncCheckins,
  type PendingCheckin,
  type PendingPlan,
} from './offline';
import { dateLabel, initialLocale, localDate, money, shiftDate, texts } from './i18n';
import { Avatar, Empty, Modal, PageHeader, Row } from './components';
import { PlanEditor, type EditorValue } from './PlanEditor';
import { SettingsScreen } from './Settings';
import { MeetingDetail } from './MeetingDetail';
import { meetingTexts } from './meetingTexts';
import { clearSavedPlaces } from './map/savedPlaces';
import './styles.css';

const MapScreen = lazy(() => import('./map/MapScreen').then((m) => ({ default: m.MapScreen })));
const AdminScreen = lazy(() =>
  import('./admin/AdminScreen').then((m) => ({ default: m.AdminScreen })),
);
const SupportScreen = lazy(() =>
  import('./SupportScreen').then((m) => ({ default: m.SupportScreen })),
);
const StudyScreen = lazy(() =>
  import('./study/StudyScreen').then((m) => ({ default: m.StudyScreen })),
);
const OfflineMapsSettings = lazy(() =>
  import('./map/OfflineMapsSettings').then((m) => ({ default: m.OfflineMapsSettings })),
);
type Tab = 'home' | 'study' | 'map' | 'friends' | 'profile';
type Sheet =
  | 'invite'
  | 'notifications'
  | 'edit-profile'
  | 'offline-maps'
  | 'privacy'
  | 'help'
  | 'about'
  | 'logout'
  | 'queue'
  | 'meetings'
  | null;
interface Toast {
  text: string;
  error?: boolean;
}
type ExportPage = Record<string, unknown> & { checkins: unknown[]; nextCursor: string | null };

export default function App() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authRevision, setAuthRevision] = useState(0);
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = texts(locale);
  const mt = meetingTexts(locale);
  const api = <T,>(path: string, options: ApiOptions = {}) =>
    unscopedApi<T>(path, { ...options, expectedUid: user?.uid ?? '' });
  const writeApi = <T,>(path: string, method: string, body?: unknown) =>
    unscopedWriteApi<T>(path, method, body, user?.uid ?? '');
  const assertCurrentUser = () => {
    if (!user || currentAuth()?.currentUser?.uid !== user.uid)
      throw new ApiError('UNAUTHENTICATED', 401);
  };
  const [profile, setProfile] = useState<Profile | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [meetings, setMeetings] = useState<Plan[]>([]);
  const [focusedPlace, setFocusedPlace] = useState<Place | null>(null);
  const [meetingProposal, setMeetingProposal] = useState<{
    plan: Plan;
    uid: string;
    operationId: string;
    place?: Place;
    picking: boolean;
  } | null>(null);
  const [date, setDate] = useState(() => localDate());
  const [tab, setTab] = useState<Tab>('home');
  const [studyDate, setStudyDate] = useState<string | undefined>(() => {
    const value = new URLSearchParams(location.search).get('study');
    return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  });
  const [studyEntry, setStudyEntry] = useState(0);
  const [settings, setSettings] = useState(false);
  const [adminEligible, setAdminEligible] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'shared'>('all');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [stale, setStale] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [deletionPending, setDeletionPending] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [editor, setEditor] = useState<EditorValue | null>(null);
  const [pickerDraft, setPickerDraft] = useState<EditorValue | null>(null);
  const [selected, setSelected] = useState<Plan | null>(null);
  const [contribution, setContribution] = useState<Plan | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Plan | null>(null);
  const [friendRemove, setFriendRemove] = useState<Friend | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [inviteLink, setInviteLink] = useState('');
  const [inviteToken, setInviteToken] = useState(() =>
    new URLSearchParams(location.search).get('invite'),
  );
  const [deepLinkPlan, setDeepLinkPlan] = useState(() =>
    new URLSearchParams(location.search).get('plan'),
  );
  const [pending, setPending] = useState<PendingCheckin[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncBlocked, setSyncBlocked] = useState(false);
  const [mapStartTab, setMapStartTab] = useState<'plans' | 'saved'>('plans');
  const [sessionPaused, setSessionPaused] = useState(false);
  const [pushReady, setPushReady] = useState(false);
  const [pushChecking, setPushChecking] = useState(false);
  const [pushRefreshEpoch, setPushRefreshEpoch] = useState(0);
  const pushOperation = useRef(false);
  const pushRevision = useRef(0);
  const pendingPushCheck = useRef<(() => void) | null>(null);
  const releasePushOperation = useCallback(() => {
    pushOperation.current = false;
    const pending = pendingPushCheck.current;
    pendingPushCheck.current = null;
    pending?.();
  }, []);
  const [pendingDrafts, setPendingDrafts] = useState<PendingPlan[]>([]);
  const requestSequence = useRef(0);
  const prevUid = useRef<string | null>(null);
  const currentDate = useRef(date);
  currentDate.current = date;
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const chooseLocale = useCallback((next: Locale) => {
    setLocale(next);
    try {
      localStorage.setItem('daypact.locale', next);
    } catch {
      /* storage disabled */
    }
  }, []);
  const syncPushDevice = useCallback(
    async (interactive: boolean, stillCurrent: () => boolean) => {
      const uid = user?.uid;
      const check = () => {
        if (!uid || !stillCurrent() || currentAuth()?.currentUser?.uid !== uid)
          throw new ApiError('UNAUTHENTICATED', 401);
      };
      check();
      let token = await registerPush({ requestPermission: interactive });
      check();
      await setActivePushUser(uid!, true);
      check();
      try {
        await unscopedWriteApi('/push/tokens', 'POST', { token, deviceId: deviceId() }, uid!);
      } catch (error) {
        // Only an explicit reconnect may replace a token associated with a previous account.
        if (!interactive || !(error instanceof ApiError) || error.code !== 'TOKEN_CONFLICT')
          throw error;
        check();
        await unregisterPush();
        check();
        token = await registerPush({ requestPermission: false });
        check();
        await unscopedWriteApi('/push/tokens', 'POST', { token, deviceId: deviceId() }, uid!);
      }
      check();
      markPushRegistration(uid!);
    },
    [user],
  );
  useEffect(() => {
    const uid = user?.uid;
    if (!uid || !user.emailVerified || profile?.uid !== uid || sessionPaused || deletionPending) {
      setPushReady(false);
      return;
    }
    let disposed = false;
    let lastRefresh = 0;
    const revision = pushRevision.current;
    const current = () =>
      !disposed && revision === pushRevision.current && currentAuth()?.currentUser?.uid === uid;
    const check = async () => {
      if (!current() || document.hidden) return;
      if (pushOperation.current) {
        pendingPushCheck.current = resume;
        return;
      }
      pushOperation.current = true;
      setPushChecking(true);
      try {
        const registered = await isPushRegistered(uid);
        if (!current()) return;
        setPushReady(registered);
        if (
          !navigator.onLine ||
          !profile.settings.notificationsEnabled ||
          !hasPushRegistration(uid)
        )
          return;
        if (Date.now() - lastRefresh < 15 * 60_000) return;
        await syncPushDevice(false, current);
        if (current()) {
          lastRefresh = Date.now();
          setPushReady(true);
        }
      } catch {
        if (current()) setPushReady(false);
      } finally {
        setPushChecking(false);
        releasePushOperation();
      }
    };
    const resume = () => {
      void check();
    };
    void check();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      disposed = true;
      if (pendingPushCheck.current === resume) pendingPushCheck.current = null;
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [
    user,
    profile?.uid,
    profile?.settings.notificationsEnabled,
    sessionPaused,
    deletionPending,
    syncPushDevice,
    releasePushOperation,
    pushRefreshEpoch,
  ]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const uid = user?.uid;
    let disposed = false;
    if (
      !uid ||
      !user.emailVerified ||
      profile?.uid !== uid ||
      !online ||
      sessionPaused ||
      deletionPending
    ) {
      setAdminEligible(false);
      setAdminOpen(false);
      return;
    }
    void unscopedApi<AdminAccess>('/admin/access', { expectedUid: uid })
      .then((access) => {
        if (!disposed && currentAuth()?.currentUser?.uid === uid)
          setAdminEligible(access.eligible === true);
      })
      .catch(() => {
        if (!disposed) {
          setAdminEligible(false);
          setAdminOpen(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [user, profile?.uid, online, sessionPaused, deletionPending]);
  useEffect(() => {
    const theme = profile?.settings.theme ?? 'dark';
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'light' ? '#f3f5f8' : '#16191f');
  }, [profile?.settings.theme]);
  useEffect(() => {
    let disposed = false;
    let unsubscribe: undefined | (() => void);
    void initializeAuth()
      .then((instance) => {
        if (disposed) return;
        setAuth(instance);
        if (!instance) {
          setAuthReady(true);
          void setActivePushUser(null);
          return;
        }
        unsubscribe = onAuthStateChanged(instance, (next) => {
          const old = prevUid.current;
          prevUid.current = next?.uid ?? null;
          if (next && old !== next.uid) activatePrivateSession(next.uid);
          void setActivePushUser(next?.emailVerified ? next.uid : null);
          if (old && old !== next?.uid) {
            setStudyDate(undefined);
            setAdminEligible(false);
            setAdminOpen(false);
            void clearPrivateData(old).catch(() => {});
            void clearSavedPlaces(old).catch(() => {});
            markPushRegistration(null);
            setProfile(null);
            setPlans([]);
            setMeetings([]);
            setMeetingProposal(null);
            setFocusedPlace(null);
            setFriends([]);
            setNotifications([]);
            setPending([]);
            setPendingDrafts([]);
            setSelected(null);
            setSheet(null);
            setEditor(null);
            setContribution(null);
            setPickerDraft(null);
            setConfirmDelete(null);
            setFriendRemove(null);
            setInviteLink('');
            setDeletionPending(false);
            setSessionPaused(false);
            setLoadError(null);
            setSyncBlocked(false);
            setSyncing(false);
            setBusy(false);
            setToast(null);
            setSettings(false);
            setTab('home');
            requestSequence.current++;
          }
          if (old !== next?.uid) {
            pushRevision.current++;
            setPushReady(false);
          }
          setUser(next);
          setAuthReady(true);
        });
      })
      .catch((err) => {
        if (!disposed) {
          setLoadError(err);
          setAuthReady(true);
        }
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    const on = () => setOnline(true),
      off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.error ? 9000 : 4500);
    return () => clearTimeout(id);
  }, [toast]);

  function hidePrivateView() {
    setAdminEligible(false);
    setAdminOpen(false);
    pushRevision.current++;
    setPushReady(false);
    void setActivePushUser(null);
    setProfile(null);
    setPlans([]);
    setMeetings([]);
    setMeetingProposal(null);
    setFocusedPlace(null);
    setFriends([]);
    setNotifications([]);
    setPending([]);
    setPendingDrafts([]);
    setSelected(null);
    setSheet(null);
    setEditor(null);
    setContribution(null);
    setPickerDraft(null);
    setConfirmDelete(null);
    setFriendRemove(null);
    setInviteLink('');
    setSessionPaused(true);
    setSyncBlocked(true);
    setLoadError(new ApiError('UNAUTHENTICATED', 401));
  }
  const refresh = useCallback(
    async (showLoading = false) => {
      if (!user?.emailVerified || currentAuth()?.currentUser?.uid !== user.uid) return;
      const uid = user.uid;
      const seq = ++requestSequence.current;
      const wantedDate = date;
      if (showLoading) setLoading(true);
      setLoadError(null);
      try {
        const paused = await isPrivateSessionPaused(uid);
        if (seq !== requestSequence.current || currentAuth()?.currentUser?.uid !== uid) return;
        if (paused) {
          hidePrivateView();
          setLoading(false);
          return;
        }
      } catch {
        /* optional private storage */
      }
      let saved;
      try {
        saved = (await loadSnapshot(uid, wantedDate)) ?? (await loadSnapshot(uid));
      } catch {
        /* optional private storage */
      }
      if (seq !== requestSequence.current || currentAuth()?.currentUser?.uid !== uid) return;
      try {
        const drafts = await pendingPlans(uid);
        if (seq !== requestSequence.current || currentAuth()?.currentUser?.uid !== uid) return;
        setPendingDrafts(drafts);
      } catch {
        /* optional private storage */
      }
      if (saved && seq === requestSequence.current && currentAuth()?.currentUser?.uid === uid) {
        setProfile((prev) => prev ?? saved.profile);
        setFriends(saved.friends);
        setMeetings(saved.meetings ?? []);
        if (saved.date === wantedDate) setPlans(saved.plans);
      }
      try {
        if (!navigator.onLine) throw new ApiError('NETWORK');
        const next = await fetchSnapshot(wantedDate, uid);
        if (seq !== requestSequence.current || currentAuth()?.currentUser?.uid !== uid) return;
        let queued: PendingCheckin[] = [];
        try {
          queued = await pendingCheckins(uid);
          if (seq !== requestSequence.current || currentAuth()?.currentUser?.uid !== uid) return;
          await saveSnapshot(uid, { ...next, savedAt: Date.now() });
        } catch {
          /* online remains usable */
        }
        if (seq !== requestSequence.current || currentAuth()?.currentUser?.uid !== uid) return;
        setPending(queued);
        setProfile(next.profile);
        setFriends(next.friends);
        setPlans(applyPending(next.plans, uid, queued));
        setMeetings(applyPending(next.meetings ?? [], uid, queued));
        setSelected((prev) => {
          if (!prev) return null;
          const current = [...next.plans, ...(next.meetings ?? [])].find(
            (p) => p.id === prev.id && p.date === prev.date,
          );
          if (current) return applyPending([current], uid, queued)[0];
          if (prev.kind === 'event') return null;
          return prev.date === wantedDate ? null : prev;
        });
        setStale(false);
        chooseLocale(next.profile.settings.locale);
        void api<{ notifications: AppNotification[] }>('/notifications')
          .then((result) => {
            if (currentAuth()?.currentUser?.uid === uid) setNotifications(result.notifications);
          })
          .catch(() => {});
      } catch (err) {
        if (seq !== requestSequence.current || currentAuth()?.currentUser?.uid !== uid) return;
        if (
          err instanceof ApiError &&
          ([401, 403, 410].includes(err.status) ||
            ['ACCOUNT_DELETED', 'AUTH_DELETE_PENDING'].includes(err.code))
        ) {
          pushRevision.current++;
          setPushReady(false);
          await setActivePushUser(null);
          const deleted =
            err.status === 410 || ['ACCOUNT_DELETED', 'AUTH_DELETE_PENDING'].includes(err.code);
          try {
            if (deleted) await Promise.all([clearPrivateData(uid), clearSavedPlaces(uid)]);
            else await pausePrivateSession(uid);
          } catch {}
          if (seq !== requestSequence.current || currentAuth()?.currentUser?.uid !== uid) return;
          if (!deleted) hidePrivateView();
          setDeletionPending(['ACCOUNT_DELETED', 'AUTH_DELETE_PENDING'].includes(err.code));
          setProfile(null);
          setPlans([]);
          setMeetings([]);
          setMeetingProposal(null);
          setFocusedPlace(null);
          setFriends([]);
          setLoadError(err);
          return;
        }
        if (saved) {
          let queued: PendingCheckin[] = [];
          try {
            queued = await pendingCheckins(uid);
          } catch {
            /* storage disabled */
          }
          if (seq !== requestSequence.current || currentAuth()?.currentUser?.uid !== uid) return;
          setProfile(saved.profile);
          setFriends(saved.friends);
          setPlans(applyPending(saved.date === wantedDate ? saved.plans : [], uid, queued));
          setMeetings(applyPending(saved.meetings ?? [], uid, queued));
          setPending(queued);
          setStale(true);
          if (navigator.onLine) setLoadError(err);
        } else {
          setLoadError(err);
          setPlans([]);
          setMeetings([]);
        }
      } finally {
        if (seq === requestSequence.current) setLoading(false);
      }
    },
    [user, date, authRevision, chooseLocale],
  );

  const synchronize = useCallback(
    async (afterEnqueue = false) => {
      if (!user?.emailVerified || !navigator.onLine) return;
      setSyncing(true);
      try {
        const result = await syncCheckins(user.uid, afterEnqueue);
        const [queue, drafts] = await Promise.all([
          pendingCheckins(user.uid),
          pendingPlans(user.uid),
        ]);
        if (currentAuth()?.currentUser?.uid !== user.uid) return;
        setSyncBlocked(result.blocked);
        if (result.blocked) {
          hidePrivateView();
          return;
        }
        setPending(queue);
        setPendingDrafts(drafts);
        if (result.sent || result.failed) await refresh();
      } catch {
        /* keep local queue */
      } finally {
        if (currentAuth()?.currentUser?.uid === user.uid) setSyncing(false);
      }
    },
    [user, refresh],
  );
  useEffect(() => {
    if (!user?.emailVerified) return;
    void refresh(true);
  }, [refresh]);
  useEffect(() => {
    if (!user?.emailVerified) return;
    if (online) void synchronize();
    const focus = () => {
      if (!document.hidden && navigator.onLine) {
        void synchronize();
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', focus);
    const timer = setInterval(() => {
      if (!document.hidden && navigator.onLine) {
        void synchronize();
        void refresh();
      }
    }, 60000);
    return () => {
      document.removeEventListener('visibilitychange', focus);
      clearInterval(timer);
    };
  }, [user, online, synchronize, refresh]);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const listener = (event: MessageEvent) => {
      if (event.data?.type === 'DAYPACT_PUSH') {
        if (event.data.recipientUid === user?.uid) void refresh();
      } else if (
        event.data?.type === 'DAYPACT_OPEN_PLAN' &&
        event.data.recipientUid === user?.uid &&
        typeof event.data.planId === 'string'
      ) {
        setDeepLinkPlan(event.data.planId);
        setDate(localDate(profile?.settings.timeZone));
        setTab('home');
        void refresh();
      } else if (
        event.data?.type === 'DAYPACT_OPEN_STUDY' &&
        event.data.recipientUid === user?.uid &&
        typeof event.data.studyDate === 'string' &&
        studyValidDate(event.data.studyDate)
      ) {
        setStudyDate(event.data.studyDate);
        setStudyEntry((entry) => entry + 1);
        setTab('study');
        setSettings(false);
        setSheet(null);
      }
    };
    navigator.serviceWorker.addEventListener('message', listener);
    return () => navigator.serviceWorker.removeEventListener('message', listener);
  }, [user, profile?.settings.timeZone, refresh]);
  useEffect(() => {
    if (!profile || !user?.emailVerified) return;
    const url = new URL(location.href);
    const wanted = url.searchParams.get('study');
    if (!wanted || !studyValidDate(wanted)) return;
    setStudyDate(wanted);
    setTab('study');
    setSettings(false);
    url.searchParams.delete('study');
    history.replaceState(null, '', url);
  }, [profile, user?.emailVerified]);
  useEffect(() => {
    if (!deepLinkPlan || !profile || loading) return;
    const plan = plans.find((p) => p.id === deepLinkPlan);
    if (plan) {
      setSelected(plan);
      setDeepLinkPlan(null);
      const url = new URL(location.href);
      url.searchParams.delete('plan');
      history.replaceState(null, '', url);
    }
  }, [deepLinkPlan, profile, plans, loading]);

  async function action<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (busy) return;
    const uid = user?.uid;
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      if (currentAuth()?.currentUser?.uid === uid) notify(readableError(err, locale), true);
      return undefined;
    } finally {
      if (currentAuth()?.currentUser?.uid === uid) setBusy(false);
    }
  }
  function requireOnline(): boolean {
    if (!online) {
      notify(t.onlineRequired, true);
      return false;
    }
    return true;
  }
  async function updateSettings(patch: Partial<SettingsData>) {
    await action(async () => {
      if (!profile) return;
      const result = await writeApi<{ settings: SettingsData }>('/settings', 'PATCH', patch);
      setProfile({ ...profile, settings: result.settings });
      if (patch.locale) chooseLocale(patch.locale);
      notify(texts(patch.locale ?? locale).saved);
    });
  }
  async function savePlan(input: PlanInput, plan?: Plan) {
    await action(async () => {
      if (!user) return;
      if (plan) {
        if (!requireOnline()) return;
        await writeApi(`/plans/${encodeURIComponent(plan.id)}`, 'PATCH', {
          ...input,
          version: plan.version,
        });
        setEditor(null);
        setPickerDraft(null);
        await refresh();
        assertCurrentUser();
        notify(t.planSaved);
        return;
      }
      const operationId = crypto.randomUUID();
      try {
        await enqueuePlan(user.uid, input, operationId);
      } catch (error) {
        assertCurrentUser();
        if (!navigator.onLine) {
          notify(t.storageUnavailable, true);
          return;
        }
        await api('/plans', {
          method: 'POST',
          body: JSON.stringify(input),
          headers: { 'Idempotency-Key': operationId },
        });
        setEditor(null);
        setPickerDraft(null);
        await refresh();
        assertCurrentUser();
        notify(t.planSaved);
        return;
      }
      const drafts = await pendingPlans(user.uid);
      assertCurrentUser();
      setPendingDrafts(drafts);
      setEditor(null);
      setPickerDraft(null);
      if (navigator.onLine) await synchronize(true);
      else notify(t.waitingSync);
    });
  }
  async function checkin(plan: Plan, completed: boolean, amount?: number) {
    if (!user || busy) return;
    if (plan.date > localDate(plan.timeZone ?? profile?.settings.timeZone)) {
      notify(
        locale === 'kk'
          ? 'Болашақ күнді алдын ала белгілеуге болмайды.'
          : 'Нельзя отмечать будущую дату.',
        true,
      );
      return;
    }
    const input = {
      date: plan.date,
      completed,
      contribution: amount,
      operationId: crypto.randomUUID(),
    };
    const uid = user.uid;
    setBusy(true);
    try {
      await enqueueCheckin(uid, plan.id, input);
      const queue = await pendingCheckins(uid);
      if (currentAuth()?.currentUser?.uid !== uid) {
        await clearPrivateData(uid).catch(() => {});
        return;
      }
      setPending(queue);
      setPlans((prev) => applyPending(prev, uid, queue));
      setMeetings((prev) => applyPending(prev, uid, queue));
      setSelected((prev) => (prev?.id === plan.id ? applyPending([prev], uid, queue)[0] : prev));
      setContribution(null);
      if (navigator.onLine) await synchronize(true);
      else notify(t.waitingSync);
    } catch (err) {
      if (currentAuth()?.currentUser?.uid !== uid) return;
      if (navigator.onLine) {
        try {
          await writeApi(`/plans/${encodeURIComponent(plan.id)}/checkins`, 'POST', input);
          setContribution(null);
          await refresh();
        } catch (e) {
          notify(readableError(e, locale), true);
        }
      } else notify(t.storageUnavailable, true);
    } finally {
      if (currentAuth()?.currentUser?.uid === uid) setBusy(false);
    }
  }
  async function nudge(plan: Plan, toUserId: string) {
    await action(async () => {
      if (!requireOnline()) return;
      await writeApi(`/plans/${encodeURIComponent(plan.id)}/nudges`, 'POST', {
        date: plan.date,
        toUserId,
      });
      notify(t.nudgeSent);
    });
  }
  async function enablePush() {
    if (pushOperation.current) return;
    pushOperation.current = true;
    try {
      await action(async () => {
        if (!requireOnline()) return;
        if (!user) return;
        const revision = pushRevision.current;
        await syncPushDevice(true, () => revision === pushRevision.current);
        const result = await writeApi<{ settings: SettingsData }>('/settings', 'PATCH', {
          notificationsEnabled: true,
        });
        if (revision !== pushRevision.current) return;
        assertCurrentUser();
        setProfile((current) =>
          current?.uid === user.uid ? { ...current, settings: result.settings } : current,
        );
        setPushReady(true);
        setPushRefreshEpoch((value) => value + 1);
        notify(t.installedPush);
      });
    } finally {
      releasePushOperation();
    }
  }
  async function testPush() {
    if (pushOperation.current) return;
    pushOperation.current = true;
    try {
      await action(async () => {
        if (!requireOnline()) return;
        const revision = pushRevision.current;
        try {
          await syncPushDevice(false, () => revision === pushRevision.current);
          await writeApi('/push/test', 'POST', { deviceId: deviceId() });
          if (revision !== pushRevision.current) return;
          assertCurrentUser();
          setPushReady(true);
          notify(t.pushTestAccepted);
        } catch (error) {
          if (
            revision === pushRevision.current &&
            currentAuth()?.currentUser?.uid === user?.uid &&
            (!(error instanceof ApiError) || error.code === 'PUSH_NOT_REGISTERED')
          )
            setPushReady(false);
          throw error;
        }
      });
    } finally {
      releasePushOperation();
    }
  }
  async function logout() {
    await action(async () => {
      const uid = user?.uid;
      if (!auth || !uid) return;
      pushRevision.current++;
      markPushRegistration(null);
      setPushReady(false);
      const privateCleanup = clearPrivateData(uid).catch(() => {});
      const mapCleanup = clearSavedPlaces(uid).catch(() => {});
      await setActivePushUser(null);
      if (navigator.onLine) {
        try {
          await writeApi('/push/tokens', 'DELETE', { deviceId: deviceId() });
          assertCurrentUser();
          await unregisterPush();
        } catch {
          /* do not prevent sign-out */
        }
      }
      await Promise.all([privateCleanup, mapCleanup]);
      assertCurrentUser();
      await signOut(auth);
    });
  }
  async function recoverSession(password: string) {
    await action(async () => {
      if (!user?.email || !requireOnline()) return;
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      assertCurrentUser();
      await user.getIdToken(true);
      await api('/me');
      assertCurrentUser();
      await resumePrivateSession(user.uid);
      assertCurrentUser();
      setSessionPaused(false);
      await setActivePushUser(user.uid);
      assertCurrentUser();
      await refresh(true);
      await synchronize();
    });
  }
  async function deleteAccount(password: string) {
    await action(async () => {
      if (!user?.email || !auth) return;
      if (!requireOnline()) return;
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      assertCurrentUser();
      await user.getIdToken(true);
      assertCurrentUser();
      pushRevision.current++;
      setPushReady(false);
      await setActivePushUser(null);
      assertCurrentUser();
      try {
        await writeApi('/me', 'DELETE');
      } catch (err) {
        if (err instanceof ApiError && err.code === 'AUTH_DELETE_PENDING') {
          try {
            await Promise.all([clearPrivateData(user.uid), clearSavedPlaces(user.uid)]);
          } catch {}
          assertCurrentUser();
          setProfile(null);
          setPlans([]);
          setFriends([]);
          setDeletionPending(true);
          setMeetings([]);
          setMeetingProposal(null);
          setFocusedPlace(null);
          setLoadError(err);
        }
        throw err;
      }
      try {
        await clearPrivateData(user.uid);
        await clearSavedPlaces(user.uid);
      } catch {
        /* disabled storage */
      }
      assertCurrentUser();
      try {
        await unregisterPush();
      } catch {
        /* subscription may already be invalid */
      }
      assertCurrentUser();
      await signOut(auth);
      setDeletionPending(false);
      setSheet(null);
      setSettings(false);
    });
  }
  async function exportData() {
    await action(async () => {
      if (!requireOnline() || !user) return;
      const uid = user.uid;
      let combined: Record<string, unknown> | null = null;
      let cursor: string | null = null;
      let bytes = 0;
      let complete = false;
      for (let page = 0; page < 500; page++) {
        if (currentAuth()?.currentUser?.uid !== uid) throw new ApiError('UNAUTHENTICATED', 401);
        const data: ExportPage = await api<ExportPage>(
          `/export?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { expectedUid: uid },
        );
        bytes += new TextEncoder().encode(JSON.stringify(data)).byteLength;
        if (bytes > 100 * 1024 * 1024) throw new ApiError('EXPORT_TOO_LARGE');
        if (!combined) combined = { ...data, checkins: [...data.checkins] };
        else (combined.checkins as unknown[]).push(...data.checkins);
        cursor = data.nextCursor;
        if (!cursor) {
          complete = true;
          break;
        }
      }
      if (!complete || !combined) throw new ApiError('EXPORT_TOO_LARGE');
      cursor = null;
      complete = false;
      const meetingCoordinationRecords: unknown[] = [];
      for (let page = 0; page < 500; page++) {
        if (currentAuth()?.currentUser?.uid !== uid) throw new ApiError('UNAUTHENTICATED', 401);
        const data: { records: unknown[]; nextCursor: string | null } = await api(
          `/export/coordination?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { expectedUid: uid },
        );
        bytes += new TextEncoder().encode(JSON.stringify(data)).byteLength;
        if (bytes > 100 * 1024 * 1024) throw new ApiError('EXPORT_TOO_LARGE');
        meetingCoordinationRecords.push(...data.records);
        cursor = data.nextCursor;
        if (!cursor) {
          complete = true;
          break;
        }
      }
      if (!complete) throw new ApiError('EXPORT_TOO_LARGE');
      combined.meetingCoordinationRecords = meetingCoordinationRecords;
      combined.study = (await api<StudyResponse>('/study', { expectedUid: uid })).study;
      if (currentAuth()?.currentUser?.uid !== uid) throw new ApiError('UNAUTHENTICATED', 401);
      delete combined.nextCursor;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(combined, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `daypact-${localDate()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function createInvitation() {
    await action(async () => {
      if (!requireOnline()) return;
      const invitation = await writeApi<Invitation>('/friends/invitations', 'POST', {});
      setInviteLink(`${location.origin}/?invite=${encodeURIComponent(invitation.token)}`);
    });
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      notify(t.copied);
    } catch {
      notify(t.genericError, true);
    }
  }
  async function acceptInvite() {
    await action(async () => {
      if (!inviteToken || !requireOnline()) return;
      await writeApi('/friends/accept', 'POST', { token: inviteToken });
      setInviteToken(null);
      const url = new URL(location.href);
      url.searchParams.delete('invite');
      history.replaceState(null, '', url);
      await refresh();
      setTab('friends');
      notify(t.friendAdded);
    });
  }
  function dismissInvite() {
    setInviteToken(null);
    const url = new URL(location.href);
    url.searchParams.delete('invite');
    history.replaceState(null, '', url);
  }
  function pickPlace(place: Place) {
    if (meetingProposal?.picking) {
      if (meetingProposal.uid !== currentAuth()?.currentUser?.uid) return;
      setMeetingProposal({ ...meetingProposal, place, picking: false });
      setFocusedPlace(place);
      setSelected(meetingProposal.plan);
      return;
    }
    setEditor({ ...pickerDraft, place });
    setPickerDraft(null);
  }
  function newMeeting(friend?: Friend) {
    setSheet(null);
    setEditor({
      mode: 'meeting',
      ...(friend
        ? {
            draft: {
              title: '',
              kind: 'event' as const,
              cadence: 'once' as const,
              startDate: date,
              time: '19:00',
              timeZone: profile?.settings.timeZone,
              memberIds: [friend.uid],
              remindMinutes: 15,
            },
          }
        : {}),
    });
  }
  function openMeeting(plan: Plan) {
    setSheet(null);
    setDate(plan.date);
    setSelected(plan);
    setMeetingProposal(null);
  }
  const closeSheet = useCallback(() => setSheet(null), []);
  const closeEditor = useCallback(() => setEditor(null), []);
  const closeSelected = useCallback(() => {
    setSelected(null);
    setMeetingProposal(null);
  }, []);

  if (!authReady)
    return (
      <main className="splash">
        <span className="brand">DayPact</span>
        <LoaderCircle className="spin" aria-label={t.loading} />
      </main>
    );
  if (!user?.emailVerified)
    return (
      <>
        <AuthScreen
          auth={auth}
          user={user}
          locale={locale}
          onLocale={chooseLocale}
          onVerified={async () => {
            if (user) await setActivePushUser(user.uid);
            setAuthRevision((x) => x + 1);
          }}
        />
        {toast && (
          <ToastMessage toast={toast} onClose={() => setToast(null)} label={t.closeNotification} />
        )}
      </>
    );
  if (!profile)
    return (
      <main className="splash">
        <span className="brand">DayPact</span>
        {loading ? (
          <>
            <LoaderCircle className="spin" />
            <p>{t.initialLoading}</p>
          </>
        ) : (
          <>
            <p className="error-copy">{loadError ? readableError(loadError, locale) : t.loading}</p>
            {sessionPaused ? (
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void recoverSession(String(new FormData(e.currentTarget).get('password')));
                }}
              >
                <PasswordInput
                  key="session-recovery"
                  label={t.currentPassword}
                  locale={locale}
                  name="password"
                  autoComplete="current-password"
                  required
                />
                <p className="form-note">{t.unsyncedLogout}</p>
                <button className="primary" disabled={busy}>
                  {t.signIn}
                </button>
              </form>
            ) : deletionPending ? (
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void deleteAccount(String(new FormData(e.currentTarget).get('password')));
                }}
              >
                <PasswordInput
                  key="deletion-retry"
                  label={t.currentPassword}
                  locale={locale}
                  name="password"
                  autoComplete="current-password"
                  required
                />
                <button className="danger-button" disabled={busy}>
                  {t.deleteAccount}
                </button>
              </form>
            ) : (
              <button className="primary" onClick={() => void refresh(true)}>
                {t.retry}
              </button>
            )}
            <button className="text-button" disabled={busy} onClick={() => void logout()}>
              {t.logout}
            </button>
          </>
        )}
        {toast && (
          <ToastMessage toast={toast} onClose={() => setToast(null)} label={t.closeNotification} />
        )}
      </main>
    );

  if (adminOpen && adminEligible)
    return (
      <div className="app-shell">
        <Suspense
          fallback={
            <div className="splash">
              <LoaderCircle className="spin" />
            </div>
          }
        >
          <AdminScreen
            key={user.uid}
            locale={locale}
            user={user}
            onBack={() => setAdminOpen(false)}
          />
        </Suspense>
      </div>
    );
  if (sheet === 'help')
    return (
      <div className="app-shell">
        <Suspense
          fallback={
            <div className="splash">
              <LoaderCircle className="spin" />
            </div>
          }
        >
          <SupportScreen key={user.uid} locale={locale} onBack={closeSheet} />
        </Suspense>
      </div>
    );
  const ownDone = plans.filter((p) => p.members.find((m) => m.uid === user.uid)?.completed).length;
  const visiblePlans = filter === 'shared' ? plans.filter((p) => p.members.length > 1) : plans;
  const sharedPlan = plans.find((p) => p.members.length > 1 && p.kind === 'event');
  const weekStart = shiftDate(date, -((new Date(`${date}T12:00Z`).getUTCDay() + 6) % 7));
  const pendingCount = pending.length + pendingDrafts.length;
  const mapPlans: Plan[] = [
    ...plans,
    ...meetings.filter((meeting) => !plans.some((plan) => plan.id === meeting.id)),
    ...pendingDrafts
      .filter((d) => !d.error && d.input.place)
      .map((d) => ({
        ...d.input,
        id: `pending:${d.operationId}`,
        ownerId: user.uid,
        memberIds: [user.uid, ...d.input.memberIds.filter((uid) => uid !== user.uid)],
        date: d.input.startDate,
        version: 0,
        createdAt: new Date(d.createdAt).toISOString(),
        updatedAt: new Date(d.createdAt).toISOString(),
        members: [
          {
            uid: user.uid,
            displayName: profile.displayName,
            completed: false,
            contribution: 0,
            rsvp: 'pending' as const,
            updatedAt: null,
          },
        ],
      })),
  ];
  return (
    <div className={`app-shell${!settings && tab === 'map' ? ' app-shell-map' : ''}`}>
      {!online && (
        <div className="offline-banner">
          <WifiOff size={15} />
          <span>{t.offline}</span>
          <small>{t.offlineNote}</small>
        </div>
      )}
      {pendingCount > 0 && (
        <button
          className={`sync-banner ${syncBlocked ? 'error' : ''}`}
          onClick={() => setSheet('queue')}
        >
          <RefreshCw size={14} className={syncing ? 'spin' : ''} />
          {syncBlocked ? t.syncBlocked : syncing ? t.syncing : `${pendingCount} ${t.pendingSync}`}
        </button>
      )}
      {settings ? (
        <SettingsScreen
          profile={profile}
          locale={locale}
          busy={busy}
          pushChecking={pushChecking}
          pushReady={
            pushReady &&
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted'
          }
          onBack={() => setSettings(false)}
          onSettings={updateSettings}
          onEditProfile={() => setSheet('edit-profile')}
          onOfflineMaps={() => setSheet('offline-maps')}
          onPush={enablePush}
          onTestPush={testPush}
          onExport={exportData}
          onDelete={deleteAccount}
          onLogout={() => setSheet('logout')}
          onInfo={setSheet}
          adminEligible={adminEligible}
          onAdmin={() => setAdminOpen(true)}
        />
      ) : (
        <>
          {tab === 'home' && (
            <main className="home-page">
              <PageHeader title={t.today}>
                <button
                  className="icon-button"
                  aria-label={t.notifications}
                  onClick={() => setSheet('notifications')}
                >
                  <Bell size={23} />
                  {notifications.some((n) => !n.read) && <i className="badge-dot" />}
                </button>
                <button
                  className="icon-button blue"
                  aria-label={t.newPlan}
                  onClick={() => setEditor({})}
                >
                  <Plus size={29} />
                </button>
              </PageHeader>
              <div className="date-line">
                <span>{dateLabel(date, locale)}</span>
                <label className="date-input-label" aria-label={t.openDate}>
                  <CalendarDays size={18} />
                  <input
                    type="date"
                    aria-label={t.openDate}
                    value={date}
                    onChange={(e) => {
                      if (e.target.value) setDate(e.target.value);
                    }}
                  />
                </label>
              </div>
              <div className="week-wrap">
                <button
                  className="week-arrow"
                  aria-label={t.datesPrev}
                  onClick={() => setDate(shiftDate(date, -7))}
                >
                  <ChevronLeft size={17} />
                </button>
                <div className="week">
                  {Array.from({ length: 7 }, (_, i) => shiftDate(weekStart, i)).map((day) => (
                    <button
                      key={day}
                      className={`day ${day === date ? 'active' : ''}`}
                      aria-pressed={day === date}
                      onClick={() => setDate(day)}
                    >
                      <small>{dateLabel(day, locale, { weekday: 'short' }).replace('.', '')}</small>
                      <b>{Number(day.slice(-2))}</b>
                    </button>
                  ))}
                </div>
                <button
                  className="week-arrow"
                  aria-label={t.datesNext}
                  onClick={() => setDate(shiftDate(date, 7))}
                >
                  <ChevronRight size={17} />
                </button>
              </div>
              <section className="progress-block">
                <div className="progress-top">
                  <span>{t.dayPlan}</span>
                  <span className="muted">
                    {ownDone} / {plans.length} {t.completedCount}
                  </span>
                </div>
                <div className="progress-track" aria-label={`${ownDone}/${plans.length}`}>
                  <span
                    style={{ width: plans.length ? `${(100 * ownDone) / plans.length}%` : '0%' }}
                  />
                </div>
              </section>
              <section className="meetings-overview">
                <div className="meetings-section-head">
                  <div>
                    <h2>{mt.meetings}</h2>
                    <p>{mt.intro}</p>
                  </div>
                  <button
                    className="meeting-create-button"
                    onClick={() => newMeeting()}
                    aria-label={mt.newMeeting}
                  >
                    <Plus size={19} />
                    {locale === 'kk' ? 'Құру' : 'Создать'}
                  </button>
                </div>
                {meetings.length ? (
                  <>
                    <div className="upcoming-meetings">
                      {meetings.slice(0, 2).map((meeting) => (
                        <MeetingCard
                          key={meeting.id}
                          plan={meeting}
                          locale={locale}
                          onClick={() => openMeeting(meeting)}
                        />
                      ))}
                    </div>
                    {meetings.length > 2 && (
                      <button className="text-button full" onClick={() => setSheet('meetings')}>
                        {t.all} · {meetings.length}
                      </button>
                    )}
                  </>
                ) : (
                  <p className="meetings-empty">{mt.emptyNote}</p>
                )}
              </section>
              {!!loadError && online && (
                <div className="inline-message error content-margin">
                  <span>{readableError(loadError, locale)}</span>
                  <button className="text-button" onClick={() => void refresh()}>
                    {t.retry}
                  </button>
                </div>
              )}
              {sharedPlan && (
                <section className="shared-card">
                  <button className="shared-card-main" onClick={() => setSelected(sharedPlan)}>
                    <div>
                      <div className="card-kicker">{t.nextShared}</div>
                      <h2>{sharedPlan.title}</h2>
                    </div>
                    <span className="time-tag">{sharedPlan.time}</span>
                  </button>
                  {sharedPlan.place && (
                    <div className="place-line">
                      <MapPin size={16} />
                      {sharedPlan.place.label}
                    </div>
                  )}
                  <div className="card-friends">
                    {sharedPlan.members
                      .filter((m) => m.uid !== user.uid)
                      .slice(0, 2)
                      .map((member) => (
                        <Avatar key={member.uid} name={member.displayName} />
                      ))}
                    <div className="status-copy">
                      {sharedPlan.members
                        .filter((m) => m.uid !== user.uid)
                        .map((m) => m.displayName)
                        .join(', ')}
                      <small>{t.shared}</small>
                    </div>
                    {sharedPlan.members.find((m) => m.uid !== user.uid && !m.completed) && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void nudge(
                            sharedPlan,
                            sharedPlan.members.find((m) => m.uid !== user.uid && !m.completed)!.uid,
                          )
                        }
                      >
                        <Bell size={16} />
                        {t.nudge}
                      </button>
                    )}
                  </div>
                </section>
              )}
              <div className="section-head">
                <h2>{filter === 'shared' ? t.sharedGoals : t.plans}</h2>
                <button
                  className="text-button"
                  onClick={() => setFilter(filter === 'all' ? 'shared' : 'all')}
                >
                  {filter === 'all' ? t.shared : t.all}
                </button>
              </div>
              {loading && !plans.length ? (
                <div className="inline-loading">
                  <LoaderCircle className="spin" />
                  {t.loading}
                </div>
              ) : visiblePlans.length ? (
                <div className="task-group">
                  {visiblePlans.map((plan) => (
                    <PlanRow
                      key={plan.id}
                      plan={plan}
                      uid={user.uid}
                      locale={locale}
                      busy={busy}
                      onOpen={() => setSelected(plan)}
                      onCheck={() =>
                        plan.kind === 'savings'
                          ? setContribution(plan)
                          : void checkin(
                              plan,
                              !plan.members.find((m) => m.uid === user.uid)?.completed,
                            )
                      }
                    />
                  ))}
                </div>
              ) : (
                <Empty icon={CalendarDays} title={t.emptyPlans} note={t.emptyPlansNote}>
                  <button className="primary" onClick={() => setEditor({})}>
                    <Plus size={18} />
                    {t.newPlan}
                  </button>
                </Empty>
              )}
              {stale && (
                <p className="home-note">
                  <Download size={14} />
                  {t.staleData}
                </p>
              )}
            </main>
          )}
          {tab === 'study' && (
            <Suspense
              fallback={
                <div className="inline-loading">
                  <LoaderCircle className="spin" />
                </div>
              }
            >
              <StudyScreen
                key={`${user.uid}:${studyEntry}`}
                uid={user.uid}
                locale={locale}
                online={online}
                initialDate={studyDate}
                onAuthError={() => hidePrivateView()}
              />
            </Suspense>
          )}
          {tab === 'map' && (
            <main className="map-page">
              <Suspense
                fallback={
                  <div className="inline-loading">
                    <LoaderCircle className="spin" />
                    {t.mapLoading}
                  </div>
                }
              >
                <MapScreen
                  key={`${user.uid}:${mapStartTab}`}
                  initialTab={mapStartTab}
                  plans={mapPlans}
                  locale={locale}
                  theme={profile.settings.theme}
                  userId={user.uid}
                  focusPlace={focusedPlace}
                  pickContext={
                    meetingProposal?.picking
                      ? 'proposal'
                      : pickerDraft?.mode === 'meeting' || pickerDraft?.draft?.kind === 'event'
                        ? 'meeting'
                        : 'plan'
                  }
                  onSelectPlan={(plan) => {
                    if (plan.id.startsWith('pending:')) setSheet('queue');
                    else if (plan.kind === 'event') openMeeting(plan);
                    else setSelected(plan);
                  }}
                  onPickPlace={pickerDraft || meetingProposal?.picking ? pickPlace : undefined}
                  onAddPlan={
                    !pickerDraft && !meetingProposal?.picking
                      ? () => {
                          setPickerDraft({});
                          setSelected(null);
                        }
                      : undefined
                  }
                  onCancelPick={
                    pickerDraft || meetingProposal?.picking
                      ? () => {
                          setPickerDraft(null);
                          if (meetingProposal?.picking) {
                            setSelected(meetingProposal.plan);
                            setMeetingProposal(null);
                          }
                        }
                      : undefined
                  }
                />
              </Suspense>
            </main>
          )}
          {tab === 'friends' && (
            <main className="friends-page">
              <PageHeader title={t.friends}>
                <button
                  className="icon-button blue"
                  aria-label={t.friendInvite}
                  onClick={() => {
                    setInviteLink('');
                    setSheet('invite');
                  }}
                >
                  <Plus size={27} />
                </button>
              </PageHeader>
              <p className="page-intro">{t.friendsIntro}</p>
              {friends.length > 0 && (
                <button className="secondary friends-meeting-button" onClick={() => newMeeting()}>
                  <CalendarDays size={18} />
                  {mt.newMeeting}
                </button>
              )}
              {friends.length ? (
                <div className="friend-list">
                  {friends.map((friend) => (
                    <article className="friend-row" key={friend.uid}>
                      <Avatar name={friend.displayName} />
                      <div className="friend-copy">
                        <b>{friend.displayName}</b>
                        <small>
                          @{friend.username}
                          {friend.city ? ` · ${friend.city}` : ''}
                        </small>
                      </div>
                      <button
                        className="icon-button blue"
                        aria-label={`${mt.newMeeting}: ${friend.displayName}`}
                        onClick={() => newMeeting(friend)}
                      >
                        <CalendarDays size={20} />
                      </button>
                      <button
                        className="icon-button muted"
                        aria-label={`${t.removeFriend}: ${friend.displayName}`}
                        onClick={() => setFriendRemove(friend)}
                      >
                        <Trash2 size={18} />
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty icon={Users} title={t.emptyFriends} note={t.emptyFriendsNote}>
                  <button
                    className="primary"
                    onClick={() => {
                      setInviteLink('');
                      setSheet('invite');
                    }}
                  >
                    <Plus size={18} />
                    {t.friendInvite}
                  </button>
                </Empty>
              )}
            </main>
          )}
          {tab === 'profile' && (
            <main className="profile-page">
              <PageHeader title={t.profile}>
                <button
                  className="icon-button"
                  aria-label={t.settings}
                  onClick={() => setSettings(true)}
                >
                  <Settings size={24} />
                </button>
              </PageHeader>
              <section className="profile-header">
                <Avatar large name={profile.displayName} />
                <div>
                  <h2>{profile.displayName}</h2>
                  <p>
                    {profile.username ? `@${profile.username}` : profile.email}
                    {profile.city ? ` · ${profile.city}` : ''}
                  </p>
                  <button className="text-button" onClick={() => setSheet('edit-profile')}>
                    {t.editProfile}
                  </button>
                </div>
              </section>
              {profile.bio && <p className="profile-bio">{profile.bio}</p>}
              <div className="profile-stats">
                <div>
                  <b>{ownDone}</b>
                  <small>
                    {date === localDate(profile.settings.timeZone)
                      ? t.todayDone
                      : dateLabel(date, locale, { day: 'numeric', month: 'short' })}
                  </small>
                </div>
                <div>
                  <b>{friends.length}</b>
                  <small>{t.friends}</small>
                </div>
                <div>
                  <b>{plans.length}</b>
                  <small>{t.dailyPlans}</small>
                </div>
              </div>
              <div className="group-caption">{t.plans.toUpperCase()}</div>
              <div className="settings-group">
                <Row label={mt.meetings} icon={CalendarDays} onClick={() => setSheet('meetings')} />
                <Row
                  label={t.allPlans}
                  icon={CalendarDays}
                  onClick={() => {
                    setFilter('all');
                    setTab('home');
                  }}
                />
                <Row
                  label={t.sharedGoals}
                  icon={Users}
                  onClick={() => {
                    setFilter('shared');
                    setTab('home');
                  }}
                />
                <Row
                  label={t.savedPlaces}
                  icon={Bookmark}
                  onClick={() => {
                    setMapStartTab('saved');
                    setTab('map');
                  }}
                />
              </div>
              <div className="group-caption">{t.application}</div>
              <div className="settings-group">
                <Row
                  label={t.offlineMaps}
                  value="Астана"
                  icon={Download}
                  onClick={() => setSheet('offline-maps')}
                />
                <Row label={t.settings} icon={Settings} onClick={() => setSettings(true)} />
                {adminEligible && (
                  <Row label={t.adminPanel} icon={Shield} onClick={() => setAdminOpen(true)} />
                )}
                <Row label={t.privacy} icon={Shield} onClick={() => setSheet('privacy')} />
              </div>
              <div className="settings-group">
                <Row label={t.help} icon={Info} onClick={() => setSheet('help')} />
                <Row label={t.logout} onClick={() => setSheet('logout')} />
              </div>
            </main>
          )}
        </>
      )}
      {!settings && (
        <nav className="bottom-nav" aria-label="DayPact">
          {(
            [
              { id: 'home', icon: Home, label: t.today },
              { id: 'study', icon: GraduationCap, label: locale === 'kk' ? 'Оқу' : 'Учёба' },
              { id: 'map', icon: MapIcon, label: t.map },
              { id: 'friends', icon: Users, label: t.friends },
              { id: 'profile', icon: UserRound, label: t.profile },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? 'active' : ''}`}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => {
                setTab(item.id);
                if (item.id === 'study') {
                  setStudyDate(undefined);
                  setStudyEntry((entry) => entry + 1);
                }
                if (item.id === 'map') setMapStartTab('plans');
                setPickerDraft(null);
                setMeetingProposal(null);
              }}
            >
              <item.icon size={24} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      )}

      {editor && (
        <PlanEditor
          onAuthError={hidePrivateView}
          value={editor}
          date={date}
          timeZone={profile.settings.timeZone}
          friends={friends}
          locale={locale}
          busy={busy}
          onClose={closeEditor}
          onSave={savePlan}
          onPickPlace={(draft, plan) => {
            setPickerDraft({ draft, plan, mode: editor.mode });
            setEditor(null);
            setTab('map');
          }}
        />
      )}
      {selected?.kind === 'event' && (
        <MeetingDetail
          key={`${user.uid}:${selected.id}:${selected.date}`}
          plan={selected}
          uid={user.uid}
          locale={locale}
          online={online}
          busy={busy}
          onClose={closeSelected}
          onRefresh={refresh}
          proposal={
            meetingProposal?.uid === user.uid &&
            meetingProposal.plan.id === selected.id &&
            meetingProposal.plan.date === selected.date &&
            meetingProposal.place
              ? { operationId: meetingProposal.operationId, place: meetingProposal.place }
              : undefined
          }
          onEdit={() => {
            setEditor({ plan: selected, mode: 'meeting' });
            setSelected(null);
            setMeetingProposal(null);
          }}
          onDelete={() => setConfirmDelete(selected)}
          onCheckin={() =>
            void checkin(
              selected,
              !selected.members.find((member) => member.uid === user.uid)?.completed,
            )
          }
          onViewPlace={(place) => {
            setFocusedPlace(place);
            setSelected(null);
            setTab('map');
          }}
          onPickPlace={() => {
            setMeetingProposal({
              plan: selected,
              uid: user.uid,
              operationId: crypto.randomUUID(),
              picking: true,
            });
            setFocusedPlace(selected.place ?? null);
            setSelected(null);
            setPickerDraft(null);
            setTab('map');
          }}
          onDiscardProposal={() => setMeetingProposal(null)}
          onProposalSaved={() => setMeetingProposal(null)}
          onPlanChanged={(plan) => {
            if (selected.date !== plan.date) setDate(plan.date);
            setSelected((current) => (current?.id === plan.id ? plan : current));
            setMeetings((current) =>
              current.map((p) => (p.id === plan.id && p.date === plan.date ? plan : p)),
            );
            setPlans((current) =>
              current.map((p) => (p.id === plan.id && p.date === plan.date ? plan : p)),
            );
          }}
        />
      )}
      {sheet === 'meetings' && (
        <Modal title={mt.upcoming} onClose={closeSheet} closeLabel={t.close}>
          <button className="primary full" onClick={() => newMeeting()}>
            <Plus size={18} />
            {mt.newMeeting}
          </button>
          {meetings.length ? (
            <div className="upcoming-meetings meeting-list">
              {meetings.map((meeting) => (
                <MeetingCard
                  key={meeting.id}
                  plan={meeting}
                  locale={locale}
                  onClick={() => openMeeting(meeting)}
                />
              ))}
            </div>
          ) : (
            <Empty icon={CalendarDays} title={mt.empty} note={mt.emptyNote} />
          )}
        </Modal>
      )}
      {selected && selected.kind !== 'event' && (
        <Modal title={selected.title} onClose={closeSelected} closeLabel={t.close}>
          <div className="plan-detail-meta">
            <Clock size={18} />
            {dateLabel(selected.date, locale, { day: 'numeric', month: 'long' })} · {selected.time}
          </div>
          {selected.place && (
            <button
              className="place-line detail-place"
              onClick={() => {
                setFocusedPlace(selected.place ?? null);
                setSelected(null);
                setTab('map');
              }}
            >
              <MapPin size={18} />
              {selected.place.label}
            </button>
          )}
          {selected.description && <p className="detail-description">{selected.description}</p>}
          <p className="form-note">
            {t[selected.cadence]} · {selected.timeZone ?? profile.settings.timeZone}
          </p>
          <div className="detail-members">
            {selected.members.map((member) => (
              <div className="detail-member" key={member.uid}>
                <Avatar name={member.displayName} />
                <div>
                  <b>
                    {member.displayName}
                    {member.uid === user.uid ? ` · ${t.you}` : ''}
                  </b>
                  <small>
                    {member.completed
                      ? t.done
                      : member.rsvp === 'accepted'
                        ? t.attending
                        : member.rsvp === 'declined'
                          ? t.declined
                          : t.pending}
                    {selected.kind === 'savings' ? ` · ${money(member.contribution, locale)}` : ''}
                  </small>
                </div>
                {member.uid !== user.uid && !member.completed && (
                  <button
                    className="icon-button blue"
                    aria-label={`${t.nudge}: ${member.displayName}`}
                    disabled={busy}
                    onClick={() => void nudge(selected, member.uid)}
                  >
                    <Bell size={19} />
                  </button>
                )}
                {member.completed && <CheckCircle2 size={20} className="success" />}
              </div>
            ))}
          </div>
          <div className="detail-actions">
            <button
              className="primary full"
              disabled={busy}
              onClick={() =>
                selected.kind === 'savings'
                  ? setContribution(selected)
                  : void checkin(
                      selected,
                      !selected.members.find((m) => m.uid === user.uid)?.completed,
                    )
              }
            >
              <Check size={20} />
              {selected.kind === 'savings'
                ? t.contribution
                : selected.members.find((m) => m.uid === user.uid)?.completed
                  ? t.markUndone
                  : t.markDone}
            </button>
            {selected.ownerId === user.uid && (
              <div className="form-columns">
                <button
                  className="text-button full"
                  onClick={() => {
                    setEditor({ plan: selected });
                    setSelected(null);
                  }}
                >
                  {t.edit}
                </button>
                <button
                  className="text-button danger full"
                  onClick={() => setConfirmDelete(selected)}
                >
                  {t.delete}
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
      {contribution && (
        <Modal title={t.contribution} closeLabel={t.close} onClose={() => setContribution(null)}>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const amount = Number(new FormData(e.currentTarget).get('amount'));
              if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1_000_000_000) {
                notify(t.amountMax, true);
                return;
              }
              void checkin(contribution, amount > 0, amount);
            }}
          >
            <p>{contribution.title}</p>
            <label>
              {t.contribution}
              <input
                name="amount"
                type="number"
                inputMode="numeric"
                min={0}
                max={1_000_000_000}
                step={1}
                required
                defaultValue={
                  contribution.members.find((m) => m.uid === user.uid)?.contribution ?? 0
                }
              />
            </label>
            <p className="form-note">{t.contributionNote}</p>
            <button className="primary full" disabled={busy}>
              {t.save}
            </button>
          </form>
        </Modal>
      )}
      {confirmDelete && (
        <Modal title={t.deletePlan} closeLabel={t.close} onClose={() => setConfirmDelete(null)}>
          <p className="form-note">{t.deletePlanNote}</p>
          <button
            className="danger-button full"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await writeApi(`/plans/${encodeURIComponent(confirmDelete.id)}`, 'DELETE');
                setConfirmDelete(null);
                setSelected(null);
                await refresh();
              })
            }
          >
            {t.delete}
          </button>
        </Modal>
      )}
      {friendRemove && (
        <Modal title={t.removeFriend} closeLabel={t.close} onClose={() => setFriendRemove(null)}>
          <p>{friendRemove.displayName}</p>
          <p className="form-note">{t.removeFriendNote}</p>
          <button
            className="danger-button full"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await writeApi(`/friends/${encodeURIComponent(friendRemove.uid)}`, 'DELETE');
                setFriendRemove(null);
                await refresh();
              })
            }
          >
            {t.confirm}
          </button>
        </Modal>
      )}
      {inviteToken && profile && (
        <Modal title={t.acceptInvite} closeLabel={t.close} onClose={dismissInvite}>
          <p className="form-note">{t.acceptInviteNote}</p>
          <button className="primary full" disabled={busy} onClick={() => void acceptInvite()}>
            {t.acceptInvite}
          </button>
        </Modal>
      )}
      {sheet === 'invite' && (
        <Modal title={t.friendInvite} closeLabel={t.close} onClose={closeSheet}>
          <p className="form-note">{t.inviteNote}</p>
          {inviteLink ? (
            <>
              <label className="form-label">
                {t.friendInvite}
                <input readOnly value={inviteLink} onFocus={(e) => e.currentTarget.select()} />
              </label>
              <div className="form-columns">
                <button className="primary" onClick={() => void copyInvite()}>
                  <Copy size={18} />
                  {t.copy}
                </button>
                {!!navigator.share && (
                  <button
                    className="secondary"
                    onClick={() =>
                      void navigator
                        .share({ title: t.inviteTitle, url: inviteLink })
                        .catch(() => {})
                    }
                  >
                    {t.share}
                  </button>
                )}
              </div>
            </>
          ) : (
            <button
              className="primary full"
              disabled={busy}
              onClick={() => void createInvitation()}
            >
              {busy ? t.loading : t.createInvite}
            </button>
          )}
        </Modal>
      )}
      {sheet === 'edit-profile' && (
        <Modal title={t.editProfile} closeLabel={t.close} onClose={closeSheet}>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void action(async () => {
                const result = await writeApi<{ profile: Profile }>('/me', 'PUT', {
                  displayName: String(data.get('name')).trim(),
                  username: String(data.get('username')).trim(),
                  bio: String(data.get('bio')).trim(),
                  city: String(data.get('city')).trim(),
                });
                setProfile(result.profile);
                setSheet(null);
                notify(t.profileSaved);
              });
            }}
          >
            <label>
              {t.name}
              <input
                name="name"
                required
                minLength={2}
                maxLength={70}
                defaultValue={profile.displayName}
              />
            </label>
            <label>
              {t.username}
              <input
                name="username"
                required
                minLength={3}
                maxLength={24}
                pattern="[a-z0-9_]+"
                autoCapitalize="none"
                defaultValue={profile.username}
              />
            </label>
            <label>
              {t.city}
              <input name="city" maxLength={80} defaultValue={profile.city} />
            </label>
            <label>
              {t.bio}
              <textarea name="bio" rows={3} maxLength={300} defaultValue={profile.bio} />
            </label>
            <button className="primary full" disabled={busy}>
              {t.save}
            </button>
          </form>
        </Modal>
      )}
      {sheet === 'notifications' && (
        <Modal title={t.notifications} closeLabel={t.close} onClose={closeSheet}>
          {notifications.length ? (
            <>
              <div className="notification-list">
                {notifications.map((note) => (
                  <button
                    className={`notification-item ${note.read ? '' : 'unread'}`}
                    key={note.id}
                    onClick={() =>
                      void action(async () => {
                        await writeApi('/notifications/read', 'POST', { ids: [note.id] });
                        setNotifications((prev) =>
                          prev.map((n) => (n.id === note.id ? { ...n, read: true } : n)),
                        );
                        const plan = plans.find((p) => p.id === note.planId);
                        if (note.studyDate) {
                          setStudyDate(note.studyDate);
                          setStudyEntry((entry) => entry + 1);
                          setTab('study');
                          setSettings(false);
                          setSheet(null);
                        }
                        if (plan) {
                          setSheet(null);
                          setSelected(plan);
                        }
                      })
                    }
                  >
                    <Bell size={19} />
                    <span>
                      <b>{note.title}</b>
                      <p>{note.body}</p>
                      <small>
                        {new Intl.DateTimeFormat(locale === 'kk' ? 'kk-KZ' : 'ru-RU', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        }).format(new Date(note.createdAt))}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              <button
                className="text-button full"
                disabled={busy || !notifications.some((n) => !n.read)}
                onClick={() =>
                  void action(async () => {
                    await writeApi('/notifications/read', 'POST', {
                      ids: notifications.filter((n) => !n.read).map((n) => n.id),
                    });
                    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
                    notify(t.notificationsRead);
                  })
                }
              >
                {t.markRead}
              </button>
            </>
          ) : (
            <Empty icon={Bell} title={t.notificationsEmpty} />
          )}
          <p className="form-note">{t.notificationPrivacy}</p>
        </Modal>
      )}
      {sheet === 'offline-maps' && (
        <Modal title={t.offlineMaps} closeLabel={t.close} onClose={closeSheet}>
          <Suspense fallback={<p>{t.loading}</p>}>
            <OfflineMapsSettings locale={locale} />
          </Suspense>
        </Modal>
      )}
      {(sheet === 'privacy' || sheet === 'about') && (
        <Modal title={t[sheet]} closeLabel={t.close} onClose={closeSheet}>
          <p className="info-copy">{sheet === 'privacy' ? t.dataNote : t.aboutText}</p>
          {sheet === 'privacy' && (
            <>
              <p className="info-copy">{t.notificationPrivacy}</p>
              <button className="secondary full" onClick={() => void exportData()}>
                <Download size={18} />
                {t.exportData}
              </button>
            </>
          )}
        </Modal>
      )}
      {sheet === 'logout' && (
        <Modal title={t.logout} closeLabel={t.close} onClose={closeSheet}>
          <p className="form-note">{pendingCount ? t.unsyncedLogout : t.logoutNote}</p>
          {pendingCount > 0 && online && (
            <button
              className="secondary full"
              disabled={syncing}
              onClick={() => void synchronize()}
            >
              {t.retrySync}
            </button>
          )}
          <button className="primary full" disabled={busy} onClick={() => void logout()}>
            {t.logout}
          </button>
        </Modal>
      )}
      {sheet === 'queue' && (
        <Modal title={t.pendingSync} closeLabel={t.close} onClose={closeSheet}>
          <p className="form-note">{syncBlocked ? t.syncBlocked : t.offlineNote}</p>
          {pending.map((item) => (
            <div className="queue-row" key={item.key}>
              <div>
                <b>{plans.find((p) => p.id === item.planId)?.title ?? item.input.date}</b>
                <small>{item.error ? t.noPlanAccess : t.waitingSync}</small>
              </div>
              {item.error && (
                <button
                  className="icon-button"
                  aria-label={t.delete}
                  onClick={() =>
                    void action(async () => {
                      await forgetPending(item.key);
                      const queue = await pendingCheckins(user.uid);
                      assertCurrentUser();
                      setPending(queue);
                      await refresh();
                    })
                  }
                >
                  <Trash2 size={19} />
                </button>
              )}
            </div>
          ))}
          {pendingDrafts.map((item) => (
            <div className="queue-row" key={item.key}>
              <div>
                <b>{item.input.title}</b>
                <small>{item.input.place?.label}</small>
                <small>
                  {item.error
                    ? readableError(new ApiError(item.error, 400), locale)
                    : t.waitingSync}
                </small>
              </div>
              <button
                className="icon-button"
                aria-label={`${t.delete}: ${item.input.title}`}
                onClick={() =>
                  void action(async () => {
                    await forgetPendingPlan(item.key);
                    const drafts = await pendingPlans(user.uid);
                    assertCurrentUser();
                    setPendingDrafts(drafts);
                  })
                }
              >
                <Trash2 size={19} />
              </button>
            </div>
          ))}
          <button
            className="primary full"
            disabled={!online || syncing}
            onClick={() => void synchronize()}
          >
            <RefreshCw size={17} />
            {t.retrySync}
          </button>
        </Modal>
      )}
      {toast && (
        <ToastMessage toast={toast} onClose={() => setToast(null)} label={t.closeNotification} />
      )}
    </div>
  );
}

function MeetingCard({
  plan,
  locale,
  onClick,
}: {
  plan: Plan;
  locale: Locale;
  onClick: () => void;
}) {
  const m = meetingTexts(locale);
  const going = plan.members.filter((member) => member.rsvp === 'accepted').length;
  return (
    <button className="meeting-card" onClick={onClick}>
      <span className="meeting-date">
        <b>{Number(plan.date.slice(-2))}</b>
        <small>{dateLabel(plan.date, locale, { month: 'short' })}</small>
      </span>
      <span className="meeting-card-copy">
        <b>{plan.title}</b>
        <span>
          <Clock size={13} />
          {plan.time}
          {plan.place && <> · {plan.place.label}</>}
        </span>
        <small>
          <Users size={13} />
          {going}/{plan.minAttendees ?? 2} ·{' '}
          {going >= (plan.minAttendees ?? 2) ? m.ready : m.gathering}
        </small>
        {plan.cadence !== 'once' && <small>{texts(locale)[plan.cadence]}</small>}
      </span>
      <ChevronRight size={18} />
    </button>
  );
}

function ToastMessage({
  toast,
  onClose,
  label,
}: {
  toast: Toast;
  onClose: () => void;
  label: string;
}) {
  return (
    <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>
      <span>{toast.text}</span>
      <button className="icon-button" aria-label={label} onClick={onClose}>
        <X size={17} />
      </button>
    </div>
  );
}
function PlanRow({
  plan,
  uid,
  locale,
  busy,
  onOpen,
  onCheck,
}: {
  plan: Plan;
  uid: string;
  locale: Locale;
  busy: boolean;
  onOpen: () => void;
  onCheck: () => void;
}) {
  const t = texts(locale);
  const own = plan.members.find((m) => m.uid === uid);
  const otherDone = plan.members.filter((m) => m.uid !== uid && m.completed);
  const total = plan.members.reduce((sum, m) => sum + m.contribution, 0);
  return (
    <article
      className={`task-row ${own?.completed ? 'completed' : ''} ${plan.kind === 'savings' ? 'savings' : ''}`}
    >
      <button
        className={`check-button ${own?.completed ? 'checked' : ''}`}
        disabled={busy}
        aria-label={`${own?.completed ? t.markUndone : t.markDone}: ${plan.title}`}
        aria-pressed={!!own?.completed}
        onClick={onCheck}
      >
        {plan.kind === 'savings' ? (
          <Wallet size={16} />
        ) : own?.completed ? (
          <Check size={17} />
        ) : null}
      </button>
      <button className="task-body" onClick={onOpen}>
        <span className="task-title">{plan.title}</span>
        {plan.kind === 'savings' ? (
          <>
            <span className="money-row">
              <b>{money(total, locale)}</b>
              <span>
                {t.goal}: {money(plan.targetAmount ?? 0, locale)}
              </span>
            </span>
            <span className="money-track">
              <i
                style={{
                  width: `${Math.min(100, (total / Math.max(1, plan.targetAmount ?? 1)) * 100)}%`,
                }}
              />
            </span>
          </>
        ) : (
          <span className={`task-sub ${otherDone.length ? 'ready' : ''}`}>
            {own?.completed
              ? t.done
              : otherDone.length
                ? `${otherDone.map((m) => m.displayName).join(', ')} · ${t.done}`
                : plan.members.length > 1
                  ? t.shared
                  : t.personal}
          </span>
        )}
      </button>
      {plan.kind !== 'savings' && <time className="task-time">{plan.time}</time>}
    </article>
  );
}
