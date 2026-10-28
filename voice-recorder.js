/* Local, incremental audio storage. No audio is sent to a server. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PitPatVoice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const BIT_RATE = 64000;
  const RESERVE_BYTES = 8 * 1024 * 1024;
  const START_BYTES = RESERVE_BYTES + BIT_RATE / 8 * 60;
  const STALL_MS = 10000;
  const PENDING_LIMIT = 2 * 1024 * 1024;

  class AudioStore {
    constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; this.opening = null; }
    open() {
      if (!this.indexedDB) return Promise.reject(new Error('This browser cannot save audio locally.'));
      if (!this.opening) this.opening = new Promise((resolve, reject) => {
        const request = this.indexedDB.open('pitpat_voice_notes_v1', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('recordings', { keyPath: 'id' });
          const chunks = db.createObjectStore('chunks', { keyPath: ['recordingId', 'sequence'] });
          chunks.createIndex('recordingId', 'recordingId');
        };
        request.onerror = () => { this.opening = null; reject(request.error); };
        request.onblocked = () => { this.opening = null; reject(new Error('Close other voice-note tabs and try again.')); };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); this.opening = null; };
          resolve(db);
        };
      });
      return this.opening;
    }
    async transaction(names, mode, run) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(names, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
        const result = {};
        tx.oncomplete = () => resolve(result.value);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('Audio storage failed.'));
        try { run(tx, result); } catch (error) { tx.abort(); reject(error); }
      });
    }
    list() {
      return this.transaction(['recordings'], 'readonly', (tx, result) => {
        tx.objectStore('recordings').getAll().onsuccess = event => {
          result.value = event.target.result.sort((a, b) => b.createdAt - a.createdAt);
        };
      });
    }
    create(record) {
      return this.transaction(['recordings'], 'readwrite', tx => tx.objectStore('recordings').add(record));
    }
    append(id, sequence, blob, durationMs) {
      return this.transaction(['recordings', 'chunks'], 'readwrite', tx => {
        const records = tx.objectStore('recordings');
        records.get(id).onsuccess = event => {
          const record = event.target.result;
          if (!record) { tx.abort(); return; }
          tx.objectStore('chunks').add({ recordingId: id, sequence, blob });
          records.put({ ...record, bytes: record.bytes + blob.size, durationMs, updatedAt: Date.now() });
        };
      });
    }
    finish(id, status, durationMs, reason) {
      return this.transaction(['recordings'], 'readwrite', tx => {
        const records = tx.objectStore('recordings');
        records.get(id).onsuccess = event => {
          if (event.target.result) records.put({ ...event.target.result, status, durationMs, reason: reason.slice(0, 240), updatedAt: Date.now() });
        };
      });
    }
    async audio(id) {
      const data = await this.transaction(['recordings', 'chunks'], 'readonly', (tx, result) => {
        result.value = {};
        tx.objectStore('recordings').get(id).onsuccess = event => { result.value.record = event.target.result; };
        tx.objectStore('chunks').index('recordingId').getAll(id).onsuccess = event => { result.value.chunks = event.target.result; };
      });
      if (!data.record || !data.chunks.length) throw new Error('No saved audio is available for this note.');
      return { record: data.record, blob: new Blob(data.chunks.sort((a, b) => a.sequence - b.sequence).map(item => item.blob), { type: data.record.mimeType }) };
    }
    remove(id) {
      return this.transaction(['recordings', 'chunks'], 'readwrite', tx => {
        tx.objectStore('recordings').delete(id);
        tx.objectStore('chunks').index('recordingId').openKeyCursor(id).onsuccess = event => {
          const cursor = event.target.result;
          if (cursor) { tx.objectStore('chunks').delete(cursor.primaryKey); cursor.continue(); }
        };
      });
    }
  }

  class VoiceRecorder {
    constructor({ store, getUserMedia, Recorder, estimate, acquireLock = async () => () => {}, now = () => performance.now(), schedule = setInterval, cancel = clearInterval, onUpdate = () => {}, onComplete = () => {}, onInterrupt = () => {} }) {
      Object.assign(this, { store, getUserMedia, Recorder, estimate, acquireLock, now, schedule, cancel, onUpdate, onComplete, onInterrupt });
      this.state = 'idle'; this.session = null; this.result = null; this.timer = null;
      this.elapsedMs = 0; this.activeSince = null; this.available = null;
    }
    get busy() { return ['starting', 'recording', 'paused', 'saving'].includes(this.state); }
    get durationMs() { return this.elapsedMs + (this.activeSince === null ? 0 : Math.max(0, this.now() - this.activeSince)); }
    update() { try { this.onUpdate(this); } catch (_) { /* UI errors must not interrupt storage. */ } }
    sealTime() { this.elapsedMs = this.durationMs; this.activeSince = null; }
    signalInterrupt(reason) {
      this.interrupted = true; this.reason = reason;
      if (!this.faultSignaled) {
        this.faultSignaled = true;
        try { this.onInterrupt(reason); } catch (_) { /* Capture must still shut down. */ }
      }
    }
    async availableBytes() {
      if (typeof this.estimate !== 'function') throw new Error('This browser cannot check available recording storage.');
      const space = await this.estimate();
      if (!space || !Number.isFinite(space.quota) || !Number.isFinite(space.usage) || space.quota <= 0) throw new Error('Available recording storage could not be checked.');
      this.available = Math.max(0, space.quota - space.usage);
      return this.available;
    }
    async start(title) {
      if (this.busy) return;
      this.state = 'starting'; this.elapsedMs = 0; this.activeSince = null;
      this.interrupted = false; this.faultSignaled = false; this.reason = '';
      this.storageFailed = false; this.pendingBytes = 0; this.savedBytes = 0; this.sequence = 0;
      this.session = null; this.result = null; this.cancelStart = false; this.saveChain = Promise.resolve(); this.finalizing = null;
      this.update();
      try {
        if (!this.Recorder || typeof this.getUserMedia !== 'function') throw new Error('Microphone recording is unavailable in this browser.');
        if (await this.availableBytes() < START_BYTES) throw new Error('Not enough browser storage to start. Free space or download and remove older voice notes.');
        this.releaseLock = await this.acquireLock();
        this.stream = await this.getUserMedia({ audio: true, video: false });
        if (this.cancelStart) throw new Error(this.reason || 'Recording start was interrupted.');
        const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(value => this.Recorder.isTypeSupported(value));
        this.recorder = new this.Recorder(this.stream, { audioBitsPerSecond: BIT_RATE, ...(type ? { mimeType: type } : {}) });
        this.session = { id: globalThis.crypto.randomUUID(), title: String(title || 'Voice note').slice(0, 80), createdAt: Date.now(), updatedAt: Date.now(), mimeType: this.recorder.mimeType || type || 'audio/webm', bytes: 0, durationMs: 0, status: 'recording', reason: '' };
        await this.store.create(this.session);
        if (this.cancelStart) throw new Error(this.reason || 'Recording start was interrupted.');
        this.recorder.ondataavailable = event => this.acceptChunk(event.data);
        this.recorder.onerror = () => this.interrupt('The microphone recorder reported an error. Saved audio is partial.');
        this.recorder.onstop = () => {
          if (this.state !== 'saving') this.signalInterrupt('The microphone recorder stopped unexpectedly. Saved audio is partial.');
          this.state = 'saving'; this.sealTime(); this.update(); void this.finalize();
        };
        for (const track of this.stream.getAudioTracks()) {
          track.onended = () => this.interrupt('Microphone capture ended unexpectedly. Saved audio is partial.');
          track.onmute = () => this.interrupt('Microphone capture was interrupted or muted by the system. Saved audio is partial.');
        }
        this.state = 'recording'; this.activeSince = this.now(); this.lastChunkAt = this.now();
        this.recorder.start(1000);
        this.timer = this.schedule(() => { void this.checkHealth(); }, 1000);
        this.update();
      } catch (error) {
        this.signalInterrupt(error.message || 'Recording could not start.');
        this.state = 'saving'; this.sealTime(); await this.finalize();
        throw error;
      }
    }
    acceptChunk(blob) {
      if (!blob || !blob.size || this.storageFailed) return;
      this.lastChunkAt = this.now();
      if (this.pendingBytes + blob.size > PENDING_LIMIT) {
        this.storageFailed = true;
        this.interrupt('Audio could not be saved quickly enough. Saved audio is partial.');
        return;
      }
      const sequence = this.sequence++;
      const duration = this.durationMs;
      this.pendingBytes += blob.size;
      this.saveChain = this.saveChain.then(async () => {
        try {
          if (this.storageFailed) return;
          await this.store.append(this.session.id, sequence, blob, duration);
          this.savedBytes += blob.size;
        } catch (_) {
          this.storageFailed = true;
          this.interrupt('Audio storage failed or is full. Previously saved audio is partial.');
        } finally { this.pendingBytes -= blob.size; this.update(); }
      });
    }
    async checkHealth() {
      if (!['recording', 'paused'].includes(this.state) || this.checking) return;
      this.checking = true;
      const session = this.session;
      try {
        const available = await this.availableBytes();
        if (session !== this.session || !['recording', 'paused'].includes(this.state)) return;
        if (available < RESERVE_BYTES + this.pendingBytes) this.interrupt('Recording stopped because browser storage is running low.');
        else if (this.state === 'recording' && (this.recorder.state !== 'recording' || this.now() - this.lastChunkAt > STALL_MS)) this.interrupt('Microphone audio stopped arriving. Saved audio is partial.');
      } catch (_) { this.interrupt('Recording stopped because available storage could no longer be checked.'); }
      finally { this.checking = false; this.update(); }
    }
    pause() {
      if (this.state !== 'recording') return;
      try { this.recorder.pause(); this.sealTime(); this.state = 'paused'; this.update(); }
      catch (_) { this.interrupt('The microphone recorder failed while pausing.'); }
    }
    resume() {
      if (this.state !== 'paused') return;
      try { this.recorder.resume(); this.activeSince = this.now(); this.lastChunkAt = this.now(); this.state = 'recording'; this.update(); }
      catch (_) { this.interrupt('The microphone recorder failed while resuming.'); }
    }
    stop() { return this.stopInternal(); }
    interrupt(reason) {
      if (!this.busy) return;
      this.signalInterrupt(reason);
      return this.stopInternal();
    }
    stopInternal() {
      if (this.state === 'starting') { this.cancelStart = true; return; }
      if (!this.busy || this.state === 'saving') return this.finalizing;
      this.sealTime(); this.state = 'saving';
      if (this.timer !== null) this.cancel(this.timer);
      this.timer = null; this.update();
      try {
        if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
        else return this.finalize();
      } catch (_) { this.signalInterrupt('The microphone recorder could not finish normally. Saved audio is partial.'); return this.finalize(); }
    }
    finalize() {
      if (this.finalizing) return this.finalizing;
      this.finalizing = (async () => {
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
        if (this.stream) for (const track of this.stream.getTracks()) { track.onended = null; track.onmute = null; track.stop(); }
        await this.saveChain;
        if (this.session) {
          try { await this.store.finish(this.session.id, this.interrupted ? 'interrupted' : 'saved', this.durationMs, this.reason); }
          catch (_) { this.signalInterrupt('Audio was saved in chunks, but its final record could not be updated. Recover the partial note below.'); }
        }
        this.result = { id: this.session && this.session.id, interrupted: this.interrupted, reason: this.reason, bytes: this.savedBytes };
        this.state = 'idle';
        if (this.releaseLock) this.releaseLock();
        this.releaseLock = null; this.stream = null; this.recorder = null;
        this.update();
        try { await this.onComplete(this.result); } catch (_) { /* Saved chunks remain recoverable. */ }
        return this.result;
      })();
      return this.finalizing;
    }
  }
  return Object.freeze({ AudioStore, VoiceRecorder, BIT_RATE, RESERVE_BYTES, START_BYTES, STALL_MS });
});
