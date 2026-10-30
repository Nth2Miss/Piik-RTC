import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceController } from '../../src/source-controller.ts';
import { normalizePreferences, captureConfig, encoderConfig, automaticBitrate, effectiveBitrate, videoOptimization, videoContentHint, defaults, presets } from '../../src/preferences.ts';

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
test('重复选择当前成员和音轨更新不重建健康的视频订阅', async () => {
  const { log, users, controller } = setup();
  users[0].hasAudio = false;
  await controller.select(1);
  await controller.select(1);
  users[0].hasAudio = true;
  await controller.select(1);
  await controller.select(1);
  assert.equal(log.filter(item => item === 'subscribe:1:video').length, 1);
  assert.equal(log.filter(item => item === 'subscribe:1:audio').length, 1);
  assert.equal(log.filter(item => item === 'play:v1').length, 1);
  assert.equal(log.includes('unsubscribe:1'), false);
  users[0].hasAudio = false;
  await controller.select(1);
  assert.equal(log.at(-1), 'stop:a1');
});
test('均衡高帧率优先保帧，普通均衡不强制清晰策略，明确清晰选项保持不变', () => {
  assert.equal(videoOptimization({...defaults,optimization:'balanced',fps:60}), 'motion');
  assert.equal(videoContentHint({...defaults,optimization:'balanced',fps:60}), 'motion');
  assert.equal(videoContentHint({...defaults,optimization:'balanced',fps:30}), '');
  assert.equal(videoOptimization({...defaults,optimization:'detail',fps:60}), 'detail');
});
test('编码尺寸按共享来源等比缩小，不拉伸窄窗口或放大小画面', () => {
  assert.deepEqual(encoderConfig(defaults, {width:3840,height:2160}), {width:1920,height:1080,frameRate:30,bitrateMax:5000});
  assert.equal(encoderConfig(defaults, {width:1080,height:1920}).width, 606);
  assert.equal(encoderConfig(defaults, {width:800,height:600}).width, 800);
  assert.equal(encoderConfig({...defaults,resolution:'native'}, {width:3440,height:1440}).width, 3440);
});
test('自动码率随分辨率和帧率调整，手动上限保持可用', () => {
  assert.equal(defaults.bitrateMode, 'auto');
  assert.equal(automaticBitrate({...defaults,resolution:'720',fps:30}), 3000);
  assert.equal(automaticBitrate({...defaults,resolution:'1080',fps:60}), 8000);
  assert.equal(automaticBitrate({...defaults,resolution:'1440',fps:60}), 16000);
  assert.equal(effectiveBitrate({...defaults,resolution:'1080',fps:60,bitrate:1000}), 8000);
  assert.equal(effectiveBitrate({...defaults,bitrateMode:'manual',bitrate:12000}), 12000);
  assert.equal(normalizePreferences({bitrateMode:'invalid'}).bitrateMode, 'auto');
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
test('暂停和恢复不修改 SDK 视频轨，暂停期间调整音量后仍能恢复', async () => {
  const { log, controller } = setup();
  await controller.select(1);
  controller.setPaused(true);
  assert.equal(log.at(-1), 'stop:a1');
  controller.setPaused(false);
  assert.equal(log.at(-1), 'play:a1');
  controller.setPaused(true);
  controller.setAudio(60, false);
  assert.equal(log.at(-1), 'volume:a1:60');
  controller.setPaused(false);
  assert.equal(log.at(-1), 'play:a1');
  assert.equal(log.filter(item => item === 'stop:v1' || item === 'play:v1').length, 1);
});
test('accepts the 12 and 16 Mbps bitrate tiers', () => {
  assert.equal(normalizePreferences({ ...defaults, bitrate: 12000 }).bitrate, 12000);
  assert.equal(normalizePreferences({ ...defaults, bitrate: 16000 }).bitrate, 16000);
  assert.equal(captureConfig({ ...defaults, bitrateMode:'manual',bitrate:16000 }).encoderConfig.bitrateMax, 16000);
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
