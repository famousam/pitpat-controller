'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../controller-core.js');

const hex = bytes => Buffer.from(bytes).toString('hex');
const waitTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const observed = promise => promise.then(() => ({ ok: true }), failure => ({ ok: false, failure }));
const command = (queue, type, speed) => observed(queue.send(type, core.makePacket(type, speed)));

function telemetry(overrides = {}) {
  return {
    state: 'running', speed: 2.5, targetSpeed: 2.5, maxSpeed: 6,
    distanceKm: 0, steps: 0, calories: 0, cycleId: 5,
    rawDuration: 0, firmware: 42, flags: 8, panelImperial: false,
    ...overrides
  };
}

function frame({ speed = 2500, target = 2500, max = 6000, flags = 8, size = 52, ...other } = {}) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x68;
  bytes[1] = size;
  view.setUint16(3, speed, false);
  view.setUint16(5, target, false);
  view.setUint32(7, other.distance ?? 1234, false);
  view.setUint32(14, other.steps ?? 2345, false);
  view.setUint16(18, other.calories ?? 45, false);
  view.setUint32(20, other.duration ?? 60000, false);
  bytes[24] = 5;
  bytes[25] = 42;
  bytes[26] = flags;
  view.setUint16(27, max, false);
  bytes[size - 1] = 0x43;
  return bytes;
}

test('speed normalization rejects nonnumbers and respects 0.1 resolution and pad cap', () => {
  assert.equal(core.normalizeSpeed(2.34), 2.3);
  assert.equal(core.normalizeSpeed(2.36), 2.4);
  assert.equal(core.normalizeSpeed(0), 1);
  assert.equal(core.normalizeSpeed(100), 6);
  assert.equal(core.normalizeSpeed(6, 4.59), 4.5);
  assert.equal(core.normalizeSpeed(0.1 + 0.2 + 1), 1.3);
  for (const value of [NaN, Infinity, -Infinity, '2', null, undefined]) assert.throws(() => core.normalizeSpeed(value));
  assert.throws(() => core.normalizeSpeed(2, 0.5));
});

test('control packets exactly match published BA09-B reference vectors', () => {
  const vectors = [
    ['start', 1, '6a170000000003e801005000040000000dba9d76ef1a43'],
    ['set_speed', 1.2, '6a170000000004b005005000040000000dba9d76ef4143'],
    ['pause', undefined, '6a1700000000000001005000020000000dba9d76eff743'],
    ['stop', undefined, '6a1700000000000001005000000000000dba9d76eff543'],
    ['heartbeat', undefined, '6a05fdf843']
  ];
  for (const [type, speed, expected] of vectors) assert.equal(hex(core.makePacket(type, speed)), expected);
  assert.throws(() => core.makePacket('resume'));
  assert.throws(() => core.makePacket('start', NaN));
  assert.equal(new DataView(core.makePacket('set_speed', 99).buffer).getUint16(6), 6000);
  assert.equal(new DataView(core.makePacket('stop', 6).buffer).getUint16(6), 0);
});

test('telemetry parses known framing, unsigned counters, metric values and state flags', () => {
  const bytes = frame({ steps: 0xf1234567, duration: 0xf1234567, distance: 0xf1234567, flags: 0x88 });
  const value = core.parseTelemetry(bytes);
  assert.equal(value.speed, 2.5);
  assert.equal(value.distanceKm, 0xf1234567 / 1000);
  assert.equal(value.steps, 0xf1234567);
  assert.equal(value.rawDuration, 0xf1234567);
  assert.equal(value.panelImperial, true);
  assert.equal(value.state, 'running');
  assert.equal(value.firmware, 42);
  for (const [flags, state] of [[0, 'stopped'], [8, 'running'], [16, 'paused'], [24, 'countdown']]) {
    assert.equal(core.parseTelemetry(frame({ flags })).state, state);
  }
  const withOffset = new Uint8Array(bytes.length + 8);
  withOffset.set(bytes, 4);
  assert.equal(core.parseTelemetry(new DataView(withOffset.buffer, 4, bytes.length)).steps, 0xf1234567);
});

test('telemetry rejects incomplete, wrapped, wrongly framed and unsupported-model packets', () => {
  assert.throws(() => core.parseTelemetry(new Uint8Array(30)), /length/);
  assert.throws(() => core.parseTelemetry(new Uint8Array(256)), /length/);
  for (const [offset, value] of [[0, 0x4d], [1, 51], [51, 0]]) {
    const invalid = frame();
    invalid[offset] = value;
    assert.throws(() => core.parseTelemetry(invalid), /frame/);
  }
  for (const options of [{ speed: 6001 }, { target: 6001 }, { max: 0 }, { max: 10000 }]) {
    assert.throws(() => core.parseTelemetry(frame(options)), /1–6/);
  }
  assert.throws(() => core.parseTelemetry([]));
});

