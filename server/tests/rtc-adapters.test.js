import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtcClient } from '../../src/rtc-client.ts';
import { VolcRtcAdapter } from '../../src/rtc/volc.ts';
import { ZegoRtcAdapter } from '../../src/rtc/zego.ts';
import { SourceController } from '../../src/source-controller.ts';
import { browserCaptureTracks, captureScreen } from '../../src/capture.ts';
import { defaults } from '../../src/preferences.ts';
import { ViewerRecovery } from '../../src/rtc/viewer-recovery.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function browser(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'MediaStream');
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  }
  Object.defineProperty(globalThis, 'MediaStream', { configurable:true, value:Stream });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'MediaStream', original); else delete globalThis.MediaStream; });
  const video = Object.assign(new EventTarget(), { kind:'video', enabled:true, readyState:'live',
    getSettings:() => ({width:1920,height:1080,displaySurface:'monitor'}), applyConstraints:async () => {}, stop() { this.readyState = 'ended'; } });
  const audio = { kind:'audio', enabled:true, readyState:'live', stop() { this.readyState = 'ended'; } };
  return { video, audio, stream:new Stream([video,audio]) };
}
function volcFixture(raw, overrides = {}) {
  const calls = [], handlers = new Map();
  const engine = {
    on:(name, handler) => handlers.set(name, handler),
    joinRoom:async () => {}, leaveRoom:async () => calls.push(['leave']),
    setScreenEncoderConfig:async config => calls.push(['config',config]),
    setVideoSourceType:async (_index, type) => calls.push(['video-source',type]), setAudioSourceType:async (_index, type) => calls.push(['audio-source',type]),
    setExternalVideoTrack:async (_index, track) => calls.push(['video',track]), setExternalAudioTrack:async () => calls.push(['audio']),
    publishScreen:async type => calls.push(['publish',type]), unpublishScreen:async () => calls.push(['unpublish']),
    subscribeScreen:async (_uid, kind) => calls.push(['subscribe',kind]),
    unsubscribeScreen:async (_uid, kind) => calls.push(['unsubscribe',kind]),
    getRemoteStreamTrack:() => raw.video, setPlaybackVolume:(_uid,_index,volume) => calls.push(['volume',volume]),
    getLocalVideoStats:() => ({screenVideoStats:{inputFrameRate:0,sentFrameRate:60}}),
    getRemoteVideoStats:() => ({'7':[{screenVideoStats:{width:1920,height:1080,decoderOutputFrameRate:0,rendererOutputFrameRate:24}}]}),
    ...overrides,
  };
  const sdk = {
    default:{createEngine:() => { calls.push(['create']); return engine; }, destroyEngine:() => calls.push(['destroy']),
      events:Object.fromEntries(['onConnectionStateChanged','onUserPublishScreen','onUserUnpublishScreen','onUserLeave','onTokenWillExpire','onLocalStreamStats','onRemoteStreamStats'].map(name => [name,name]))},
    StreamIndex:{STREAM_INDEX_SCREEN:1}, MediaType:{AUDIO:1,VIDEO:2,AUDIO_AND_VIDEO:3},
    VideoSourceType:{VIDEO_SOURCE_TYPE_EXTERNAL:1,VIDEO_SOURCE_TYPE_INTERNAL:0}, AudioSourceType:{AUDIO_SOURCE_TYPE_EXTERNAL:1,AUDIO_SOURCE_TYPE_INTERNAL:0},
  };
  return { sdk, calls, engine, emit:(name,value) => handlers.get(name)(value), announce:() => handlers.get('onUserPublishScreen')({userId:'7',mediaType:3}) };
}
function zegoFixture(raw, overrides = {}) {
  const calls = [], handlers = new Map();
  const engine = {
    on:(name, handler) => handlers.set(name, handler), loginRoom:async () => true,
    logoutRoom:() => calls.push(['leave']), destroyEngine:() => calls.push(['destroy']),
    createStream:async config => { calls.push(['config',config.custom]); return config.custom.source; },
    setVideoConfig:async (_stream,config) => calls.push(['encoder',config]),
    startPublishingStream:() => { calls.push(['publish']); return true; }, stopPublishingStream:() => calls.push(['unpublish']), destroyStream:() => {},
    startPlayingStream:async () => raw.stream, stopPlayingStream:() => calls.push(['unsubscribe']),
    getPublishingStreamQuality:() => ({video:{videoFPS:60}}),
    getPlayingStreamQuality:() => ({video:{videoFPS:60,videoTransferFPS:0,videoRenderFPS:24}}),
    ...overrides,
  };
  const sdk = { ZegoExpressEngine:class { constructor() { calls.push(['create']); return engine; } } };
  return { sdk, calls, engine, announce:() => handlers.get('roomStreamUpdate')('room','ADD',[{user:{userID:'7'},streamID:'room_7'}]) };
}
function agoraFixture(overrides = {}) {
  const calls = [];
  const client = { remoteUsers:[], on() {}, join:async () => 42, leave:async () => calls.push(['leave']),
    publish:async tracks => calls.push(['publish',tracks]), unpublish:async () => calls.push(['unpublish']),
    getLocalVideoStats:() => ({sendResolutionWidth:1920,sendResolutionHeight:1080,sendFrameRate:60,encodeDelay:0}),
    getRemoteVideoStats:() => ({'7':{receiveResolutionWidth:1920,receiveResolutionHeight:1080,receiveFrameRate:60,decodeFrameRate:60}}),
    getRTCStats:() => ({RTT:5,OutgoingAvailableBandwidth:9000,RecvBitrate:0,SendBitrate:8000000,Duration:1,UserCount:2}),
    ...overrides };
  const sdk = { createClient:() => client,
    createCustomVideoTrack:config => { calls.push(['config',config]); return browserCaptureTracks.createCustomVideoTrack(config); },
    createCustomAudioTrack:config => browserCaptureTracks.createCustomAudioTrack(config),
  };
  return {sdk,calls};
}

