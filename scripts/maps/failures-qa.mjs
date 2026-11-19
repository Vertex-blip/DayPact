import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.MAP_QA_URL ?? 'http://127.0.0.1:5179/';
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const cachedArchive = (page) =>
  page.evaluate(async () => {
    const c = await caches.open('daypact-public-map-v1');
    return (await c.keys()).some((r) => r.url.endsWith('.pmtiles'));
  });
try {
  const broken = await browser.newContext();
  const p = await broken.newPage();
  const bytes = await readFile('public/maps/astana-20261117.pmtiles');
  bytes[0] ^= 1;
  await broken.route('**/*.pmtiles', (route) =>
    route.fulfill({ status: 200, contentType: 'application/octet-stream', body: bytes }),
  );
  await p.goto(base);
  await p.getByText('Жүктелген файл толық емес.', { exact: false }).waitFor({ timeout: 20000 });
  assert.equal(await cachedArchive(p), false, 'A hash mismatch must never enter the offline cache');
  await broken.close();
  console.log('PASS: corrupt archive rejected before caching');

  const cancelled = await browser.newContext();
  const c = await cancelled.newPage();
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let reached;
  const requested = new Promise((resolve) => {
    reached = resolve;
  });
  await cancelled.route('**/*.pmtiles', async (route) => {
    reached();
    await hold;
    await route.abort().catch(() => {});
  });
  await c.goto(base);
  await requested;
  await c.getByRole('button', { name: 'Болдырмау', exact: true }).click();
  await c.getByRole('button', { name: 'Картаны жүктеу', exact: false }).waitFor();
  assert.equal(await cachedArchive(c), false, 'Cancellation must not cache a partial archive');
  release();
  await cancelled.close();
  console.log('PASS: download cancellation stops without partial cache');

  const quota = await browser.newContext();
  await quota.addInitScript(() =>
    Object.defineProperty(navigator.storage, 'estimate', {
      value: async () => ({ quota: 1, usage: 0 }),
    }),
  );
  const q = await quota.newPage();
  let downloaded = false;
  q.on('request', (r) => {
    if (r.url().endsWith('.pmtiles')) downloaded = true;
  });
  await q.goto(base);
  await q.getByText('Құрылғыда бос орын жеткіліксіз.', { exact: false }).waitFor();
  assert.equal(downloaded, false, 'Quota check prevents wasteful download');
  await quota.close();
  console.log('PASS: insufficient storage explained before downloading');
} finally {
  await browser.close();
}