test('queue serializes all writes and Stop supersedes unsent motion and heartbeat', async () => {
  const operations = [];
  const gates = [];
  const queue = new core.CommandQueue((packet, type) => {
    const gate = deferred();
    operations.push(type);
    gates.push(gate);
    return gate.promise;
  });
  const first = command(queue, 'set_speed', 2);
  const pending = command(queue, 'set_speed', 3);
  const heartbeat = command(queue, 'heartbeat');
  const stop = command(queue, 'stop');
  assert.deepEqual(operations, ['set_speed']);
  assert.equal((await pending).failure.code, 'CANCELLED');
  assert.equal((await heartbeat).failure.code, 'CANCELLED');
  const blocked = await command(queue, 'start', 2);
  assert.equal(blocked.failure.code, 'CANCELLED');
  gates[0].resolve();
  await waitTurn();
  assert.deepEqual(operations, ['set_speed', 'stop']);
  gates[1].resolve();
  assert.equal((await first).ok, true);
  assert.equal((await stop).ok, true);
  assert.equal(queue.busy, false);
});

test('unsent speed changes coalesce and Pause cancels further pending motion', async () => {
  const gates = [];
  const writes = [];
  const queue = new core.CommandQueue((packet, type) => {
    const gate = deferred();
    gates.push(gate);
    writes.push({ type, speed: packet.length === 23 ? new DataView(packet.buffer).getUint16(6) : 0 });
    return gate.promise;
  });
  const inFlight = command(queue, 'heartbeat');
  const old = command(queue, 'set_speed', 2);
  const latest = command(queue, 'set_speed', 3);
  assert.equal((await old).failure.code, 'CANCELLED');
  gates[0].resolve();
  await waitTurn();
  assert.deepEqual(writes.map(write => write.speed), [0, 3000]);
  const next = command(queue, 'set_speed', 4);
  const pause = command(queue, 'pause');
  assert.equal((await next).failure.code, 'CANCELLED');
  assert.equal((await command(queue, 'set_speed', 5)).failure.code, 'CANCELLED');
  gates[1].resolve();
  await waitTurn();
  assert.equal(writes[2].type, 'pause');
  gates[2].resolve();
  await Promise.all([inFlight, latest, pause]);
});

test('guard is rechecked at write time; rejection keeps Stop available', async () => {
  const gate = deferred();
  const writes = [];
  let fresh = true;
  const queue = new core.CommandQueue((packet, type) => {
    writes.push(type);
    return type === 'heartbeat' ? gate.promise : Promise.resolve();
  });
  queue.setMotionGuard(type => fresh && type !== 'pause');
  const heartbeat = command(queue, 'heartbeat');
  const speed = command(queue, 'set_speed', 2);
  fresh = false;
  gate.resolve();
  await heartbeat;
  assert.equal((await speed).failure.code, 'GUARD');
  assert.deepEqual(writes, ['heartbeat']);
  assert.equal((await command(queue, 'stop')).ok, true);
  assert.equal(queue.closed, false);
});

test('disconnect cancellation cannot replay pending movement or interfere with a fresh queue', async () => {
  const oldGate = deferred();
  const writes = [];
  const oldQueue = new core.CommandQueue((packet, type) => { writes.push(`old:${type}`); return oldGate.promise; });
  const oldWrite = command(oldQueue, 'heartbeat');
  const staleStart = command(oldQueue, 'start', 3);
  oldQueue.cancel('Disconnected');
  assert.equal((await oldWrite).failure.code, 'CANCELLED');
  assert.equal((await staleStart).failure.code, 'CANCELLED');
  const nextQueue = new core.CommandQueue((packet, type) => { writes.push(`new:${type}`); return Promise.resolve(); });
  assert.equal((await command(nextQueue, 'heartbeat')).ok, true);
  oldGate.resolve();
  await waitTurn();
  assert.deepEqual(writes, ['old:heartbeat', 'new:heartbeat']);
  assert.equal((await command(oldQueue, 'stop')).failure.code, 'CANCELLED');
});

