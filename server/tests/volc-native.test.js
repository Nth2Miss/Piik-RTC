import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../../src/preferences.ts';

// The native adapter talks to the desktop audio helper through the page bridge.
// Install a minimal bridge before loading the module so publish can exercise
// the external-audio path in Node.
const previousWindow = globalThis.window;
globalThis.window = { piikDesktop: {
  isDesktop: true,
  startAudio: async () => ({ ok:true, sampleRate:48000, channels:2, bits:16, encoding:'pcm_s16le', blockAlign:4 }),
  stopAudio: async () => ({ ok:true }),
  onNativeFrame: () => () => {},
} };
const { VolcNativeAdapter } = await import('../../src/rtc/volc-native.ts');
globalThis.window = previousWindow;

function fixture(t, overrides = {}) {
  const calls = [], events = [], queue = [];
  const adapter = new VolcNativeAdapter({emit:(...event)=>events.push(event)},async options => {
    calls.push(options);
    if (options.operation === 'poll') return {events:queue.splice(0)};
    if (options.operation === 'join') queue.push({type:'connection',state:0});
    if (options.operation === 'start') queue.push({type:'publish-state',state:0,reason:0});
    if (options.operation === 'prepare') return {width:1920,height:1032};
    return await overrides[options.operation]?.(options) ?? {ok:true};
  });
  t.after(()=>adapter.leave());
  return {adapter,calls,events,queue};
}
const selection = {sourceId:'window:7',kind:'window',name:'test',pid:7,audio:'app'};

test('原生共享使用真实 SDK 来源和16Mbps配置，不创建浏览器采集或外部编码轨', async t => {
  const {adapter,calls} = fixture(t);
  await adapter.join('public-app','room','fake-token',7);
  const preferences = {...defaults,resolution:'1080',fps:60,bitrateMode:'auto'};
  const capture = await adapter.capture(selection,preferences);
  assert.equal(capture.width,1920); assert.equal(capture.height,1032);
  assert.equal(capture.tracks[0].trackMediaType,'video');
  assert.equal(typeof capture.tracks[0].getMediaStreamTrack,'function');
  await adapter.publish(capture.tracks,preferences,capture);
  const start = calls.find(call=>call.operation==='start');
  assert.equal(start.bitrate,16000); assert.equal(start.fps,60);
  assert.equal(start.sourceId,selection.sourceId); assert.equal(start.audioMode,'app');
  assert.equal(start.audio,true); assert.equal(start.externalAudio,true);
  await adapter.unpublish(capture.tracks); capture.close();
  assert.equal(capture.tracks[0].enabled,false);
  assert.equal(calls.some(call=>call.operation==='stop'),true);
});

test('原生发布不能把 SDK 请求返回成功当成服务器发布确认', async t => {
  const {adapter,queue} = fixture(t,{start:async()=>{queue.length=0;return {ok:true};}});
  await adapter.join('app','room','fake-token',7);
  const capture = await adapter.capture(selection,defaults);
  let published = false;
  const publishing = adapter.publish(capture.tracks,defaults,capture).then(()=>{published=true;});
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(published,false);
  queue.push({type:'publish-state',state:0,reason:0});
  await publishing; assert.equal(published,true);
});

test('原生远端旧流撤销不能覆盖新流，真实撤销仍通知控制器', async t => {
  const {adapter,queue,events} = fixture(t);
  await adapter.join('app','room','fake-token',7);
  queue.push({type:'publication',uid:'8',streamId:'old',kind:'video',published:true},
    {type:'publication',uid:'8',streamId:'new',kind:'video',published:true},
    {type:'publication',uid:'8',streamId:'old',kind:'video',published:false});
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(adapter.remoteUsers[0].streamId,'new');
  assert.equal(adapter.remoteUsers[0].hasVideo,true);
  assert.equal(events.some(([name])=>name==='user-unpublished'),false);
  queue.push({type:'publication',uid:'8',streamId:'new',kind:'video',published:false});
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(adapter.remoteUsers[0].hasVideo,false);
});

test('原生 SDK 进房失败释放连接，不把失败报告成媒体已连接', async t => {
  const {adapter,queue,calls} = fixture(t,{join:async()=>{queue.length=0;queue.push({type:'connection',state:1,reason:-1000});return {ok:true};}});
  await assert.rejects(adapter.join('app','room','fake-token',7),/连接失败/);
  assert.equal(calls.some(call=>call.operation==='leave'),true);
});
