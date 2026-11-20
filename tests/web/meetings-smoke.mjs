/** Local-only meeting UI regression. Identity/API fixtures never reach a live service. */
import { chromium, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5177';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw new Error('Local fixtures only');
const replayLegacyFocus = process.env.PLAYWRIGHT_REPLAY_LEGACY_MAP_FOCUS === '1';
const output = path.join(
  root,
  'test-results',
  replayLegacyFocus ? 'meetings-legacy-focus' : 'meetings',
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const results = [],
  errors = [];
const passed = (name) => {
  results.push(name);
  console.log(name);
};
let page;
try {
  const env = await readFile(path.join(root, '.env.local'), 'utf8');
  const key = env
    .match(/^VITE_FIREBASE_API_KEY=(.+)$/m)?.[1]
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!key) throw new Error('Public test build configuration missing');
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    locale: 'kk-KZ',
    colorScheme: 'dark',
  });
  // Keep the real MapLibre instance, render, click handler and React effects.
  // Hold only its load notification so a user can edit before React sees readiness.
  // This local Vite module interception never changes application source or a live build.
  await context.route('**/src/web/map/MapScreen.tsx*', async (route) => {
    const response = await route.fetch();
    let source = await response.text();
    const ready = 'if (alive) setMapReady(true);';
    if (!source.includes(ready))
      throw new Error('MapLibre readiness instrumentation no longer matches');
    source = source.replace(
      ready,
      `if (alive) {
      if (window.__daypactHoldMapReady) {
        window.__daypactReleaseMapReady = () => {
          if (alive) setMapReady(true);
          window.__daypactHoldMapReady = false;
        };
      } else setMapReady(true);
    }`,
    );
    if (replayLegacyFocus) {
      const fixedEffect =
        /useEffect\(\(\) => \{\s*if \(!focusPlace \|\| !pkg\.manifest\) return;[\s\S]*?\}, \[\s*focusPlace,\s*pkg\.manifest,\s*userId\s*\]\);/;
      if (!fixedEffect.test(source))
        throw new Error('Fixed focus effect not found for local legacy replay');
      source = source.replace(fixedEffect, '');
      source = source.replace(
        'activeUser.current = userId;',
        `activeUser.current = userId;
        useEffect(() => {
          if (!focusPlace || !mapReady || !pkg.manifest) return;
          if (!pointInBounds(focusPlace, pkg.manifest.bounds)) {
            setMessage(t.geoOutside);
            return;
          }
          setSearching(false);
          setPlan(null);
          setPoint(focusPlace);
          setLabel(focusPlace.label);
          map.current?.easeTo({ center: [focusPlace.lng, focusPlace.lat],
            zoom: Math.max(map.current.getZoom(), 15), duration: 450 });
        }, [focusPlace, mapReady, pkg.manifest, t.geoOutside]);`,
      );
    }
    await route.fulfill({ response, body: source });
  });
  const now = Math.floor(Date.now() / 1000);
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: 'alice',
        user_id: 'alice',
        aud: 'daypact-ui-test',
        iss: 'https://securetoken.google.com/daypact-ui-test',
        email: 'alice@example.test',
        email_verified: true,
        iat: now,
        exp: now + 3600,
        auth_time: now,
        firebase: { sign_in_provider: 'password' },
      }),
    ).toString('base64url'),
    'test-signature',
  ].join('.');
  const user = {
    uid: 'alice',
    email: 'alice@example.test',
    emailVerified: true,
    displayName: 'Мұхаммад',
    isAnonymous: false,
    providerData: [
      {
        providerId: 'password',
        uid: 'alice@example.test',
        email: 'alice@example.test',
        displayName: 'Мұхаммад',
        phoneNumber: null,
        photoURL: null,
      },
    ],
    stsTokenManager: {
      refreshToken: 'test-refresh',
      accessToken: jwt,
      expirationTime: Date.now() + 3600000,
    },
    createdAt: String(Date.now()),
    lastLoginAt: String(Date.now()),
    apiKey: key,
    appName: '[DEFAULT]',
  };
  await context.addInitScript(
    ({ user, key }) => {
      localStorage.setItem('daypact.locale', 'kk');
      const name = `firebase:authUser:${key}:[DEFAULT]`;
      localStorage.setItem(name, JSON.stringify(user));
      const request = indexedDB.open('firebaseLocalStorageDb', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction('firebaseLocalStorage', 'readwrite');
        tx.objectStore('firebaseLocalStorage').put({ fbase_key: name, value: user });
        tx.oncomplete = () => db.close();
      };
    },
    { user, key },
  );
  const settings = {
    locale: 'kk',
    theme: 'dark',
    notificationsEnabled: true,
    friendNudges: true,
    quietStart: '22:00',
    quietEnd: '08:00',
    timeZone: 'Asia/Almaty',
  };
  const profile = {
    uid: 'alice',
    displayName: 'Мұхаммад',
    username: 'muhammad',
    bio: '',
    city: 'Астана',
    email: 'alice@example.test',
    settings,
    createdAt: new Date().toISOString(),
  };
  const friends = [
    { uid: 'bob', displayName: 'Айдос', username: 'aidos', city: 'Астана' },
    { uid: 'carol', displayName: 'Нұржан', username: 'nurzhan', city: 'Астана' },
  ];
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const plans = [],
    proposals = [],
    proposalAttempts = [],
    rsvpRequests = [];
  let failFirstProposal = true;
  const places = () => ({ planVersion: plans[0]?.version ?? 1, options: proposals });
  await context.route('https://identitytoolkit.googleapis.com/**', (route) =>
    route.fulfill({
      json: {
        users: [
          {
            localId: 'alice',
            email: 'alice@example.test',
            emailVerified: true,
            displayName: 'Мұхаммад',
            providerUserInfo: user.providerData,
            validSince: '0',
          },
        ],
      },
    }),
  );
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method(),
      name = url.pathname;
    const body = method === 'GET' ? undefined : request.postDataJSON();
    let result,
      status = 200;
    if (name === '/api/me') result = { profile };
    else if (name === '/api/friends') result = { friends };
    else if (name === '/api/meetings') result = { meetings: plans };
    else if (name === '/api/notifications') result = { notifications: [] };
    else if (name === '/api/settings') {
      Object.assign(settings, body);
      result = { settings };
    } else if (name === '/api/plans' && method === 'GET')
      result = { plans: plans.filter((plan) => plan.date === url.searchParams.get('date')) };
    else if (name === '/api/plans' && method === 'POST') {
      expect(body.kind).toBe('event');
      expect(body.cadence).toBe('once');
      expect(body.memberIds).toEqual(['bob', 'carol']);
      const plan = {
        ...body,
        id: randomUUID(),
        ownerId: 'alice',
        version: 1,
        date: body.startDate,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        members: [profile, ...friends].map((p) => ({
          uid: p.uid,
          displayName: p.displayName,
          completed: false,
          contribution: 0,
          rsvp: 'pending',
          updatedAt: null,
        })),
      };
      plans.push(plan);
      result = { plan };
      status = 201;
      proposals.push({
        id: randomUUID(),
        planId: plan.id,
        proposedBy: 'bob',
        proposerName: 'Айдос',
        place: { lat: 51.124, lng: 71.435, label: 'Достар футбол алаңы' },
        voterIds: ['bob'],
        createdAt: new Date().toISOString(),
      });
    } else if (name.endsWith('/places') && method === 'GET') result = places();
    else if (name.endsWith('/places') && method === 'POST') {
      expect(Object.keys(body).sort()).toEqual(['operationId', 'place']);
      proposalAttempts.push(body.operationId);
      if (!proposals.some((p) => p.id === body.operationId))
        proposals.push({
          id: body.operationId,
          planId: plans[0].id,
          proposedBy: 'alice',
          proposerName: 'Мұхаммад',
          place: body.place,
          voterIds: [],
          createdAt: new Date().toISOString(),
        });
      if (failFirstProposal) {
        failFirstProposal = false;
        return route.abort('failed');
      }
      result = places();
    } else if (name.endsWith('/place-vote')) {
      proposals.forEach((p) => (p.voterIds = p.voterIds.filter((uid) => uid !== 'alice')));
      if (body.optionId) proposals.find((p) => p.id === body.optionId).voterIds.push('alice');
      result = { ok: true };
    } else if (name.endsWith('/place-confirm')) {
      expect(body.version).toBe(plans[0].version);
      plans[0].place = proposals.find((p) => p.id === body.optionId).place;
      plans[0].version++;
      plans[0].members.forEach((m) => (m.rsvp = 'pending'));
      result = { plan: plans[0] };
    } else if (name.endsWith('/rsvp')) {
      rsvpRequests.push(body);
      if (body.version !== plans[0].version) {
        status = 409;
        result = { error: { code: 'VERSION_CONFLICT' } };
      } else {
        plans[0].members[0].rsvp = body.status;
        result = { ok: true };
      }
    } else if (name.endsWith('/checkins')) {
      plans[0].members[0].completed = body.completed;
      result = { ok: true };
    } else {
      status = 404;
      result = { error: { code: 'NOT_FOUND' } };
    }
    await route.fulfill({ status, json: result });
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Бүгін', exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole('button', { name: 'Кездесу құру', exact: true }).click();
  await page.getByLabel('Кездесу атауы', { exact: true }).fill('Футбол');
  await page.locator('input[name=date]').fill(future);
  await page.locator('input[name=time]').fill('19:30');
  await page.getByRole('checkbox', { name: /Айдос/ }).check();
  await page.getByRole('checkbox', { name: /Нұржан/ }).check();
  await page.locator('select[name=reminder]').selectOption('-1');
  await page.screenshot({ path: path.join(output, 'editor-kk.png') });
  await page.getByRole('button', { name: 'Картадан таңдау', exact: true }).click();
  await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible({ timeout: 120000 });
  await expect(page.locator('.dp-map-loading')).toHaveCount(0, { timeout: 120000 });
  await page.locator('canvas.maplibregl-canvas').click({ position: { x: 185, y: 350 } });
  await page.getByLabel('Картадағы орын', { exact: true }).fill('Бәйтерек футбол алаңы');
  await page.getByRole('button', { name: 'Кездесетін орын ретінде таңдау', exact: true }).click();
  await expect(page.getByLabel('Кездесу атауы', { exact: true })).toHaveValue('Футбол');
  await expect(page.locator('input[name=date]')).toHaveValue(future);
  await expect(page.locator('input[name=time]')).toHaveValue('19:30');
  await expect(page.getByRole('checkbox', { name: /Айдос/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Нұржан/ })).toBeChecked();
  passed('map_picker_preserves_meeting_title_time_and_multiple_friends');
  await page.getByRole('dialog').getByRole('button', { name: 'Кездесу құру', exact: true }).click();
  await expect.poll(() => plans.length).toBe(1);
  await page.getByRole('button', { name: 'Бүгін', exact: true }).click();
  await expect(page.locator('.meeting-card')).toHaveCount(1, { timeout: 20000 });
  await page.screenshot({ path: path.join(output, 'home-kk.png') });
  await page.locator('.meeting-card').click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Футбол', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Келемін', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Келемін', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(rsvpRequests.at(-1).version).toBe(1);
  passed('future_meeting_visible_and_self_rsvp_versioned');
  await page.evaluate(() => {
    window.__daypactHoldMapReady = true;
    delete window.__daypactReleaseMapReady;
  });
  await page.getByRole('button', { name: 'Картадан орын ұсыну', exact: true }).click();
  await page.waitForFunction(
    () => typeof window.__daypactReleaseMapReady === 'function',
    undefined,
    { timeout: 120000 },
  );
  await page.locator('canvas.maplibregl-canvas').click({ position: { x: 210, y: 410 } });
  await page.getByLabel('Картадағы орын', { exact: true }).fill('Басқа футбол алаңы');
  const chosenCoordinates = await page.locator('.dp-map-sheet .dp-map-muted').innerText();
  expect(chosenCoordinates).not.toBe(
    `${plans[0].place.lat.toFixed(5)}, ${plans[0].place.lng.toFixed(5)}`,
  );
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.__daypactReleaseMapReady();
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  await expect(page.getByLabel('Картадағы орын', { exact: true })).toHaveValue(
    'Басқа футбол алаңы',
  );
  await expect(page.locator('.dp-map-sheet .dp-map-muted')).toHaveText(chosenCoordinates);
  await page.getByRole('button', { name: 'Осы орынды ұсыну', exact: true }).click();
  await expect(page.locator('.meeting-proposal-draft')).toContainText('Басқа футбол алаңы');
  await page.getByRole('button', { name: 'Орынды ұсыну', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Орынды ұсыну', exact: true }).click();
  await expect(page.locator('.meeting-proposal-draft')).toHaveCount(0);
  expect(proposalAttempts).toHaveLength(2);
  expect(proposalAttempts[0]).toBe(proposalAttempts[1]);
  expect(proposals).toHaveLength(2);
  expect(`${proposals[1].place.lat.toFixed(5)}, ${proposals[1].place.lng.toFixed(5)}`).toBe(
    chosenCoordinates,
  );
  expect(proposals[1].place.label).toBe('Басқа футбол алаңы');
  passed('late_map_readiness_preserves_edited_point_label_and_submitted_draft');
  passed('proposal_lost_response_retry_retains_operation_id');
  await page
    .getByRole('button', { name: 'Осы орынға дауыс беру: Басқа футбол алаңы', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Дауысты қайтару', exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Осы орынға дауыс беру: Достар футбол алаңы', exact: true })
    .click();
  await expect
    .poll(() => proposals.filter((p) => p.voterIds.includes('alice')).map((p) => p.place.label))
    .toEqual(['Достар футбол алаңы']);
  passed('vote_moves_between_options_without_duplicate_votes');
  const option = page
    .locator('.meeting-option')
    .filter({ has: page.getByRole('button', { name: 'Достар футбол алаңы', exact: true }) });
  await option.getByRole('button', { name: 'Осы орынды бекіту', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Келемін', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(plans[0].version).toBe(2);
  expect(plans[0].place.label).toBe('Достар футбол алаңы');
  await expect(page.getByRole('button', { name: 'Келемін', exact: true })).toBeEnabled();
  passed('organizer_confirmation_changes_place_and_resets_attendance');
  plans[0].version = 3;
  plans[0].time = '20:15';
  await page.getByRole('button', { name: 'Келемін', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Кездесу өзгерді');
  await expect(page.locator('.meeting-heading-meta')).toContainText('20:15');
  await page.getByRole('button', { name: 'Келемін', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Келемін', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(rsvpRequests.at(-1).version).toBe(3);
  passed('stale_attendance_response_refreshes_details_before_retry');
  await page.getByRole('dialog').evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'meeting-kk.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Профиль', exact: true }).click();
  await page.getByRole('button', { name: 'Баптаулар', exact: true }).first().click();
  await page.getByRole('button', { name: 'Тіл Қазақша', exact: true }).click();
  await page.getByRole('button', { name: 'Русский', exact: true }).click();
  await page.getByRole('button', { name: /^Оформление / }).click();
  await page.getByRole('button', { name: 'Светлое', exact: true }).click();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await page.getByRole('button', { name: 'Сегодня', exact: true }).click();
  await page.locator('.meeting-card').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Я приду', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('dialog').evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'meeting-light-ru.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
  passed('russian_light_theme_and_narrow_viewport_without_browser_errors');
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ passed: true, checks: results, errors }, null, 2),
  );
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
