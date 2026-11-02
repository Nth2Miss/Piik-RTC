import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewerRecovery } from '../../src/rtc/viewer-recovery.ts';
import { browserVideoTrack, hasVideoOutput } from '../../src/rtc/browser.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; }
function fixture(overrides = {}, operations = {}) {
  const state = {scope:'room:1',enabled:true,connected:true,connecting:false,busy:false,sharing:false,visible:true,paused:false,
    leaseHealthy:true,intentRevision:0,targetUid:7,published:false,videoReady:false,playbackBlocked:false,...overrides};
  const calls = [], changes = [];
  const recovery = new ViewerRecovery({read:() => ({...state}),
    disconnect:async () => { calls.push('disconnect'); state.connected = false; await operations.disconnect?.(); },
    connect:async () => { calls.push('connect'); await operations.connect?.(); state.connected = true; },
    select:async uid => { calls.push(['select',uid]); await operations.select?.(); },
    resubscribe:operations.resubscribe ? async uid => {calls.push(['resubscribe',uid]); await operations.resubscribe();} : undefined,
    changed:record => changes.push(record),
  });
  return {recovery,state,calls,changes};
}

test('无首帧先重试订阅，恢复出画后不退出或重新加入媒体房间', async () => {
  const f = fixture({published:true},{resubscribe:async () => {f.state.videoReady = true;}});
  f.recovery.tick(0); f.recovery.tick(13999); assert.equal(f.calls.length,0);
  f.recovery.tick(14000); await flush();
  assert.deepEqual(f.calls,[['resubscribe',7]]);
  f.recovery.tick(16000); assert.equal(f.recovery.export()[0].status,'receiving');
  for (const at of [20000,40000,60000]) f.recovery.tick(at);
  assert.deepEqual(f.calls,[['resubscribe',7]]);
});

test('轻量恢复仍无画面才重进，整次进房对所有共享者合计最多重进一次', async () => {
  const f = fixture({published:true},{resubscribe:async () => {}});
  f.recovery.tick(0); f.recovery.tick(14000); await flush();
  f.recovery.tick(16000); f.recovery.tick(23999); assert.deepEqual(f.calls,[['resubscribe',7]]);
  f.recovery.tick(24000); await flush();
  assert.deepEqual(f.calls,[['resubscribe',7],'disconnect','connect',['select',7]]);
  f.state.targetUid = 8;
  f.recovery.tick(26000); f.recovery.tick(40000); await flush();
  f.recovery.tick(50000); f.recovery.tick(60000); await flush();
  assert.equal(f.calls.filter(call => call === 'disconnect').length,1);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'resubscribe').length,2);
});

test('慢订阅完成后仍留足出画时间，不能立刻再重进房间', async () => {
  const pending = deferred(), f = fixture({published:true},{resubscribe:() => pending.promise});
  f.recovery.tick(0); f.recovery.tick(14000); await flush(); f.recovery.tick(30000);
  pending.resolve(); await flush();
  f.recovery.tick(32000); f.recovery.tick(39999);
  assert.deepEqual(f.calls,[['resubscribe',7]]);
  f.recovery.tick(40000); await flush();
  assert.equal(f.calls.filter(call => call === 'disconnect').length,1);
});

test('新发布刚到时先等首帧，不能把此前缺失发布的时间算作播放失败', async () => {
  const f = fixture({}, {resubscribe:async () => {}});
  f.recovery.tick(0); f.state.published = true; f.recovery.tick(18000);
  f.recovery.tick(20000); f.recovery.tick(31999); assert.equal(f.calls.length,0);
  f.recovery.tick(32000); await flush(); assert.deepEqual(f.calls,[['resubscribe',7]]);
});

test('服务端持续共享但 RTC 丢流，等待启动窗口后仅重建一次，不以重新进房冒充出画', async () => {
  const f = fixture();
  f.recovery.tick(0); f.recovery.tick(19999); assert.equal(f.calls.length,0);
  f.recovery.tick(20000); await flush();
  assert.deepEqual(f.calls,['disconnect','connect',['select',7]]);
  assert.equal(f.recovery.export().at(-1).status,'rejoined');
  for (let at = 22000; at <= 60000; at += 2000) f.recovery.tick(at);
  await flush(); assert.equal(f.calls.length,3);
  f.state.published = true; f.state.videoReady = true; f.recovery.tick(62000);
  assert.equal(f.recovery.export().at(-1).status,'receiving');
  const copy = f.recovery.export(); copy[0].status = 'failed';
  assert.equal(f.recovery.export()[0].status,'receiving');
});

