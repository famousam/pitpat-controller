'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceRecorder, START_BYTES, RESERVE_BYTES, STALL_MS } = require('../voice-recorder.js');
const turn = () => new Promise(resolve => setImmediate(resolve));

class FakeRecorder {
  static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
  constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm;codecs=opus'; this.stops = 0; }
  start(slice) { assert.equal(slice, 1000); this.state = 'recording'; }
  emit(text) { this.ondataavailable({ data: new Blob([text], { type: this.mimeType }) }); }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() { this.stops += 1; this.state = 'inactive'; queueMicrotask(() => this.onstop()); }
  unexpectedStop() { this.state = 'inactive'; this.onstop(); }
}

function setup() {
  let time = 0;
  let available = START_BYTES + 1000000;
  let estimatesFail = false;
  let microphoneCalls = 0;
  let releases = 0;
  const faults = [];
  const completed = [];
  const track = { stopped: 0, onended: null, stop() { this.stopped += 1; } };
  const store = {
    records: new Map(), chunks: [], failAppend: false, failFinish: false,
    async create(record) { this.records.set(record.id, { ...record }); },
    async append(id, sequence, blob, durationMs) {
      if (this.failAppend) throw new DOMException('Storage full', 'QuotaExceededError');
      this.chunks.push({ id, sequence, blob });
      const record = this.records.get(id); record.bytes += blob.size; record.durationMs = durationMs;
    },
    async finish(id, status, durationMs, reason) {
      if (this.failFinish) throw new DOMException('Storage full', 'QuotaExceededError');
      Object.assign(this.records.get(id), { status, durationMs, reason });
    }
  };
  const recorder = new VoiceRecorder({
    store, Recorder: FakeRecorder,
    getUserMedia: async options => { assert.deepEqual(options, { audio: true, video: false }); microphoneCalls += 1; return { getAudioTracks: () => [track], getTracks: () => [track] }; },
    estimate: async () => { if (estimatesFail) throw new Error('Storage unavailable'); return { quota: available + 1000, usage: 1000 }; },
    acquireLock: async () => () => { releases += 1; }, now: () => time,
    schedule: () => 42, cancel: timer => assert.equal(timer, 42),
    onInterrupt: reason => faults.push(reason), onComplete: result => completed.push(result)
  });
  return { recorder, store, track, faults, completed, advance: ms => { time += ms; }, space: bytes => { available = bytes; }, estimateFailure: () => { estimatesFail = true; }, get microphoneCalls() { return microphoneCalls; }, get releases() { return releases; } };
}

test('low storage blocks microphone access and requests a pad stop once', async () => {
  const s = setup(); s.space(START_BYTES - 1);
  await assert.rejects(s.recorder.start('Instructions'), /Not enough/);
  assert.equal(s.microphoneCalls, 0);
  assert.equal(s.faults.length, 1);
  assert.equal(s.recorder.busy, false);
  assert.equal(s.store.records.size, 0);
});

test('audio is saved as it arrives; normal stop finishes after the final chunk', async () => {
  const s = setup(); await s.recorder.start('Instructions');
  const capture = s.recorder.recorder;
  s.advance(1000); capture.emit('first'); await s.recorder.saveChain;
  assert.equal(s.store.chunks.length, 1);
  assert.equal(s.recorder.busy, true);
  s.advance(1000); capture.emit('second'); s.recorder.stop();
  await turn(); await s.recorder.finalizing;
  assert.equal(await new Blob(s.store.chunks.map(chunk => chunk.blob)).text(), 'firstsecond');
  assert.deepEqual(s.store.chunks.map(chunk => chunk.sequence), [0, 1]);
  assert.equal(s.completed[0].interrupted, false);
  assert.equal(s.store.records.get(s.completed[0].id).status, 'saved');
  assert.equal(s.track.stopped, 1);
  assert.equal(s.releases, 1);
  assert.equal(s.faults.length, 0);
});

test('running out of estimated storage stops capture and retains committed audio', async () => {
  const s = setup(); await s.recorder.start('Instructions');
  s.recorder.recorder.emit('retained'); await s.recorder.saveChain;
  const capture = s.recorder.recorder;
  s.space(RESERVE_BYTES - 1); await s.recorder.checkHealth();
  assert.equal(capture.stops, 1);
  assert.equal(s.faults.length, 1);
  await turn(); await s.recorder.finalizing;
  assert.equal(await s.store.chunks[0].blob.text(), 'retained');
  assert.equal(s.completed[0].interrupted, true);
  assert.match(s.completed[0].reason, /storage is running low/);
});

