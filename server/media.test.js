import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceController } from '../src/source-controller.ts';
import { normalizePreferences, captureConfig, defaults, presets } from '../src/preferences.ts';

function track(id, log) {
  return { play: () => log.push(`play:${id}`), stop: () => log.push(`stop:${id}`), close: () => log.push(`close:${id}`), setVolume: v => log.push(`volume:${id}:${v}`) };
}
function setup(subscribe) {
  const log = [];
  const users = [1, 2].map(uid => ({ uid, hasVideo: true, hasAudio: true, videoTrack: track(`v${uid}`, log), audioTrack: track(`a${uid}`, log) }));
  const controller = new SourceController({ client: {
    subscribe: subscribe || (async (user, type) => { log.push(`subscribe:${user.uid}:${type}`); }),
    unsubscribe: async user => { log.push(`unsubscribe:${user.uid}`); },
  }, remote: uid => users.find(u => u.uid === uid), video: t => t.play(), empty: () => log.push('empty'), error: e => { throw e; } });
  return { log, users, controller };
}
test('switching users stops previous video and audio, and only subscribes the selected source', async () => {
  const { log, controller } = setup();
  await controller.select(1);
  assert.equal(log.includes('subscribe:2:video'), false);
  await controller.select(2);
  assert.ok(log.indexOf('stop:a1') < log.indexOf('play:a2'));
  assert.ok(log.includes('unsubscribe:1'));
  assert.ok(log.includes('play:v2'));
  assert.equal(controller.selected, 2);
});
test('switching away from local preview never closes the published local track', async () => {
  const { log, controller } = setup();
  controller.setLocal(99, track('local', log));
  await controller.select(99); await controller.select(1); await controller.select(99);
  assert.ok(log.includes('stop:local'));
  assert.equal(log.includes('close:local'), false);
  assert.ok(log.includes('stop:a1'));
  await controller.select(undefined);
  assert.equal(controller.selected, undefined);
});
test('rapid switching cannot play a stale asynchronous subscription', async () => {
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const { controller, log } = setup(async (user, type) => { if (user.uid === 1 && type === 'video') await gate; });
  const first = controller.select(1);
  await new Promise(resolve => setImmediate(resolve));
  const second = controller.select(2); unblock(); await Promise.all([first, second]);
  assert.equal(log.includes('play:v1'), false);
  assert.equal(log.includes('play:a1'), false);
  assert.ok(log.includes('play:v2'));
  controller.setAudio(0, true);
  assert.ok(log.includes('volume:a2:0'));
});
test('local pause silences remote audio and resumes at the current volume', async () => {
  const { log, controller } = setup();
  await controller.select(1);
  controller.setPaused(true);
  assert.equal(log.at(-1), 'volume:a1:0');
  controller.setPaused(false);
  assert.equal(log.at(-1), 'volume:a1:80');
  controller.setPaused(true);
  controller.setAudio(60, false);
  assert.equal(log.at(-1), 'volume:a1:0');
  controller.setPaused(false);
  assert.equal(log.at(-1), 'volume:a1:60');
  controller.setPaused(true);
  await controller.select(2);
  assert.ok(log.includes('volume:a2:0'));
  controller.setPaused(false);
  assert.equal(log.at(-1), 'volume:a2:60');
});
test('accepts the 12 and 16 Mbps bitrate tiers', () => {
  assert.equal(normalizePreferences({ ...defaults, bitrate: 12000 }).bitrate, 12000);
  assert.equal(normalizePreferences({ ...defaults, bitrate: 16000 }).bitrate, 16000);
  assert.equal(captureConfig({ ...defaults, bitrate: 16000 }).encoderConfig.bitrateMax, 16000);
  assert.equal(normalizePreferences({ ...defaults, bitrate: 11000 }).bitrate, defaults.bitrate);
});
test('invalid persisted settings are bounded; presets produce SDK capture configuration', () => {
  const bad = normalizePreferences({ volume: Infinity, fps: 999, resolution: '<script>', bitrate: -1, optimization: 'invalid', audio: 'false' });
  assert.deepEqual(bad, defaults);
  assert.equal(normalizePreferences({ volume: -20 }).volume, 0);
  assert.equal(normalizePreferences({ volume: 180 }).volume, 100);
  const game = normalizePreferences({ ...defaults, ...presets.game });
  const config = captureConfig(game);
  assert.equal(config.encoderConfig.frameRate, 60);
  assert.equal(config.encoderConfig.width, 1920);
  assert.equal(config.encoderConfig.bitrateMax, 8000);
  assert.equal(config.optimizationMode, 'motion');
  assert.equal(config.selfBrowserSurface, 'exclude');
  assert.equal(captureConfig({ ...game, audio: false }).systemAudio, 'exclude');
});