test('SDK 报告已发布但无首帧，等待正常订阅超时后才重建；静态画面有首帧则不重建', async () => {
  const f = fixture({published:true});
  f.recovery.tick(0); f.recovery.tick(19999); assert.equal(f.calls.length,0);
  f.recovery.tick(20000); await flush(); assert.equal(f.calls.length,3);
  assert.equal(f.recovery.export()[0].reason,'missing-first-frame');
  const healthy = fixture({published:true,videoReady:true});
  for (let at = 0; at <= 30000; at += 2000) healthy.recovery.tick(at);
  assert.equal(healthy.calls.length,0);
});

test('声网即构、正在本机共享、后台、主动暂停、交互中、租约失效和自动播放限制不触发接收重建', async () => {
  for (const override of [{enabled:false},{sharing:true},{visible:false},{paused:true},{busy:true},{leaseHealthy:false},
    {playbackBlocked:true},{targetUid:undefined},{connected:false},{connecting:true}]) {
    const f = fixture(override);
    for (let at = 0; at <= 30000; at += 2000) f.recovery.tick(at);
    await flush(); assert.equal(f.calls.length,0,JSON.stringify(override));
  }
});

test('用户切换、离房、本地开始共享或失去租约时，迟到的重连不能抢回旧画面', async () => {
  for (const override of [{intentRevision:1},{scope:'other:2'},{sharing:true},{leaseHealthy:false},{targetUid:8}]) {
    const pending = deferred(), f = fixture({}, {connect:() => pending.promise});
    f.recovery.tick(0); f.recovery.tick(20000); await flush();
    Object.assign(f.state,override); pending.resolve(); await flush();
    assert.deepEqual(f.calls,['disconnect','connect']);
    assert.equal(f.recovery.export()[0].status,'cancelled');
  }
});

test('退出确认失败不继续连接或循环重建，下一次进房才重新获得恢复机会', async () => {
  const f = fixture({}, {disconnect:async () => { throw new Error('leave failed'); }});
  f.recovery.tick(0); f.recovery.tick(20000); await flush();
  assert.deepEqual(f.calls,['disconnect']); assert.equal(f.recovery.export()[0].status,'failed');
  f.state.connected = true;
  f.recovery.tick(20000); f.recovery.tick(30000); await flush(); assert.equal(f.calls.length,1);
  f.state.scope = 'room:2'; f.recovery.tick(40000); f.recovery.tick(60000); await flush(); assert.equal(f.calls.length,2);
});

test('浏览器视频暴露首帧与自动播放限制，点击重试且停止后不残留监听', async t => {
  const saved = Object.getOwnPropertyDescriptor(globalThis,'document'), savedStream = Object.getOwnPropertyDescriptor(globalThis,'MediaStream');
  const document = new EventTarget();
  let attempts = 0;
  const video = {style:{},readyState:0,paused:true,frames:0,error:null,
    getVideoPlaybackQuality(){return {totalVideoFrames:this.frames,droppedVideoFrames:this.droppedFrames ?? 0};},
    async play(){ if (++attempts === 1) throw new DOMException('blocked','NotAllowedError'); this.paused = false; },
    pause(){this.paused = true;},remove(){},
  };
  document.createElement = () => video;
  Object.defineProperty(globalThis,'document',{configurable:true,value:document});
  Object.defineProperty(globalThis,'MediaStream',{configurable:true,value:class {constructor(tracks){this.tracks = tracks;}}});
  t.after(() => {
    if (saved) Object.defineProperty(globalThis,'document',saved); else delete globalThis.document;
    if (savedStream) Object.defineProperty(globalThis,'MediaStream',savedStream); else delete globalThis.MediaStream;
  });
  const track = browserVideoTrack({kind:'video'});
  track.play({replaceChildren(){}}); await flush();
  assert.equal(track.getPlaybackState().playError,'blocked'); assert.equal(track.getPlaybackState().frames,0);
  document.dispatchEvent(new Event('click')); await flush();
  video.readyState = 2; video.frames = 1;
  assert.equal(track.getPlaybackState().playError,undefined); assert.equal(track.getPlaybackState().frames,1);
  assert.equal(hasVideoOutput(track.getPlaybackState()),true);
  video.droppedFrames = 1; assert.equal(hasVideoOutput(track.getPlaybackState()),false);
  video.droppedFrames = 0; video.paused = true; assert.equal(hasVideoOutput(track.getPlaybackState()),false);
  track.stop(); document.dispatchEvent(new Event('click')); await flush();
  assert.equal(attempts,2); assert.equal(track.getPlaybackState().attached,false);
});
