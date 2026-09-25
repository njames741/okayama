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

async function openBrowser(url, { javascript = true, now, beforeLoadSource } = {}) {
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
  if (beforeLoadSource) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: beforeLoadSource }, sessionId);
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
    setReducedMotion: () => send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    }, sessionId),
    press: async (key) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key }, sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key }, sessionId);
    },
    reload: async () => {
      await send('Page.reload', { ignoreCache: true }, sessionId);
      await waitFor(
        async () => {
          try { return await evaluate("document.readyState === 'complete'"); } catch { return false; }
        },
        'Page did not finish reloading',
      );
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

test('pre-trip view prioritizes dated actions and keeps completed records collapsed', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#before-trip`);
  t.after(() => browser.close());

  await waitFor(
    () => browser.evaluate(`document.querySelector('#before-trip.is-active') !== null`),
    'Pre-trip view did not become active',
  );
  const state = await browser.evaluate(`JSON.stringify({
    actions: [...document.querySelectorAll('#before-trip [data-pretrip-list] > .action-card')].map((card) => ({
      status: card.querySelector('[data-field="status"]')?.textContent.trim(),
      deadline: card.querySelector('time')?.getAttribute('datetime'),
      text: card.innerText,
    })),
    completedOpen: document.querySelector('#completed-pretrip')?.open,
    completedText: document.querySelector('#completed-pretrip')?.textContent,
    publicText: document.querySelector('#before-trip')?.innerText,
  })`).then(JSON.parse);

  assert.deepEqual(state.actions.map(({ deadline }) => deadline), [
    '2026-09-20',
    '2026-09-26',
    '2026-09-27',
  ]);
  assert.deepEqual(state.actions.map(({ status }) => status), ['需複查', '待處理', '待處理']);
  for (const action of state.actions) {
    assert.match(action.text, /下一個動作/);
    assert.match(action.text, /完成條件/);
  }
  assert.equal(state.completedOpen, false);
  assert.match(state.completedText, /豊島美術館.*已完成/);
  assert.doesNotMatch(state.publicText, /原本建議|取消這個建議|AI 更正|更正流水帳/);
});