test('火山轻量重试只重新绑定订阅与播放器，保留媒体连接和现有音频', async t => {
  const raw = browser(t), f = volcFixture(raw);
  const client = new RtcClient({volc:async () => f.sdk});
  await client.setProvider('volc'); await client.join('app','room','test-token',42); f.announce();
  let shown;
  const source = new SourceController({client,remote:uid => client.remoteUsers.find(user => user.uid === uid),video:track => {shown = track;},empty(){},error(error){throw error;}});
  await source.select(7); const previous = shown, audio = client.remoteUsers[0].audioTrack;
  await source.select(7,true);
  assert.ok(shown); assert.notEqual(shown,previous); assert.equal(client.remoteUsers[0].audioTrack,audio);
  assert.equal(f.calls.filter(([name,type]) => name === 'subscribe' && type === 2).length,2);
  assert.equal(f.calls.filter(([name,type]) => name === 'subscribe' && type === 1).length,1);
  assert.equal(f.calls.some(([name]) => ['leave','destroy','unsubscribe'].includes(name)),false);
  await source.select(undefined); await client.leave();
});

for (const provider of ['volc','volc2']) {
  test(`${provider} 页面仍连接但发布缓存已丢失，接收恢复重进媒体房间后重新订阅且不关闭采集`, async t => {
    const raw = browser(t);
    let joins = 0, connected = true, shown;
    const f = volcFixture(raw,{joinRoom:async () => { if (++joins === 2) f.emit('onUserPublishScreen',{userId:'7',mediaType:2}); }});
    const client = new RtcClient({volc:async () => f.sdk});
    await client.setProvider(provider); await client.join('app','room','test-token',42);
    const source = new SourceController({client,remote:uid => client.remoteUsers.find(user => user.uid === uid),video:track => {shown = track;},empty:() => {shown = undefined;},error(error){throw error;}});
    const recovery = new ViewerRecovery({
      read:() => ({scope:'room:1',enabled:true,connected,connecting:false,busy:false,sharing:false,visible:true,paused:false,leaseHealthy:true,intentRevision:0,
        targetUid:7,published:!!client.remoteUsers.find(user => user.uid === 7)?.hasVideo,videoReady:!!shown,playbackBlocked:false}),
      disconnect:async () => {connected = false; await source.select(undefined); await client.leave();},
      connect:async () => {await client.join('app','room','test-token',42); connected = true;},
      select:uid => source.select(uid),changed(){},
    });
    recovery.tick(0); recovery.tick(20000); await flush();
    assert.equal(joins,2); assert.ok(shown); assert.equal(source.selected,7);
    assert.equal(raw.video.readyState,'live');
    assert.equal(f.calls.filter(([name,kind]) => name === 'subscribe' && kind === 2).length,1);
    assert.equal(recovery.export()[0].status,'rejoined');
    await source.select(undefined); await client.leave();
  });
}

test('火山离房等待服务器确认，超时仍销毁旧引擎', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const pending = deferred(), f = volcFixture(browser(t),{leaveRoom:async waitAck => {assert.equal(waitAck,true); await pending.promise;}});
  const adapter = new VolcRtcAdapter({emit(){}},async () => f.sdk);
  await adapter.join('app','room','test-token',42);
  const leaving = adapter.leave(), rejected = assert.rejects(leaving,/退出媒体房间确认超时/);
  await flush(); assert.equal(f.calls.some(([name]) => name === 'destroy'),false);
  t.mock.timers.tick(8000); await rejected;
  assert.equal(f.calls.filter(([name]) => name === 'destroy').length,1);
  pending.resolve(); await flush();
});

for (const provider of ['volc','volc2']) {
  test(`${provider} 停播与重发在同一轮事件到达，观看端必须订阅新轨道而非复用旧播放`, async t => {
    const raw = browser(t), replacement = browser(t);
    let remoteTrack = raw.video, shown, source;
    const f = volcFixture(raw,{getRemoteStreamTrack:() => remoteTrack});
    const client = new RtcClient({volc:async () => f.sdk});
    await client.setProvider(provider); await client.join('app','room','test-token',42);
    source = new SourceController({client,remote:uid => client.remoteUsers.find(user => user.uid === uid),video:track => {shown = track;},empty:() => {shown = undefined;},error(error){throw error;}});
    client.on('user-published',(user,kind) => { if (kind === 'video') void source.select(user.uid); });
    client.on('user-unpublished',(user,kind) => { if (kind === 'video') source.holdForRepublish(user.uid,() => {}); });
    f.emit('onUserPublishScreen',{userId:'7',mediaType:2}); await flush();
    const old = shown;
    assert.ok(old);
    f.emit('onUserUnpublishScreen',{userId:'7',mediaType:2});
    remoteTrack = replacement.video;
    f.emit('onUserPublishScreen',{userId:'7',mediaType:2});
    await flush();
    assert.equal(f.calls.filter(([name,kind]) => name === 'subscribe' && kind === 2).length,2);
    assert.ok(shown); assert.notEqual(shown,old); assert.equal(source.selected,7);
    await source.select(undefined); await client.leave();
  });
}

