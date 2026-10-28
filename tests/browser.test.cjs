'use strict';
/* Isolated Chromium smoke tests. All Bluetooth interfaces below are fake. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

let playwright;
try { playwright = require('playwright'); }
catch (_) {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error('Install Playwright and its Chromium browser to run browser tests.');
  playwright = require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'));
}

const root = path.resolve(__dirname, '..');
let server;
let browser;
let origin;

before(async () => {
  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'controller-core.js', 'treadmill.js', 'voice-recorder.js', 'voice-notes.js'].includes(file)) {
        response.writeHead(404); response.end(); return;
      }
      const data = await fs.readFile(path.join(root, file));
      response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(data);
    } catch (_) { response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.PITPAT_BROWSER_EXECUTABLE ? { executablePath: process.env.PITPAT_BROWSER_EXECUTABLE } : {}),
    args: ['--no-sandbox']
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

function mockBluetooth(storage) {
  const serviceId = '0000fba0-0000-1000-8000-00805f9b34fb';
  const writeId = '0000fba1-0000-1000-8000-00805f9b34fb';
  const notifyId = '0000fba2-0000-1000-8000-00805f9b34fb';
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility !== 'visible' });
  window.__xss = false;
  for (const [key, value] of Object.entries(storage || {})) localStorage.setItem(key, JSON.stringify(value));

  const rx = new EventTarget();
  rx.startNotifications = async () => { window.__ble.notifications = true; return rx; };
  rx.value = null;
  const device = new EventTarget();
  device.name = 'PitPat-T01 · simulated';
  device.id = 'mock-only';
  const tx = {
    properties: { write: true },
    writeValueWithResponse: async input => {
      const bytes = Array.from(new Uint8Array(input));
      const type = bytes.length === 5 ? 'heartbeat' : bytes[12] === 0 ? 'stop' : bytes[12] === 2 ? 'pause' : bytes[8] === 5 ? 'set_speed' : 'start';
      const record = { type, speed: bytes.length === 23 ? (bytes[6] * 256 + bytes[7]) / 1000 : 0, bytes, connection: window.__ble.connection };
      window.__ble.writes.push(record);
      if (window.__ble.hold === type || window.__ble.hold === '*') {
        await new Promise(resolve => window.__ble.held.push(resolve));
      }
    }
  };
  const service = {
    getCharacteristic: async uuid => {
      if (uuid === writeId) return tx;
      if (uuid === notifyId) return rx;
      throw new Error('Unexpected mock characteristic');
    }
  };
  const gatt = {
    connected: false,
    connect: async () => {
      gatt.connected = true;
      window.__ble.connection += 1;
      return gatt;
    },
    disconnect: () => {
      const wasConnected = gatt.connected;
      gatt.connected = false;
      if (wasConnected) device.dispatchEvent(new Event('gattserverdisconnected'));
    },
    getPrimaryService: async uuid => {
      if (uuid !== serviceId) throw new Error('Unexpected mock service');
      return service;
    }
  };
  device.gatt = gatt;
  const mock = window.__ble = {
    connection: 0,
    requests: [],
    writes: [],
    hold: null,
    held: [],
    notifications: false,
    release: () => {
      mock.hold = null;
      const pending = mock.held.splice(0);
      for (const resolve of pending) resolve();
    },
    disconnect: () => gatt.disconnect(),
    setVisibility: value => {
      visibility = value;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    emit: (data = {}) => {
      const state = data.state || 'stopped';
      const values = { speed: state === 'running' ? 2 : 0, target: state === 'running' ? 2 : 0, distance: 0, steps: 0, calories: 0, cycle: 1, ...data };
      const bytes = new Uint8Array(values.size || 52);
      const view = new DataView(bytes.buffer);
      bytes[0] = values.header ?? 0x68; bytes[1] = bytes.length;
      view.setUint16(3, Math.round(values.speed * 1000), false);
      view.setUint16(5, Math.round(values.target * 1000), false);
      view.setUint32(7, Math.round(values.distance * 1000), false);
      view.setUint32(14, values.steps, false);
      view.setUint16(18, values.calories, false);
      bytes[24] = values.cycle; bytes[25] = 42;
      bytes[26] = { stopped: 0, running: 8, paused: 16, countdown: 24 }[state];
      view.setUint16(27, 6000, false);
      bytes[bytes.length - 1] = 0x43;
      rx.value = view;
      rx.dispatchEvent(new Event('characteristicvaluechanged'));
    },
    malformed: () => {
      rx.value = new DataView(new Uint8Array(9).buffer);
      rx.dispatchEvent(new Event('characteristicvaluechanged'));
    },
    notify: bytes => {
      rx.value = new DataView(new Uint8Array(bytes).buffer);
      rx.dispatchEvent(new Event('characteristicvaluechanged'));
    }
  };
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: { requestDevice: async options => { mock.requests.push(options); return device; } }
  });
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: { request: async () => {
      const sentinel = new EventTarget();
      sentinel.release = async () => sentinel.dispatchEvent(new Event('release'));
      return sentinel;
    } }
  });
}

async function createPage(t, storage = {}) {
  const context = await browser.newContext({ viewport: { width: 448, height: 998 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  t.after(() => context.close());
  const page = await context.newPage();
  const external = [];
  const requests = [];
  const errors = [];
  page.on('pageerror', problem => errors.push(problem.message));
  await context.route('**/*', route => {
    const url = route.request().url();
    requests.push(url);
    if (!url.startsWith(origin + '/')) { external.push(url); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(mockBluetooth, storage);
  await page.addInitScript(mockVoice);
  await page.goto(origin, { waitUntil: 'load' });
  await page.waitForFunction(() => window.PitPatCore && document.getElementById('buildVersion').textContent.includes('Improved'));
  return { page, external, requests, errors };
}

