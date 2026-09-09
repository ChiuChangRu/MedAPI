import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const app = readFileSync(new URL('../fieldlog/public/app.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../fieldlog/public/index.html', import.meta.url), 'utf8');
const extract = n => app.match(new RegExp(`(?:async )?function ${n}\\([^\\n]*\\)[\\s\\S]*?\\n\\}`))[0];
function trackStream() {
  const track = { readyState: 'live', muted: true, stop() { this.readyState = 'ended'; } };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}
function panelContext(overrides = {}) {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false, disabled: false, style: {}, dataset: {},
      classList: { toggle() {} }, pause() {}, load() {}, removeAttribute() {} });
    return nodes.get(id);
  };
  const c = vm.createContext({ $, Date, clearTimeout, setTimeout, Blob,
    URL: { createObjectURL: () => 'blob:local-test', revokeObjectURL() {} },
    loadMicChoices() {}, AUDIO_SIGNAL_FLOOR: 0.0001, readMicPeak: () => .1,
    ...overrides,
  });
  vm.runInContext('let AUDIO=null, AUDIO_STARTING=false, AUDIO_SELECTED_MIC=null, MIC_TEST_CANCEL=null, MIC_TEST_URL=null;\n'+
    ['setAudioPanel','setAudioStatus','refreshAudioPanel','clearMicTestPlayback','closeAudioPanel','stopStream','testSelectedMic'].map(extract).join('\n'), c);
  return { c, $ };
}
test('panel is visible immediately, never labels a failed connection as recording', () => {
  const { c, $ } = panelContext();
  c.setAudioPanel('connecting', 'checking');
  assert.equal($('audio-badge').style.display, 'flex');
  assert.equal($('audio-panel-title').textContent, '正在連接麥克風');
  assert.equal($('audio-record-actions').hidden, true);
  c.setAudioPanel('failed', 'no input');
  assert.equal($('audio-panel-title').textContent, '未開始錄音');
  assert.equal($('audio-timer').textContent, '00:00');
  assert.equal($('audio-recovery').hidden, false);
  assert.equal($('audio-status').textContent, 'no input');
});
test('active recording exposes stop controls and cannot hide its panel; muted track switches to warning', () => {
  const { c, $ } = panelContext();
  c.session = { stream: trackStream(), recorder: { state: 'recording' } };
  vm.runInContext('AUDIO=session', c);
  c.setAudioPanel('recording');
  assert.equal($('audio-record-actions').hidden, false);
  assert.equal($('audio-panel-close').hidden, true);
  c.closeAudioPanel();
  assert.equal($('audio-badge').style.display, 'flex');
  c.refreshAudioPanel();
  assert.equal($('audio-badge').dataset.state, 'waiting');
  assert.match($('audio-signal').textContent, /未收到聲音/);
  c.session.stream.getTracks()[0].muted = false;
  c.refreshAudioPanel();
  assert.equal($('audio-badge').dataset.state, 'recording');
});
test('readiness starts a real consumer before waiting for unmute, and stops that recorder', async () => {
  const events = [], stream = trackStream();
  const c = vm.createContext({
    MediaRecorder: class { state='inactive'; start() { events.push('start'); this.state='recording'; stream.getTracks()[0].muted=false; } stop() { events.push('stop'); this.state='inactive'; } },
    waitForTrackUsable: async s => { events.push('wait'); return !s.getTracks()[0].muted; },
    probeStreamPeak: async () => .2, AUDIO_MUTE_GRACE_MS: 1, AUDIO_SIGNAL_FLOOR: .0001,
  });
  vm.runInContext(extract('probeMicReadiness'), c);
  const result = await c.probeMicReadiness(stream);
  assert.equal(result.usable, true);
  assert.deepEqual(events, ['start','wait','stop']);
  assert.equal(stream.getTracks()[0].readyState, 'live', 'main recording still owns the input');
});
test('readiness never accepts an ended track or permanent muted silence', async () => {
  const stream = trackStream();
  const c = vm.createContext({ MediaRecorder: class { state='inactive'; start() { this.state='recording'; } stop() { this.state='inactive'; } },
    waitForTrackUsable: async () => false, probeStreamPeak: async () => 0, AUDIO_MUTE_GRACE_MS: 1, AUDIO_SIGNAL_FLOOR: .0001 });
  vm.runInContext(extract('probeMicReadiness'), c);
  assert.equal((await c.probeMicReadiness(stream)).usable, false);
  stream.getTracks()[0].stop();
  c.waitForTrackUsable = async () => true;
  c.probeStreamPeak = async () => .3;
  assert.equal((await c.probeMicReadiness(stream)).usable, false);
});
test('short test records even a muted-flag stream, releases input, and only provides local playback', async () => {
  const stream = trackStream(); let starts=0;
  const { c, $ } = panelContext({ openMicStream: async () => stream,
    setTimeout: (f, ms) => setTimeout(f, ms / 100),
    MediaRecorder: class { state='inactive'; mimeType='audio/webm'; start() { starts++; this.state='recording'; } stop() { this.state='inactive'; this.ondataavailable?.({ data: new Blob(['sample']) }); this.onstop?.(); } },
  });
  await c.testSelectedMic();
  assert.equal(starts, 1);
  assert.equal(stream.getTracks()[0].readyState, 'ended');
  assert.equal($('audio-test-playback').src, 'blob:local-test');
  assert.equal($('audio-test-playback').hidden, false);
  assert.equal($('audio-panel-title').textContent, '未開始錄音');
  assert.equal(vm.runInContext('AUDIO_STARTING', c), false);
});
test('closing a test before getUserMedia resolves stops the late stream and creates no recorder', async () => {
  let resolve; const stream = trackStream();
  const { c, $ } = panelContext({ openMicStream: () => new Promise(r => { resolve=r; }), MediaRecorder: class { constructor() { assert.fail('cancelled test must not record'); } } });
  const pending = c.testSelectedMic();
  c.closeAudioPanel();
  resolve(stream); await pending;
  assert.equal(stream.getTracks()[0].readyState, 'ended');
  assert.equal($('audio-badge').style.display, 'none');
  assert.equal(vm.runInContext('AUDIO_STARTING', c), false);
});
test('every panel element used by the renderer exists exactly once in the shipped page', () => {
  for (const id of ['audio-badge','audio-panel-title','audio-signal','audio-recovery','audio-panel-close','audio-test-btn','audio-retry-btn','audio-mic-select','audio-test-playback','audio-record-actions']) {
    assert.equal(index.split(`id="${id}"`).length-1, 1, id);
  }
});
