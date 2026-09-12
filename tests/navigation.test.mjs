import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const siteDir = path.resolve(import.meta.dirname, '..');
const htmlPath = path.join(siteDir, 'index.html');
const chromePath = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function waitFor(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

async function openBrowser(url, { javascript = true, now } = {}) {
  assert.ok(existsSync(chromePath), `Chrome not found at ${chromePath}`);
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'okayama-nav-test-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-background-networking',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const [port] = (await waitFor(
    async () => existsSync(portFile) && readFile(portFile, 'utf8'),
    'Chrome did not expose a DevTools port',
  )).trim().split(/\r?\n/);
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.json());
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  if (now) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `{
        const RealDate = Date;
        const fixedNow = ${JSON.stringify(new Date(now).valueOf())};
        globalThis.Date = class extends RealDate {
          constructor(...args) { super(...(args.length ? args : [fixedNow])); }
          static now() { return fixedNow; }
        };
      }`,
    }, sessionId);
  }
  if (!javascript) {
    await send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);
  }
  await send('Page.navigate', { url }, sessionId);
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await waitFor(
    () => evaluate("document.readyState !== 'loading'"),
    'Page did not become interactive',
  );

  return {
    evaluate,
    setViewport: (width, height) => send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 600,
    }, sessionId),
    press: async (key) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key }, sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key }, sessionId);
    },
    close: async () => {
      try { await send('Target.closeTarget', { targetId }); } catch {}
      try { await send('Browser.close'); } catch {}
      socket.close();
      chrome.kill();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test('three top-level destinations are real links and remain readable without JavaScript', async () => {
  const html = await readFile(htmlPath, 'utf8');

  for (const [id, label] of [
    ['itinerary', '行程'],
    ['before-trip', '出發前'],
    ['planning', '規劃／查證'],
  ]) {
    assert.match(html, new RegExp(`<a[^>]+href="#${id}"[^>]*>${label}</a>`));
    assert.match(html, new RegExp(`<[^>]+id="${id}"[^>]+data-top-view`));
  }
  assert.doesNotMatch(html, /data-top-view[^>]*\shidden(?:\s|=|>)/);
  assert.equal((html.match(/<article class="day reveal" id="day[1-7]"[^>]*>/g) || []).length, 7);
  assert.match(html, /id="todo"/);
  assert.match(html, /aria-label="交通須知"/);
});

test('core itinerary and pre-trip content are visibly rendered when JavaScript is disabled', async (t) => {
  const browser = await openBrowser(pathToFileURL(htmlPath).href, { javascript: false });
  t.after(() => browser.close());

  const visibility = await browser.evaluate(`JSON.stringify({
    enhanced: document.documentElement.classList.contains('js'),
    views: [...document.querySelectorAll('[data-top-view]')].map((el) => getComputedStyle(el).display),
    day: getComputedStyle(document.querySelector('#day1')).opacity,
    todo: getComputedStyle(document.querySelector('#before-trip .reveal')).opacity
  })`).then(JSON.parse);

  assert.deepEqual(visibility, {
    enhanced: false,
    views: ['block', 'block', 'block'],
    day: '1',
    todo: '1',
  });
});

test('direct fragment, navigation clicks, and browser Back keep the correct region visible', async (t) => {
  const pageUrl = `${pathToFileURL(htmlPath).href}#before-trip`;
  const browser = await openBrowser(pageUrl);
  t.after(() => browser.close());

  const state = () => browser.evaluate(`JSON.stringify({
    hash: location.hash,
    current: document.querySelector('.site-nav a[aria-current="page"]')?.getAttribute('href'),
    visible: [...document.querySelectorAll('[data-top-view]')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => el.id)
  })`).then(JSON.parse);

  await waitFor(async () => (await state()).current === '#before-trip', 'Direct fragment was not selected');
  assert.deepEqual(await state(), {
    hash: '#before-trip',
    current: '#before-trip',
    visible: ['before-trip'],
  });

  await browser.evaluate(`document.querySelector('.site-nav a[href="#planning"]').focus()`);
  await browser.press('Enter');
  await waitFor(async () => (await state()).current === '#planning', 'Keyboard navigation did not select the region');
  assert.deepEqual(await state(), {
    hash: '#planning',
    current: '#planning',
    visible: ['planning'],
  });

  await browser.evaluate('history.back()');
  await waitFor(async () => (await state()).current === '#before-trip', 'Back did not restore the prior region');
  assert.deepEqual(await state(), {
    hash: '#before-trip',
    current: '#before-trip',
    visible: ['before-trip'],
  });

  await browser.evaluate('history.forward()');
  await waitFor(async () => (await state()).current === '#planning', 'Forward did not restore the next region');
  assert.deepEqual(await state(), {
    hash: '#planning',
    current: '#planning',
    visible: ['planning'],
  });
});

test('an empty fragment defaults to the itinerary region', async (t) => {
  const browser = await openBrowser(pathToFileURL(htmlPath).href);
  t.after(() => browser.close());

  const selected = await waitFor(
    () => browser.evaluate(`document.querySelector('.site-nav a[aria-current="page"]')?.getAttribute('href')`),
    'Default region was not selected',
  );
  assert.equal(selected, '#itinerary');
  assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('#itinerary')).display !== 'none'`), true);
  assert.equal(await browser.evaluate(`getComputedStyle(document.body).fontSize`), '16px');
  assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.site-nav a')).fontSize`), '14px');
  for (const selector of ['.leg.t .what', '.warn', '.fold-body', '.note', '.cand small']) {
    assert.equal(
      await browser.evaluate(`getComputedStyle(document.querySelector('${selector}')).fontSize`),
      '16px',
      `${selector} should not shrink core text below 16px`,
    );
  }
});

