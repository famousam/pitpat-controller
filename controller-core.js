/*
 * PitPat WebBT — improved controller core, version 1.1.0.
 * Protocol interoperability based on KeiranY/PitPat-WebBT (Unlicense) and
 * the documented BA09-B packet vectors in heilmic/treadmill-tray.
 * No hardware validation is implied. Receive checksums are NOT verified:
 * the FBA notification checksum is not sufficiently established upstream.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PitPatCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.1.0';
  const SERVICE_UUID = '0000fba0-0000-1000-8000-00805f9b34fb';
  const WRITE_UUID = '0000fba1-0000-1000-8000-00805f9b34fb';
  const NOTIFY_UUID = '0000fba2-0000-1000-8000-00805f9b34fb';
  const MIN_SPEED = 1;
  const MAX_SPEED = 6;
  const STEP = 0.1;
  const TYPES = new Set(['start', 'set_speed', 'pause', 'stop', 'heartbeat']);
  const STATES = new Set(['countdown', 'running', 'paused', 'stopped']);

  function error(code, message) {
    const result = new Error(message);
    result.code = code;
    return result;
  }

  function finiteNumber(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`${name} must be a finite number.`);
    }
    return value;
  }

  function normalizeSpeed(value, max = MAX_SPEED) {
    finiteNumber(value, 'Speed');
    finiteNumber(max, 'Maximum speed');
    if (max < MIN_SPEED) throw new RangeError('Maximum speed is below 1 km/h.');
    // Round the upper bound down so rounding never exceeds the device limit.
    const upper = Math.floor(Math.min(max, MAX_SPEED) * 10 + 1e-8) / 10;
    return Math.min(upper, Math.max(MIN_SPEED, Math.round(value * 10) / 10));
  }

  function makePacket(type, speed = MIN_SPEED) {
    if (!TYPES.has(type)) throw new TypeError('Unknown treadmill command.');
    if (type === 'heartbeat') return new Uint8Array([0x6a, 0x05, 0xfd, 0xf8, 0x43]);
    const moving = type === 'start' || type === 'set_speed';
    const wireSpeed = moving ? Math.round(normalizeSpeed(speed) * 1000) : 0;
    const packet = new Uint8Array(23);
    packet[0] = 0x6a;
    packet[1] = 0x17;
    packet[6] = (wireSpeed >>> 8) & 0xff;
    packet[7] = wireSpeed & 0xff;
    packet[8] = type === 'set_speed' ? 5 : 1;
    packet[10] = 80; // Upstream protocol default; not a personal calorie estimate.
    packet[12] = type === 'pause' ? 2 : type === 'stop' ? 0 : 4;
    const userId = 58965456623n; // Fixed protocol value; no PitPat account needed.
    for (let i = 0; i < 8; i += 1) {
      packet[13 + i] = Number((userId >> BigInt(56 - i * 8)) & 0xffn);
    }
    for (let i = 1; i <= 20; i += 1) packet[21] ^= packet[i];
    packet[22] = 0x43;
    return packet;
  }

  function notificationView(input) {
    if (input instanceof DataView) return input;
    if (input instanceof Uint8Array) return new DataView(input.buffer, input.byteOffset, input.byteLength);
    throw error('FORMAT', 'Expected a Bluetooth notification byte array.');
  }

  // Describe framing only. Do not expose payloads, device serials, or counters.
  function describeNotification(input) {
    const view = notificationView(input);
    const size = view.byteLength;
    const byte = offset => offset >= 0 && offset < size ? `0x${view.getUint8(offset).toString(16).padStart(2, '0')}` : 'missing';
    return `${size} bytes; header ${byte(0)}; declared length ${size > 1 ? view.getUint8(1) : 'missing'}; trailer ${byte(size - 1)}`;
  }

  function parseTelemetry(input) {
    const view = notificationView(input);
    const size = view.byteLength;
    if (size < 31 || size > 255) {
      throw error('FORMAT', 'Unsupported or incomplete treadmill notification length.');
    }
    // This PitPat-T01 firmware was observed sending a 60-byte 0x67 frame
    // with the same status-field offsets. Keep other 0x67 lengths blocked.
    const knownHeader = view.getUint8(0) === 0x68 || (view.getUint8(0) === 0x67 && size === 60);
    if (!knownHeader || view.getUint8(1) !== size || view.getUint8(size - 1) !== 0x43) {
      throw error('FORMAT', 'Unrecognized treadmill frame; movement controls remain disabled.');
    }
    const speed = view.getUint16(3, false) / 1000;
    const targetSpeed = view.getUint16(5, false) / 1000;
    const maxSpeed = view.getUint16(27, false) / 1000;
    if (speed > MAX_SPEED || targetSpeed > MAX_SPEED || maxSpeed < MIN_SPEED || maxSpeed > MAX_SPEED) {
      throw error('MODEL', 'Reported speed or maximum is outside this 1–6 km/h controller profile.');
    }
    const flags = view.getUint8(26);
    const state = { 0x18: 'countdown', 0x08: 'running', 0x10: 'paused', 0: 'stopped' }[flags & 0x18];
    return {
      state,
      speed,
      targetSpeed,
      maxSpeed,
      distanceKm: view.getUint32(7, false) / 1000,
      steps: view.getUint32(14, false),
      calories: view.getUint16(18, false),
      rawDuration: view.getUint32(20, false),
      cycleId: view.getUint8(24),
      firmware: view.getUint8(25),
      flags,
      panelImperial: Boolean(flags & 0x80)
    };
  }

  /**
   * One queue belongs to one GATT connection. cancel() closes it permanently.
   * A timeout faults the queue; it NEVER releases the queue to make another
   * write while the timed-out platform operation might still be in progress.
   * An already transmitted command cannot be recalled by any software queue.
   */
  class CommandQueue {
    constructor(writeFn, { timeoutMs = 2500, onFault = () => {} } = {}) {
      if (typeof writeFn !== 'function' || typeof onFault !== 'function') throw new TypeError('Invalid queue callbacks.');
      finiteNumber(timeoutMs, 'Write timeout');
      if (timeoutMs <= 0) throw new RangeError('Write timeout must be positive.');
      this._write = writeFn;
      this._timeout = timeoutMs;
      this._onFault = onFault;
      this._guard = () => true;
      this._pending = [];
      this._flight = null;
      this._closed = null;
    }

    get closed() { return Boolean(this._closed); }
    get busy() { return Boolean(this._flight || this._pending.length); }

    setMotionGuard(fn) {
      if (typeof fn !== 'function') throw new TypeError('Motion guard must be a function.');
      this._guard = fn;
    }

    _settle(item, problem) {
      if (item.settled) return;
      item.settled = true;
      if (problem) item.reject(problem);
      else item.resolve();
    }

    _removePending(predicate, message) {
      const keep = [];
      for (const item of this._pending) {
        if (predicate(item)) this._settle(item, error('CANCELLED', message));
        else keep.push(item);
      }
      this._pending = keep;
    }

    _barrier() {
      return [this._flight, ...this._pending].find(item => item && (item.type === 'stop' || item.type === 'pause'));
    }

    send(type, packet) {
      if (this._closed) return Promise.reject(error('CANCELLED', 'Connection queue is closed; reconnect explicitly.'));
      if (!TYPES.has(type) || !(packet instanceof Uint8Array)) return Promise.reject(new TypeError('Invalid queued command.'));
      const all = [this._flight, ...this._pending].filter(Boolean);
      if (type === 'stop') {
        const existing = all.find(item => item.type === 'stop');
        if (existing) return existing.promise;
        this._removePending(() => true, 'Superseded by Stop.');
      } else if (type === 'pause') {
        if (all.some(item => item.type === 'stop')) return Promise.reject(error('CANCELLED', 'Stop is already pending.'));
        const existing = all.find(item => item.type === 'pause');
        if (existing) return existing.promise;
        this._removePending(item => item.type !== 'stop', 'Superseded by Pause.');
      } else {
        if (this._barrier()) return Promise.reject(error('CANCELLED', 'Wait for the pending Stop or Pause.'));
        if (type === 'set_speed') this._removePending(item => item.type === 'set_speed', 'Replaced by the latest selected speed.');
        if (type === 'heartbeat') {
          const existing = this._pending.find(item => item.type === 'heartbeat');
          if (existing) return existing.promise;
        }
        if (type === 'start') {
          const existing = all.find(item => item.type === 'start');
          if (existing) return existing.promise;
        }
      }
      let resolve;
      let reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const item = { type, packet: new Uint8Array(packet), resolve, reject, promise, settled: false, timer: null };
      if (type === 'stop' || type === 'pause') this._pending.unshift(item);
      else this._pending.push(item);
      this._pump();
      return promise;
    }

    _pump() {
      if (this._closed || this._flight) return;
      while (this._pending.length) {
        const item = this._pending.shift();
        if (item.type === 'start' || item.type === 'set_speed' || item.type === 'pause') {
          try {
            if (this._guard(item.type, item.packet) !== true) throw error('GUARD', 'Fresh compatible treadmill state is required.');
          } catch (problem) {
            this._settle(item, problem instanceof Error ? problem : error('GUARD', 'Movement guard rejected the command.'));
            continue;
          }
        }
        this._flight = item;
        item.timer = setTimeout(() => this._fault(error('TIMEOUT', 'Bluetooth write timed out. Use the physical remote; reconnect before sending more commands.')), this._timeout);
        try {
          const result = this._write(item.packet, item.type);
          Promise.resolve(result).then(() => this._finish(item), problem => this._finish(item, problem));
        } catch (problem) {
          this._finish(item, problem);
        }
        return;
      }
    }

    _finish(item, problem) {
      clearTimeout(item.timer);
      if (this._flight !== item) return;
      if (this._closed) {
        this._flight = null;
        return;
      }
      if (problem) {
        const failure = error('WRITE_FAILED', `Bluetooth write failed: ${String(problem.message || problem)}`);
        this._fault(failure);
        return;
      }
      this._settle(item);
      this._flight = null;
      this._pump();
    }

    _fault(problem) {
      if (this._closed) return;
      this._closed = problem;
      if (this._flight) {
        clearTimeout(this._flight.timer);
        this._settle(this._flight, problem);
      }
      for (const item of this._pending) this._settle(item, problem);
      this._pending = [];
      try { this._onFault(problem); } catch (_) { /* A consumer callback cannot reopen or drain a failed queue. */ }
    }

    cancel(reason = 'Bluetooth connection ended.') {
      if (this._closed) return;
      this._closed = error('CANCELLED', String(reason));
      if (this._flight) {
        clearTimeout(this._flight.timer);
        this._settle(this._flight, this._closed);
      }
      for (const item of this._pending) this._settle(item, this._closed);
      this._pending = [];
    }

    discardPending(reason = 'Queued commands discarded.', { keepStop = true } = {}) {
      // Used when the page is hidden or telemetry becomes stale. An explicit
      // Stop may remain queued, but stale movement must never survive a gap.
      this._removePending(item => !(keepStop && item.type === 'stop'), String(reason));
    }
  }

  let sessionCounter = 0;
  const rounded = (value, places = 3) => Math.round(value * (10 ** places)) / (10 ** places);
  const cleanReason = value => typeof value === 'string' ? value.replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, 160) : '';

  function validateStoredRecord(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const statuses = new Set(['active', 'paused', 'completed', 'interrupted']);
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(input.id) || !statuses.has(input.status)) return null;
    const bounded = (value, lower, upper) => typeof value === 'number' && Number.isFinite(value) && value >= lower && value <= upper;
    if (!bounded(input.startedAt, 0, 8.64e15)) return null;
    const endedAt = input.endedAt === null || input.endedAt === undefined ? null : input.endedAt;
    if (endedAt !== null && !bounded(endedAt, input.startedAt, 8.64e15)) return null;
    if ((input.status === 'completed' || input.status === 'interrupted') && endedAt === null) return null;
    if (!bounded(input.activeSeconds, 0, 604800) || !bounded(input.distanceKm, 0, 10000) ||
        !bounded(input.steps, 0, 10000000) || !Number.isInteger(input.steps) ||
        !bounded(input.calories, 0, 1000000) || !bounded(input.meanSpeedKmh, 0, MAX_SPEED)) return null;
    const usualSpeedKmh = input.usualSpeedKmh === null || input.usualSpeedKmh === undefined ? null : input.usualSpeedKmh;
    if (usualSpeedKmh !== null && !bounded(usualSpeedKmh, MIN_SPEED, MAX_SPEED)) return null;
    return {
      id: input.id,
      startedAt: input.startedAt,
      endedAt,
      status: input.status,
      incomplete: input.incomplete === true,
      speedCoverageComplete: input.speedCoverageComplete === true,
      activeSeconds: rounded(input.activeSeconds),
      distanceKm: rounded(input.distanceKm, 6),
      steps: input.steps,
      calories: rounded(input.calories),
      usualSpeedKmh: usualSpeedKmh === null ? null : normalizeSpeed(usualSpeedKmh),
      meanSpeedKmh: rounded(input.meanSpeedKmh),
      reason: cleanReason(input.reason)
    };
  }

  /**
   * Tracks only observed intervals and counter increments. No duration-unit
   * assumptions, estimates across missing notifications, or merging across
   * disconnects. A pause preserves the session; Stop closes it. The phone must
   * remain active and receive telemetry for complete observed records.
   */
  class SessionTracker {
    constructor() {
      this._current = null;
      this._previous = null;
      this._lastCompleted = null;
    }

    get active() { return this._current !== null; }
    get lastCompleted() { return this._lastCompleted ? { ...this._lastCompleted } : null; }

    _begin(sample, previous, nowMs, wallMs) {
      const fresh = previous && nowMs - previous.nowMs >= 0 && nowMs - previous.nowMs <= 5000;
      const knownStart = fresh && (previous.sample.state === 'stopped' || previous.sample.state === 'countdown') &&
        previous.sample.cycleId === sample.cycleId;
      sessionCounter += 1;
      this._current = {
        id: `walk-${Math.trunc(wallMs)}-${sessionCounter}-${Math.random().toString(36).slice(2, 9)}`,
        startedAt: wallMs,
        endedAt: null,
        status: 'active',
        incomplete: !knownStart,
        speedCoverageComplete: Boolean(knownStart),
        activeSeconds: 0,
        distanceKm: 0,
        steps: 0,
        calories: 0,
        reason: knownStart ? '' : 'Joined an already running workout; earlier activity is not included.',
        speedIntegral: 0,
        buckets: new Map()
      };
      // The current reading is the baseline when joining an ongoing workout.
      // With an observed start, capture the first observable counter increment.
      if (knownStart) this._addCounters(previous.sample, sample, nowMs - previous.nowMs);
    }

    _markIncomplete(reason, speedCoverageAffected = false) {
      if (!this._current) return;
      this._current.incomplete = true;
      if (speedCoverageAffected) this._current.speedCoverageComplete = false;
      if (!this._current.reason) this._current.reason = reason;
    }

    _addCounters(previous, sample, elapsedMs) {
      if (previous.cycleId !== sample.cycleId) {
        this._markIncomplete('Treadmill session counter changed; the new reading was used as a baseline.', true);
        return;
      }
      const distance = sample.distanceKm - previous.distanceKm;
      const steps = sample.steps - previous.steps;
      const calories = sample.calories - previous.calories;
      if (distance < -1e-8 || steps < 0 || calories < 0) {
        this._markIncomplete('Treadmill counters reset; the last recorded totals were preserved.');
        return;
      }
      const seconds = Math.max(0, elapsedMs) / 1000;
      // Wide plausibility margins permit coarse device counters without
      // accepting enormous jumps from corrupted or unrelated notifications.
      if (distance > MAX_SPEED * seconds / 3600 + 0.02 || steps > Math.max(20, seconds * 10) || calories > Math.max(10, seconds)) {
        this._markIncomplete('A counter jump was excluded from this record.');
        return;
      }
      this._current.distanceKm += Math.max(0, distance);
      this._current.steps += steps;
      this._current.calories += calories;
    }

    update(sample, nowMs, wallMs = Date.now()) {
      finiteNumber(nowMs, 'Monotonic time');
      finiteNumber(wallMs, 'Wall time');
      if (!sample || !STATES.has(sample.state) || !Number.isFinite(sample.speed) || sample.speed < 0 || sample.speed > MAX_SPEED ||
          !Number.isFinite(sample.distanceKm) || sample.distanceKm < 0 || !Number.isInteger(sample.steps) || sample.steps < 0 ||
          !Number.isFinite(sample.calories) || sample.calories < 0 || !Number.isInteger(sample.cycleId)) {
        throw new TypeError('Invalid session telemetry.');
      }
      const previous = this._previous;
      if (!this._current) {
        if (sample.state === 'running') this._begin(sample, previous, nowMs, wallMs);
      } else if (previous) {
        const elapsedMs = nowMs - previous.nowMs;
        if (elapsedMs < 0 || elapsedMs > 5000) {
          this._markIncomplete('A telemetry gap was excluded from this record.', true);
        } else {
          if (previous.sample.state === 'running') {
            const seconds = elapsedMs / 1000;
            this._current.activeSeconds += seconds;
            this._current.speedIntegral += previous.sample.speed * seconds;
            if (previous.sample.speed > 0 && seconds > 0) {
              const bucket = normalizeSpeed(previous.sample.speed);
              this._current.buckets.set(bucket, (this._current.buckets.get(bucket) || 0) + seconds);
            }
          }
          this._addCounters(previous.sample, sample, elapsedMs);
        }
      }
      this._previous = { sample: { ...sample }, nowMs, wallMs };
      if (this._current) {
        if (sample.state === 'stopped') return this._finish('completed', wallMs);
        this._current.status = sample.state === 'paused' ? 'paused' : 'active';
      }
      return this.snapshot();
    }

    snapshot() {
      const current = this._current;
      if (!current) return null;
      let usualSpeedKmh = null;
      let largest = 0;
      for (const [speed, seconds] of current.buckets) {
        if (seconds > largest || (seconds === largest && (usualSpeedKmh === null || speed < usualSpeedKmh))) {
          largest = seconds;
          usualSpeedKmh = speed;
        }
      }
      return {
        id: current.id,
        startedAt: current.startedAt,
        endedAt: current.endedAt,
        status: current.status,
        incomplete: current.incomplete,
        speedCoverageComplete: current.speedCoverageComplete,
        activeSeconds: rounded(current.activeSeconds),
        distanceKm: rounded(current.distanceKm, 6),
        steps: current.steps,
        calories: rounded(current.calories),
        usualSpeedKmh,
        meanSpeedKmh: current.activeSeconds > 0 ? rounded(current.speedIntegral / current.activeSeconds) : 0,
        reason: cleanReason(current.reason)
      };
    }

    _finish(status, wallMs, reason) {
      if (!this._current) return null;
      this._current.status = status;
      this._current.endedAt = Math.max(this._current.startedAt, wallMs);
      if (status === 'interrupted') {
        this._current.incomplete = true;
        this._current.speedCoverageComplete = false;
      }
      if (reason) this._current.reason = cleanReason(reason);
      const record = this.snapshot();
      this._lastCompleted = record;
      this._current = null;
      return { ...record };
    }

    interrupt(reason = 'Bluetooth connection interrupted.', wallMs = Date.now()) {
      finiteNumber(wallMs, 'Wall time');
      const record = this._finish('interrupted', wallMs, reason);
      this._previous = null;
      return record;
    }
  }

  return Object.freeze({
    VERSION, SERVICE_UUID, WRITE_UUID, NOTIFY_UUID, MIN_SPEED, MAX_SPEED, STEP,
    normalizeSpeed, makePacket, parseTelemetry, describeNotification, CommandQueue, SessionTracker,
    validateStoredRecord, ValidateStoredRecord: validateStoredRecord
  });
});
