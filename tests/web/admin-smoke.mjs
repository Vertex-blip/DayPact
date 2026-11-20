/** Local browser integration checks. Every account and API response is a test-only fixture. */
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5179';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw new Error('Admin fixtures may only run against a local development server.');
const output = path.join(root, 'test-results', 'admin-smoke');
await mkdir(output, { recursive: true });
const localConfig =
  process.env.PLAYWRIGHT_USE_LOCAL_FIREBASE_CONFIG === '1'
    ? await readFile(path.join(root, '.env.local'), 'utf8')
    : '';
const key =
  localConfig
    .match(/^VITE_FIREBASE_API_KEY=(.+)$/m)?.[1]
    .trim()
    .replace(/^["']|["']$/g, '') ?? 'test-only-api-key';
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const errors = [];
const mutations = [];
const fixtureDate = new Date().toISOString();
function account(uid, name, extra = {}) {
  return {
    uid,
    email: `${uid}@example.test`,
    displayName: name,
    emailVerified: true,
    disabled: false,
    protected: uid === 'alice',
    appRegistered: true,
    createdAt: fixtureDate,
    lastSignInAt: fixtureDate,
    moderation: 'active',
    ...extra,
  };
}
async function fixture({
  locale = 'kk',
  theme = 'dark',
  setupRequired = false,
  unlocked = false,
  eligible = true,
} = {}) {
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    locale: locale === 'kk' ? 'kk-KZ' : 'ru-RU',
    colorScheme: theme,
    serviceWorkers: 'block',
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
        email: 'alice@example.test',
        displayName: 'Мұхаммад',
        phoneNumber: null,
        photoURL: null,
      },
    ],
    stsTokenManager: {
      refreshToken: 'test-refresh-token',
      accessToken: jwt,
      expirationTime: Date.now() + 3600000,
    },
    createdAt: String(Date.now()),
    lastLoginAt: String(Date.now()),
    apiKey: key,
    appName: '[DEFAULT]',
  };
  await context.addInitScript(
    ({ user, apiKey, locale }) => {
      localStorage.setItem('daypact.locale', locale);
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
    { user: firebaseUser, apiKey: key, locale },
  );
  const settings = {
    locale,
    theme,
    notificationsEnabled: false,
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
    createdAt: fixtureDate,
  };
  const state = {
    eligible,
    setupRequired,
    unlocked,
    expiresIn: 900000,
    setupExpiresIn: 600000,
    overviewDelay: 0,
    accounts: [
      account('alice', 'Мұхаммад'),
      account('bob', 'Айдос', { emailVerified: false }),
      account('carol', 'Аружан', { disabled: true, moderation: 'suspended' }),
    ],
    pendingActions: [
      { uid: 'carol', email: 'carol@example.test', action: 'restore', updatedAt: fixtureDate },
    ],
    tickets: [
      {
        id: 'ticket-1',
        userId: 'bob',
        category: 'help',
        subject: 'Кездесудің уақыты',
        message: 'Кездесу уақытын өзгертуге көмектесіңізші.',
        reply: '',
        status: 'open',
        createdAt: fixtureDate,
        updatedAt: fixtureDate,
        email: 'bob@example.test',
        displayName: 'Айдос',
      },
    ],
    ownTickets: [
      {
        id: 'own-ticket',
        userId: 'alice',
        category: 'help',
        subject: 'Карта туралы сұрақ',
        message: 'Картаны қалай жүктеуге болатынын айтыңызшы.',
        reply: 'Профильдегі офлайн карталар бөлімін ашыңыз.',
        status: 'closed',
        createdAt: fixtureDate,
        updatedAt: fixtureDate,
      },
    ],
  };
  await context.route('https://identitytoolkit.googleapis.com/**', (route) =>
    route.fulfill({
      json: route.request().url().includes('signInWithPassword')
        ? {
            localId: 'alice',
            email: 'alice@example.test',
            idToken: jwt,
            refreshToken: 'test-refresh-token',
            expiresIn: '3600',
            registered: true,
          }
        : {
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
  await context.route('https://securetoken.googleapis.com/**', (route) =>
    route.fulfill({
      json: {
        user_id: 'alice',
        access_token: jwt,
        id_token: jwt,
        refresh_token: 'test-refresh-token',
        expires_in: '3600',
        token_type: 'Bearer',
      },
    }),
  );
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      pathname = url.pathname,
      method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();
    const fail = (code, status = 401) => route.fulfill({ status, json: { error: { code } } });
    let result;
    if (pathname === '/api/admin/access')
      result = state.eligible
        ? {
            eligible: true,
            setupRequired: state.setupRequired,
            unlocked: state.unlocked,
            expiresAt: new Date(Date.now() + state.expiresIn).toISOString(),
          }
        : { eligible: false };
    else if (pathname === '/api/admin/security/setup')
      result = {
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUri: 'otpauth://totp/TestOnly?secret=JBSWY3DPEHPK3PXP',
        expiresAt: new Date(Date.now() + state.setupExpiresIn).toISOString(),
      };
    else if (
      pathname === '/api/admin/security/unlock' ||
      pathname === '/api/admin/security/confirm'
    ) {
      if (body.code !== '123456') return fail('ADMIN_CODE_INVALID');
      state.unlocked = true;
      state.setupRequired = false;
      result = { unlocked: true, expiresAt: new Date(Date.now() + state.expiresIn).toISOString() };
    } else if (pathname === '/api/admin/security/lock') {
      state.unlocked = false;
      result = { ok: true };
    } else if (pathname.startsWith('/api/admin/') && !state.unlocked)
      return fail('ADMIN_UNLOCK_REQUIRED');
    else if (pathname === '/api/admin/overview') {
      if (state.overviewDelay)
        await new Promise((resolve) => setTimeout(resolve, state.overviewDelay));
      result = {
        appUsers: 3,
        newUsers7Days: 2,
        suspendedUsers: 1,
        openTickets: 1,
        plans: 7,
        databaseBytes: 122880,
        databaseLimitBytes: 524288000,
        pushConfigured: true,
        accountManagementConfigured: true,
        push: { pending: 2, delivered: 24, skipped: 1, failed: 1 },
        recentPushFailures: [
          {
            id: 'push-1',
            userId: 'bob',
            kind: 'reminder',
            state: 'failed',
            attempts: 3,
            createdAt: fixtureDate,
          },
        ],
      };
    } else if (pathname === '/api/admin/users') {
      const query = url.searchParams.get('query');
      const all = query
        ? state.accounts.filter((u) => u.email === query || u.uid === query)
        : state.accounts;
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      result = {
        users: all.slice(offset, offset + 2),
        nextPageToken: offset + 2 < all.length ? String(offset + 2) : null,
        pendingActions: state.pendingActions,
      };
    } else if (/\/api\/admin\/users\/[^/]+\/action$/.test(pathname)) {
      const uid = decodeURIComponent(pathname.split('/')[4]);
      const target = state.accounts.find((u) => u.uid === uid);
      if (!target) return fail('ACCOUNT_NOT_FOUND', 404);
      if (target.protected) return fail('ADMIN_OWNER_PROTECTED', 403);
      if (body.confirmEmail !== target.email) return fail('ADMIN_CONFIRMATION_REQUIRED', 400);
      mutations.push({ uid, ...body });
      if (body.action === 'delete') state.accounts = state.accounts.filter((u) => u.uid !== uid);
      else {
        target.disabled = body.action === 'suspend';
        target.moderation = target.disabled ? 'suspended' : 'active';
      }
      state.pendingActions = state.pendingActions.filter((a) => a.uid !== uid);
      result = { ok: true };
    } else if (pathname === '/api/admin/support') result = { tickets: state.tickets };
    else if (pathname.startsWith('/api/admin/support/') && method === 'PATCH') {
      const target = state.tickets.find((ticket) => ticket.id === pathname.split('/').at(-1));
      Object.assign(target, body);
      mutations.push({ ticket: target.id, ...body });
      result = { ok: true };
    } else if (pathname === '/api/admin/audit')
      result = {
        events: [
          {
            id: 'audit-1',
            actorUid: 'alice',
            targetUid: 'bob',
            action: 'user.suspend',
            outcome: 'success',
            createdAt: fixtureDate,
          },
          {
            id: 'audit-2',
            actorUid: 'alice',
            targetUid: null,
            action: 'security.unlock',
            outcome: 'success',
            createdAt: fixtureDate,
          },
        ],
      };
    else if (pathname === '/api/support' && method === 'GET')
      result = { tickets: state.ownTickets };
    else if (pathname === '/api/support' && method === 'POST') {
      const ticket = {
        id: 'new-ticket',
        userId: 'alice',
        ...body,
        reply: '',
        status: 'open',
        createdAt: fixtureDate,
        updatedAt: fixtureDate,
      };
      state.ownTickets.unshift(ticket);
      result = { ticket };
    } else if (pathname === '/api/me') result = { profile };
    else if (pathname === '/api/plans') result = { plans: [] };
    else if (pathname === '/api/friends') result = { friends: [] };
    else if (pathname === '/api/meetings') result = { meetings: [] };
    else if (pathname === '/api/notifications') result = { notifications: [] };
    else if (pathname === '/api/settings') {
      Object.assign(settings, body);
      result = { settings };
    } else result = { ok: true };
    await route.fulfill({ json: result });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await expect(
    page.getByRole('heading', { name: locale === 'kk' ? 'Бүгін' : 'Сегодня', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Профиль', exact: true }).click();
  return { context, page, state };
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}
async function unlock(page, locale = 'kk', code = '123456') {
  await page.locator('input[name="password"]').fill('test-only-password');
  await page.locator('input[name="code"]').fill(code);
  await page
    .getByRole('button', { name: locale === 'kk' ? 'Панельді ашу' : 'Открыть панель', exact: true })
    .click();
}
try {
  const { context, page, state } = await fixture();
  await page.getByRole('button', { name: 'Админ-панель', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Қауіпсіз кіру' })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'security-kk-dark.png'), fullPage: true });
  await unlock(page, 'kk', '000000');
  await expect(page.getByRole('alert')).toContainText('Код дұрыс емес');
  await expect(page.locator('input[name="password"]')).toHaveValue('');
  await unlock(page);
  await expect(page.getByText('База көлемі', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'overview-kk-dark.png'), fullPage: true });
  await noOverflow(page);
  await page.locator('.admin-tabs').getByRole('button', { name: 'Қолданушылар' }).click();
  await expect(page.locator('.admin-user-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Әкімші', exact: true })).toBeDisabled();
  await expect(page.getByText('Пошта расталмаған', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'users-kk-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Келесі бет', exact: true }).click();
  await expect(page.locator('.admin-user-card')).toHaveCount(1);
  await expect(page.locator('.admin-user-card')).toContainText('Аружан');
  await page.getByRole('button', { name: 'Алдыңғы бет', exact: true }).click();
  await page.getByLabel('Email немесе UID').fill('bob@example.test');
  await page.getByRole('button', { name: 'Іздеу', exact: true }).click();
  await expect(page.locator('.admin-user-card')).toHaveCount(1);
  await page
    .locator('.admin-user-card')
    .getByRole('button', { name: 'Басқару', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Уақытша бұғаттау', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByLabel('Растау үшін аккаунттың email мекенжайын енгіз')
    .fill('wrong@example.test');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Уақытша бұғаттау', exact: true })
    .click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('email');
  expect(mutations).toHaveLength(0);
  await page
    .getByRole('dialog')
    .getByLabel('Растау үшін аккаунттың email мекенжайын енгіз')
    .fill('bob@example.test');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Уақытша бұғаттау', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.admin-user-card')).toContainText('Бұғатталған');
  await page
    .locator('.admin-user-card')
    .getByRole('button', { name: 'Басқару', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Қайта қосу', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Растау үшін аккаунттың email мекенжайын енгіз')
    .fill('bob@example.test');
  await page.getByRole('dialog').getByRole('button', { name: 'Қайта қосу', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.admin-user-card')).toContainText('Белсенді');
  await page
    .locator('.admin-user-card')
    .getByRole('button', { name: 'Басқару', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Біржола жою', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('жаңа аккаунт ашуға болады');
  await page.screenshot({
    path: path.join(output, 'delete-confirmation-kk-dark.png'),
    fullPage: true,
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Бас тарту', exact: true }).click();
  expect(state.accounts.some((u) => u.uid === 'bob')).toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: 'Біржола жою', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Растау үшін аккаунттың email мекенжайын енгіз')
    .fill('bob@example.test');
  await page.getByRole('dialog').getByRole('button', { name: 'Біржола жою', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Аккаунттар табылмады', { exact: true })).toBeVisible();
  expect(mutations.map((m) => m.action)).toEqual(['suspend', 'restore', 'delete']);
  await page.getByRole('button', { name: 'Қайта орындау', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Растау үшін аккаунттың email мекенжайын енгіз')
    .fill('carol@example.test');
  await page.getByRole('dialog').getByRole('button', { name: 'Қайта қосу', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Аяқталмаған әрекеттер', { exact: true })).toHaveCount(0);
  await page.locator('.admin-tabs').getByRole('button', { name: 'Өтініштер' }).click();
  await page.getByRole('button', { name: /Кездесудің уақыты/ }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Әкімші жауабы')
    .fill('Кездесуді ашып, уақытын өзгертіңіз.');
  await page.getByRole('dialog').locator('select[name="status"]').selectOption('closed');
  await page.getByRole('dialog').getByRole('button', { name: 'Сақтау', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.admin-ticket-card')).toContainText('Жабық');
  await page.locator('.admin-tabs').getByRole('button', { name: 'Пуштар' }).click();
  await expect(page.getByText('Қызмет қабылдады', { exact: true })).toBeVisible();
  await page.locator('.admin-tabs').getByRole('button', { name: 'Әрекеттер' }).click();
  await expect(page.locator('.admin-log-row').filter({ hasText: 'Панельді ашу' })).toBeVisible();
  await page.getByRole('button', { name: 'Панельді құлыптау', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Қауіпсіз кіру' })).toBeVisible();
  await expect(
    page.locator('.admin-user-card, .admin-metrics, .admin-ticket-card, .admin-log-row'),
  ).toHaveCount(0);
  state.expiresIn = 500;
  state.overviewDelay = 900;
  await unlock(page);
  await expect(page.getByRole('alert')).toContainText('сессиясы аяқталды');
  await expect(page.locator('.admin-metrics')).toHaveCount(0);
  await page.waitForTimeout(1000);
  await expect(page.locator('.admin-metrics')).toHaveCount(0);
  await page.getByRole('button', { name: 'Артқа', exact: true }).click();
  await page.getByRole('button', { name: 'Көмек және қолдау', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Көмек және қолдау' })).toBeVisible();
  await page.getByLabel('Тақырып', { exact: true }).fill('Тест өтініші');
  await page
    .getByLabel('Хабарлама', { exact: true })
    .fill('Қолданбадағы кездесулер туралы сұрақ бар.');
  await page.getByRole('button', { name: 'Жіберу', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Өтініш жіберілді');
  await page.getByRole('button', { name: /Карта туралы сұрақ/ }).click();
  await expect(page.getByRole('dialog')).toContainText('офлайн карталар');
  await page.getByRole('dialog').getByRole('button', { name: 'Жабу', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'support-kk-dark.png'), fullPage: true });
  await noOverflow(page);
  await context.close();

  const ru = await fixture({ locale: 'ru', theme: 'light', setupRequired: true });
  await ru.page.getByRole('button', { name: 'Админ-панель', exact: true }).click();
  await expect(ru.page.getByRole('heading', { name: 'Второй шаг защиты' })).toBeVisible();
  await ru.page.locator('input[name="password"]').fill('test-only-password');
  await ru.page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(ru.page.getByRole('heading', { name: 'Добавь в аутентификатор' })).toBeVisible();
  await ru.page.locator('input[name="code"]').fill('123456');
  await ru.page.getByRole('button', { name: 'Подтвердить и открыть', exact: true }).click();
  await expect(ru.page.getByText('Объём базы', { exact: true })).toBeVisible();
  await ru.page.screenshot({ path: path.join(output, 'overview-ru-light.png'), fullPage: true });
  await noOverflow(ru.page);
  await ru.page.locator('.admin-tabs').getByRole('button', { name: 'Пользователи' }).click();
  await expect(ru.page.locator('.admin-user-card')).toHaveCount(2);
  await ru.page.setViewportSize({ width: 375, height: 812 });
  await noOverflow(ru.page);
  await ru.page.screenshot({ path: path.join(output, 'users-ru-light.png'), fullPage: true });
  await ru.context.setOffline(true);
  await expect(ru.page.locator('.admin-page')).toHaveCount(0);
  await ru.context.close();

  const expiring = await fixture({ setupRequired: true });
  expiring.state.setupExpiresIn = 400;
  await expiring.page.getByRole('button', { name: 'Админ-панель', exact: true }).click();
  await expiring.page.locator('input[name="password"]').fill('test-only-password');
  await expiring.page.getByRole('button', { name: 'Жалғастыру', exact: true }).click();
  await expect(expiring.page.getByRole('alert')).toContainText(
    'Кілттің жарамдылық уақыты аяқталды',
  );
  await expect(expiring.page.locator('.admin-setup-key')).toHaveCount(0);
  await expiring.context.close();

  for (const [locale, theme] of [
    ['kk', 'light'],
    ['ru', 'dark'],
  ]) {
    const visual = await fixture({ locale, theme, unlocked: true });
    await visual.page.setViewportSize({ width: 375, height: 812 });
    await visual.page.getByRole('button', { name: 'Админ-панель', exact: true }).click();
    await expect(visual.page.locator('.admin-metrics')).toBeVisible();
    await noOverflow(visual.page);
    await visual.page.screenshot({
      path: path.join(output, `overview-${locale}-${theme}-375.png`),
      fullPage: true,
    });
    await visual.context.close();
  }

  const ordinary = await fixture({ eligible: false });
  await expect(
    ordinary.page.getByRole('button', { name: 'Админ-панель', exact: true }),
  ).toHaveCount(0);
  await ordinary.context.close();
  expect(errors).toEqual([]);
  console.log(
    'Admin UI passed: password + MFA, setup expiry, server session expiry/late response, exact search/pagination, owner protection, suspend/restore/delete confirmations, pending retry, support/reply, push/audit, KK/RU, dark/light, mobile overflow, offline/non-owner gate. Fixtures only.',
  );
} finally {
  await browser.close();
}