test('day selector keeps fixed dates and shows one requested itinerary day', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#day4`);
  t.after(() => browser.close());

  await waitFor(
    () => browser.evaluate(`document.querySelector('[aria-label="選擇行程日"] [aria-current="date"]')?.textContent.includes('Day 4')`),
    'Day 4 was not selected from the fragment',
  );
  const state = await browser.evaluate(`JSON.stringify({
    labels: [...document.querySelectorAll('[aria-label="選擇行程日"] a')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim()),
    visibleDays: [...document.querySelectorAll('.day')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => el.id),
    summary: document.querySelector('.day-summary')?.innerText,
    scrollY,
  })`).then(JSON.parse);

  assert.equal(state.labels.length, 7);
  assert.match(state.labels[0], /Day 1.*9\/27/);
  assert.match(state.labels[6], /Day 7.*10\/3/);
  assert.deepEqual(state.visibleDays, ['day4']);
  assert.ok(state.scrollY > 0, 'A Day fragment should move the selected day into view');
  for (const text of ['9 / 30', '豊島 · 藝術跳島', '07:05', '17:55', '08:40', '10:30', '16:25']) {
    assert.match(state.summary, new RegExp(text.replace('/', '\\/')));
  }
  assert.doesNotMatch(state.summary, /體力/);
});

test('Tokyo trip date selects today while dates outside the trip select Day 1', async (t) => {
  async function selectedDay(now) {
    const browser = await openBrowser(pathToFileURL(htmlPath).href, { now });
    t.after(() => browser.close());
    return waitFor(
      () => browser.evaluate(`document.querySelector('[aria-label="選擇行程日"] [aria-current="date"]')?.getAttribute('href')`),
      `No selected day for ${now}`,
    );
  }

  assert.equal(await selectedDay('2026-09-28T15:30:00Z'), '#day3');
  assert.equal(await selectedDay('2026-09-26T15:30:00Z'), '#day1');
  assert.equal(await selectedDay('2026-10-03T15:30:00Z'), '#day1');
});