test('火山旧发布的订阅迟到，不能覆盖新画面或取消新发布的订阅', async t => {
  const raw = browser(t), old = deferred();
  let calls = 0;
  const f = volcFixture(raw,{subscribeScreen:async () => { if (++calls === 1) await old.promise; }});
  const adapter = new VolcRtcAdapter({emit(){}},async () => f.sdk);
  await adapter.join('app','room','test-token',42);
  f.emit('onUserPublishScreen',{userId:'7',mediaType:2});
  const user = adapter.remoteUsers[0], pending = adapter.subscribe(user,'video');
  const rejected = assert.rejects(pending,/订阅已取消/);
  await flush();
  f.emit('onUserUnpublishScreen',{userId:'7',mediaType:2});
  f.emit('onUserPublishScreen',{userId:'7',mediaType:2});
  await adapter.subscribe(user,'video'); const current = user.videoTrack;
  old.resolve(); await rejected;
  assert.ok(current); assert.equal(user.videoTrack,current);
  assert.equal(f.calls.filter(([name]) => name === 'unsubscribe').length,0);
  await adapter.leave();
});

test('火山旧取消订阅完成时，不清空新发布的轨道或音量状态', async t => {
  const raw = browser(t), old = deferred();
  const f = volcFixture(raw,{unsubscribeScreen:async () => old.promise});
  const adapter = new VolcRtcAdapter({emit(){}},async () => f.sdk);
  await adapter.join('app','room','test-token',42); f.announce();
  const user = adapter.remoteUsers[0];
  await adapter.subscribe(user,'video'); await adapter.subscribe(user,'audio');
  const oldAudio = user.audioTrack, cancelling = adapter.unsubscribe(user);
  f.emit('onUserUnpublishScreen',{userId:'7',mediaType:3});
  f.emit('onUserPublishScreen',{userId:'7',mediaType:3});
  await adapter.subscribe(user,'video'); await adapter.subscribe(user,'audio');
  const video = user.videoTrack, audio = user.audioTrack;
  audio.play(); const count = f.calls.filter(([name]) => name === 'volume').length;
  old.resolve(); await cancelling; oldAudio.stop();
  assert.equal(user.videoTrack,video); assert.equal(user.audioTrack,audio);
  assert.equal(f.calls.filter(([name]) => name === 'volume').length,count);
  await adapter.leave();
});

for (const provider of ['volc','volc2']) {
  test(`${provider} 冷启动编码卡顿只重发一次，保留原采集、配置及音视频绑定`, async t => {
    let now = 0; t.mock.method(Date,'now',() => now);
    const raw = browser(t), f = volcFixture(raw,{getLocalVideoStats:() => ({})});
    const client = new RtcClient({volc:async () => f.sdk});
    await client.setProvider(provider); await client.join('app','room','test-token',42);
    const tracks = [browserCaptureTracks.createCustomVideoTrack({mediaStreamTrack:raw.video}),browserCaptureTracks.createCustomAudioTrack({mediaStreamTrack:raw.audio})];
    const stats = {inputFrameRate:55,encoderOutputFrameRate:.5,sentFrameRate:.5,videoLossRate:0,rtt:7,statsInterval:2001,encodedFrameWidth:1280,encodedFrameHeight:688};
    await client.publish(tracks,{...defaults,fps:60});
    for (const at of [4000,6000,8000]) { now = at; f.emit('onLocalStreamStats',{isScreen:true,videoStats:stats}); }
    await flush();
    assert.deepEqual(f.calls.slice(-2),[['unpublish'],['publish',3]]);
    assert.equal(f.calls.filter(([name]) => name === 'config').length,1);
    assert.equal(f.calls.filter(([name]) => name === 'video').length,1);
    assert.equal(f.calls.filter(([name]) => name === 'audio').length,1);
    assert.equal(raw.video.readyState,'live'); assert.equal(raw.audio.readyState,'live');
    assert.equal(client.getLocalVideoStats().startupRecovery.status,'republished');
    for (const at of [10000,12000,14000,16000]) { now = at; f.emit('onLocalStreamStats',{isScreen:true,videoStats:stats}); }
    await flush(); assert.equal(f.calls.filter(([name]) => name === 'publish').length,2);
    await client.unpublish(tracks); await client.publish(tracks,{...defaults,fps:60});
    for (const at of [20000,22000,24000,26000]) { now = at; f.emit('onLocalStreamStats',{isScreen:true,videoStats:stats}); }
    await flush(); assert.equal(f.calls.filter(([name]) => name === 'publish').length,3);
    await client.unpublish(tracks); await client.leave();
  });
}

