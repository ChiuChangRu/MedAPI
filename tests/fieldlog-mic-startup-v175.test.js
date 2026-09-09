import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const app = readFileSync(new URL('../fieldlog/public/app.js', import.meta.url), 'utf8');
const fn = name => app.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\)[\\s\\S]*?\\n\\}`))[0];
function stream() {
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; }, getSettings() { return { deviceId: 'selected' }; } };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}
function acquire(overrides = {}) {
  const context = vm.createContext({
    listMicDeviceIds: async () => ['physical', 'default'],
    openMicStream: async () => stream(), waitForTrackUsable: async () => true,
    probeStreamPeak: async () => 0.1, AUDIO_MUTE_GRACE_MS: 1, AUDIO_SIGNAL_FLOOR: 0.0001,
    ...overrides,
  });
  vm.runInContext('async function probeMicReadiness(stream) { return { usable: await waitForTrackUsable(stream), peak: await probeStreamPeak(stream) }; }\n' + ['stopStream', 'micDeviceIdOf', 'acquireLiveMic', 'audioStartErrorMessage'].map(fn).join('\n'), context);
  return context;
}
test('startup uses browser-selected input before enumerated hardware', async () => {
  const opened = [];
  const c = acquire({ openMicStream: async id => { opened.push(id); return stream(); } });
  assert.equal((await c.acquireLiveMic(null)).silent, false);
  assert.deepEqual(opened, [null]);
});
test('muted startup closes first stream and retries once with simple constraints', async () => {
  const first = stream(), second = stream(), opened = [];
  const c = acquire({
    openMicStream: async (id, simple) => {
      opened.push([id, simple]);
      if (simple) assert.equal(first.getTracks()[0].readyState, 'ended');
      return simple ? second : first;
    },
    waitForTrackUsable: async s => s === second,
  });
  assert.equal((await c.acquireLiveMic(null)).stream, second);
  assert.deepEqual(opened, [[null, undefined], [null, true]]);
});
test('persistent muted input is released and diagnosed separately from permission denial', async () => {
  const streams = [];
  const c = acquire({ listMicDeviceIds: async () => [], openMicStream: async () => { const s = stream(); streams.push(s); return s; }, waitForTrackUsable: async () => false });
  await assert.rejects(c.acquireLiveMic(null), e => e.name === 'MicNotReadyError' && /未開始錄音/.test(c.audioStartErrorMessage(e)));
  assert.equal(streams.length, 2);
  assert.ok(streams.every(s => s.getTracks()[0].readyState === 'ended'));
  assert.match(c.audioStartErrorMessage({ name: 'NotAllowedError' }), /權限/);
});
test('background singlePass does not retry a muted input', async () => {
  let count = 0;
  const c = acquire({ openMicStream: async () => { count++; return stream(); }, waitForTrackUsable: async () => false });
  await assert.rejects(c.acquireLiveMic('bad', { singlePass: true }), { name: 'MicNotReadyError' });
  assert.equal(count, 1);
});
test('double click opens only one microphone and cancellation releases the startup lock', async () => {
  let resolve, calls = 0;
  const mic = stream();
  const c = vm.createContext({ navigator: { mediaDevices: {} }, window: { MediaRecorder: {} },
    setAudioPanel() {}, loadMicChoices() {}, showToast() {}, confirm: () => false,
    acquireLiveMic: () => { calls++; return new Promise(r => { resolve = r; }); },
  });
  vm.runInContext('let AUDIO = null; let AUDIO_STARTING = false; let AUDIO_TARGET_ENTRY = null; let AUDIO_SELECTED_MIC = null; let MIC_TEST_URL = null;\n' + ['stopStream','audioStartErrorMessage','startAudio'].map(fn).join('\n'), c);
  const first = c.startAudio(null);
  await c.startAudio(null);
  assert.equal(calls, 1);
  resolve({ stream: mic, silent: true });
  await first;
  assert.equal(mic.getTracks()[0].readyState, 'ended');
  assert.equal(vm.runInContext('AUDIO_STARTING', c), false);
});
test('recorder setup failure releases microphone, clears session, and permits retry', async () => {
  const mic = stream(), messages = [], badge = { style: {} };
  const c = vm.createContext({ navigator: { mediaDevices: {} }, window: { MediaRecorder: {} },
    setAudioPanel: (state, m) => { if (m) messages.push(m); }, loadMicChoices() {}, showToast: m => messages.push(m), $: () => badge,
    acquireLiveMic: async () => ({ stream: mic, silent: false }),
    ensureEntryForCapture: async () => ({ entryId: 1, folderId: 2 }),
    initAudioGraph() {}, watchAudioStream() {},
    startAudioSegRecorder() { throw new Error('encoder failed'); }, clearInterval() {}, clearTimeout() {},
  });
  vm.runInContext('let AUDIO = null; let AUDIO_STARTING = false; let AUDIO_TARGET_ENTRY = null; let AUDIO_SELECTED_MIC = null; let MIC_TEST_URL = null;\n' + ['stopStream','audioStartErrorMessage','startAudio'].map(fn).join('\n'), c);
  await c.startAudio(null);
  assert.equal(mic.getTracks()[0].readyState, 'ended');
  assert.equal(vm.runInContext('AUDIO', c), null);
  assert.equal(vm.runInContext('AUDIO_STARTING', c), false);
  assert.match(messages.at(-1), /encoder failed/);
});
