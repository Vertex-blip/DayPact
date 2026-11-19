/** Local browser smoke test. All account/API fixtures are test-only route mocks. */
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5175';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw new Error('UI fixtures are restricted to a local development server.');
const output = path.join(root, 'test-results', 'ui-smoke');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  executablePath:
    process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const errors = [];
try {
  const anon = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    locale: 'kk-KZ',
  });
  const login = await anon.newPage();
  login.on('pageerror', (e) => errors.push(e.message));
  await login.goto(base, { waitUntil: 'networkidle' });
  await expect(login.getByRole('heading', { name: 'Кіру', exact: true })).toBeVisible();
  await login.screenshot({ path: path.join(output, 'login-kk.png'), fullPage: true });
  await login.getByRole('button', { name: 'Аккаунт ашу', exact: true }).click();
  await expect(login.getByLabel('Парольді қайталау')).toBeVisible();
  await login.getByLabel('Атың', { exact: true }).fill('Test User');
  await login.getByLabel('Электрондық пошта', { exact: true }).fill('test@example.test');
  await login.locator('input[name="password"]').fill('A-long-test-password');
  await login.getByLabel('Парольді қайталау').fill('different-password');
  await login.getByRole('button', { name: 'Аккаунт ашу', exact: true }).click();
  await expect(login.getByRole('alert')).toContainText('Парольдер бірдей емес.');
  await login.screenshot({ path: path.join(output, 'signup-kk.png'), fullPage: true });
  await login.getByRole('button', { name: 'Баптаулар', exact: true }).click();
  await login.getByRole('button', { name: 'Русский', exact: true }).click();
  await expect(login.getByRole('heading', { name: 'Создать аккаунт' })).toBeVisible();
  await anon.close();

  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    locale: 'kk-KZ',
    colorScheme: 'dark',
  });
  const localConfig =
    process.env.PLAYWRIGHT_USE_LOCAL_FIREBASE_CONFIG === '1'
      ? await readFile(path.join(root, '.env.local'), 'utf8')
      : '';
  const key =
    localConfig
      .match(/^VITE_FIREBASE_API_KEY=(.+)$/m)?.[1]
      .trim()
      .replace(/^["']|["']$/g, '') ?? 'test-only-api-key';
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
        name: 'Мұхаммад',
        iat: now,
        exp: now + 3600,
        auth_time: now,
        firebase: { sign_in_provider: 'password' },
      }),
    ).toString('base64url'),
    'test-signature',
  ].join('.');
  const firebaseUser = {
    uid: 'alice',
    email: 'alice@example.test',
    emailVerified: true,
    displayName: 'Мұхаммад',
    isAnonymous: false,
    providerData: [
      {
        providerId: 'password',
        uid: 'alice@example.test',
        displayName: 'Мұхаммад',
        email: 'alice@example.test',
        phoneNumber: null,
        photoURL: null,
      },
    ],
    stsTokenManager: {
      refreshToken: 'test-refresh-token',
      accessToken: jwt,
      expirationTime: Date.now() + 3_600_000,
    },
    createdAt: String(Date.now()),
    lastLoginAt: String(Date.now()),
    apiKey: key,
    appName: '[DEFAULT]',
  };
  await context.addInitScript(
    ({ user, apiKey }) => {
      localStorage.setItem('daypact.locale', 'kk');
      const storageKey = `firebase:authUser:${apiKey}:[DEFAULT]`;
      localStorage.setItem(storageKey, JSON.stringify(user));
      const request = indexedDB.open('firebaseLocalStorageDb', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('firebaseLocalStorage', 'readwrite');
        tx.objectStore('firebaseLocalStorage').put({ fbase_key: storageKey, value: user });
        tx.oncomplete = () => db.close();
      };
    },
    { user: firebaseUser, apiKey: key },
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
  const friend = { uid: 'bob', displayName: 'Айдос', username: 'aidos', city: 'Астана' };
  const checkins = [];
  const createdPlans = [];
  const records = [
    {
      id: 'book',
      title: '20 минут кітап оқу',
      kind: 'habit',
      members: [
        {
          uid: 'alice',
          displayName: 'Мұхаммад',
          completed: true,
          contribution: 0,
          rsvp: 'pending',
          updatedAt: null,
        },
      ],
    },
    {
      id: 'mosque',
      title: 'Мешітте намаз оқу',
      kind: 'habit',
      members: [
        {
          uid: 'alice',
          displayName: 'Мұхаммад',
          completed: false,
          contribution: 0,
          rsvp: 'pending',
          updatedAt: null,
        },
        {
          uid: 'bob',
          displayName: 'Айдос',
          completed: true,
          contribution: 0,
          rsvp: 'pending',
          updatedAt: null,
        },
      ],
    },
    {
      id: 'walk',
      title: 'Нұржолмен серуен',
      kind: 'event',
      place: { lat: 51.1283, lng: 71.4304, label: 'Бәйтерек' },
      members: [
        {
          uid: 'alice',
          displayName: 'Мұхаммад',
          completed: false,
          contribution: 0,
          rsvp: 'pending',
          updatedAt: null,
        },
        {
          uid: 'bob',
          displayName: 'Айдос',
          completed: false,
          contribution: 0,
          rsvp: 'pending',
          updatedAt: null,
        },
      ],
    },
  ];
  let selectedDate;
  function plans(date) {
    selectedDate = date;
    return records.map((r) => ({
      ownerId: 'alice',
      description: '',
      cadence: 'daily',
      startDate: date,
      time: r.id === 'walk' ? '19:00' : '18:30',
      timeZone: 'Asia/Almaty',
      memberIds: r.members.map((m) => m.uid),
      remindMinutes: 15,
      version: 1,
      date,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...r,
    }));
  }
  await context.route('https://identitytoolkit.googleapis.com/**', (route) =>
    route.fulfill({
      json: {
        users: [
          {
            localId: 'alice',
            email: 'alice@example.test',
            emailVerified: true,
            displayName: 'Мұхаммад',
            providerUserInfo: firebaseUser.providerData,
            validSince: '0',
          },
        ],
      },
    }),
  );
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      pathname = url.pathname,
      method = request.method();
    let result;
    if (pathname === '/api/me' && method === 'GET') result = { profile };
    else if (pathname === '/api/friends') result = { friends: [friend] };
    else if (pathname === '/api/plans' && method === 'GET')
      result = { plans: plans(url.searchParams.get('date')) };
    else if (pathname === '/api/notifications') result = { notifications: [] };
    else if (pathname === '/api/settings') {
      Object.assign(settings, request.postDataJSON());
      result = { settings };
    } else if (pathname.endsWith('/checkins')) {
      const input = request.postDataJSON();
      checkins.push(input);
      const record = records.find((r) => pathname.includes('/' + r.id + '/'));
      if (record)
        Object.assign(record.members[0], {
          completed: input.completed,
          contribution: input.contribution ?? 0,
        });
      result = { ok: true };
    } else if (pathname === '/api/plans' && method === 'POST') {
      const input = request.postDataJSON();
      createdPlans.push({ input, key: request.headers()['idempotency-key'] });
      const record = {
        ...input,
        id: `created-plan-${createdPlans.length}`,
        members: [
          {
            uid: 'alice',
            displayName: 'Мұхаммад',
            completed: false,
            contribution: 0,
            rsvp: 'pending',
            updatedAt: null,
          },
        ],
      };
      records.push(record);
      result = { plan: plans(selectedDate).at(-1) };
    } else if (pathname === '/api/friends/invitations')
      result = {
        token: 'one-use-fixture-token',
        expiresAt: new Date(Date.now() + 604800000).toISOString(),
      };
    else result = { ok: true };
    await route.fulfill({ json: result });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Бүгін', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page.screenshot({ path: path.join(output, 'home-kk.png'), fullPage: true });
  if (process.env.PLAYWRIGHT_COLD_MAP === '1') {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.getByRole('button', { name: 'Профиль', exact: true }).click();
    await page.getByRole('button', { name: 'Баптаулар', exact: true }).first().click();
    await page.getByRole('button', { name: 'Офлайн карталар Астана', exact: true }).click();
    await page.getByRole('button', { name: 'Жүктеу', exact: true }).click();
    await expect(page.getByText('Құрылғыда сақталған', { exact: true })).toBeVisible({
      timeout: 90000,
    });
    expect(
      await page.evaluate(() =>
        performance.getEntriesByType('resource').some((r) => /MapScreen.*\.js/.test(r.name)),
      ),
    ).toBe(false);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Артқа', exact: true }).click();
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Карта', exact: true }).click();
    await expect(page.locator('.dp-map-pin').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.dp-map-loading')).toHaveCount(0);
    await expect
      .poll(() =>
        page.locator('.dp-map-canvas').evaluate((el) => el.getBoundingClientRect().height),
      )
      .toBeGreaterThan(250);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(output, 'map-cold-offline-kk.png') });
    await context.setOffline(false);
    await expect(page.locator('.offline-banner')).toHaveCount(0);
    await page.getByRole('button', { name: 'Нұржолмен серуен', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'map-kk.png') });
    await page.getByRole('button', { name: '3D', exact: true }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(output, 'map-3d-kk.png') });
    await page.getByRole('button', { name: 'Профиль', exact: true }).click();
    await page.getByRole('button', { name: 'Баптаулар', exact: true }).first().click();
    await page.getByRole('button', { name: 'Безендіру Қараңғы', exact: true }).click();
    await page.getByRole('button', { name: 'Жарық', exact: true }).click();
    await page.getByRole('button', { name: 'Артқа', exact: true }).click();
    await page.getByRole('button', { name: 'Карта', exact: true }).click();
    await expect(page.locator('.dp-map-screen')).toHaveAttribute('data-map-theme', 'light');
    await expect(page.locator('.dp-map-pin').first()).toBeVisible();
    await page.getByRole('button', { name: 'Нұржолмен серуен', exact: true }).click();
    if (await page.locator('.toast button').count()) await page.locator('.toast button').click();
    await page.screenshot({ path: path.join(output, 'map-light-kk.png') });
    await page.getByRole('button', { name: 'Профиль', exact: true }).click();
    await page.getByRole('button', { name: 'Баптаулар', exact: true }).first().click();
    await page.getByRole('button', { name: 'Безендіру Жарық', exact: true }).click();
    await page.getByRole('button', { name: 'Қараңғы', exact: true }).click();
    await page.getByRole('button', { name: 'Артқа', exact: true }).click();
    await page.getByRole('button', { name: 'Бүгін', exact: true }).click();
  }
  await context.setOffline(true);
  await expect(page.getByText('Интернет жоқ', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Орындалды деп белгілеу: Мешітте намаз оқу', exact: true })
    .click();
  await expect(page.getByText('1 өзгеріс жіберілмеді', { exact: true })).toBeVisible();
  expect(checkins).toHaveLength(0);
  await context.setOffline(false);
  await expect(page.getByText('1 өзгеріс жіберілмеді', { exact: true })).toHaveCount(0);
  await expect.poll(() => checkins.length).toBe(1);
  expect(checkins[0].operationId).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Жаңа жоспар', exact: true }).click();
  await page.getByLabel('Атауы', { exact: true }).fill('Тест: бірге кітап оқу');
  await page.getByRole('button', { name: 'Сақтау', exact: true }).click();
  await expect(page.getByText('Тест: бірге кітап оқу', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Жаңа жоспар', exact: true }).click();
  await page.getByLabel('Атауы', { exact: true }).fill('Офлайн ортақ жоспар');
  await page.getByRole('checkbox', { name: /Айдос/ }).check();
  await page.getByRole('button', { name: 'Сақтау', exact: true }).click();
  await expect(page.getByText('1 өзгеріс жіберілмеді', { exact: true })).toBeVisible();
  expect(createdPlans).toHaveLength(1);
  await page.getByText('1 өзгеріс жіберілмеді', { exact: true }).click();
  await expect(page.getByText('Офлайн ортақ жоспар', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'offline-queue-kk.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await context.setOffline(false);
  await expect.poll(() => createdPlans.length).toBe(2);
  expect(createdPlans[1].input.memberIds).toEqual(['bob']);
  expect(createdPlans[1].key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByText('Офлайн ортақ жоспар', { exact: true })).toBeVisible();
  await page.getByText('Тест: бірге кітап оқу', { exact: true }).click();
  await page.getByRole('button', { name: 'Жою', exact: true }).click();
  await expect(page.locator('[role=dialog]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('[role=dialog]')).toHaveCount(1);
  expect(await page.getByRole('dialog').getAttribute('aria-hidden')).toBeNull();
  await page.keyboard.press('Escape');
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Профиль', exact: true }).click();
  if (await page.locator('.toast button').count()) await page.locator('.toast button').click();
  await page.screenshot({ path: path.join(output, 'profile-kk.png'), fullPage: true });
  await page.getByRole('button', { name: 'Баптаулар', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Баптаулар', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'settings-kk.png'), fullPage: true });
  await page.getByRole('button', { name: 'Тіл Қазақша', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Русский', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Настройки', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'settings-ru.png'), fullPage: true });
  await page.getByRole('button', { name: /^Тихие часы/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await context.close();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          'login/register/localization',
          'password mismatch validation',
          'home/profile/settings layout',
          'offline checkin + reconnect idempotent sync',
          'create plan',
          'offline shared-plan queue and UUID replay',
          'language persistence',
          'nested modal Escape isolation',
          ...(process.env.PLAYWRIGHT_COLD_MAP === '1'
            ? [
                'Settings-only map download then first Map open offline',
                'real map in production app + Settings theme propagation',
              ]
            : []),
        ],
        screenshots: output,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