for (const action of ['unpublish','leave']) {
  test(`火山恢复等待取消发布期间执行 ${action}，迟到结果不能重新发布`, async t => {
    let now = 0; t.mock.method(Date,'now',() => now);
    const raw = browser(t), unpublishing = deferred();
    const f = volcFixture(raw,{unpublishScreen:async () => { f.calls.push(['unpublish']); await unpublishing.promise; }});
    const adapter = new VolcRtcAdapter({emit(){}},async () => f.sdk);
    await adapter.join('app','room','test-token',42);
    const tracks = [browserCaptureTracks.createCustomVideoTrack({mediaStreamTrack:raw.video})];
    await adapter.publish(tracks,{...defaults,fps:60});
    for (const at of [4000,6000,8000]) {
      now = at; f.emit('onLocalStreamStats',{isScreen:true,videoStats:{inputFrameRate:55,encoderOutputFrameRate:0,videoLossRate:0,rtt:7,statsInterval:2001,encodedFrameWidth:1280,encodedFrameHeight:688}});
    }
    await flush(); const stopping = adapter[action](tracks); await flush();
    unpublishing.resolve(); await stopping; await flush();
    assert.equal(f.calls.filter(([name]) => name === 'publish').length,1);
    if (action !== 'leave') await adapter.leave();
  });
}

test('火山恢复失败只通知一次并保留失败状态，不循环重发', async t => {
  let now = 0; t.mock.method(Date,'now',() => now);
  const raw = browser(t), events = [];
  let publishes = 0;
  const f = volcFixture(raw,{publishScreen:async () => { if (++publishes > 1) throw new Error('SDK failure'); }});
  const adapter = new VolcRtcAdapter({emit:(...args) => events.push(args)},async () => f.sdk);
  await adapter.join('app','room','test-token',42);
  const tracks = [browserCaptureTracks.createCustomVideoTrack({mediaStreamTrack:raw.video})];
  await adapter.publish(tracks,{...defaults,fps:60});
  for (const at of [4000,6000,8000,10000,12000]) {
    now = at; f.emit('onLocalStreamStats',{isScreen:true,videoStats:{inputFrameRate:55,encoderOutputFrameRate:0,videoLossRate:0,rtt:7,statsInterval:2001,encodedFrameWidth:1280,encodedFrameHeight:688}});
    await flush();
  }
  assert.equal(publishes,2); assert.equal(adapter.getLocalVideoStats().startupRecovery.status,'failed');
  assert.equal(events.filter(([name]) => name === 'screen-publish-error').length,1);
  await adapter.unpublish(tracks); await adapter.leave();
});

test('火山短暂重发保留观看选择并重新订阅，用户切换与真正停播不被覆盖', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const raw = browser(t), user = {uid:7,hasVideo:true,hasAudio:false}, other = {uid:8,hasVideo:true,hasAudio:false};
  let subscriptions = 0, fallbacks = 0;
  const source = new SourceController({
    client:{subscribe:async who => { subscriptions++; who.videoTrack = {play(){},stop(){}}; },unsubscribe:async who => { who.videoTrack = undefined; }},
    remote:uid => uid === 7 ? user : uid === 8 ? other : undefined, video(){}, empty(){}, error(error){throw error;},
  });
  await source.select(7); user.hasVideo = false;
  source.holdForRepublish(7,() => fallbacks++); await flush();
  assert.equal(source.selected,7);
  user.hasVideo = true; await source.select(7); t.mock.timers.tick(2000);
  assert.equal(subscriptions,2); assert.equal(fallbacks,0);
  user.hasVideo = false; source.holdForRepublish(7,() => fallbacks++); await flush();
  await source.select(8); t.mock.timers.tick(2000);
  assert.equal(source.selected,8); assert.equal(fallbacks,0);
  user.hasVideo = true; await source.select(7); user.hasVideo = false;
  source.holdForRepublish(7,() => fallbacks++); await flush(); t.mock.timers.tick(2000);
  assert.equal(fallbacks,1); await source.select(undefined);
});

test('火山首次和再次发布调用顺序一致，编码只在绑定轨道前设置一次', async t => {
  const raw = browser(t), f = volcFixture(raw);
  const adapter = new VolcRtcAdapter({emit(){}},async () => f.sdk);
  await adapter.join('app','room','test-token',42);
  const tracks = [browserCaptureTracks.createCustomVideoTrack({mediaStreamTrack:raw.video}),browserCaptureTracks.createCustomAudioTrack({mediaStreamTrack:raw.audio})];
  const rounds = [];
  for (let round = 0; round < 2; round++) {
    f.calls.length = 0;
    await adapter.publish(tracks,{...defaults,fps:60,optimization:'balanced'},{width:1920,height:1032});
    assert.deepEqual(f.calls.map(([name]) => name),['config','video-source','video','audio-source','audio','publish']);
    assert.equal(f.calls[0][1].width,1920); assert.equal(f.calls[0][1].height,1032); assert.equal(f.calls[0][1].frameRate,60);
    await adapter.unpublish(tracks);
    rounds.push(f.calls.map(([name,value]) => [name,name === 'video' ? 'track' : value]));
    const count = f.calls.length;
    await adapter.unpublish(tracks);
    assert.equal(f.calls.length,count);
  }
  assert.deepEqual(rounds[0],rounds[1]);
  await adapter.leave();
});

