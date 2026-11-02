import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureDesktopScreen, startNativeVideo } from '../../src/desktop/capture.ts';
import { browserCaptureTracks } from '../../src/capture.ts';
import { defaults } from '../../src/preferences.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
const selection = {sourceId:'test',kind:'window',name:'test',pid:1,audio:'none'};
function fixture(t, write = async () => {}) {
  const saved = new Map(), handlers = {}, calls = {stops:0,draws:0,closed:0,aborted:0,generators:0};
  const install = (name,value) => { saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name)); Object.defineProperty(globalThis,name,{configurable:true,value}); };
  t.after(() => { for (const [name,descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis,name,descriptor); else delete globalThis[name]; } });
  const makeTrack = () => ({readyState:'live',getSettings:() => ({width:1920,height:1080,frameRate:0}),applyConstraints:async () => {},requestFrame(){},stop(){this.readyState = 'ended';}});
  install('VideoFrame',class {});
  install('MediaStreamTrackGenerator',class {
    constructor() {
      calls.generators++;
      Object.assign(this,makeTrack());
      this.writable = {getWriter:() => ({write,abort:async () => {calls.aborted++;}})};
    }
  });
  install('document',{body:{appendChild(){}},createElement:() => ({style:{},remove(){},
    getContext:() => ({fillRect(){},drawImage(){calls.draws++;}}),captureStream:() => ({getVideoTracks:() => [makeTrack()]})})});
  const bridge = {
    startVideo:async () => ({ok:true,width:1920,height:1080,mode:'raw'}),stopVideo:async () => {calls.stops++;return {ok:true};},
    onVideoFrameRaw:handler => {handlers.raw = handler;return () => {delete handlers.raw;};},
    onVideoFrame:handler => {handlers.jpeg = handler;return () => {delete handlers.jpeg;};},
    onVideoEnded:handler => {handlers.ended = handler;return () => {delete handlers.ended;};},
  };
  return {bridge,calls,handlers,frame() { const frame = {close(){calls.closed++;}};handlers.raw({frame,width:1920,height:1080,seq:1});return frame;}};
}

for (const provider of ['volc','volc2']) {
  test(`${provider} 自动采集走 Canvas，真实输出后才允许初始化 RTC`, async t => {
    const f = fixture(t);
    const capturing = captureDesktopScreen(selection,{...defaults,desktopVideoMode:'generator'},browserCaptureTracks,()=>{},{provider,bridge:f.bridge});
    await flush(); f.frame(); const capture = await capturing;
    assert.equal(f.calls.generators,0); assert.equal(f.calls.draws,1);
    assert.equal(capture.diagnostics().path,'canvas-raw'); assert.equal(capture.diagnostics().written,1);
    assert.equal(capture.tracks[0].getMediaStreamTrack().getSettings().frameRate,0); // no fabricated settings
    await capture.waitForOutput(); capture.close(); await flush();
    assert.equal(f.calls.stops,1);
  });
}

test('Generator 首帧有背压时先创建 RTC 轨道，发布消费后才确认输出', async t => {
  let consume;
  const f = fixture(t,() => new Promise(resolve => {consume = resolve;}));
  const capturing = captureDesktopScreen(selection,defaults,browserCaptureTracks,()=>{},{provider:'agora',bridge:f.bridge});
  await flush(); f.frame(); const capture = await capturing;
  assert.equal(capture.diagnostics().received,1); assert.equal(capture.diagnostics().written,0);
  let ready = false; const output = capture.waitForOutput().then(() => {ready = true;});
  await flush(); assert.equal(ready,false);
  consume(); await output;
  assert.equal(capture.diagnostics().written,1); assert.equal(f.calls.closed,1);
  capture.close(); await flush(); assert.equal(f.calls.aborted,1);
});

test('Generator 写入失败不会当作首帧成功，保留失败诊断', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f = fixture(t,async () => {throw new Error('sink rejected');});
  const capturing = captureDesktopScreen(selection,defaults,browserCaptureTracks,()=>{},{provider:'zego',bridge:f.bridge});
  await flush(); f.frame(); const capture = await capturing; await flush();
  const output = assert.rejects(capture.waitForOutput(),/未成功输出/);
  t.mock.timers.tick(5000); await output;
  assert.equal(capture.diagnostics().written,0); assert.equal(capture.diagnostics().errors,1);
  assert.equal(capture.diagnostics().lastError,'sink rejected'); capture.close(); await flush();
});

test('没有原生帧时明确失败并释放采集，不再超时后继续发布', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f = fixture(t); let diagnostics;
  const rejected = assert.rejects(captureDesktopScreen(selection,defaults,browserCaptureTracks,()=>{},
    {provider:'volc',bridge:f.bridge,onDiagnostics:value => {diagnostics = value;}}),/未收到原生/);
  await flush(); t.mock.timers.tick(5000); await rejected; await flush();
  assert.equal(diagnostics.received,0); assert.equal(f.calls.stops,1);
  assert.equal(f.handlers.raw,undefined);
});

test('等待首帧时停止采集会立即结束等待并清理监听', async t => {
  const f = fixture(t), video = await startNativeVideo(f.bridge,selection,defaults,'volc');
  const rejected = assert.rejects(video.progress.wait('written'),/已停止/);
  await video.stop(); await rejected;
  assert.equal(f.handlers.raw,undefined); assert.equal(f.handlers.ended,undefined);
});