async function emit(page, data = {}) { await page.evaluate(value => window.__ble.emit(value), data); }
async function ready(page, data = {}) {
  await page.locator('#connectBtn').click();
  await page.waitForFunction(() => window.__ble.notifications && document.getElementById('connectBtn').textContent === 'Disconnect');
  await emit(page, data); await emit(page, data);
  await page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Connected');
}
async function writes(page) { return page.evaluate(() => window.__ble.writes); }
async function expectWrites(page, type, count) {
  await page.waitForFunction(({ type, count }) => window.__ble.writes.filter(item => item.type === type).length >= count, { type, count });
}

test('no motion on load/connect/preselection; explicit Start and symmetric 0.1 speed controls', async t => {
  const { page, errors } = await createPage(t);
  assert.deepEqual(await writes(page), []);
  await page.locator('[data-speed="2"]').click();
  assert.equal(await page.locator('#selectedSpeed').textContent(), '2.0');
  assert.deepEqual(await writes(page), []);
  await ready(page);
  assert.ok((await writes(page)).every(item => item.type === 'heartbeat'));
  await page.locator('[data-speed="3"]').click();
  assert.ok((await writes(page)).every(item => item.type === 'heartbeat'));
  await page.locator('#startBtn').click();
  await expectWrites(page, 'start', 1);
  assert.equal((await writes(page)).find(item => item.type === 'start').speed, 3);
  await emit(page, { state: 'running', speed: 3, target: 3 });
  await page.waitForFunction(() => !document.getElementById('speedUpBtn').disabled);
  await page.locator('#speedUpBtn').click();
  await expectWrites(page, 'set_speed', 1);
  await page.locator('#speedDownBtn').click();
  await expectWrites(page, 'set_speed', 2);
  assert.deepEqual((await writes(page)).filter(item => item.type === 'set_speed').map(item => item.speed), [3.1, 3]);
  assert.deepEqual(errors, []);
});