test('planning view organizes current rationale and traceable evidence without edit history', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#planning`);
  t.after(() => browser.close());

  await waitFor(
    () => browser.evaluate(`document.querySelector('#planning.is-active') !== null`),
    'Planning view did not become active',
  );
  const state = await browser.evaluate(`JSON.stringify({
    planningDays: [...document.querySelectorAll('#planning [data-planning-day]')].map((el) => el.getAttribute('data-planning-day')),
    commonTopics: [...document.querySelectorAll('#planning [data-common-topic]')].map((el) => el.getAttribute('data-common-topic')),
    evidence: [...document.querySelectorAll('#planning details.planning-source')].map((el) => ({
      open: el.open,
      summary: el.querySelector('summary')?.innerText,
      links: [...el.querySelectorAll('.fold-body a[href^="http"]')].length,
    })),
    estimate: document.querySelector('#planning .estimate')?.innerText,
    mapInPlanning: document.querySelector('#planning #mapall') !== null,
    restaurantsInPlanning: document.querySelector('#planning #restaurants .restaurant-grid') !== null,
    itineraryHasFullMap: document.querySelector('#itinerary #mapall') !== null,
    text: document.querySelector('#planning')?.innerText,
  })`).then(JSON.parse);

  assert.deepEqual(state.planningDays, ['1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(state.commonTopics, ['transport', 'restaurants', 'tickets']);
  assert.ok(state.evidence.length >= 3);
  for (const item of state.evidence) {
    assert.equal(item.open, false);
    assert.match(item.summary, /已查證 2026-\d{2}-\d{2}/);
    assert.ok(item.links > 0, `${item.summary} should link to an external source`);
  }
  assert.match(state.estimate, /推估/);
  assert.match(state.estimate, /推定|可能|約/);
  assert.equal(state.mapInPlanning, true);
  assert.equal(state.restaurantsInPlanning, true);
  assert.equal(state.itineraryHasFullMap, false);
  assert.doesNotMatch(state.text, /原本建議|取消這個建議|AI 更正|更正流水帳/);
});

test('local rehearsal offers only movable themes and previews a theme-to-date swap', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#planning`);
  t.after(() => browser.close());

  await waitFor(
    () => browser.evaluate(`document.querySelector('[data-rehearsal]') !== null`),
    'Local rehearsal controls were not available',
  );
  const initial = await browser.evaluate(`JSON.stringify({
    labels: [...document.querySelectorAll('[data-rehearsal] select')].map((select) =>
      [...select.options].filter((option) => option.value).map((option) => option.textContent.trim())
    ),
    fixedThemes: document.querySelector('[data-rehearsal]').innerText,
    confirmDisabled: document.querySelector('[data-rehearsal-confirm]').disabled,
  })`).then(JSON.parse);

  const expectedThemes = ['児島半島日', '倉敷 × 吉備路', '跨瀨戶大橋 × 高松', '姫路城'];
  assert.deepEqual(initial.labels[0].map((label) => expectedThemes.find((theme) => label.startsWith(theme))), expectedThemes);
  assert.deepEqual(initial.labels[1].map((label) => expectedThemes.find((theme) => label.startsWith(theme))), expectedThemes);
  assert.ok(initial.labels.flat().every((label) => /目前\s*(9\/28|9\/29|10\/1|10\/2)/.test(label)));
  assert.doesNotMatch(initial.fixedThemes, /抵達 · 岡山夜色.*目前|豊島 · 藝術跳島.*目前|後樂園 · 回家.*目前/);
  assert.equal(initial.confirmDisabled, true);

  await browser.evaluate(`{
    const selects = document.querySelectorAll('[data-rehearsal] select');
    selects[0].value = [...selects[0].options].find((option) => option.textContent.startsWith('児島半島日')).value;
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    selects[1].value = [...selects[1].options].find((option) => option.textContent.startsWith('跨瀨戶大橋 × 高松')).value;
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  const preview = await browser.evaluate(`document.querySelector('[data-rehearsal-preview]').innerText`);
  assert.match(preview, /児島半島日.*10\/1/);
  assert.match(preview, /跨瀨戶大橋 × 高松.*9\/28/);
  assert.equal(await browser.evaluate(`document.querySelector('[data-rehearsal-confirm]').disabled`), false);
});

test('confirming a rehearsal keeps fixed date slots and moves every theme presentation together', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#planning`);
  t.after(() => browser.close());

  await browser.evaluate(`{
    const selects = document.querySelectorAll('[data-rehearsal] select');
    selects[0].value = [...selects[0].options].find((option) => option.textContent.startsWith('児島半島日')).value;
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    selects[1].value = [...selects[1].options].find((option) => option.textContent.startsWith('跨瀨戶大橋 × 高松')).value;
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-rehearsal-confirm]').click();
  }`);
  await waitFor(
    () => browser.evaluate(`document.querySelector('[data-rehearsal-status]').innerText.includes('本裝置自訂順序')`),
    'Custom order status was not announced',
  );
  await browser.evaluate(`location.hash = '#day2'`);
  await waitFor(
    () => browser.evaluate(`document.querySelector('#day2.is-active-day')?.dataset.title === '跨瀨戶大橋 × 高松'`),
    'Day 2 did not receive the Takamatsu theme',
  );

  const state = await browser.evaluate(`JSON.stringify({
    slots: [...document.querySelectorAll('.day')].map((day) => ({ id: day.id, date: day.dataset.date })),
    overviewDay2: document.querySelector('.ov a[href="#day2"] .t').innerText,
    pickerDay2: document.querySelector('.day-picker a[href="#day2"]').innerText,
    summary: document.querySelector('.day-summary').innerText,
    detail: document.querySelector('#day2').innerText,
    mapDescription: document.querySelector('#day2 .mapstatic').alt,
    fixedDay4: document.querySelector('#day4').dataset.title,
    customBanner: document.querySelector('[data-custom-order-banner]').innerText,
  })`).then(JSON.parse);

  assert.deepEqual(state.slots.map(({ id }) => id), ['day1', 'day2', 'day3', 'day4', 'day5', 'day6', 'day7']);
  assert.deepEqual(state.slots.map(({ date }) => date), [
    '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03',
  ]);
  assert.match(state.overviewDay2, /跨瀨戶大橋 × 高松/);
  assert.match(state.pickerDay2, /跨瀨戶大橋 × 高松/);
  assert.match(state.summary, /9 \/ 28.*跨瀨戶大橋 × 高松/s);
  assert.match(state.summary, /需複查.*班次.*營業時間.*休館日.*賽程.*日期限定預約/s);
  assert.match(state.detail, /栗林公園/);
  assert.doesNotMatch(state.detail, /鷲羽山觀瀨戶大橋/);
  assert.match(state.mapDescription, /跨瀨戶大橋與高松/);
  assert.match(state.detail, /需複查.*沒有自動重新查證/s);
  assert.equal(state.fixedDay4, '豊島 · 藝術跳島');
  assert.match(state.customBanner, /本裝置自訂順序/);
});