test('火山停止等待正在进行的绑定，下一次发布等待停止完成', async t => {
  const raw = browser(t), binding = deferred(), stopping = deferred();
  let firstBind = true;
  const f = volcFixture(raw,{
    setExternalVideoTrack:async () => { f.calls.push(['video']); if (firstBind) { firstBind = false; await binding.promise; } },
    unpublishScreen:async () => { f.calls.push(['unpublish']); await stopping.promise; },
  });
  const adapter = new VolcRtcAdapter({emit(){}},async () => f.sdk);
  await adapter.join('app','room','test-token',42);
  const tracks = [browserCaptureTracks.createCustomVideoTrack({mediaStreamTrack:raw.video})];
  const first = adapter.publish(tracks,defaults); await flush();
  const stop = adapter.unpublish(tracks), next = adapter.publish(tracks,defaults);
  await flush(); assert.equal(f.calls.some(([name]) => name === 'unpublish'),false);
  binding.resolve(); await first; await flush();
  assert.equal(f.calls.filter(([name]) => name === 'config').length,1);
  stopping.resolve(); await stop; await next;
  assert.equal(f.calls.filter(([name]) => name === 'publish').length,2);
  assert.ok(f.calls.findIndex(([name]) => name === 'unpublish') < f.calls.findLastIndex(([name]) => name === 'config'));
  await adapter.unpublish(tracks); await adapter.leave();
});

test('火山发布失败仍清理两个外部源，清理失败可重试且不吞掉原始错误', async t => {
  const raw = browser(t), original = new Error('publish failed');
  let failPublish = true, failStop = true;
  const f = volcFixture(raw,{
    publishScreen:async () => { if (failPublish) throw original; f.calls.push(['publish']); },
    unpublishScreen:async () => { f.calls.push(['unpublish']); if (failStop) throw new Error('stop failed'); },
  });
  const adapter = new VolcRtcAdapter({emit(){}},async () => f.sdk);
  await adapter.join('app','room','test-token',42);
  const tracks = [browserCaptureTracks.createCustomVideoTrack({mediaStreamTrack:raw.video})];
  await assert.rejects(adapter.publish(tracks,defaults),error => error === original);
  assert.deepEqual(f.calls.slice(-3),[['unpublish'],['video-source',0],['audio-source',0]]);
  failStop = false; await adapter.unpublish(tracks);
  failPublish = false; await adapter.publish(tracks,defaults);
  await adapter.unpublish(tracks); await adapter.leave();
});

test('火山退出中取消未完成发布，先回收外部轨道再销毁引擎', async t => {
  const raw = browser(t), binding = deferred();
  const f = volcFixture(raw,{setExternalVideoTrack:async () => { await binding.promise; }});
  const adapter = new VolcRtcAdapter({emit(){}},async () => f.sdk);
  await adapter.join('app','room','test-token',42);
  const tracks = [browserCaptureTracks.createCustomVideoTrack({mediaStreamTrack:raw.video})];
  const publishing = adapter.publish(tracks,defaults);
  const rejected = assert.rejects(publishing,/共享发布已取消/);
  await flush(); const leaving = adapter.leave(); await flush();
  assert.equal(f.calls.some(([name]) => name === 'destroy'),false);
  binding.resolve(); await rejected; await leaving;
  assert.equal(f.calls.some(([name]) => name === 'publish'),false);
  assert.deepEqual(f.calls.slice(-5),[['unpublish'],['video-source',0],['audio-source',0],['leave'],['destroy']]);
});

