/* Local Web Bluetooth UI. No telemetry upload, remote imports, or auto-start. */
(() => {
  'use strict';
  const C = globalThis.PitPatCore;
  const $ = id => document.getElementById(id);
  if (!C) {
    $('message').textContent = 'Controller files are missing. Upload controller-core.js and treadmill.js beside index.html, then reload.';
    $('message').dataset.kind = 'error';
    $('connectBtn').disabled = true;
    return;
  }

  const KEYS = { history: 'pitpat_local_v1_history', active: 'pitpat_local_v1_active', settings: 'pitpat_local_v1_settings' };
  const compatibleBrowser = Boolean(window.isSecureContext && navigator.bluetooth && window.top === window);
  const FRESH_MS = 5000;
  const HISTORY_LIMIT = 500;
  let history = [];
  const state = {
    epoch: 0, connecting: false, connected: false, gattReady: false, device: null, server: null,
    tx: null, rx: null, notificationHandler: null, disconnectedHandler: null,
    queue: null, releaseTabLock: null, latest: null, validCount: 0, lastValid: 0,
    sequence: 0, invalidReason: '', stale: false, intent: null, actionId: 0,
    selected: 1, usual: null, lastUserSpeedAt: -Infinity, tracker: new C.SessionTracker(),
    lastArchivedId: null, lastSavedAt: 0, lastHeartbeatAt: -Infinity,
    heartbeatPending: false, wake: null, wakePending: false, dragging: false,
    transportFault: false, notificationCount: 0, notificationShapes: []
  };

  function message(text, kind = '') {
    $('message').textContent = text;
    $('message').dataset.kind = kind;
  }

  function storageWarning(text) {
    $('storageWarning').textContent = text;
    $('storageWarning').hidden = false;
  }

  function renderDiagnostics() {
    $('notificationDiagnostics').value = [
      `PitPat connection diagnostics · build ${C.VERSION}`,
      `Notifications received: ${state.notificationCount}`,
      'Expected framing: 0x68, or 60-byte 0x67; declared length equals received bytes; trailer 0x43.',
      ...state.notificationShapes.map(item => `${item.count}× ${item.summary}\n${item.result}`)
    ].join('\n');
    $('copyDiagnosticsBtn').disabled = state.notificationCount === 0;
  }

  function recordNotification(value, result) {
    state.notificationCount += 1;
    let summary;
    try { summary = C.describeNotification(value); }
    catch (_) { summary = 'Notification did not contain a supported byte array.'; }
    const existing = state.notificationShapes.find(item => item.summary === summary && item.result === result);
    if (existing) existing.count += 1;
    else {
      state.notificationShapes.push({ summary, result, count: 1 });
      if (state.notificationShapes.length > 6) state.notificationShapes.shift();
    }
    renderDiagnostics();
  }

  function readJSON(key, fallback) {
    try {
      const text = localStorage.getItem(key);
      if (!text) return fallback;
      if (text.length > 2_000_000) throw new Error('Stored data is too large.');
      return JSON.parse(text);
    } catch (_) {
      storageWarning('Some saved data could not be read. Controls still work; export this session before closing the page.');
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      storageWarning('This browser could not save your data. Controls still work. Keep the page open and export a backup before leaving.');
    }
  }

  function saveSettings() {
    writeJSON(KEYS.settings, { selected: state.selected, usual: state.usual, keepAwake: $('keepAwake').checked });
  }

  function archive(record) {
    const safe = C.validateStoredRecord(record);
    if (!safe || (safe.status !== 'completed' && safe.status !== 'interrupted')) return;
    const existing = history.find(item => item.id === safe.id);
    if (existing && existing.status === 'completed' && safe.status === 'interrupted') return;
    history = [safe, ...history.filter(item => item.id !== safe.id)]
      .sort((a, b) => b.startedAt - a.startedAt).slice(0, HISTORY_LIMIT);
    state.lastArchivedId = safe.id;
    if (safe.status === 'completed' && safe.speedCoverageComplete && safe.activeSeconds >= 10 && safe.usualSpeedKmh !== null) {
      state.usual = C.normalizeSpeed(safe.usualSpeedKmh);
      state.selected = state.usual;
      saveSettings();
    }
    writeJSON(KEYS.history, history);
    writeJSON(KEYS.active, null);
    renderHistory();
  }

  function saveActive(force = false) {
    if (force || performance.now() - state.lastSavedAt >= 2000) {
      state.lastSavedAt = performance.now();
      writeJSON(KEYS.active, state.tracker.snapshot());
    }
  }

  function interruptRecord(reason) {
    const ended = state.tracker.interrupt(reason, Date.now());
    if (ended) archive(ended);
  }

  function formatTime(value) {
    const seconds = Math.max(0, Math.floor(value));
    const hours = Math.floor(seconds / 3600);
    return (hours ? `${hours}:` : '') + String(Math.floor(seconds / 60) % 60).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }

  function fresh() {
    return state.connected && !state.transportFault && !state.invalidReason && state.validCount >= 2 &&
      performance.now() - state.lastValid <= FRESH_MS && document.visibilityState === 'visible';
  }

  function maxSpeed() { return state.latest ? Math.min(6, state.latest.maxSpeed) : 6; }
  function linkWritable() { return state.connected && state.gattReady && state.server && state.server.connected && state.tx && state.queue && !state.queue.closed; }

  function render() {
    const live = fresh();
    const s = state.latest;
    const writable = Boolean(linkWritable());
    let connectionText = 'Disconnected';
    let kind = '';
    if (state.connecting) { connectionText = 'Connecting'; kind = 'busy'; }
    else if (state.connected) {
      if (state.invalidReason) { connectionText = 'Unsupported data'; kind = 'error'; }
      else if (state.stale) { connectionText = 'Live data lost'; kind = 'error'; }
      else if (live) { connectionText = 'Connected'; kind = 'ready'; }
      else { connectionText = 'Checking live data'; kind = 'busy'; }
    }
    $('connectionStatus').textContent = connectionText;
    $('connectionDot').dataset.kind = kind;
    $('connectBtn').textContent = state.connected ? 'Disconnect' : state.connecting ? 'Connecting…' : 'Connect';
    $('connectBtn').disabled = state.connecting || !compatibleBrowser;
    $('deviceName').textContent = state.device ? (state.device.name || 'Selected walking pad') : 'PitPat / SuperRun · up to 6 km/h';
    $('actualSpeed').textContent = live && s ? s.speed.toFixed(1) : '—';
    $('beltState').textContent = live && s ? ({ running: 'Walking', paused: 'Paused', stopped: 'Ready', countdown: 'Starting…' }[s.state]) : 'No live data';
    $('selectedSpeed').textContent = state.selected.toFixed(1);
    $('speedSlider').max = String(maxSpeed());
    if (!state.dragging) $('speedSlider').value = String(state.selected);
    $('upperBound').textContent = maxSpeed().toFixed(1);
    const adjustingBlocked = Boolean(state.intent) || (s && s.state === 'countdown' && live);
    $('speedSlider').disabled = adjustingBlocked;
    $('speedDownBtn').disabled = adjustingBlocked || state.selected <= 1;
    $('speedUpBtn').disabled = adjustingBlocked || state.selected >= maxSpeed();
    for (const button of document.querySelectorAll('[data-speed]')) {
      button.disabled = adjustingBlocked || Number(button.dataset.speed) > maxSpeed();
    }
    $('usualBtn').textContent = state.usual === null ? 'Usual —' : `Usual ${state.usual.toFixed(1)}`;
    $('usualBtn').disabled = adjustingBlocked || state.usual === null;
    $('targetLabel').textContent = live && s.state === 'running' ? 'Requested speed' : 'Selected speed';
    $('selectionNote').textContent = state.intent ? 'Waiting for the pad to confirm the command. Stop remains available.' :
      live && s.state === 'running' ? 'Speed buttons adjust the running belt. The large reading shows its actual speed.' :
      'Selecting a speed while stopped does not start the belt.';
    $('startBtn').disabled = !live || !writable || Boolean(state.intent) || s.state === 'countdown';
    $('startBtn').textContent = live && s.state === 'running' ? 'Pause' :
      live && s.state === 'paused' ? `Resume at ${state.selected.toFixed(1)}` :
      live && s.state === 'countdown' ? 'Starting…' : `Start at ${state.selected.toFixed(1)}`;
    // Stop intentionally does not depend on valid telemetry or page visibility.
    $('stopBtn').disabled = !writable;
    $('stopBtn').textContent = state.intent && state.intent.kind === 'stop' ? 'Stop again' : 'Stop';
    const record = state.tracker.snapshot() || state.tracker.lastCompleted;
    $('sessionTime').textContent = formatTime(record ? record.activeSeconds : 0);
    $('sessionDistance').textContent = record ? record.distanceKm.toFixed(2) : '0.00';
    $('sessionSteps').textContent = record ? record.steps.toLocaleString() : '0';
    $('sessionCalories').textContent = record ? Math.round(record.calories).toLocaleString() : '0';
    $('recordingStatus').textContent = record ? ({ active: 'Recording', paused: 'Paused', completed: 'Saved', interrupted: 'Partial' }[record.status]) : 'Waiting';
    $('recordNote').textContent = record && record.incomplete ? `Partial record. ${record.reason || 'Some activity was not observed.'}` :
      record && record.status === 'completed' ? 'Saved to this browser. Your usual speed is learned from observed walking time.' :
      'Recording begins when live data shows the belt running. Pause keeps the session open.';
    $('exportBtn').disabled = history.length === 0 && !state.tracker.active;
    $('telemetryStatus').textContent = state.invalidReason || (state.lastValid ? `${Math.max(0, (performance.now() - state.lastValid) / 1000).toFixed(1)} s since last valid frame` : 'None received');
    $('firmware').textContent = s ? String(s.firmware) : '—';
    $('reportedMax').textContent = s ? `${s.maxSpeed.toFixed(1)} km/h` : '—';
    $('panelUnits').textContent = s ? (s.panelImperial ? 'Imperial flag; this controller uses km/h' : 'Metric') : '—';
    $('rawTimer').textContent = s ? `${s.rawDuration} (raw; not used for tracked time)` : '—';
  }

  function renderHistory() {
    const list = $('historyList');
    list.replaceChildren();
    for (const item of history.slice(0, 10)) {
      const row = document.createElement('li');
      const description = document.createElement('div');
      const title = document.createElement('div'); title.className = 'title';
      title.textContent = new Date(item.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const detail = document.createElement('div'); detail.className = 'detail';
      const partial = item.incomplete || item.status === 'interrupted';
      if (partial) detail.classList.add('partial');
      detail.textContent = `${partial ? 'Partial · ' : ''}${item.steps.toLocaleString()} reported steps` +
        (item.usualSpeedKmh === null ? '' : ` · usual ${item.usualSpeedKmh.toFixed(1)} km/h`);
      description.append(title, detail);
      const numbers = document.createElement('div'); numbers.className = 'numbers';
      numbers.textContent = `${formatTime(item.activeSeconds)} · ${item.distanceKm.toFixed(2)} km`;
      row.append(description, numbers); list.append(row);
    }
    $('historyEmpty').hidden = history.length > 0;
    $('historyCaption').textContent = `${history.length ? `Showing ${Math.min(history.length, 10)} of ${history.length} saved walks. ` : ''}Stored only in this browser (up to 500 records). Export a backup before clearing site data.`;
    $('exportBtn').disabled = history.length === 0 && !state.tracker.active;
  }

  function handleCommandError(error, epoch, actionId) {
    if (epoch !== state.epoch || error.code === 'CANCELLED') return;
    if (actionId && actionId !== state.actionId) return;
    if (error.code === 'GUARD') {
      message('The state changed before the command could be sent. Check the live data, then choose the action again.', 'warning');
      if (state.intent && state.intent.kind !== 'stop') state.intent = null;
    } else message('Bluetooth could not confirm the write. Use the physical remote if the belt is moving, then reconnect.', 'error');
    render();
  }

  function sendHeartbeat(epoch) {
    const now = performance.now();
    if (epoch !== state.epoch || !linkWritable() || state.heartbeatPending || now - state.lastHeartbeatAt < 500) return;
    state.lastHeartbeatAt = now;
    state.heartbeatPending = true;
    const queue = state.queue;
    queue.send('heartbeat', C.makePacket('heartbeat')).catch(error => handleCommandError(error, epoch))
      .finally(() => { if (epoch === state.epoch) state.heartbeatPending = false; });
  }

  function observe(event, epoch) {
    if (epoch !== state.epoch || !state.connected) return;
    // Transport is independent of rendering/storage failures.
    sendHeartbeat(epoch);
    let sample;
    try { sample = C.parseTelemetry(event.target.value); }
    catch (error) {
      recordNotification(event.target.value, error.message);
      state.invalidReason = error.message;
      state.validCount = 0;
      state.queue.discardPending('Unsupported telemetry.');
      interruptRecord('Unsupported telemetry interrupted the recording.');
      message(`${error.message} Stop can still be attempted while connected. Open Connection details below and copy the diagnostics.`, 'warning');
      render();
      return;
    }
    recordNotification(event.target.value, 'Compatible status accepted.');
    const now = performance.now();
    const previous = state.latest;
    const wasFresh = fresh();
    if (state.lastValid && now - state.lastValid > FRESH_MS) {
      state.validCount = 0;
      state.queue.discardPending('A gap interrupted live telemetry.');
    }
    state.latest = sample;
    state.lastValid = now;
    state.sequence += 1;
    state.invalidReason = '';
    state.stale = false;
    state.validCount = document.visibilityState === 'visible' ? Math.min(2, state.validCount + 1) : 0;
    state.selected = C.normalizeSpeed(state.selected, sample.maxSpeed);

    // Follow a physical-remote change only after our last target has settled.
    if (sample.state === 'running' && !state.intent && !state.dragging && now - state.lastUserSpeedAt > 2000 && sample.targetSpeed >= 1) {
      state.selected = C.normalizeSpeed(sample.targetSpeed, sample.maxSpeed);
    }
    const intent = state.intent;
    if (intent && intent.written && state.sequence > intent.sequence) {
      const confirmed = intent.kind === 'start' ? sample.state === 'running' :
        intent.kind === 'pause' ? sample.state === 'paused' && sample.speed <= 0.1 :
        sample.state === 'stopped' && sample.speed <= 0.1;
      if (confirmed) {
        state.intent = null;
        message(intent.kind === 'start' ? 'The pad reports it is running.' : intent.kind === 'pause' ? 'The pad reports it is paused.' : 'The pad reports it has stopped.');
      }
    }
    if (document.visibilityState === 'visible') {
      try {
        state.tracker.update(sample, now, Date.now());
        const ended = state.tracker.lastCompleted;
        if (ended && ended.id !== state.lastArchivedId) archive(ended);
        saveActive(!previous || previous.state !== sample.state);
      } catch (_) {
        interruptRecord('Recording encountered an unexpected value.');
        storageWarning('Recording was interrupted by unexpected data. The Bluetooth controls remain separate from recording.');
      }
    }
    if (!wasFresh && fresh() && !state.intent) message('Live data received. Compare the speed with the pad’s display before your first start.');
    render();
  }

  async function acquireTabLock() {
    if (!navigator.locks) return () => {};
    return new Promise((resolve, reject) => {
      navigator.locks.request('pitpat-local-bluetooth', { ifAvailable: true }, async lock => {
        if (!lock) { reject(new Error('Another tab is using this controller. Disconnect it or close that tab first.')); return; }
        await new Promise(release => resolve(release));
      }).catch(reject);
    });
  }

  function teardown(reason, announce = true) {
    const oldDevice = state.device;
    state.epoch += 1;
    if (state.queue) state.queue.cancel(reason);
    if (state.rx && state.notificationHandler) state.rx.removeEventListener('characteristicvaluechanged', state.notificationHandler);
    if (oldDevice && state.disconnectedHandler) oldDevice.removeEventListener('gattserverdisconnected', state.disconnectedHandler);
    interruptRecord(reason);
    if (state.releaseTabLock) state.releaseTabLock();
    state.releaseTabLock = null;
    state.connected = false;
    state.gattReady = false;
    state.connecting = false;
    state.queue = null;
    state.tx = null;
    state.rx = null;
    state.server = null;
    state.device = null;
    state.latest = null;
    state.validCount = 0;
    state.lastValid = 0;
    state.sequence = 0;
    state.invalidReason = '';
    state.stale = false;
    state.intent = null;
    state.heartbeatPending = false;
    state.lastHeartbeatAt = -Infinity;
    state.notificationHandler = null;
    state.disconnectedHandler = null;
    try { if (oldDevice && oldDevice.gatt.connected) oldDevice.gatt.disconnect(); } catch (_) { /* Link may already be gone. */ }
    void updateWakeLock();
    if (announce) message(`${reason} Reconnect when ready. Disconnecting does not guarantee the belt has stopped.`, 'warning');
    render();
  }

  async function connect() {
    if (state.connecting || state.connected) return;
    if (!compatibleBrowser) {
      message('Open the published HTTPS address directly in Chrome on your Pixel. This preview cannot access Bluetooth.', 'error');
      return;
    }
    const epoch = ++state.epoch;
    state.notificationCount = 0;
    state.notificationShapes = [];
    renderDiagnostics();
    state.connecting = true;
    state.transportFault = false;
    render();
    message('Choose your walking pad in Chrome’s Bluetooth chooser.');
    let selectedDevice = null;
    let heldLock = null;
    let connectionTimer = null;
    try {
      // Call from the click handler before awaits: requestDevice needs a gesture.
      selectedDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [C.SERVICE_UUID] }, { namePrefix: 'PitPat' }],
        optionalServices: [C.SERVICE_UUID]
      });
      if (epoch !== state.epoch) return;
      connectionTimer = setTimeout(() => {
        if (epoch !== state.epoch || state.gattReady) return;
        teardown('The Bluetooth connection attempt timed out.', false);
        message('Connection timed out. Close PitPat, switch the pad off and on, then try Connect again.', 'warning');
      }, 20000);
      heldLock = await acquireTabLock();
      if (epoch !== state.epoch) { heldLock(); return; }
      state.releaseTabLock = heldLock;
      state.device = selectedDevice;
      state.disconnectedHandler = () => { if (epoch === state.epoch) teardown('Bluetooth connection lost. Use the physical remote if needed.'); };
      selectedDevice.addEventListener('gattserverdisconnected', state.disconnectedHandler);
      const server = await selectedDevice.gatt.connect();
      if (epoch !== state.epoch) {
        if ((!state.device || state.device.id !== selectedDevice.id) && server.connected) server.disconnect();
        return;
      }
      state.server = server;
      const service = await server.getPrimaryService(C.SERVICE_UUID);
      const tx = await service.getCharacteristic(C.WRITE_UUID);
      const rx = await service.getCharacteristic(C.NOTIFY_UUID);
      if (epoch !== state.epoch) return;
      if (typeof tx.writeValueWithResponse !== 'function' || !tx.properties.write) {
        throw new Error('The selected pad does not expose the expected write-with-response characteristic.');
      }
      state.tx = tx;
      state.rx = rx;
      state.connected = true;
      state.connecting = false;
      state.queue = new C.CommandQueue(async packet => {
        if (epoch !== state.epoch || !state.connected || !server.connected) throw new Error('Connection changed.');
        await tx.writeValueWithResponse(packet);
      }, { timeoutMs: 2500, onFault: error => {
        if (epoch !== state.epoch) return;
        state.transportFault = true;
        teardown('Bluetooth command outcome is uncertain.', false);
        message(`${error.message} Use the physical remote if the belt is moving.`, 'error');
      } });
      state.queue.setMotionGuard((type, packet) => {
        if (epoch !== state.epoch || !fresh() || !state.latest) return false;
        if (type === 'start' || type === 'set_speed') {
          const requested = ((packet[6] << 8) | packet[7]) / 1000;
          if (requested < 1 || requested > maxSpeed()) return false;
        }
        if (type === 'start') return state.intent && state.intent.kind === 'start' && ['stopped', 'paused'].includes(state.latest.state);
        if (type === 'pause') return state.intent && state.intent.kind === 'pause' && state.latest.state === 'running';
        return !state.intent && state.latest.state === 'running';
      });
      state.notificationHandler = event => observe(event, epoch);
      rx.addEventListener('characteristicvaluechanged', state.notificationHandler);
      await rx.startNotifications();
      if (epoch !== state.epoch) return;
      state.gattReady = true;
      sendHeartbeat(epoch);
      message(fresh() ? 'Live data received. Compare the speed with the pad’s display before your first start.' : 'Connected. Waiting for two compatible live readings; no movement command has been sent.');
      void updateWakeLock();
      render();
    } catch (error) {
      if (epoch !== state.epoch) return;
      teardown('Connection attempt ended.', false);
      message(error.name === 'NotFoundError' ? 'No device selected. Switch the pad on and close PitPat, then try Connect again.' :
        `Could not connect: ${error.message || error}. Check Bluetooth and Chrome’s Nearby devices permission.`, 'warning');
    } finally { if (connectionTimer) clearTimeout(connectionTimer); }
  }

  function chooseSpeed(value) {
    if (state.intent || (fresh() && state.latest.state === 'countdown')) return;
    state.selected = C.normalizeSpeed(value, maxSpeed());
    saveSettings();
    render();
    if (!fresh() || state.latest.state !== 'running' || !linkWritable()) return;
    const epoch = state.epoch;
    const actionId = ++state.actionId;
    state.lastUserSpeedAt = performance.now();
    const valueSent = state.selected;
    message(`Requesting ${valueSent.toFixed(1)} km/h. Watch the actual belt-speed reading.`);
    state.queue.send('set_speed', C.makePacket('set_speed', valueSent)).then(() => {
      if (epoch === state.epoch && actionId === state.actionId) message(`Speed command sent for ${valueSent.toFixed(1)} km/h. The actual belt speed may ramp gradually.`);
    }).catch(error => handleCommandError(error, epoch, actionId));
  }

  function control(kind) {
    if (!linkWritable()) return;
    if (kind !== 'stop' && (!fresh() || state.intent)) return;
    if (kind === 'start' && !['stopped', 'paused'].includes(state.latest.state)) return;
    if (kind === 'pause' && state.latest.state !== 'running') return;
    const epoch = state.epoch;
    const actionId = ++state.actionId;
    const intent = { kind, sequence: state.sequence, startedAt: performance.now(), written: false, warned: false };
    state.intent = intent;
    state.lastUserSpeedAt = performance.now();
    render();
    message(kind === 'stop' ? 'Sending Stop. Waiting for the pad to report stopped.' : kind === 'pause' ? 'Sending Pause. Waiting for the pad to report paused.' : `Starting at ${state.selected.toFixed(1)} km/h. Waiting for the pad’s live state.`);
    state.queue.send(kind, C.makePacket(kind, state.selected)).then(() => {
      if (epoch === state.epoch && state.intent === intent) intent.written = true;
    }).catch(error => {
      if (epoch === state.epoch && state.intent === intent && error.code === 'CANCELLED') state.intent = null;
      handleCommandError(error, epoch, actionId);
      render();
    });
  }

  async function updateWakeLock() {
    const wanted = $('keepAwake').checked && state.connected && document.visibilityState === 'visible';
    if (!wanted) {
      const previous = state.wake;
      state.wake = null;
      if (previous) { try { await previous.release(); } catch (_) {} }
      $('wakeStatus').textContent = $('keepAwake').checked ? 'Requested when connected and visible.' : 'Off. Keep the screen open yourself while walking.';
      return;
    }
    if (!navigator.wakeLock) { $('wakeStatus').textContent = 'Unavailable here. Keep this screen open manually.'; return; }
    if (state.wake || state.wakePending) return;
    state.wakePending = true;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!state.connected || !$('keepAwake').checked || document.visibilityState !== 'visible') { await sentinel.release(); return; }
      state.wake = sentinel;
      $('wakeStatus').textContent = 'Screen awake. Switching apps can still interrupt control.';
      sentinel.addEventListener('release', () => {
        if (state.wake !== sentinel) return;
        state.wake = null;
        $('wakeStatus').textContent = 'Wake lock released. Keep the screen open; toggle this to request again.';
      });
    } catch (_) { $('wakeStatus').textContent = 'Chrome declined the wake lock. Keep the screen open manually.'; }
    finally { state.wakePending = false; }
  }

  function suspendObservation(reason) {
    if (state.queue) state.queue.discardPending(reason);
    state.validCount = 0;
    interruptRecord(reason);
    // A write already in flight cannot be canceled; never imply an auto-stop.
    if (state.connected) message('Recording was interrupted while this page was hidden. Wait for fresh data. The belt may still be moving.', 'warning');
    render();
  }

  $('connectBtn').addEventListener('click', () => {
    if (state.connected) teardown('Disconnected by you.');
    else void connect();
  });
  $('startBtn').addEventListener('click', () => control(fresh() && state.latest.state === 'running' ? 'pause' : 'start'));
  $('stopBtn').addEventListener('click', () => control('stop'));
  $('speedUpBtn').addEventListener('click', () => chooseSpeed(state.selected + 0.1));
  $('speedDownBtn').addEventListener('click', () => chooseSpeed(state.selected - 0.1));
  for (const button of document.querySelectorAll('[data-speed]')) button.addEventListener('click', () => chooseSpeed(Number(button.dataset.speed)));
  $('usualBtn').addEventListener('click', () => { if (state.usual !== null) chooseSpeed(state.usual); });
  $('speedSlider').addEventListener('input', () => {
    state.dragging = true;
    $('selectedSpeed').textContent = Number($('speedSlider').value).toFixed(1);
  });
  $('speedSlider').addEventListener('change', () => { state.dragging = false; chooseSpeed(Number($('speedSlider').value)); });
  $('speedSlider').addEventListener('blur', () => { state.dragging = false; render(); });
  $('keepAwake').addEventListener('change', () => { saveSettings(); void updateWakeLock(); });
  document.addEventListener('pitpat-voice-interrupted', () => {
    if (linkWritable()) {
      control('stop');
      message('Voice recording was interrupted. Sending Stop; waiting for the pad to report stopped.', 'warning');
    } else message('Voice recording was interrupted. Stop could not be sent over Bluetooth. Use the physical remote if the belt is moving.', 'warning');
  });
  $('copyDiagnosticsBtn').addEventListener('click', async () => {
    const text = $('notificationDiagnostics').value;
    try {
      await navigator.clipboard.writeText(text);
      $('diagnosticsStatus').textContent = 'Diagnostics copied. Paste them into the support conversation.';
    } catch (_) {
      $('notificationDiagnostics').focus();
      $('notificationDiagnostics').select();
      $('diagnosticsStatus').textContent = 'Select and copy the diagnostics text above.';
    }
  });
  $('exportBtn').addEventListener('click', () => {
    const current = state.tracker.snapshot();
    const payload = { format: 'pitpat-local-history', version: C.VERSION, exportedAt: new Date().toISOString(),
      note: 'Observed activity only. Incomplete records exclude gaps. Device steps/calories may be estimates.',
      sessions: current ? [current, ...history.filter(item => item.id !== current.id)] : history };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `walking-pad-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') suspendObservation('The controller page was hidden; unseen activity is not included.');
    else { state.validCount = 0; render(); }
    void updateWakeLock();
  });
  document.addEventListener('freeze', () => suspendObservation('Chrome suspended the controller page.'));
  window.addEventListener('pagehide', () => {
    // Let an active voice recorder request Stop while this GATT link exists.
    document.dispatchEvent(new Event('pitpat-before-bluetooth-teardown'));
    teardown('The controller page was closed or navigated away.', false);
  });
  setInterval(() => {
    if (state.connected && state.lastValid && performance.now() - state.lastValid > FRESH_MS && !state.stale) {
      state.stale = true; state.validCount = 0;
      state.queue.discardPending('Live data became stale.');
      interruptRecord('Live data stopped arriving; unseen activity is not included.');
      message('Live data is stale. Movement controls are disabled. You can attempt Stop, or use the physical remote.', 'warning');
    }
    if (state.intent && performance.now() - state.intent.startedAt > 8000 && !state.intent.warned) {
      state.intent.warned = true;
      message('The command’s effect has not been confirmed by live data. Use Stop or the physical remote if needed.', 'warning');
    }
    render();
  }, 1000);

  const settings = readJSON(KEYS.settings, {});
  if (settings && typeof settings === 'object') {
    if (typeof settings.selected === 'number' && Number.isFinite(settings.selected)) state.selected = C.normalizeSpeed(settings.selected);
    if (typeof settings.usual === 'number' && settings.usual >= 1 && settings.usual <= 6) state.usual = C.normalizeSpeed(settings.usual);
    if (typeof settings.keepAwake === 'boolean') $('keepAwake').checked = settings.keepAwake;
  }
  const stored = readJSON(KEYS.history, []);
  if (Array.isArray(stored)) {
    const records = stored.slice(0, HISTORY_LIMIT).map(C.validateStoredRecord).filter(record => record && ['completed', 'interrupted'].includes(record.status));
    history = Array.from(new Map(records.map(record => [record.id, record])).values()).sort((a, b) => b.startedAt - a.startedAt);
  }
  const unfinished = C.validateStoredRecord(readJSON(KEYS.active, null));
  if (unfinished && ['active', 'paused'].includes(unfinished.status)) {
    archive({ ...unfinished, status: 'interrupted', incomplete: true, endedAt: Math.max(unfinished.startedAt, Date.now()), reason: 'The previous page closed or reloaded; unseen activity is not included.' });
  }
  $('buildVersion').textContent = `Improved ${C.VERSION} · upstream 17f94a6`;
  renderDiagnostics();
  renderHistory();
  render();
  if (!compatibleBrowser) message('Open the published HTTPS address directly in Chrome on Android. Bluetooth is unavailable in this browser or embedded preview.', 'warning');
})();