test('a custom order survives reload and restoring the published version clears it', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#planning`);
  t.after(() => browser.close());

  await browser.evaluate(`{
    const selects = document.querySelectorAll('[data-rehearsal] select');
    selects[0].value = [...selects[0].options].find((option) => option.textContent.startsWith('倉敷 × 吉備路')).value;
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    selects[1].value = [...selects[1].options].find((option) => option.textContent.startsWith('姫路城')).value;
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-rehearsal-confirm]').click();
  }`);
  assert.notEqual(await browser.evaluate(`localStorage.getItem('okayama.itinerary.rehearsal.v1')`), null);

  await browser.reload();
  await waitFor(
    () => browser.evaluate(`document.querySelector('#day3')?.dataset.title === '姫路城'`),
    'Saved theme mapping was not restored after reload',
  );
  assert.match(await browser.evaluate(`document.querySelector('[data-rehearsal-status]').innerText`), /本裝置自訂順序/);
  assert.match(await browser.evaluate(`document.querySelector('.day-summary').innerText`), /本裝置自訂順序/);

  await browser.evaluate(`document.querySelector('[data-rehearsal-reset]').click()`);
  await waitFor(
    () => browser.evaluate(`document.querySelector('#day3')?.dataset.title === '倉敷 × 吉備路'`),
    'Published mapping was not restored',
  );
  assert.equal(await browser.evaluate(`localStorage.getItem('okayama.itinerary.rehearsal.v1')`), null);
  assert.match(await browser.evaluate(`document.querySelector('[data-rehearsal-status]').innerText`), /目前為發布順序/);
  assert.equal(await browser.evaluate(`document.querySelector('[data-custom-order-banner]').hidden`), true);
});

test('a storage write failure keeps the current swap usable and explains that it will not persist', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#planning`, {
    beforeLoadSource: `Storage.prototype.setItem = function () { throw new DOMException('blocked', 'SecurityError'); };`,
  });
  t.after(() => browser.close());

  await browser.evaluate(`{
    const selects = document.querySelectorAll('[data-rehearsal] select');
    selects[0].value = [...selects[0].options].find((option) => option.textContent.startsWith('児島半島日')).value;
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    selects[1].value = [...selects[1].options].find((option) => option.textContent.startsWith('倉敷 × 吉備路')).value;
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-rehearsal-confirm]').click();
  }`);
  await waitFor(
    () => browser.evaluate(`document.querySelector('#day2')?.dataset.title === '倉敷 × 吉備路'`),
    'In-memory swap did not survive a storage failure',
  );
  const status = await browser.evaluate(`document.querySelector('[data-rehearsal-status]').innerText`);
  assert.match(status, /本機儲存寫入失敗/);
  assert.match(status, /下次開啟不會保留/);
  assert.match(status, /本裝置自訂順序/);
});