for (const provider of ['agora','zego','volc','volc2']) {
  test(`${provider} 清晰/流畅/均衡分别映射，60fps 均衡不继承上一轮流畅提示`, async t => {
    const raw = browser(t), agora = agoraFixture(), volc = volcFixture(raw), zego = zegoFixture(raw);
    const client = new RtcClient({agora:async () => agora.sdk,volc:async () => volc.sdk,zego:async () => zego.sdk});
    await client.setProvider(provider); await client.join('123','room','test-token',42);
    for (const optimization of ['motion','detail','balanced']) {
      const preferences = {...defaults,fps:60,optimization};
      const captured = await captureScreen(preferences,provider === 'agora' ? agora.sdk : browserCaptureTracks,async () => raw.stream);
      await client.publish(captured.tracks,preferences);
      if (provider === 'agora') {
        assert.equal(agora.calls.filter(([name]) => name === 'config').at(-1)[1].optimizationMode,optimization);
      } else if (provider === 'zego') {
        assert.equal(zego.calls.filter(([name]) => name === 'config').at(-1)[1].videoOptimizationMode,optimization === 'balanced' ? 'default' : optimization);
      } else {
        assert.equal(volc.calls.filter(([name]) => name === 'config').at(-1)[1].contentHint,optimization === 'balanced' ? undefined : optimization);
      }
      assert.equal(raw.video.contentHint,optimization === 'balanced' ? '' : optimization);
      await client.unpublish(captured.tracks); captured.close();
      raw.video.readyState = 'live'; raw.audio.readyState = 'live';
    }
    await client.leave();
  });
  test(`${provider} 统一编码诊断明确区分不可用、0 和 false，不伪造编码受限原因`, async t => {
    const raw = browser(t), agora = agoraFixture(), volc = volcFixture(raw), zego = zegoFixture(raw,{
      getPublishingStreamQuality:() => ({video:{videoFPS:60,videoTransferFPS:0,isHardwareEncode:false,videoPacketsLostRate:0}}),
    });
    const client = new RtcClient({agora:async () => agora.sdk,volc:async () => volc.sdk,zego:async () => zego.sdk});
    await client.setProvider(provider); await client.join('123','room','test-token',42);
    const stats = client.getLocalVideoStats(), diagnostic = stats.diagnostics;
    assert.equal(diagnostic.qualityLimitationReason.status,'unavailable'); assert.equal(diagnostic.qualityLimitationReason.value,null);
    assert.equal(diagnostic.encoderImplementation.status,'unavailable');
    assert.equal(stats.observation.kind,'poll'); assert.equal(stats.observation.sdkSampleAt,null); assert.equal(stats.observation.sdkSampleAgeMs,null);
    assert.equal(stats.observation.stale,null); // polling cannot establish native sample freshness
    if (provider === 'agora') {
      assert.deepEqual(diagnostic.meanEncodeTimeMs,{status:'available',value:0});
      assert.equal(client.getRTCStats().OutgoingAvailableBandwidth,9000);
    } else {
      assert.equal(diagnostic.meanEncodeTimeMs.status,'unavailable'); assert.equal(stats.encodeDelay,undefined);
      assert.equal(client.getRTCStats().OutgoingAvailableBandwidth,undefined);
    }
    if (provider === 'zego') {
      assert.deepEqual(diagnostic.hardwareAccelerated,{status:'available',value:false});
      assert.deepEqual(diagnostic.encoderOutputFps,{status:'available',value:0});
      assert.equal(stats.targetSendBitrate,undefined); assert.equal(stats.sendRttMs,undefined);
    }
    await client.leave();
  });
}

test('即构轮询保留缓存观测时间，缓存过期重新读取，不假装 SDK 数据有新时间戳', async t => {
  let now = 1000, reads = 0;
  t.mock.method(Date,'now',() => now);
  const f = zegoFixture(browser(t),{getPublishingStreamQuality:() => {reads++;return {video:{videoFPS:60}};}});
  const adapter = new ZegoRtcAdapter({emit(){}},async () => f.sdk);
  await adapter.join('123','room','test-token',42);
  assert.equal(adapter.getLocalVideoStats().observation.observedAt,1000);
  now += 1000;
  const cached = adapter.getLocalVideoStats();
  assert.equal(reads,1); assert.equal(cached.observation.observationAgeMs,1000); assert.equal(cached.observation.sdkSampleAgeMs,null);
  now += 2000;
  assert.equal(adapter.getLocalVideoStats().observation.observedAt,4000); assert.equal(reads,2);
  await adapter.unpublish([]); adapter.getLocalVideoStats(); assert.equal(reads,3);
  await adapter.leave();
});

test('火山统计回调保留编码输出、零值、上行丢包及原始周期，过期不会被读取刷新', async t => {
  let now = 1000; t.mock.method(Date,'now',() => now);
  const f = volcFixture(browser(t));
  const adapter = new VolcRtcAdapter({emit(){}},async () => f.sdk);
  await adapter.join('app','room','test-token',42);
  const raw = {encoderOutputFrameRate:0,encodedFrameCount:0,sentFrameRate:0,inputFrameRate:45,statsInterval:2000,videoLossRate:.02,targetKBitrate:0};
  f.emit('onLocalStreamStats',{isScreen:true,videoStats:raw});
  raw.encoderOutputFrameRate = 50; // SDK-owned objects cannot rewrite the retained callback
  const first = adapter.getLocalVideoStats();
  assert.deepEqual(first.diagnostics.encoderOutputFps,{status:'available',value:0});
  assert.deepEqual(first.diagnostics.uplinkLossPercent,{status:'available',value:2});
  assert.equal(first.targetSendBitrate,0); assert.equal(first.observation.intervalMs,2000);
  assert.equal(first.observation.source,'volc.onLocalStreamStats'); assert.equal(first.observation.stale,false);
  now += 7000; const old = adapter.getLocalVideoStats();
  assert.equal(old.observation.observedAt,1000); assert.equal(old.observation.observationAgeMs,7000); assert.equal(old.observation.stale,true);
  await adapter.unpublish([]);
  assert.equal(adapter.getLocalVideoStats().observation.kind,'poll');
  await adapter.leave();
});

