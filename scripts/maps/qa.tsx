// Isolated local QA fixture; never imported by the production application.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MapScreen from '../../src/web/map/MapScreen';
import OfflineMapsSettings from '../../src/web/map/OfflineMapsSettings';
import type { Locale, Plan, Theme } from '../../src/shared/contracts';
import * as savedPlaces from '../../src/web/map/savedPlaces';
Object.assign(window, { daypactMapQa: { savedPlaces } });

const plan: Plan = {
  id: 'qa-plan',
  ownerId: 'qa-user',
  version: 1,
  date: '2026-11-19',
  title: 'Нұржолмен серуен',
  kind: 'event',
  cadence: 'once',
  startDate: '2026-11-19',
  time: '19:00',
  memberIds: ['qa-user'],
  remindMinutes: 15,
  place: { lat: 51.1282, lng: 71.4304, label: 'Бәйтерек' },
  members: [
    {
      uid: 'qa-user',
      displayName: 'Мұхаммад',
      completed: false,
      contribution: 0,
      rsvp: 'accepted',
      updatedAt: null,
    },
  ],
  createdAt: '2026-11-19T00:00:00Z',
  updatedAt: '2026-11-19T00:00:00Z',
};
const params = new URLSearchParams(location.search),
  clean = params.has('clean'),
  theme = (params.get('theme') ?? 'dark') as Theme;
function App() {
  const [locale, setLocale] = useState<Locale>('kk'),
    [settings, setSettings] = useState(false),
    [picked, setPicked] = useState(''),
    [uid, setUid] = useState('qa-user');
  return (
    <>
      {!clean && (
        <header
          style={{ height: 45, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px' }}
        >
          <button onClick={() => setLocale((l) => (l === 'kk' ? 'ru' : 'kk'))}>KK / RU</button>
          <button onClick={() => setSettings((v) => !v)}>Settings / map</button>
          <button onClick={() => setUid((v) => (v === 'qa-user' ? 'qa-other' : 'qa-user'))}>
            User
          </button>
          <output>{picked}</output>
        </header>
      )}
      <main style={{ height: clean ? '100dvh' : 'calc(100dvh - 45px)' }}>
        {settings ? (
          <OfflineMapsSettings locale={locale} />
        ) : (
          <MapScreen
            plans={[plan]}
            locale={locale}
            theme={theme}
            userId={uid}
            onSelectPlan={(p) => setPicked(p.title)}
            onPickPlace={clean ? undefined : (p) => setPicked(p.label)}
          />
        )}
      </main>
    </>
  );
}
document.head.insertAdjacentHTML(
  'beforeend',
  '<style>@font-face{font-family:Roboto;src:url(/fonts/Roboto-Variable.ttf) format("truetype");font-weight:100 900}html,body,#root{margin:0;height:100%;background:#171b21;color:#eee;font-family:Roboto,Arial,sans-serif}*{box-sizing:border-box}button{font:inherit}#root{max-width:430px;margin:auto}</style>',
);
async function start() {
  if (import.meta.env.PROD) {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
  }
  createRoot(document.getElementById('root')!).render(<App />);
}
void start();
