/* Voice-note UI: recording, local recovery, download, and user-initiated sharing. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const V = globalThis.PitPatVoice;
  const store = V && new V.AudioStore();
  const urls = new Set();
  let prepared = null;
  let ready = false;
  const formatBytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const formatTime = ms => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`;
  const status = text => { $('voiceStatus').textContent = text; };

  async function acquireLock() {
    if (!navigator.locks) throw new Error('This browser cannot reserve a recording session. Use current Chrome.');
    return new Promise((resolve, reject) => {
      navigator.locks.request('pitpat-voice-recording', { ifAvailable: true }, async lock => {
        if (!lock) { reject(new Error('A voice note is being recorded in another tab.')); return; }
        await new Promise(release => resolve(release));
      }).catch(reject);
    });
  }

  function render(recorder) {
    const busy = recorder.busy;
    $('voiceRecordBtn').disabled = !ready || busy;
    $('voiceTitle').disabled = busy;
    $('voicePauseBtn').disabled = !['recording', 'paused'].includes(recorder.state);
    $('voicePauseBtn').textContent = recorder.state === 'paused' ? 'Resume' : 'Pause';
    $('voiceSaveBtn').disabled = !['recording', 'paused'].includes(recorder.state);
    $('voiceTimer').textContent = formatTime(recorder.durationMs || 0);
    $('voiceIndicator').textContent = ({ idle: 'Ready', starting: 'Checking…', recording: 'Recording', paused: 'Paused', saving: 'Saving…' })[recorder.state];
    $('voiceIndicator').dataset.recording = recorder.state === 'recording' ? 'true' : 'false';
    if (Number.isFinite(recorder.available)) $('voiceStorage').textContent = `Browser storage available: ${formatBytes(recorder.available)}. ${formatBytes(V.RESERVE_BYTES)} kept in reserve.`;
    if (recorder.state === 'recording') status(`Recording · ${formatBytes(recorder.savedBytes)} saved so far.`);
    else if (recorder.state === 'paused') status('Recording paused. Audio already received remains saved.');
    else if (recorder.state === 'saving') status('Finishing the saved audio…');
    else if (recorder.state === 'starting') status('Checking storage and requesting the microphone…');
  }

  function action(text, fn) {
    const button = document.createElement('button');
    button.className = 'small'; button.textContent = text;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await fn(); }
      catch (error) { status(error.message || 'The audio action could not be completed.'); }
      finally { button.disabled = false; }
    });
    return button;
  }

  async function fileFor(id) {
    if (prepared && prepared.id === id) return prepared.file;
    const { record, blob } = await store.audio(id);
    const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const name = record.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'Voice note';
    const file = new File([blob], `${name}-${new Date(record.createdAt).toISOString().replace(/[:.]/g, '-')}.${extension}`, { type: blob.type });
    prepared = { id, file };
    return file;
  }

  async function refresh() {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    const records = await store.list();
    const list = $('voiceNotesList'); list.replaceChildren();
    $('voiceNotesEmpty').hidden = records.length > 0;
    for (const note of records) {
      const row = document.createElement('li');
      const title = document.createElement('p'); title.className = 'voice-note-title'; title.textContent = note.title;
      const detail = document.createElement('p'); detail.className = 'subtle';
      const partial = note.status !== 'saved';
      detail.textContent = `${new Date(note.createdAt).toLocaleString()} · ${formatTime(note.durationMs)} · ${formatBytes(note.bytes)}${partial ? ' · Partial / interrupted' : ''}`;
      const reason = document.createElement('p'); reason.className = 'subtle';
      reason.textContent = partial ? note.reason || 'The previous recording ended without finishing. Recover the saved segments below.' : '';
      const controls = document.createElement('div'); controls.className = 'voice-note-actions';
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.hidden = true;
      if (note.bytes > 0) {
        controls.append(action('Listen / recover', async () => {
          const file = await fileFor(note.id);
          const url = URL.createObjectURL(file); urls.add(url);
          audio.src = url; audio.hidden = false;
          status(partial ? 'Recovered saved audio segments. An interrupted last segment may be incomplete.' : 'Audio ready to play.');
        }));
        controls.append(action('Download audio', async () => {
          const file = await fileFor(note.id);
          const url = URL.createObjectURL(file); urls.add(url);
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name;
          document.body.append(anchor); anchor.click(); anchor.remove();
          status('Audio download requested. Keep the original until you have checked the downloaded file.');
        }));
        if (navigator.share && navigator.canShare) controls.append(action('Share audio', async () => {
          const file = await fileFor(note.id);
          if (!navigator.canShare({ files: [file] })) { status('This browser cannot share this audio file. Download it, then attach it in Google Chat.'); return; }
          try { await navigator.share({ files: [file], title: note.title }); status('Audio handed to the selected sharing app.'); }
          catch (error) {
            if (error.name === 'AbortError') { status('Sharing canceled. The voice note is still saved here.'); return; }
            if (error.name === 'NotAllowedError') { status('Audio prepared. Tap Share audio again, or download it and attach it in Google Chat.'); return; }
            throw error;
          }
        }));
      }
      controls.append(action('Delete', async () => {
        if (recorder.busy) { status('Finish the active recording before removing a voice note.'); return; }
        if (!window.confirm(`Permanently delete “${note.title}” from this browser? Download or share it first if you need a copy.`)) return;
        await store.remove(note.id); if (prepared && prepared.id === note.id) prepared = null;
        await refresh(); status('Voice note deleted from this browser.');
      }));
      row.append(title, detail, reason, controls, audio); list.append(row);
    }
  }

  if (!V || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !globalThis.MediaRecorder || !navigator.storage || !navigator.storage.estimate) {
    status('Voice recording needs current Chrome, microphone access, and browser storage.');
    return;
  }
  const recorder = new V.VoiceRecorder({
    store,
    getUserMedia: options => navigator.mediaDevices.getUserMedia(options),
    Recorder: globalThis.MediaRecorder,
    estimate: () => navigator.storage.estimate(),
    acquireLock,
    onUpdate: render,
    onInterrupt: reason => {
      document.dispatchEvent(new CustomEvent('pitpat-voice-interrupted', { detail: { reason } }));
    },
    onComplete: async result => {
      status(result.interrupted ? `${result.reason} Recover the saved partial note below.` : 'Voice note saved on this device. Download it or share it for transcription.');
      await refresh();
    }
  });
  $('voiceRecordBtn').addEventListener('click', async () => {
    // Request protection from automatic eviction when the browser permits it.
    if (navigator.storage.persist) void navigator.storage.persist().catch(() => {});
    try { await recorder.start($('voiceTitle').value); }
    catch (error) { status(`${error.message} A Stop request was attempted if the pad was connected.`); }
  });
  $('voicePauseBtn').addEventListener('click', () => recorder.state === 'paused' ? recorder.resume() : recorder.pause());
  $('voiceSaveBtn').addEventListener('click', () => { recorder.stop(); });
  const interrupt = reason => { if (recorder.busy) recorder.interrupt(reason); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') interrupt('The recording page was hidden. Recording stopped and a pad Stop request was attempted.');
  });
  document.addEventListener('freeze', () => interrupt('The browser suspended the recording page. Saved audio is partial.'));
  // Run before the Bluetooth pagehide teardown so Stop can still be attempted.
  window.addEventListener('pagehide', () => interrupt('The recording page was closed or reloaded. Saved audio is partial.'), { capture: true });
  void (async () => {
    try {
      await store.open(); await refresh();
      const available = await recorder.availableBytes();
      ready = true; render(recorder);
      status(available < V.START_BYTES ? 'Free storage before recording: less than the required reserve and one minute of audio is available.' : 'Ready. Audio is saved on this device as you record.');
    } catch (error) { status(`Voice notes unavailable: ${error.message}`); }
  })();
})();