test('三家远端统计都携带来源信息，火山标记陈旧回调并在取消订阅后清除', async t => {
  let now = 1000; t.mock.method(Date,'now',() => now);
  const raw = browser(t), volc = volcFixture(raw), zego = zegoFixture(raw), agora = agoraFixture();
  const client = new RtcClient({agora:async () => agora.sdk});
  await client.setProvider('agora');
  assert.equal(client.getRemoteVideoStats()['7'].observation.source,'agora.getRemoteVideoStats'); await client.leave();
  const z = new ZegoRtcAdapter({emit(){}},async () => zego.sdk); await z.join('123','room','test-token',42); zego.announce();
  await z.subscribe(z.remoteUsers[0],'video'); assert.equal(z.getRemoteVideoStats()['7'].observation.kind,'poll'); await z.leave();
  const v = new VolcRtcAdapter({emit(){}},async () => volc.sdk); await v.join('app','room','test-token',42); volc.announce();
  await v.subscribe(v.remoteUsers[0],'video');
  volc.emit('onRemoteStreamStats',{userId:'7',isScreen:true,videoStats:{width:1920,height:1080,decoderOutputFrameRate:0,statsInterval:2000}});
  now += 7000;
  assert.equal(v.getRemoteVideoStats()['7'].observation.stale,true); assert.equal(v.getRemoteVideoStats()['7'].decodeFrameRate,0);
  await v.unsubscribe(v.remoteUsers[0]); assert.deepEqual(v.getRemoteVideoStats(),{}); await v.leave();
});

for (const provider of ['agora','zego','volc','volc2']) {
  test(`${provider} 首次进入和共享仅加载自己的 SDK，并传递 1080p60 自动码率`, async t => {
    const raw = browser(t), agora = agoraFixture(), volc = volcFixture(raw), zego = zegoFixture(raw);
    const loads = {agora:0,volc:0,zego:0};
    const client = new RtcClient(Object.fromEntries(Object.entries({agora,volc,zego}).map(([name,fixture]) => [name,async () => { loads[name]++; return fixture.sdk; }])));
    await client.setProvider(provider);
    assert.equal(loads.agora, provider === 'agora' ? 1 : 0);
    await client.join('123', 'room', 'test-token', 42);
    const preferences = {...defaults,fps:60,optimization:'balanced'};
    const capture = await captureScreen(preferences, provider === 'agora' ? agora.sdk : browserCaptureTracks, async () => raw.stream);
    await client.publish(capture.tracks, preferences);
    assert.deepEqual(loads, {agora:Number(provider === 'agora'),volc:Number(provider.startsWith('volc')),zego:Number(provider === 'zego')});
    const fixture = provider === 'agora' ? agora : provider === 'zego' ? zego : volc;
    const config = fixture.calls.find(([name]) => name === 'config')[1];
    assert.equal(config.bitrateMax ?? config.maxKbps ?? config.bitrate, provider === 'zego' ? 10000 : 16000);
    assert.ok(fixture.calls.some(([name]) => name === 'publish'));
    if (provider === 'zego') assert.deepEqual(fixture.calls.find(([name]) => name === 'encoder')[1], {width:1920,height:1080,frameRate:60,maxBitrate:10000});
    await client.unpublish(capture.tracks); capture.close(); await client.leave();
    assert.equal(raw.video.readyState, 'ended'); assert.equal(raw.audio.readyState, 'ended');
  });
}

test('火山暂停、调音量、静音和恢复通过实际适配器控制引擎，且不重订阅视频', async t => {
  const fixture = volcFixture(browser(t));
  const adapter = new VolcRtcAdapter({emit(){}}, async () => fixture.sdk);
  await adapter.join('app','room','test-token',42); fixture.announce();
  const controller = new SourceController({client:adapter,remote:() => adapter.remoteUsers[0],video(){},empty(){},error(error){throw error;}});
  await controller.select(7);
  const volume = () => fixture.calls.filter(([name]) => name === 'volume').at(-1)[1];
  assert.equal(volume(), 80);
  controller.setPaused(true); assert.equal(volume(), 0);
  controller.setAudio(35, false); assert.equal(volume(), 0);
  controller.resumeAudio(); assert.equal(volume(), 0);
  await controller.select(7); assert.equal(volume(), 0);
  controller.setPaused(false); assert.equal(volume(), 35);
  controller.setAudio(35, true); controller.setPaused(true); controller.setPaused(false); assert.equal(volume(), 0);
  controller.setAudio(60, false); assert.equal(volume(), 60);
  assert.equal(fixture.calls.filter(([name,kind]) => name === 'subscribe' && kind === 2).length, 1);
  await controller.select(undefined); await adapter.leave();
});