test('active day exposes journey stages and keeps semantic priority visible', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#day4`);
  t.after(() => browser.close());

  await waitFor(
    () => browser.evaluate(`document.querySelector('#day4.is-active-day') !== null`),
    'Day 4 did not become active',
  );
  const semantics = await browser.evaluate(`JSON.stringify({
    stages: [...document.querySelectorAll('#day4 .journey-stage > h4')].map((el) => el.textContent.trim()),
    choice: document.querySelector('#day4 .on-site-choice')?.innerText,
    choiceDisplay: getComputedStyle(document.querySelector('#day4 .on-site-choice')).display,
    criticalDisplay: getComputedStyle(document.querySelector('#day4 .critical')).display,
    fallbacks: [...document.querySelectorAll('#day4 details.fallback')].map((el) => el.open),
    verified: document.querySelector('#day4 .verified')?.innerText,
    estimate: document.querySelector('#day4 .estimate')?.innerText,
    supplementsClosed: [...document.querySelectorAll('.leg-more')].every((el) => !el.open),
    verifiedTimetable: document.querySelector('#day2 .verified-detail > summary')?.innerText,
    day5ReturnTimes: [...document.querySelectorAll('#day5 .journey-stage[aria-label="回程"] .when')].map((el) => el.innerText),
    day5DinnerStage: document.querySelector('#day5 .when') && [...document.querySelectorAll('#day5 .when')]
      .find((el) => el.innerText === '17:30')?.closest('.journey-stage')?.getAttribute('aria-label'),
  })`).then(JSON.parse);

  for (const stage of ['去程', '主要行程', '午餐', '下午行程', '回程']) {
    assert.ok(semantics.stages.includes(stage), `Missing ${stage} stage`);
  }
  for (const text of ['09:15 前決定', '天氣', '10:30 豊島美術館']) {
    assert.match(semantics.choice, new RegExp(text));
  }
  assert.notEqual(semantics.choiceDisplay, 'none');
  assert.notEqual(semantics.criticalDisplay, 'none');
  assert.ok(semantics.fallbacks.every((open) => open === false));
  assert.match(semantics.verified, /已查證.*2026-/);
  assert.match(semantics.estimate, /推估/);
  assert.equal(semantics.supplementsClosed, true);
  assert.match(semantics.verifiedTimetable, /已查證 2026-08-29/);
  assert.deepEqual(semantics.day5ReturnTimes, ['~19:30']);
  assert.equal(semantics.day5DinnerStage, '下午行程');
});

test('day layout is sticky and two-column on desktop, then readable without overflow on mobile', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#day4`);
  t.after(() => browser.close());

  await browser.setViewport(1200, 800);
  const desktop = await browser.evaluate(`JSON.stringify({
    columns: getComputedStyle(document.querySelector('.day-workspace')).gridTemplateColumns.split(' ').length,
    rail: getComputedStyle(document.querySelector('.day-rail')).position,
    articlePhoto: getComputedStyle(document.querySelector('#day4 .daypic')).display,
    summaryPhotoHeight: document.querySelector('.day-summary .summary-photo').getBoundingClientRect().height,
  })`).then(JSON.parse);
  assert.equal(desktop.columns, 2);
  assert.equal(desktop.rail, 'sticky');
  assert.equal(desktop.articlePhoto, 'none');
  assert.ok(desktop.summaryPhotoHeight <= 120);

  await browser.setViewport(390, 844);
  const mobile = await browser.evaluate(`JSON.stringify({
    columns: getComputedStyle(document.querySelector('.day-workspace')).gridTemplateColumns.split(' ').length,
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    dayTarget: document.querySelector('.day-picker a').getBoundingClientRect().height,
    choiceColumns: getComputedStyle(document.querySelector('.choice-grid')).gridTemplateColumns.split(' ').length,
  })`).then(JSON.parse);
  assert.equal(mobile.columns, 1);
  assert.equal(mobile.content, mobile.viewport);
  assert.ok(mobile.dayTarget >= 44);
  assert.equal(mobile.choiceColumns, 1);
  for (const selector of [
    '.day-picker small',
    '.summary-date',
    '.summary-times dt',
    '.summary-hard b',
    '.journey-stage > h4',
    '.leg .when',
  ]) {
    assert.equal(
      await browser.evaluate(`getComputedStyle(document.querySelector('${selector}')).fontSize`),
      '14px',
      `${selector} should meet the 14px label minimum`,
    );
  }

  await browser.evaluate(`document.querySelector('.day-picker a[href="#day2"]').focus()`);
  await browser.press('Enter');
  await waitFor(
    () => browser.evaluate(`document.querySelector('.day-picker [aria-current="date"]')?.getAttribute('href') === '#day2'`),
    'Keyboard could not switch days',
  );
});
