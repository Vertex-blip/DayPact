import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.MAP_QA_URL ?? 'http://127.0.0.1:5179/';
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  viewport: { width: 430, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const errors = [],
  requests = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('request', (r) => {
  if (r.url().includes('/maps/') || r.url().includes('/map-assets/')) requests.push(r.url());
});
page.on('requestfailed', (r) => console.log('request failed', r.url(), r.failure()?.errorText));
try {
  await page.goto(base);
  await page.locator('.dp-map-pin').waitFor({ timeout: 60000 });
  await page.waitForTimeout(7000);
  await mkdir('scripts/maps/.qa', { recursive: true });
  await page.locator('.dp-map-screen').screenshot({ path: 'scripts/maps/.qa/map-kk.png' });
  console.log(
    JSON.stringify({
      phase: 'render',
      errors,
      packageRequests: requests.length,
      archiveRequests: requests.filter((u) => u.endsWith('.pmtiles')).length,
      body: (await page.locator('body').innerText()).slice(0, 900),
    }),
  );
  if (errors.length) throw new Error('Map console errors: ' + errors.join(' | '));
  await page.getByRole('textbox', { name: 'Орын немесе жоспар іздеу' }).fill('Бәйтерек');
  await page.waitForTimeout(300);
  console.log('search', await page.locator('.dp-map-results').innerText());
  await page.locator('.dp-map-results button').nth(1).click();
  await page.getByRole('textbox', { name: 'Картадағы орын' }).fill('Жеке орын QA');
  await page.getByRole('button', { name: 'Сақтау', exact: true }).click();
  await page.getByRole('button', { name: 'Сақталғандар', exact: true }).click();
  await page.locator('.dp-map-saved-list button').filter({ hasText: 'Жеке орын QA' }).waitFor();
  await page.getByRole('button', { name: 'User', exact: true }).click();
  await page.getByText('Сақталған орындар әзірге жоқ.', { exact: false }).waitFor();
  assert.equal(
    await page.locator('.dp-map-saved-list button').count(),
    0,
    'Another user cannot see saved places',
  );
  await page.getByRole('button', { name: 'User', exact: true }).click();
  await page.locator('.dp-map-saved-list button').filter({ hasText: 'Жеке орын QA' }).waitFor();
  await page.getByRole('button', { name: 'Ортақ жоспарлар', exact: true }).click();
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await page.getByRole('button', { name: 'KK / RU' }).click();
  assert.equal(
    await page.locator('.dp-user-location').count(),
    0,
    'Location is never requested automatically',
  );
  await context.grantPermissions(['geolocation'], { origin: new URL(base).origin });
  await context.setGeolocation({ latitude: 51.1282, longitude: 71.4304, accuracy: 7 });
  await page.getByRole('button', { name: 'Моё местоположение', exact: true }).click();
  await page.locator('.dp-user-location').waitFor();
  await page.getByText('Точность ±7 м', { exact: false }).waitFor();
  await page.waitForTimeout(1500);
  await page.locator('.dp-map-screen').screenshot({ path: 'scripts/maps/.qa/map-ru.png' });
  await page.getByRole('button', { name: 'Settings / map' }).click();
  await page.getByRole('button', { name: 'Settings / map' }).click();
  await page.locator('.dp-map-pin').waitFor({ timeout: 10000 });
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Settings / map' }).click();
  await page.getByRole('button', { name: 'Settings / map' }).click();
  await page.locator('.dp-map-pin').waitFor({ timeout: 10000 });
  await page.waitForTimeout(2500);
  await page.locator('.dp-map-screen').screenshot({ path: 'scripts/maps/.qa/map-offline.png' });
  await page.reload();
  await page.locator('.dp-map-pin').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Сақталғандар', exact: true }).click();
  await page.locator('.dp-map-saved-list button').filter({ hasText: 'Жеке орын QA' }).waitFor();
  await page.getByRole('button', { name: 'Ортақ жоспарлар', exact: true }).click();
  await page.locator('.maplibregl-canvas').click({ position: { x: 70, y: 430 } });
  await page.getByRole('textbox', { name: 'Картадағы орын' }).fill('Офлайн орын QA');
  await page.getByRole('button', { name: 'Сақтау', exact: true }).click();
  await page.getByRole('button', { name: 'Сақталғандар', exact: true }).click();
  await page.locator('.dp-map-saved-list button').filter({ hasText: 'Офлайн орын QA' }).waitFor();
  assert.equal(
    requests.filter((u) => u.endsWith('.pmtiles')).length,
    1,
    'Offline map never downloads per tile',
  );
  assert.deepEqual(errors, [], 'Online and offline map render without browser errors');
  const races = await page.evaluate(async () => {
    const s = window.daypactMapQa.savedPlaces,
      uid = 'qa-logout-race';
    const point = { lat: 51.1282, lng: 71.4304, label: 'Race test' };
    s.activateSavedPlaceSession(uid);
    const oldSave = s.savePlace(uid, point).then(
      () => false,
      () => true,
    );
    const logout = s.clearSavedPlaces(uid);
    s.activateSavedPlaceSession(uid);
    const newSave = s.savePlace(uid, { ...point, label: 'New session' });
    const [oldRejected] = await Promise.all([oldSave, logout, newSave]);
    const values = await s.listSavedPlaces(uid);
    await s.clearSavedPlaces(uid);
    return {
      oldRejected,
      labels: values.map((p) => p.label),
      closedCount: (await s.listSavedPlaces(uid)).length,
    };
  });
  assert.equal(races.oldRejected, true, 'A pending pre-logout save must be rejected');
  assert.deepEqual(
    races.labels,
    ['New session'],
    'Fast relogin waits for old-session cleanup before saving',
  );
  assert.equal(races.closedCount, 0, 'Closed session cannot read places');
  console.log(
    JSON.stringify({
      phase: 'offline',
      errors,
      archiveRequests: requests.filter((u) => u.endsWith('.pmtiles')).length,
      body: (await page.locator('body').innerText()).slice(0, 800),
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      phase: 'failure',
      errors,
      body: await page.locator('body').innerText(),
      cache: await page.evaluate(async () => {
        const result = {};
        for (const n of await caches.keys()) {
          const c = await caches.open(n);
          result[n] = await Promise.all(
            (await c.keys())
              .filter((r) => r.url.includes('/assets/'))
              .map(async (r) => ({
                url: r.url,
                requestOrigin: r.headers.get('Origin'),
                vary: (await c.match(r))?.headers.get('Vary'),
              })),
          );
        }
        return result;
      }),
    }),
  );
  await page.screenshot({ path: 'scripts/maps/.qa/failure.png' });
  throw error;
} finally {
  await browser.close();
}