for (const provider of ['volc','zego']) {
  const Adapter = provider === 'volc' ? VolcRtcAdapter : ZegoRtcAdapter;
  const fixtureFor = provider === 'volc' ? volcFixture : zegoFixture;
  test(`${provider} 诊断保留零帧率，不以解码或渲染冒充接收帧率`, async t => {
    const fixture = fixtureFor(browser(t)), adapter = new Adapter({emit(){}}, async () => fixture.sdk);
    await adapter.join('123','room','test-token',42); fixture.announce();
    await adapter.subscribe(adapter.remoteUsers[0], 'video');
    const stats = adapter.getRemoteVideoStats()['7'];
    assert.equal(stats.receiveFrameRate, undefined); assert.equal(stats.decodeFrameRate, 0); assert.equal(stats.renderFrameRate, 24);
    assert.equal(adapter.getLocalVideoStats().captureFrameRate, provider === 'volc' ? 0 : undefined);
    await adapter.leave(); assert.deepEqual(adapter.getRemoteVideoStats(), {});
  });
  test(`${provider} 订阅超时后迟到结果不会恢复画面或拉流计费`, async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    const raw = browser(t), gate = deferred();
    const fixture = fixtureFor(raw, provider === 'volc' ? {subscribeScreen:() => gate.promise} : {startPlayingStream:() => gate.promise});
    const adapter = new Adapter({emit(){}}, async () => fixture.sdk);
    await adapter.join('123','room','test-token',42); fixture.announce();
    const user = adapter.remoteUsers[0], errors = [], played = [];
    const controller = new SourceController({client:adapter,remote:() => user,video:track => played.push(track),empty(){},error:error => errors.push(error)});
    const selection = controller.select(7); await flush();
    t.mock.timers.tick(12000); await selection;
    assert.match(errors[0].message, /超时/);
    gate.resolve(raw.stream); await flush();
    assert.equal(user.videoTrack, undefined); assert.equal(user.stream, undefined); assert.deepEqual(played, []);
    if (provider === 'zego') assert.deepEqual(adapter.zegoPulls, []);
    assert.ok(fixture.calls.some(([name]) => name === 'unsubscribe'));
    await adapter.leave();
  });
  test(`${provider} 等待 SDK 时退出不会迟到创建引擎`, async t => {
    const fixture = fixtureFor(browser(t)), gate = deferred(), events = [];
    const adapter = new Adapter({emit:(...args) => events.push(args)}, () => gate.promise);
    const joining = adapter.join('123','room','test-token',42);
    const rejected = assert.rejects(joining, /取消/);
    await adapter.leave(); gate.resolve(fixture.sdk); await rejected;
    assert.equal(fixture.calls.some(([name]) => name === 'create'), false);
    assert.equal(events.some(([name,state]) => name === 'connection-state-change' && state === 'CONNECTED'), false);
  });
  test(`${provider} 等待订阅时退出清理引擎并丢弃迟到媒体`, async t => {
    const raw = browser(t), gate = deferred();
    const fixture = fixtureFor(raw, provider === 'volc' ? {subscribeScreen:() => gate.promise} : {startPlayingStream:() => gate.promise});
    const adapter = new Adapter({emit(){}}, async () => fixture.sdk);
    await adapter.join('123','room','test-token',42); fixture.announce();
    const user = adapter.remoteUsers[0], pending = adapter.subscribe(user,'video');
    const rejected = assert.rejects(pending, /取消/);
    await adapter.leave(); gate.resolve(raw.stream); await rejected;
    assert.equal(user.videoTrack, undefined); assert.equal(user.stream, undefined); assert.deepEqual(adapter.remoteUsers, []);
    assert.ok(fixture.calls.some(([name]) => name === 'destroy'));
  });
  test(`${provider} 取消后重试成功，旧订阅迟到不能停掉新订阅`, async t => {
    const raw = browser(t), gate = deferred(); let calls = 0;
    const read = () => ++calls === 1 ? gate.promise : Promise.resolve(raw.stream);
    const fixture = fixtureFor(raw, provider === 'volc' ? {subscribeScreen:read} : {startPlayingStream:read});
    const adapter = new Adapter({emit(){}}, async () => fixture.sdk);
    await adapter.join('123','room','test-token',42); fixture.announce();
    const user = adapter.remoteUsers[0], abort = new AbortController();
    const rejected = assert.rejects(adapter.subscribe(user,'video',abort.signal), /取消/);
    abort.abort(); await adapter.subscribe(user,'video');
    const track = user.videoTrack, stops = fixture.calls.filter(([name]) => name === 'unsubscribe').length;
    gate.resolve(raw.stream); await rejected;
    assert.equal(user.videoTrack, track);
    assert.equal(fixture.calls.filter(([name]) => name === 'unsubscribe').length, stops);
    await adapter.leave();
  });
  test(`${provider} 取消观看立即结束等待，迟到订阅不再显示`, async t => {
    const raw = browser(t), gate = deferred();
    const fixture = fixtureFor(raw, provider === 'volc' ? {subscribeScreen:() => gate.promise} : {startPlayingStream:() => gate.promise});
    const adapter = new Adapter({emit(){}}, async () => fixture.sdk);
    await adapter.join('123','room','test-token',42); fixture.announce();
    const user = adapter.remoteUsers[0], played = [], errors = [];
    const controller = new SourceController({client:adapter,remote:() => user,video:track => played.push(track),empty(){},error:error => errors.push(error)});
    const selecting = controller.select(7); await flush();
    await controller.select(undefined); await selecting;
    assert.deepEqual(errors, []); assert.deepEqual(played, []);
    gate.resolve(raw.stream); await flush();
    assert.equal(user.videoTrack, undefined); assert.equal(user.stream, undefined);
    await adapter.leave();
  });
}

test('火山离房失败也会销毁引擎并清空远端状态', async t => {
  const fixture = volcFixture(browser(t), {leaveRoom:async () => { throw new Error('offline'); }});
  const adapter = new VolcRtcAdapter({emit(){}}, async () => fixture.sdk);
  await adapter.join('app','room','test-token',42); fixture.announce();
  await assert.rejects(adapter.leave(), /offline/);
  assert.ok(fixture.calls.some(([name]) => name === 'destroy')); assert.deepEqual(adapter.remoteUsers, []);
});
