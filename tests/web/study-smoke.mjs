/** Isolated, local-only browser regression against real StudyScreen, API and IndexedDB modules. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudySeed } from '../fixtures/study.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5236';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw new Error('Local fixtures only');
const output = path.join(root, 'test-results', 'study');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const results = [],
  errors = [];
const passed = (name) => {
  results.push(name);
  console.log(name);
};
const context = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 1,
  locale: 'kk-KZ',
  colorScheme: 'dark',
});
let doc = { ...createStudySeed(), version: 1, updatedAt: '2026-11-23T12:00:00.000Z' },
  conflict = false,
  authFailure = false,
  reads = 0,
  writes = 0;
await context.route('**/src/web/main.tsx*', (route) =>
  route.fulfill({
    contentType: 'application/javascript',
    body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import StudyScreen from '/src/web/study/StudyScreen.tsx';
import {activatePrivateSession,isPrivateSessionPaused,loadStudyCache} from '/src/web/offline.ts';
import '/src/web/styles.css';
window.__testUid='study-fixture-user';
activatePrivateSession(window.__testUid);
let props={uid:window.__testUid,locale:'kk',online:true};
const root=ReactDOM.createRoot(document.getElementById('root'));
function render(){root.render(React.createElement(React.StrictMode,null,React.createElement('main',{className:'app-shell'},React.createElement(StudyScreen,{...props,onAuthError:()=>{window.__authErrors=(window.__authErrors??0)+1;}}))));}
window.studyHarness={setProps(p){props={...props,...p};render();},async paused(){return isPrivateSessionPaused(props.uid);},async cached(){return loadStudyCache(props.uid);},unmount(){root.unmount();}};
render();`,
  }),
);
await context.route('**/src/web/firebase.ts*', (route) =>
  route.fulfill({
    contentType: 'application/javascript',
    body: `export function currentAuth(){return {currentUser:window.__testUid?{uid:window.__testUid,getIdToken:async()=> 'fixture-token'}:null};}`,
  }),
);
await context.route('**/api/study', async (route) => {
  if (authFailure) {
    await route.fulfill({ status: 403, json: { error: { code: 'ACCOUNT_SUSPENDED' } } });
    return;
  }
  if (route.request().method() === 'GET') {
    reads++;
    await route.fulfill({ json: { study: doc } });
    return;
  }
  writes++;
  const body = route.request().postDataJSON();
  if (conflict || body.version !== (doc?.version ?? 0)) {
    conflict = false;
    await route.fulfill({ status: 409, json: { error: { code: 'VERSION_CONFLICT' } } });
    return;
  }
  doc = { ...body.data, version: (doc?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
  await route.fulfill({ json: { study: doc } });
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
const dialog = () => page.getByRole('dialog');
const close = async () => {
  await dialog()
    .getByRole('button', { name: /^(Жабу|Закрыть)$/ })
    .click();
};
const save = async () => {
  await dialog().getByRole('button', { name: 'Сақтау', exact: true }).click();
  await expect(dialog()).toHaveCount(0);
};
const chooseDate = async (value) => {
  await page.getByLabel('Күнді таңдау', { exact: true }).fill(value);
};
const noOverflow = async () =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
try {
  await page.clock.install({ time: new Date('2026-11-23T09:00:00Z') });
  await page.goto(base);
  await expect(page.getByTestId('study-full-schedule')).toBeVisible();
  await expect(page.locator('.study-full-day')).toHaveCount(7);
  await expect(page.getByRole('button', { name: 'Толық', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  for (const title of new Set(doc.lessons.map((item) => item.title)))
    await expect(page.getByTestId('study-full-schedule')).toContainText(title);
  await expect(page.locator('.study-full-day').first()).toContainText('08:00');
  await expect(page.locator('.study-full-day').first()).toContainText('A1.1.101');
  await expect(page.locator('.study-full-row')).toHaveCount(14);
  await page.getByLabel('Пән, кабинет немесе оқытушы').fill('A1.1.808');
  await expect(page.locator('.study-lesson')).toHaveCount(2);
  await page.getByRole('button', { name: 'Тазарту', exact: true }).click();
  await expect(page.locator('.study-full-day')).toHaveCount(7);
  const original = structuredClone(doc);
  doc = {
    ...doc,
    lessons: doc.lessons.filter((item) => item.format !== 'online'),
    version: doc.version + 1,
  };
  await page.getByRole('button', { name: 'Оқу баптаулары', exact: true }).click();
  await dialog().getByRole('button', { name: 'Жаңарту', exact: true }).click();
  await expect(page.locator('.study-full-row')).toHaveCount(13);
  await expect(page.locator('.study-full-row .is-online')).toHaveCount(0);
  await expect(
    page.locator('.study-full-day').first().locator('.study-full-row').first(),
  ).toContainText('13:05');
  await expect(page.locator('.study-full-day').nth(2)).toContainText('Кесте толық емес');
  await expect(page.locator('.study-full-day').nth(5).locator('.study-full-row')).toHaveCount(0);
  await noOverflow();
  await page.screenshot({ path: path.join(output, 'full-430-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await noOverflow();
  await page.screenshot({ path: path.join(output, 'full-375-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow();
  await page.evaluate(() => window.studyHarness.setProps({ locale: 'ru' }));
  await expect(page.getByRole('button', { name: 'Полностью', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await noOverflow();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.screenshot({ path: path.join(output, 'full-375-light-ru.png'), fullPage: true });
  await page.evaluate(() => {
    window.studyHarness.setProps({ locale: 'kk' });
    document.documentElement.dataset.theme = 'dark';
  });
  await page.setViewportSize({ width: 430, height: 932 });
  doc = { ...original, version: doc.version + 1 };
  await page.getByRole('button', { name: 'Оқу баптаулары', exact: true }).click();
  await dialog().getByRole('button', { name: 'Жаңарту', exact: true }).click();
  await expect(page.locator('.study-full-row')).toHaveCount(14);
  passed(
    'Full schedule defaults open: all times/subjects/rooms, search, no-online dataset, 430/375/320px and KK/RU',
  );
  await page.getByRole('button', { name: 'Апта', exact: true }).click();
  await expect(page.locator('.study-week-day')).toHaveCount(7);
  await expect(page.getByTestId('study-actual-status')).toContainText('7 желтоқсан');
  await expect(page.locator('.study-date-picker')).toContainText('Көрсетілген: 1-апта');
  await expect(page.locator('.study-week-day').first()).toContainText('9 сабақ');
  await expect(page.locator('.study-week-day').nth(2)).toContainText('Кесте толық емес');
  await expect(page.locator('.study-week-day').nth(5)).toContainText('11:00');
  await noOverflow();
  await page.screenshot({ path: path.join(output, 'week-430-dark.png'), fullPage: true });
  passed('Week overview, 7 days, pre-term status and incomplete days');

  await page.getByRole('button', { name: 'Аптаны толық ашу', exact: true }).click();
  await expect(page.locator('.study-week-day').nth(2).locator('.study-lesson')).toHaveCount(2);
  await expect(page.locator('.study-week-day').nth(5).locator('.study-lesson')).toHaveCount(0);
  await page.getByLabel('Пән, кабинет немесе оқытушы').fill('A1.1.808');
  await expect(page.locator('.study-lesson')).toHaveCount(2);
  await expect(page.locator('.study-result-date').first()).toContainText('Сәрсенбі');
  await page.getByRole('button', { name: 'Тазарту', exact: true }).click();
  await page.locator('.study-week-summary').first().click();
  await expect(page.locator('.study-lesson')).toHaveCount(5);
  await expect(page.locator('.study-next-card')).toContainText('08:00');
  await page.screenshot({ path: path.join(output, 'day-430-dark.png'), fullPage: true });
  passed('Full week, known-only partial day, search and grouped day lessons');

  await page.locator('.study-lesson').filter({ hasText: '13:05' }).click();
  await expect(dialog()).toContainText('A1.1.101');
  await dialog().getByRole('button', { name: 'Тек осы күнді өзгерту', exact: true }).click();
  await dialog().getByLabel('Басталуы', { exact: true }).fill('12:00');
  await dialog().getByLabel('Аяқталуы', { exact: true }).fill('12:50');
  await dialog().getByLabel('Кабинет', { exact: true }).fill('A1.TEST');
  await save();
  await expect(page.locator('.study-lesson').filter({ hasText: 'A1.TEST' })).toContainText(
    'Өзгертілген',
  );
  await page.getByRole('button', { name: 'Толық', exact: true }).click();
  await expect(page.locator('.study-full-row').filter({ hasText: 'A1.TEST' })).toContainText(
    '12:00',
  );
  await page.locator('.study-full-row').filter({ hasText: 'A1.TEST' }).click();
  await expect(dialog()).toContainText('A1.TEST');
  await close();
  await page.getByRole('button', { name: 'Күн', exact: true }).click();
  await chooseDate('2026-12-14');
  await expect(page.locator('.study-lesson').filter({ hasText: 'A1.TEST' })).toHaveCount(0);
  await expect(page.locator('.study-lesson').filter({ hasText: '13:05' })).toContainText(
    'A1.1.101',
  );
  await chooseDate('2026-12-07');
  await page.locator('.study-lesson').filter({ hasText: 'A1.TEST' }).click();
  await dialog().getByRole('button', { name: 'Тек осы күнді өзгерту', exact: true }).click();
  await dialog().getByLabel('Бұл күні сабақ болмайды').check();
  await save();
  await expect(page.locator('.study-lesson.is-cancelled')).toHaveCount(1);
  await page.getByRole('button', { name: 'Толық', exact: true }).click();
  await expect(page.locator('.study-full-row.is-cancelled')).toHaveCount(1);
  await page.getByRole('button', { name: 'Күн', exact: true }).click();
  await page.locator('.study-lesson.is-cancelled').click();
  await dialog().getByRole('button', { name: 'Тек осы күнді өзгерту', exact: true }).click();
  await dialog().getByRole('button', { name: 'Осы күнгі өзгерісті алып тастау' }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(page.locator('.study-lesson.is-cancelled')).toHaveCount(0);
  await expect(page.locator('.study-lesson').filter({ hasText: '13:05' })).toContainText(
    'A1.1.101',
  );
  passed('Dated room/time override, next-week isolation, cancellation and restore');

  await page.getByRole('button', { name: 'Сабақ қосу', exact: true }).click();
  await dialog().getByLabel('Пән атауы', { exact: true }).fill('Тест сабағы');
  await dialog().getByLabel('Апта күні', { exact: true }).selectOption('7');
  await dialog().getByLabel('Кабинет', { exact: true }).fill('NEW.101');
  await save();
  await chooseDate('2026-12-13');
  await expect(page.locator('.study-lesson')).toHaveCount(1);
  await page.locator('.study-lesson').click();
  await dialog().getByRole('button', { name: 'Тек осы күнді өзгерту', exact: true }).click();
  await dialog().getByLabel('Ескерту', { exact: true }).fill('Confirmed exception');
  await save();
  expect(doc.overrides).toHaveLength(1);
  await page.locator('.study-lesson').click();
  await dialog().getByRole('button', { name: 'Апталық кестені өзгерту', exact: true }).click();
  await dialog().getByLabel('Апта күні', { exact: true }).selectOption('6');
  const beforeWeekdayChange = writes;
  await dialog().getByRole('button', { name: 'Сақтау', exact: true }).click();
  await expect(dialog()).toBeVisible();
  expect(writes).toBe(beforeWeekdayChange);
  await dialog().getByRole('checkbox').check();
  await dialog().getByLabel('Пән атауы', { exact: true }).fill('Өзгерген сабақ');
  await save();
  expect(doc.overrides).toHaveLength(0);
  await expect(page.locator('.study-lesson')).toHaveCount(0);
  await chooseDate('2026-12-12');
  await expect(page.locator('.study-lesson')).toContainText('Өзгерген сабақ');
  await page.locator('.study-lesson').click();
  await dialog().getByRole('button', { name: 'Апталық кестені өзгерту', exact: true }).click();
  await dialog().getByRole('button', { name: 'Жою', exact: true }).click();
  await expect(dialog()).toBeVisible();
  await dialog().getByRole('button', { name: 'Иә, жою', exact: true }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(page.locator('.study-lesson')).toHaveCount(0);
  await page
    .locator('.study-incomplete')
    .getByRole('button', { name: 'Өзгерту', exact: true })
    .click();
  await dialog().getByRole('button', { name: 'Бұл күннің кестесі толық', exact: true }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(page.locator('.study-incomplete')).toHaveCount(0);
  passed('Weekly CRUD, explicit weekday-reset/delete confirmation and incomplete-day resolution');

  await page.getByRole('button', { name: 'Күнтізбе', exact: true }).click();
  await expect(page.locator('.study-period')).toHaveCount(4);
  await page.screenshot({ path: path.join(output, 'calendar-430-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Кезең қосу', exact: true }).click();
  await dialog().getByLabel('Кезең атауы', { exact: true }).fill('Consultation');
  await dialog().getByLabel('Басталу күні', { exact: true }).fill('2027-02-12');
  await dialog().getByLabel('Аяқталу күні', { exact: true }).fill('2027-02-12');
  await save();
  await expect(page.locator('.study-period')).toHaveCount(5);
  await page.getByRole('button', { name: 'Бос күн қосу', exact: true }).click();
  await dialog().getByLabel('Күннің атауы', { exact: true }).fill('Оқу демалысы');
  await dialog().getByLabel('Күнді таңдау', { exact: true }).fill('2026-12-08');
  await save();
  await page.getByRole('button', { name: 'Күн', exact: true }).click();
  await chooseDate('2026-12-08');
  await expect(page.locator('.study-lesson')).toHaveCount(0);
  await expect(page.locator('.study-day-note')).toContainText('Оқу демалысы');
  await page.getByRole('button', { name: 'Толық', exact: true }).click();
  await expect(page.locator('.study-full-day').nth(1).locator('.study-full-row')).toHaveCount(0);
  await expect(page.locator('.study-full-day').nth(1)).toContainText('Оқу демалысы');
  await page.getByRole('button', { name: 'Оқу баптаулары', exact: true }).click();
  await dialog()
    .getByRole('button', { name: /Сабақ еске салулары/ })
    .click();
  await dialog().getByLabel('Сабаққа дейін', { exact: true }).selectOption('10');
  await dialog().getByLabel('Пушта кабинет пен уақытты көрсету').check();
  await save();
  expect(doc.term.remindMinutes).toBe(10);
  expect(doc.term.roomInPush).toBe(true);
  passed('Academic period/holiday editing, holiday suppression and reminder privacy setting');

  await page.getByRole('button', { name: 'Апта', exact: true }).click();
  await chooseDate('2026-12-07');
  for (const [instant, label] of [
    ['2026-12-14T09:00:00Z', 'Қазір 2-апта'],
    ['2027-01-04T09:00:00Z', 'Midterm'],
    ['2027-02-08T09:00:00Z', 'Endterm'],
    ['2027-02-15T09:00:00Z', 'Finals'],
  ]) {
    await page.clock.setSystemTime(new Date(instant));
    await page.clock.runFor(30_100);
    await expect(page.getByTestId('study-actual-status')).toContainText(label);
    await expect(page.locator('.study-date-picker')).toContainText('Көрсетілген: 1-апта');
  }
  await expect(page.getByTestId('study-actual-status')).not.toContainText('11-апта');
  passed('Actual week 2 and Midterm/Endterm/Finals independent from browsed week');

  conflict = true;
  await page.getByRole('button', { name: 'Оқу баптаулары', exact: true }).click();
  await dialog()
    .getByRole('button', { name: /Сабақ еске салулары/ })
    .click();
  await dialog().getByLabel('Сабаққа дейін', { exact: true }).selectOption('15');
  await dialog().getByRole('button', { name: 'Сақтау', exact: true }).click();
  await expect(dialog().getByRole('alert')).toContainText('басқа құрылғыда');
  expect(doc.term.remindMinutes).toBe(10);
  await dialog().getByRole('button', { name: 'Жаңарту', exact: true }).click();
  await expect(dialog()).toHaveCount(0);
  passed('CAS conflict preserves server data and provides reload');

  await page.evaluate(() => window.studyHarness.setProps({ locale: 'ru' }));
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('heading', { name: 'Учёба', exact: true })).toBeVisible();
  await noOverflow();
  await page.screenshot({ path: path.join(output, 'week-375-light-ru.png'), fullPage: true });
  await page.getByRole('button', { name: 'День', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'day-375-light-ru.png'), fullPage: true });
  await page.getByRole('button', { name: 'Календарь', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'calendar-375-light-ru.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow();
  passed('430px/375px screenshots and 320px layout; KK/RU, dark/light');

  const before = reads;
  await page.evaluate(() => window.studyHarness.setProps({ online: false }));
  await expect(page.locator('.study-offline')).toBeVisible();
  await page.getByRole('button', { name: 'Неделя', exact: true }).click();
  await page.getByLabel('Выбрать дату', { exact: true }).fill('2027-02-08');
  await expect(page.locator('.study-week-day')).toHaveCount(7);
  await expect(page.getByRole('button', { name: 'Добавить занятие', exact: true })).toBeDisabled();
  expect(reads).toBe(before);
  passed('Whole-term offline navigation without network or writes');

  authFailure = true;
  await page.evaluate(() => window.studyHarness.setProps({ online: true }));
  await expect.poll(() => page.evaluate(() => window.__authErrors ?? 0)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.studyHarness.paused())).toBe(true);
  expect(
    await page.evaluate(async () => {
      try {
        await window.studyHarness.cached();
        return false;
      } catch (error) {
        return error.code === 'UNAUTHENTICATED';
      }
    }),
  ).toBe(true);
  await expect(page.locator('.study-week-day')).toHaveCount(0);
  await page.reload();
  await page.evaluate(() => window.studyHarness.setProps({ online: false }));
  await expect(page.locator('.study-week-day')).toHaveCount(0);
  await expect(page.locator('.study-lesson')).toHaveCount(0);
  expect(await page.evaluate(() => window.studyHarness.paused())).toBe(true);
  passed('403 suspension clears cache and persists private lock across offline reload');
  expect(errors).toEqual([]);
  await writeFile(
    path.join(output, 'results.json'),
    JSON.stringify({ passed: results, reads, writes, errors }, null, 2),
  );
} catch (error) {
  console.log('Browser errors', errors);
  console.log((await page.locator('body').innerText()).slice(0, 2500));
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await browser.close();
}