test('rehearsal remains keyboard-operable, announced, and usable on a zoomed mobile layout', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#planning`);
  t.after(() => browser.close());
  await browser.setViewport(390, 844);
  await browser.setReducedMotion();

  assert.equal(
    await browser.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`),
    true,
  );
  await browser.evaluate(`document.querySelector('[data-rehearsal-first]').focus()`);
  await browser.press('ArrowDown');
  await browser.evaluate(`document.querySelector('[data-rehearsal-second]').focus()`);
  await browser.press('ArrowDown');
  await browser.press('ArrowDown');
  await waitFor(
    () => browser.evaluate(`!document.querySelector('[data-rehearsal-confirm]').disabled`),
    'Keyboard selection did not produce a valid preview',
  );
  assert.match(await browser.evaluate(`document.querySelector('[data-rehearsal-preview]').innerText`), /交換後/);

  await browser.evaluate(`document.querySelector('[data-rehearsal-confirm]').focus()`);
  await browser.press(' ');
  await waitFor(
    () => browser.evaluate(`document.querySelector('[data-rehearsal-status]').innerText.includes('本裝置自訂順序')`),
    'Keyboard confirmation did not announce the custom order',
  );
  const semantics = await browser.evaluate(`JSON.stringify({
    previewLive: document.querySelector('[data-rehearsal-preview]').getAttribute('aria-live'),
    statusRole: document.querySelector('[data-rehearsal-status]').getAttribute('role'),
    bannerRole: document.querySelector('[data-custom-order-banner]').getAttribute('role'),
    selectHeight: document.querySelector('[data-rehearsal-first]').getBoundingClientRect().height,
    confirmHeight: document.querySelector('[data-rehearsal-confirm]').getBoundingClientRect().height,
    fields: getComputedStyle(document.querySelector('.rehearsal-fields')).gridTemplateColumns.split(' ').length,
  })`).then(JSON.parse);
  assert.equal(semantics.previewLive, 'polite');
  assert.equal(semantics.statusRole, 'status');
  assert.equal(semantics.bannerRole, 'status');
  assert.ok(semantics.selectHeight >= 44);
  assert.ok(semantics.confirmHeight >= 44);
  assert.equal(semantics.fields, 1);

  await browser.evaluate(`document.documentElement.style.zoom = '2'`);
  const zoomed = await browser.evaluate(`JSON.stringify({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    controlsVisible: [...document.querySelectorAll('[data-rehearsal] select, [data-rehearsal] button')]
      .every((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0),
  })`).then(JSON.parse);
  assert.equal(zoomed.content, zoomed.viewport);
  assert.equal(zoomed.controlsVisible, true);

  await browser.evaluate(`document.querySelector('[data-rehearsal-reset]').focus()`);
  await browser.press(' ');
  await waitFor(
    () => browser.evaluate(`document.querySelector('[data-rehearsal-status]').innerText.includes('目前為發布順序')`),
    'Keyboard reset did not restore the published order',
  );
});

test('pre-trip and planning controls stay keyboard-usable and stack as cards on mobile', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#planning`);
  t.after(() => browser.close());
  await browser.setViewport(390, 844);

  const mobile = await browser.evaluate(`JSON.stringify({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    restaurantColumns: getComputedStyle(document.querySelector('.restaurant-grid')).gridTemplateColumns.split(' ').length,
    dayColumns: getComputedStyle(document.querySelector('.planning-day-grid')).gridTemplateColumns.split(' ').length,
    restaurantTables: document.querySelectorAll('#planning #restaurants table').length,
    summaryTarget: document.querySelector('.planning-day > summary').getBoundingClientRect().height,
  })`).then(JSON.parse);

  assert.equal(mobile.content, mobile.viewport);
  assert.equal(mobile.restaurantColumns, 1);
  assert.equal(mobile.dayColumns, 1);
  assert.equal(mobile.restaurantTables, 0);
  assert.ok(mobile.summaryTarget >= 44);

  await browser.evaluate(`document.querySelector('.planning-day > summary').focus()`);
  await browser.press(' ');
  assert.equal(await browser.evaluate(`document.querySelector('.planning-day').open`), true);

  await browser.evaluate(`document.querySelector('.site-nav a[href="#before-trip"]').focus()`);
  await browser.press('Enter');
  await waitFor(
    () => browser.evaluate(`document.querySelector('#before-trip.is-active') !== null`),
    'Keyboard could not reach the pre-trip view',
  );
  await browser.evaluate(`document.querySelector('#completed-pretrip > summary').focus()`);
  await browser.press(' ');
  assert.equal(await browser.evaluate(`document.querySelector('#completed-pretrip').open`), true);
});