test('Stop is available during countdown, malformed telemetry, and stale data', async t => {
  const { page, errors } = await createPage(t);
  await ready(page);
  await emit(page, { state: 'countdown', target: 1 });
  assert.equal(await page.locator('#startBtn').isDisabled(), true);
  assert.equal(await page.locator('#stopBtn').isDisabled(), false);
  await page.locator('#stopBtn').click();
  await expectWrites(page, 'stop', 1);
  await emit(page); await emit(page);
  await page.evaluate(() => window.__ble.malformed());
  assert.equal(await page.locator('#startBtn').isDisabled(), true);
  assert.equal(await page.locator('#stopBtn').isDisabled(), false);
  await page.locator('#stopBtn').click();
  await expectWrites(page, 'stop', 2);
  await emit(page); await emit(page);
  // A real five-second notification gap exercises the production watchdog.
  await page.waitForTimeout(6100);
  assert.equal(await page.locator('#connectionStatus').textContent(), 'Live data lost');
  assert.equal(await page.locator('#startBtn').isDisabled(), true);
  assert.equal(await page.locator('#stopBtn').isDisabled(), false);
  await page.locator('#stopBtn').click();
  await expectWrites(page, 'stop', 3);
  assert.deepEqual(errors, []);
});

test('Pause write acknowledgement does not release controls until paused telemetry confirms', async t => {
  const { page, errors } = await createPage(t);
  await ready(page, { state: 'running', speed: 2, target: 2 });
  await page.locator('#startBtn').click();
  await expectWrites(page, 'pause', 1);
  assert.equal(await page.locator('#startBtn').isDisabled(), true);
  assert.equal(await page.locator('#speedUpBtn').isDisabled(), true);
  await page.evaluate(() => document.getElementById('speedUpBtn').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert.equal((await writes(page)).filter(item => item.type === 'set_speed').length, 0);
  await emit(page, { state: 'paused', speed: 0.5, target: 0 });
  assert.equal(await page.locator('#startBtn').isDisabled(), true);
  await emit(page, { state: 'paused', speed: 0, target: 0 });
  await page.waitForFunction(() => !document.getElementById('startBtn').disabled);
  await page.locator('[data-speed="3"]').click();
  assert.equal((await writes(page)).filter(item => item.type === 'set_speed').length, 0);
  await page.locator('#startBtn').click();
  await expectWrites(page, 'start', 1);
  assert.equal((await writes(page)).find(item => item.type === 'start').speed, 3);
  assert.deepEqual(errors, []);
});

test('disconnect cancels a queued Start and old write completion cannot replay after reconnect', async t => {
  const { page, errors } = await createPage(t);
  await page.evaluate(() => { window.__ble.hold = 'heartbeat'; });
  await ready(page);
  await page.waitForFunction(() => window.__ble.held.length === 1);
  await page.locator('#startBtn').click();
  assert.equal((await writes(page)).filter(item => item.type === 'start').length, 0);
  await page.locator('#connectBtn').click();
  assert.equal(await page.locator('#connectionStatus').textContent(), 'Disconnected');
  await page.evaluate(() => { window.__ble.hold = null; });
  await ready(page);
  await page.evaluate(() => window.__ble.release());
  await page.waitForTimeout(50);
  assert.equal((await writes(page)).filter(item => item.type === 'start' || item.type === 'set_speed').length, 0);
  assert.equal(await page.locator('#connectionStatus').textContent(), 'Connected');
  assert.deepEqual(errors, []);
});

test('hiding the page discards queued movement and archives a partial session without claiming auto-stop', async t => {
  const { page, errors } = await createPage(t);
  await ready(page, { state: 'running', speed: 2, target: 2 });
  await page.waitForTimeout(550);
  await page.evaluate(() => { window.__ble.hold = 'heartbeat'; });
  await emit(page, { state: 'running', speed: 2, target: 2, steps: 1, distance: 0.001 });
  await page.waitForFunction(() => window.__ble.held.length === 1);
  await page.locator('#speedUpBtn').click();
  assert.equal((await writes(page)).filter(item => item.type === 'set_speed').length, 0);
  await page.evaluate(() => window.__ble.setVisibility('hidden'));
  assert.equal(await page.locator('#startBtn').isDisabled(), true);
  assert.match(await page.locator('#message').textContent(), /belt may still be moving/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pitpat_local_v1_history')));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'interrupted');
  assert.equal(saved[0].incomplete, true);
  await page.evaluate(() => window.__ble.release());
  await page.evaluate(() => window.__ble.setVisibility('visible'));
  assert.equal(await page.locator('#startBtn').isDisabled(), true);
  await emit(page, { state: 'running', speed: 2, target: 2 });
  assert.equal(await page.locator('#startBtn').isDisabled(), true);
  await emit(page, { state: 'running', speed: 2, target: 2 });
  assert.equal(await page.locator('#startBtn').isDisabled(), false);
  assert.equal((await writes(page)).filter(item => ['start', 'set_speed', 'stop'].includes(item.type)).length, 0);
  assert.deepEqual(errors, []);
});

test('crafted local history cannot inject executable markup and legacy bad values are dropped', async t => {
  const safe = { id: 'history-safe', startedAt: 1700000000000, endedAt: 1700000010000, status: 'completed', incomplete: false, speedCoverageComplete: true, activeSeconds: 10, distanceKm: 0.01, steps: 20, calories: 1, usualSpeedKmh: 2, meanSpeedKmh: 2, reason: '<img src=x onerror="window.__xss=true">' };
  const bad = { ...safe, id: 'history-bad', steps: '<img src=x onerror="window.__xss=true">', speedUnit: '<svg onload="window.__xss=true">' };
  const { page, errors, external } = await createPage(t, { pitpat_local_v1_history: [safe, bad] });
  assert.equal(await page.locator('#historyList li').count(), 1);
  assert.equal(await page.locator('#historyList img, #historyList svg, #historyList script').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), false);
  assert.equal(await page.locator('[type="file"]').count(), 0);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
});

test('mobile layout fits Pixel and smaller widths; app loads only local runtime files', async t => {
  const { page, errors, external, requests } = await createPage(t);
  await ready(page, { state: 'running', speed: 2.5, target: 2.5 });
  for (const width of [448, 360]) {
    await page.setViewportSize({ width, height: 998 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `Horizontal overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 448, height: 998 });
  const qa = process.env.PITPAT_QA_DIR || path.resolve(root, '..', 'qa-pitpat');
  await fs.mkdir(qa, { recursive: true });
  await page.screenshot({ path: path.join(qa, 'pixel-controller.png'), fullPage: true });
  assert.deepEqual(external, []);
  const paths = new Set(requests.map(url => new URL(url).pathname));
  for (const requestPath of paths) assert.ok(['/', '/controller-core.js', '/treadmill.js', '/voice-recorder.js', '/voice-notes.js', '/favicon.ico'].includes(requestPath), `Unexpected runtime request: ${requestPath}`);
  assert.deepEqual(await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src'))), ['controller-core.js?v=1.1.1', 'treadmill.js?v=1.1.1', 'voice-recorder.js?v=1.1.1', 'voice-notes.js?v=1.1.1']);
  assert.deepEqual(errors, []);
});

test('unsupported frames stay blocked and provide bounded diagnostics without serials or history', async t => {
  const { page, errors } = await createPage(t);
  await ready(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.__copiedDiagnostics = text; }
    } });
    for (let header = 0x70; header < 0x79; header += 1) {
      const bytes = new Uint8Array(52);
      bytes[0] = header; bytes[1] = 52; bytes[51] = 0x43;
      bytes.set(new TextEncoder().encode('PRIVATE-SERIAL01'), 32);
      window.__ble.notify(Array.from(bytes));
    }
  });
  assert.equal(await page.locator('#startBtn').isDisabled(), true);
  assert.equal(await page.locator('#stopBtn').isDisabled(), false);
  const diagnostics = await page.locator('#notificationDiagnostics').inputValue();
  assert.match(diagnostics, /Notifications received: 11/);
  assert.match(diagnostics, /52 bytes; header 0x78; declared length 52; trailer 0x43/);
  assert.match(diagnostics, /Unrecognized treadmill frame/);
  assert.equal(diagnostics.split('\n').filter(line => line.startsWith('1×')).length, 6);
  assert.doesNotMatch(diagnostics, /PRIVATE|SERIAL|PitPat-T01|mock-only|history|0x70;/);
  await page.locator('summary').click();
  await page.locator('#copyDiagnosticsBtn').click();
  assert.equal(await page.evaluate(() => window.__copiedDiagnostics), diagnostics);
  assert.deepEqual((await writes(page)).filter(item => item.type !== 'heartbeat'), []);
  assert.deepEqual(errors, []);
});

test('the observed 60-byte 0x67 pad can report idle without sending motion', async t => {
  const { page, errors } = await createPage(t);
  await ready(page, { header: 0x67, size: 60 });
  assert.equal(await page.locator('#beltState').textContent(), 'Ready');
  assert.equal(await page.locator('#actualSpeed').textContent(), '0.0');
  assert.equal(await page.locator('#startBtn').isDisabled(), false);
  assert.deepEqual((await writes(page)).filter(item => item.type !== 'heartbeat'), []);
  assert.deepEqual(errors, []);
});

function mockVoice() {
  const voice = window.__voice = { available: 100 * 1024 * 1024, captures: 0, stoppedTracks: 0 };
  Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: async () => ({ quota: voice.available, usage: 0 }) });
  Object.defineProperty(navigator.storage, 'persist', { configurable: true, value: async () => true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => {
      voice.captures += 1;
      voice.track = { onended: null, stop: () => { voice.stoppedTracks += 1; } };
      return { getAudioTracks: () => [voice.track], getTracks: () => [voice.track] };
    }
  } });
  window.MediaRecorder = class {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor() { this.mimeType = 'audio/webm;codecs=opus'; this.state = 'inactive'; voice.recorder = this; }
    start() { this.state = 'recording'; this.timer = setInterval(() => { if (this.state === 'recording') this.ondataavailable({ data: new Blob(['simulated-audio'], { type: this.mimeType }) }); }, 200); }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() {
      clearInterval(this.timer); this.state = 'inactive';
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['final-simulated-audio'], { type: this.mimeType }) }); this.onstop?.(); });
    }
  };
}

test('voice chunks survive reload and low storage requests a pad Stop without opening the microphone', async t => {
  const { page, errors } = await createPage(t);
  await ready(page);
  await page.waitForFunction(() => !document.getElementById('voiceRecordBtn').disabled);
  await page.locator('#voiceRecordBtn').click();
  await page.waitForFunction(() => document.getElementById('voiceIndicator').textContent === 'Recording' || document.getElementById('voiceStatus').textContent.includes('Stop request was attempted'));
  assert.equal(await page.locator('#voiceIndicator').textContent(), 'Recording', await page.locator('#voiceStatus').textContent());
  await page.waitForTimeout(500);
  await page.locator('#voiceSaveBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('#voiceNotesList li').length === 1);
  assert.equal((await writes(page)).filter(item => item.type !== 'heartbeat').length, 0);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#voiceNotesList li').length === 1 && !document.getElementById('voiceRecordBtn').disabled);
  await ready(page);
  await page.evaluate(() => { window.__voice.available = 1024; });
  await page.locator('#voiceRecordBtn').click();
  await expectWrites(page, 'stop', 1);
  assert.equal(await page.evaluate(() => window.__voice.captures), 0);
  assert.match(await page.locator('#voiceStatus').textContent(), /Not enough/);
  assert.deepEqual(errors, []);
});

test('a lost microphone saves a partial voice note and requests a pad Stop', async t => {
  const { page, errors } = await createPage(t);
  await ready(page);
  await page.waitForFunction(() => !document.getElementById('voiceRecordBtn').disabled);
  await page.locator('#voiceRecordBtn').click();
  await page.waitForFunction(() => document.getElementById('voiceIndicator').textContent === 'Recording' || document.getElementById('voiceStatus').textContent.includes('Stop request was attempted'));
  assert.equal(await page.locator('#voiceIndicator').textContent(), 'Recording', await page.locator('#voiceStatus').textContent());
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__voice.track.onended());
  await expectWrites(page, 'stop', 1);
  await page.waitForFunction(() => document.querySelectorAll('#voiceNotesList li').length === 1);
  assert.match(await page.locator('#voiceNotesList').textContent(), /Partial \/ interrupted/);
  assert.equal(await page.evaluate(() => window.__voice.stoppedTracks), 1);
  assert.deepEqual(errors, []);
});
