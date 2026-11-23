import { useEffect, useRef, useState } from 'react';
import { GraduationCap } from 'lucide-react';
import type { Locale } from '../shared/contracts';
import type { StudyDocument, StudyResponse } from '../shared/study';
import { studyConflictsAt } from '../shared/studyTime';
import { api, ApiError } from './api';
import { currentAuth } from './firebase';
import { loadStudyCache, saveStudyCache, pausePrivateSession } from './offline';

/** Only the signed-in user's own schedule is consulted. A warning never blocks a meeting. */
export function StudyConflict({
  date,
  time,
  zone,
  locale,
  onAuthError,
}: {
  date: string;
  time: string;
  zone: string;
  locale: Locale;
  onAuthError?: () => void;
}) {
  const [study, setStudy] = useState<StudyDocument | null>(null);
  const [cached, setCached] = useState(false);
  const [ownerUid] = useState(() => currentAuth()?.currentUser?.uid);
  const authErrorRef = useRef(onAuthError);
  authErrorRef.current = onAuthError;
  useEffect(() => {
    const uid = ownerUid;
    if (!uid) return;
    let active = true;
    const valid = () => active && currentAuth()?.currentUser?.uid === uid;
    void (async () => {
      try {
        const saved = await loadStudyCache(uid);
        if (valid() && saved) {
          setStudy(saved);
          setCached(true);
        }
        if (!navigator.onLine) return;
        const response = await api<StudyResponse>('/study', { expectedUid: uid });
        if (!valid()) return;
        setStudy(response.study);
        setCached(false);
        await saveStudyCache(uid, response.study);
      } catch (error) {
        if (
          valid() &&
          error instanceof ApiError &&
          (error.status === 401 ||
            [
              'ACCOUNT_SUSPENDED',
              'ACCOUNT_DELETED',
              'AUTH_DELETE_PENDING',
              'REAUTH_REQUIRED',
            ].includes(error.code))
        ) {
          setStudy(null);
          setCached(false);
          try {
            await pausePrivateSession(uid);
          } finally {
            if (valid()) authErrorRef.current?.();
          }
        }
        /* Missing schedule is not a claim that this time is free. */
      }
    })();
    return () => {
      active = false;
    };
  }, [ownerUid]);
  const conflicts = study ? studyConflictsAt(study, date, time, zone) : [];
  if (!conflicts.length || currentAuth()?.currentUser?.uid !== ownerUid) return null;
  return (
    <p className="form-note" role="status">
      <GraduationCap size={16} />{' '}
      {locale === 'ru'
        ? 'Начало встречи совпадает с твоим занятием: '
        : 'Кездесудің басталуы сабағыңмен сәйкес келеді: '}
      {conflicts
        .map((lesson) => `${lesson.startTime}–${lesson.endTime} · ${lesson.title}`)
        .join('; ')}
      .{cached && (locale === 'ru' ? ' По сохранённому расписанию.' : ' Сақталған кесте бойынша.')}
    </p>
  );
}
