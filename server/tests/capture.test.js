import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserCaptureTracks, captureScreen, displayOptions, knownWindowAudioSupport } from '../../src/capture.ts';
import { defaults, normalizePreferences } from '../../src/preferences.ts';

function fakeCapture(surface, hasAudio = true) {
  const rawVideo = Object.assign(new EventTarget(), { readyState: 'live', stopped: false,
    getSettings: () => ({ displaySurface: surface }), applyConstraints: async () => {}, stop() { this.stopped = true; } });
  const rawAudio = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getVideoTracks: () => [rawVideo], getAudioTracks: () => hasAudio ? [rawAudio] : [], getTracks: () => hasAudio ? [rawVideo, rawAudio] : [rawVideo] };
  const created = [];
  const sdk = {
    createCustomVideoTrack: config => { created.push(['video', config]); return { stop() {}, close() {} }; },
    createCustomAudioTrack: config => { created.push(['audio', config]); return { stop() {}, close() {} }; },
  };
  return { rawVideo, rawAudio, stream, sdk, created };
}
test('picker requests source-specific window audio and offers system audio for screens', async () => {
  const options = displayOptions(defaults);
  assert.equal(options.windowAudio, 'window'); assert.equal(options.systemAudio, 'include');
  assert.equal('displaySurface' in options.video, false);
  assert.equal(options.monitorTypeSurfaces, 'include');
  const fake = fakeCapture('window');
  const capture = await captureScreen(defaults, fake.sdk, async supplied => {
    assert.equal(supplied.systemAudio, 'include'); return fake.stream;
  }, true);
  assert.equal(capture.hasAudio, true); assert.equal(fake.created.length, 2);
  assert.equal(fake.created[1][1].mediaStreamTrack, fake.rawAudio);
  let ended = false; capture.onEnded(() => { ended = true; }); fake.rawVideo.dispatchEvent(new Event('ended'));
  assert.equal(ended, true); capture.close();
  assert.equal(fake.rawVideo.stopped, true); assert.equal(fake.rawAudio.stopped, true);
});
test('unidentified audio is discarded even if the browser ignores hints', async () => {
  for (const surface of [undefined, 'unknown']) {
    const fake = fakeCapture(surface);
    const capture = await captureScreen(defaults, fake.sdk, async () => fake.stream);
    assert.equal(capture.hasAudio, false); assert.equal(fake.rawAudio.stopped, true);
    assert.equal(fake.created.length, 1); capture.close();
  }
  assert.equal(displayOptions({ ...defaults, audio: false }).audio, false);
});
test('screen audio is published, while disabling audio discards tracks for every source', async () => {
  const screen = fakeCapture('monitor');
  const capture = await captureScreen(defaults, screen.sdk, async () => screen.stream, false);
  assert.equal(capture.hasAudio, true);
  assert.equal(screen.created[1][1].mediaStreamTrack, screen.rawAudio);
  capture.close();
  const silentOptions = displayOptions({ ...defaults, audio: false });
  assert.equal(silentOptions.systemAudio, 'exclude');
  assert.equal(silentOptions.windowAudio, 'exclude');
  for (const surface of ['browser', 'window', 'monitor']) {
    const fake = fakeCapture(surface);
    const silent = await captureScreen({ ...defaults, audio: false }, fake.sdk, async () => fake.stream, true);
    assert.equal(silent.hasAudio, false);
    assert.equal(fake.rawAudio.stopped, true);
    assert.equal(fake.created.length, 1);
    silent.close();
  }
});
test('saved source preferences do not restrict the browser picker or window audio', async () => {
  const preferences = normalizePreferences({ ...defaults, surface: 'monitor' });
  assert.equal('surface' in preferences, false);
  const fake = fakeCapture('window');
  const capture = await captureScreen(preferences, fake.sdk, async options => {
    assert.equal('displaySurface' in options.video, false);
    assert.equal(options.monitorTypeSurfaces, 'include');
    assert.notEqual(options.audio, false);
    return fake.stream;
  }, true);
  assert.equal(capture.hasAudio, true);
  capture.close();
});
test('missing window audio remains a silent share and never falls back to another audio source', async () => {
  const fake = fakeCapture('window', false);
  const capture = await captureScreen(defaults, fake.sdk, async () => fake.stream);
  assert.equal(capture.hasAudio, false); assert.equal(fake.created.length, 1); capture.close();
});
test('capture initialization failure releases native tracks', async () => {
  const fake = fakeCapture('window');
  fake.sdk.createCustomAudioTrack = () => { throw new Error('audio init failed'); };
  await assert.rejects(captureScreen(defaults, fake.sdk, async () => fake.stream, true), /audio init failed/);
  assert.equal(fake.rawVideo.stopped, true); assert.equal(fake.rawAudio.stopped, true);
});
test('即构采集限制 1080P，并在无法保证分辨率时释放轨道', async () => {
  const fake = fakeCapture('monitor');
  let constraints;
  fake.rawVideo.applyConstraints = async value => { constraints = value; };
  fake.rawVideo.getSettings = () => ({ displaySurface:'monitor', width:1920, height:1080 });
  const captured = await captureScreen(defaults, fake.sdk, async () => fake.stream, true, true);
  assert.deepEqual(constraints, {width:{max:1920},height:{max:1080},frameRate:{ideal:30,max:30}});
  captured.close();
  const oversized = fakeCapture('monitor');
  oversized.rawVideo.applyConstraints = async () => {};
  oversized.rawVideo.getSettings = () => ({displaySurface:'monitor',width:2560,height:1440});
  await assert.rejects(captureScreen(defaults, oversized.sdk, async () => oversized.stream, true, true), /1080P/);
  assert.equal(oversized.rawVideo.stopped, true);
  assert.equal(oversized.rawAudio.stopped, true);
});
test('1080p60 均衡采集限制高分屏输入，并向编码器传递流畅策略和实际比例', async () => {
  const fake = fakeCapture('monitor', false);
  fake.rawVideo.getSettings = () => ({displaySurface:'monitor',width:3440,height:1440});
  fake.rawVideo.applyConstraints = async constraints => {
    assert.deepEqual(constraints, {width:{max:1920},height:{max:1080},frameRate:{ideal:60,max:60}});
    fake.rawVideo.getSettings = () => ({displaySurface:'monitor',width:1920,height:804,frameRate:60});
  };
  const capture = await captureScreen({...defaults, fps:60, optimization:'balanced'}, fake.sdk, async () => fake.stream);
  assert.equal(fake.rawVideo.contentHint, '');
  assert.equal(fake.created[0][1].optimizationMode, 'motion');
  assert.equal(fake.created[0][1].frameRate, 60);
  assert.equal(fake.created[0][1].height, 804);
  capture.close();
});
test('约束失败释放全部采集轨道，原画仅限制帧率', async () => {
  const fake = fakeCapture('monitor');
  fake.rawVideo.applyConstraints = async () => { throw new Error('constraints'); };
  await assert.rejects(captureScreen(defaults, fake.sdk, async () => fake.stream), /画质/);
  assert.ok(fake.rawVideo.stopped && fake.rawAudio.stopped);
  const native = fakeCapture('monitor', false);
  native.rawVideo.applyConstraints = async constraints => assert.deepEqual(constraints, {frameRate:{ideal:60,max:60}});
  const capture = await captureScreen({...defaults,resolution:'native',fps:60}, native.sdk, async () => native.stream);
  capture.close();
});
test('older window capture cannot accidentally publish system loopback audio', async () => {
  assert.equal(knownWindowAudioSupport('Mozilla/5.0 Chrome/140.0.0.0'), false);
  assert.equal(knownWindowAudioSupport('Mozilla/5.0 Chrome/141.0.0.0'), true);
  assert.equal(knownWindowAudioSupport('Firefox/150'), false);
  const fake = fakeCapture('window');
  const capture = await captureScreen(defaults, fake.sdk, async () => fake.stream, false);
  assert.equal(capture.hasAudio, false); assert.equal(fake.rawAudio.stopped, true); capture.close();
  const tab = fakeCapture('browser');
  const tabCapture = await captureScreen(defaults, tab.sdk, async () => tab.stream, false);
  assert.equal(tabCapture.hasAudio, true); tabCapture.close();
});
test('非声网采集直接封装原生媒体轨，不依赖声网 SDK', async () => {
  const fake = fakeCapture('monitor');
  const capture = await captureScreen(defaults, browserCaptureTracks, async () => fake.stream);
  assert.equal(capture.hasAudio, true);
  assert.equal(capture.tracks[0].trackMediaType, 'video');
  assert.equal(capture.tracks[0].getMediaStreamTrack(), fake.rawVideo);
  assert.equal(capture.tracks[1].getMediaStreamTrack(), fake.rawAudio);
  capture.close();
  assert.equal(fake.rawVideo.stopped, true);
  assert.equal(fake.rawAudio.stopped, true);
});