test('a timed-out write faults the queue permanently and never starts a subsequent write', async () => {
  const gate = deferred();
  const writes = [];
  const faults = [];
  const queue = new core.CommandQueue((packet, type) => { writes.push(type); return gate.promise; }, { timeoutMs: 15, onFault: failure => faults.push(failure.code) });
  const first = command(queue, 'heartbeat');
  const second = command(queue, 'stop');
  assert.equal((await first).failure.code, 'TIMEOUT');
  assert.equal((await second).failure.code, 'TIMEOUT');
  gate.resolve();
  await waitTurn();
  assert.deepEqual(writes, ['heartbeat']);
  assert.deepEqual(faults, ['TIMEOUT']);
  assert.equal(queue.closed, true);
});

test('discardPending drops stale motion while preserving an explicit pending Stop', async () => {
  const gates = [];
  const writes = [];
  const queue = new core.CommandQueue((packet, type) => {
    writes.push(type);
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });
  const heartbeat = command(queue, 'heartbeat');
  const speed = command(queue, 'set_speed', 2);
  queue.discardPending('Page hidden');
  assert.equal((await speed).failure.code, 'CANCELLED');
  const stop = command(queue, 'stop');
  queue.discardPending('Page hidden again');
  gates[0].resolve();
  await waitTurn();
  assert.deepEqual(writes, ['heartbeat', 'stop']);
  gates[1].resolve();
  await Promise.all([heartbeat, stop]);
});

test('Stop remains available if the guard throws, and write rejection closes the queue', async () => {
  let attempts = 0;
  const queue = new core.CommandQueue(() => { attempts += 1; return Promise.reject(new Error('No GATT')); });
  queue.setMotionGuard(() => { throw new Error('State unknown'); });
  assert.match((await command(queue, 'start', 1)).failure.message, /unknown/);
  assert.equal(attempts, 0);
  assert.equal((await command(queue, 'stop')).failure.code, 'WRITE_FAILED');
  assert.equal(attempts, 1);
  assert.equal(queue.closed, true);
});

test('session keeps pause and resume together and stores observed increments once', () => {
  const tracker = new core.SessionTracker();
  tracker.update(telemetry({ state: 'stopped', speed: 0 }), 0, 10000);
  tracker.update(telemetry(), 1000, 11000);
  tracker.update(telemetry({ distanceKm: 0.001, steps: 1, calories: 1 }), 2000, 12000);
  const paused = tracker.update(telemetry({ state: 'paused', speed: 0, distanceKm: 0.002, steps: 2, calories: 1 }), 3000, 13000);
  assert.equal(paused.status, 'paused');
  const id = paused.id;
  tracker.update(telemetry({ state: 'paused', speed: 0, distanceKm: 0.002, steps: 2, calories: 1 }), 4000, 14000);
  tracker.update(telemetry({ distanceKm: 0.002, steps: 2, calories: 1 }), 5000, 15000);
  const record = tracker.update(telemetry({ state: 'stopped', speed: 0, distanceKm: 0.003, steps: 3, calories: 2 }), 6000, 16000);
  assert.equal(record.id, id);
  assert.equal(record.activeSeconds, 3);
  assert.equal(record.distanceKm, 0.003);
  assert.equal(record.steps, 3);
  assert.equal(record.status, 'completed');
  assert.equal(record.incomplete, false);
  assert.equal(record.usualSpeedKmh, 2.5);
  assert.equal(tracker.active, false);
  assert.equal(tracker.snapshot(), null);
  assert.equal(tracker.lastCompleted.id, id);
});

test('joining mid-workout excludes earlier totals and marks record incomplete', () => {
  const tracker = new core.SessionTracker();
  tracker.update(telemetry({ distanceKm: 2, steps: 3000, calories: 100 }), 0, 10000);
  const result = tracker.update(telemetry({ distanceKm: 2.001, steps: 3001, calories: 101 }), 1000, 11000);
  assert.equal(result.incomplete, true);
  assert.equal(result.distanceKm, 0.001);
  assert.equal(result.steps, 1);
  assert.equal(result.calories, 1);
});

test('counter resets on Stop preserve last totals without negative values', () => {
  const tracker = new core.SessionTracker();
  tracker.update(telemetry({ state: 'stopped', speed: 0 }), 0, 10000);
  tracker.update(telemetry(), 1000, 11000);
  tracker.update(telemetry({ distanceKm: 0.001, steps: 1 }), 2000, 12000);
  const stopped = tracker.update(telemetry({ state: 'stopped', speed: 0 }), 3000, 13000);
  assert.equal(stopped.distanceKm, 0.001);
  assert.equal(stopped.steps, 1);
  assert.equal(stopped.incomplete, true);
  assert.match(stopped.reason, /reset/);
  assert.equal(stopped.speedCoverageComplete, true);
});