test('returning to a visible planning map requests a complete redraw', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#planning`);
  t.after(() => browser.close());
  await waitFor(
    () => browser.evaluate(`document.querySelector('#planning.is-active') !== null`),
    'Planning view did not become active',
  );

  await browser.evaluate(`{
    window.__overviewInvalidations = 0;
    document.querySelector('#mapall')._map = {
      invalidateSize() { window.__overviewInvalidations += 1; }
    };
    location.hash = '#itinerary';
  }`);
  await waitFor(
    () => browser.evaluate(`document.querySelector('#itinerary.is-active') !== null`),
    'Itinerary view did not become active',
  );
  await browser.evaluate(`location.hash = '#planning'`);
  await waitFor(
    () => browser.evaluate(`window.__overviewInvalidations > 0`),
    'Visible overview map was not invalidated after returning to planning',
  );
});

test('a direct planning subsection link reveals and positions its content', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#restaurants`);
  t.after(() => browser.close());

  await waitFor(
    () => browser.evaluate(`document.querySelector('#planning.is-active') !== null`),
    'Planning view did not become active for a subsection link',
  );
  const state = await browser.evaluate(`JSON.stringify({
    current: document.querySelector('.site-nav a[aria-current="page"]')?.getAttribute('href'),
    top: document.querySelector('#restaurants').getBoundingClientRect().top,
    scrollY,
  })`).then(JSON.parse);
  assert.equal(state.current, '#planning');
  assert.ok(state.scrollY > 0);
  assert.ok(state.top >= 55 && state.top <= 100, `Restaurant section top was ${state.top}px`);
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

test('Day 4 restaurant link opens the visible restaurant list', async (t) => {
  const browser = await openBrowser(`${pathToFileURL(htmlPath).href}#day4`);
  t.after(() => browser.close());

  await browser.evaluate(`document.querySelector('#day4 a[href="#restaurants"]').click()`);
  await waitFor(
    () => browser.evaluate(`location.hash === '#restaurants' && document.querySelector('#planning.is-active') !== null`),
    'Restaurant link did not open planning',
  );
  assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('#restaurants')).display !== 'none'`), true);
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
    topics: [...document.querySelectorAll('[aria-label="選擇行程日"] a')].map((el) => el.querySelector('.picker-topic')?.innerText.trim() || ''),
    visibleDays: [...document.querySelectorAll('.day')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => el.id),
    summary: document.querySelector('.day-summary')?.innerText,
    scrollY,
  })`).then(JSON.parse);

  assert.equal(state.labels.length, 7);
  assert.match(state.labels[0], /Day 1.*9\/27/);
  assert.match(state.labels[6], /Day 7.*10\/3/);
  assert.deepEqual(state.topics, [
    '抵達 · 岡山夜色',
    '児島半島日',
    '倉敷 × 吉備路',
    '豊島 · 藝術跳島',
    '跨瀨戶大橋 × 高松',
    '姫路城',
    '岡山後楽園 · 回家',
  ]);
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
    day2Verified: [...document.querySelectorAll('#day2 .verified-detail > summary')].map((el) => el.innerText),
    day5ReturnTimes: [...document.querySelectorAll('#day5 .journey-stage[aria-label="回程"] .when')].map((el) => el.innerText),
    day5DinnerStage: document.querySelector('#day5 .when') && [...document.querySelectorAll('#day5 .when')]
      .find((el) => el.innerText === '~17:20')?.closest('.journey-stage')?.getAttribute('aria-label'),
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
  assert.ok(semantics.day2Verified.some((value) => /競艇場接駁.*2026-09-24 查證/.test(value)));
  assert.ok(semantics.day2Verified.some((value) => /已查證 2026-08-29/.test(value)));
  assert.deepEqual(semantics.day5ReturnTimes, ['19:40']);
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
    fixedNavHeight: document.querySelector('.site-nav-shell').getBoundingClientRect().height
      + document.querySelector('.day-picker').getBoundingClientRect().height,
    choiceColumns: getComputedStyle(document.querySelector('.choice-grid')).gridTemplateColumns.split(' ').length,
  })`).then(JSON.parse);
  assert.equal(mobile.columns, 1);
  assert.equal(mobile.content, mobile.viewport);
  assert.ok(mobile.dayTarget >= 44);
  assert.ok(mobile.fixedNavHeight <= 125, `Mobile navigation is too tall: ${mobile.fixedNavHeight}px`);
  assert.equal(mobile.choiceColumns, 1);
  const reading = await browser.evaluate(`(() => {
    const day = document.querySelector('#day4');
    window.scrollTo(0, day.getBoundingClientRect().top + window.scrollY + 450);
    const picker = document.querySelector('.day-picker').getBoundingClientRect();
    const nav = document.querySelector('.site-nav-shell').getBoundingClientRect();
    return JSON.stringify({ pickerTop: picker.top, navBottom: nav.bottom, pickerBottom: picker.bottom, viewportHeight: innerHeight });
  })()`).then(JSON.parse);
  assert.ok(reading.pickerTop >= reading.navBottom - 2, 'Date picker should stay below the main navigation while reading');
  assert.ok(reading.pickerBottom < reading.viewportHeight, 'Date picker should remain in view while reading');
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
  await new Promise((resolve) => setTimeout(resolve, 100));
  const switched = await browser.evaluate(`JSON.stringify({
    dayTop: document.querySelector('#day2').getBoundingClientRect().top,
    pickerBottom: document.querySelector('.day-picker').getBoundingClientRect().bottom,
    pickerHeight: document.querySelector('.day-picker').getBoundingClientRect().height,
    navHeight: document.querySelector('.site-nav-shell').getBoundingClientRect().height,
    innerWidth,
    scrollY,
    selectedVisible: (() => {
      const selected = document.querySelector('.day-picker [aria-current="date"]').getBoundingClientRect();
      const picker = document.querySelector('.day-picker').getBoundingClientRect();
      return selected.left >= picker.left && selected.right <= picker.right;
    })(),
  })`).then(JSON.parse);
  assert.ok(switched.dayTop >= switched.pickerBottom - 2, `Switched day should start below the sticky picker: ${JSON.stringify(switched)}`);
  assert.equal(switched.selectedVisible, true);

  await browser.setViewport(320, 700);
  await waitFor(
    () => browser.evaluate(`document.querySelector('.day-picker').getBoundingClientRect().top >= document.querySelector('.site-nav-shell').getBoundingClientRect().bottom - 2`),
    'Narrow phone navigation did not settle below the main navigation',
  );
  const narrow = await browser.evaluate(`JSON.stringify({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    pickerTop: document.querySelector('.day-picker').getBoundingClientRect().top,
    navBottom: document.querySelector('.site-nav-shell').getBoundingClientRect().bottom,
    fixedNavHeight: document.querySelector('.site-nav-shell').getBoundingClientRect().height
      + document.querySelector('.day-picker').getBoundingClientRect().height,
  })`).then(JSON.parse);
  assert.equal(narrow.content, narrow.viewport);
  assert.ok(narrow.fixedNavHeight <= 130, `Narrow phone navigation is too tall: ${narrow.fixedNavHeight}px`);
  assert.ok(narrow.pickerTop >= narrow.navBottom - 2, `Narrow phone navigation should not overlap: ${JSON.stringify(narrow)}`);
});
