import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackSampler } from '../../src/playback-stats.ts';

test('播放统计用实际采样间隔计算，区分已播放帧和丢弃帧', () => {
  const sampler = new PlaybackSampler();
  assert.equal(sampler.sample({totalVideoFrames:100,droppedVideoFrames:2}, 1000), undefined);
  assert.deepEqual(sampler.sample({totalVideoFrames:220,droppedVideoFrames:8}, 3000), {fps:57,total:120,dropped:6,droppedPercent:5});
  assert.equal(sampler.sample({totalVideoFrames:400,droppedVideoFrames:8}, 6000).fps, 60);
  assert.equal(sampler.sample({totalVideoFrames:400,droppedVideoFrames:8}, 8000).fps, 0);
});
test('视频计数重置或无有效间隔时重新建立基线', () => {
  const sampler = new PlaybackSampler();
  sampler.sample({totalVideoFrames:100,droppedVideoFrames:2}, 1000);
  assert.equal(sampler.sample({totalVideoFrames:10,droppedVideoFrames:0}, 2000), undefined);
  assert.equal(sampler.sample({totalVideoFrames:10,droppedVideoFrames:0}, 2000), undefined);
  assert.equal(sampler.sample({totalVideoFrames:70,droppedVideoFrames:0}, 3000).fps, 60);
});