test('a later gap invalidates speed learning even when an earlier counter reset is the first reason', () => {
  const tracker = new core.SessionTracker();
  tracker.update(telemetry({ state: 'stopped', speed: 0 }), 0, 10000);
  tracker.update(telemetry(), 1000, 11000);
  tracker.update(telemetry({ distanceKm: 0.001, steps: 1 }), 2000, 12000);
  tracker.update(telemetry(), 3000, 13000);
  assert.equal(tracker.snapshot().speedCoverageComplete, true);
  tracker.update(telemetry({ distanceKm: 0.01, steps: 10 }), 10000, 20000);
  const record = tracker.update(telemetry({ state: 'stopped', speed: 0 }), 11000, 21000);
  assert.match(record.reason, /reset/);
  assert.equal(record.speedCoverageComplete, false);
  assert.equal(core.validateStoredRecord(record).speedCoverageComplete, false);
});

test('telemetry gaps and cycle changes establish a new baseline without inventing elapsed activity', () => {
  const tracker = new core.SessionTracker();
  tracker.update(telemetry({ state: 'stopped', speed: 0 }), 0, 10000);
  tracker.update(telemetry(), 1000, 11000);
  tracker.update(telemetry({ distanceKm: 0.001, steps: 1 }), 2000, 12000);
  tracker.update(telemetry({ distanceKm: 0.1, steps: 150 }), 20000, 30000);
  tracker.update(telemetry({ distanceKm: 0.101, steps: 151 }), 21000, 31000);
  tracker.update(telemetry({ cycleId: 6, distanceKm: 0.5, steps: 500 }), 22000, 32000);
  const snapshot = tracker.update(telemetry({ cycleId: 6, distanceKm: 0.501, steps: 501 }), 23000, 33000);
  assert.equal(snapshot.distanceKm, 0.003);
  assert.equal(snapshot.steps, 3);
  assert.equal(snapshot.activeSeconds, 4);
  assert.equal(snapshot.incomplete, true);
});

test('usual speed is duration weighted and ignores a final zero reading', () => {
  const tracker = new core.SessionTracker();
  tracker.update(telemetry({ state: 'stopped', speed: 0 }), 0, 10000);
  tracker.update(telemetry({ speed: 1.5 }), 1000, 11000);
  tracker.update(telemetry({ speed: 2.5 }), 2000, 12000);
  tracker.update(telemetry({ speed: 2.5 }), 6000, 16000);
  tracker.update(telemetry({ speed: 1 }), 10000, 20000);
  const record = tracker.update(telemetry({ state: 'stopped', speed: 0 }), 11000, 21000);
  assert.equal(record.usualSpeedKmh, 2.5);
  assert.equal(record.activeSeconds, 10);
  assert.equal(record.meanSpeedKmh, 2.25);
});

test('interrupt closes the session without restoring it or merging a new connection', () => {
  const tracker = new core.SessionTracker();
  tracker.update(telemetry(), 0, 10000);
  tracker.update(telemetry({ distanceKm: 0.001, steps: 1 }), 1000, 11000);
  const record = tracker.interrupt('Connection dropped', 12000);
  assert.equal(record.status, 'interrupted');
  assert.equal(record.incomplete, true);
  assert.equal(tracker.active, false);
  assert.equal(tracker.interrupt('again', 13000), null);
  const next = tracker.update(telemetry({ distanceKm: 5, steps: 1000 }), 5000, 15000);
  assert.notEqual(next.id, record.id);
  assert.equal(next.distanceKm, 0);
});

test('stored records are bounded, typed and copied without unknown fields', () => {
  const tracker = new core.SessionTracker();
  tracker.update(telemetry(), 0, 10000);
  tracker.update(telemetry(), 1000, 11000);
  const record = tracker.interrupt('<img onerror=x>disconnected', 12000);
  const clean = core.validateStoredRecord({ ...record, evil: '<script>attack()</script>' });
  assert.ok(clean);
  assert.equal(clean.evil, undefined);
  assert.equal(clean.reason.includes('<'), false);
  assert.equal(core.validateStoredRecord({ ...record, steps: '9<script>' }), null);
  assert.equal(core.validateStoredRecord({ ...record, id: '<img src=x>' }), null);
  assert.equal(core.validateStoredRecord({ ...record, distanceKm: Infinity }), null);
  assert.equal(core.validateStoredRecord({ ...record, activeSeconds: -1 }), null);
  assert.equal(core.validateStoredRecord({ ...record, usualSpeedKmh: 9 }), null);
  assert.equal(core.validateStoredRecord({ ...record, endedAt: null }), null);
});