test('a real storage-write failure stops recording even if quota estimates looked sufficient', async () => {
  const s = setup(); await s.recorder.start('Instructions');
  s.recorder.recorder.emit('saved'); await s.recorder.saveChain;
  s.store.failAppend = true;
  s.recorder.recorder.emit('unsaved');
  await turn(); await s.recorder.finalizing;
  assert.equal(s.faults.length, 1);
  assert.equal(s.store.chunks.length, 1);
  assert.equal(await s.store.chunks[0].blob.text(), 'saved');
  assert.match(s.completed[0].reason, /storage failed/);
  assert.equal(s.track.stopped, 1);
});

test('unexpected recorder stop and lost microphone both request Stop and save partial notes', async () => {
  for (const mode of ['stop', 'track', 'mute']) {
    const s = setup(); await s.recorder.start('Instructions');
    s.recorder.recorder.emit('saved'); await s.recorder.saveChain;
    if (mode === 'stop') s.recorder.recorder.unexpectedStop();
    else if (mode === 'track') s.track.onended();
    else s.track.onmute();
    await turn(); await s.recorder.finalizing;
    assert.equal(s.faults.length, 1);
    assert.equal(s.completed[0].interrupted, true);
    assert.equal(s.store.chunks.length, 1);
    assert.equal(s.recorder.busy, false);
  }
});

test('a stalled capture is stopped; an intentional pause excludes paused time', async () => {
  const s = setup(); await s.recorder.start('Instructions');
  s.advance(1000); s.recorder.recorder.emit('saved'); await s.recorder.saveChain;
  s.recorder.pause(); s.advance(STALL_MS + 1); await s.recorder.checkHealth();
  assert.equal(s.recorder.state, 'paused'); assert.equal(s.faults.length, 0);
  assert.equal(s.recorder.durationMs, 1000);
  s.recorder.resume(); s.advance(STALL_MS + 1); await s.recorder.checkHealth();
  await turn(); await s.recorder.finalizing;
  assert.equal(s.faults.length, 1);
  assert.match(s.completed[0].reason, /audio stopped arriving/);
  assert.equal(s.store.chunks.length, 1);
});

test('failure to recheck storage and failure to finalize metadata preserve saved chunks', async () => {
  for (const mode of ['estimate', 'finish']) {
    const s = setup(); await s.recorder.start('Instructions');
    s.recorder.recorder.emit('saved'); await s.recorder.saveChain;
    if (mode === 'estimate') { s.estimateFailure(); await s.recorder.checkHealth(); }
    else { s.store.failFinish = true; s.recorder.stop(); }
    await turn(); await s.recorder.finalizing;
    assert.equal(s.faults.length, 1);
    assert.equal(s.completed[0].interrupted, true);
    assert.equal(s.store.chunks.length, 1);
    assert.equal(s.releases, 1);
  }
});

test('interrupting a capture before microphone permission resolves releases the stream and lock', async () => {
  const s = setup();
  let releaseMicrophone;
  s.recorder.getUserMedia = () => new Promise(resolve => { releaseMicrophone = resolve; });
  const starting = s.recorder.start('Instructions'); await turn();
  s.recorder.interrupt('Page was hidden.');
  releaseMicrophone({ getTracks: () => [s.track], getAudioTracks: () => [s.track] });
  await assert.rejects(starting, /hidden/);
  assert.equal(s.track.stopped, 1); assert.equal(s.releases, 1);
  assert.equal(s.faults.length, 1); assert.equal(s.recorder.busy, false);
});

test('empty audio callbacks cannot hide a stalled recording', async () => {
  const s = setup(); await s.recorder.start('Instructions');
  s.advance(STALL_MS + 1); s.recorder.acceptChunk(new Blob([]));
  await s.recorder.checkHealth(); await turn(); await s.recorder.finalizing;
  assert.equal(s.faults.length, 1);
  assert.equal(s.completed[0].interrupted, true);
  assert.equal(s.store.chunks.length, 0);
});
