import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VolcStartupWatch } from '../../src/rtc/volc-startup.ts';

const sample = {inputFrameRate:55,encoderOutputFrameRate:.5,videoLossRate:0,rtt:7,statsInterval:2001,encodedFrameWidth:1280,encodedFrameHeight:688};

test('60fps 首次在 2～14fps 波动仍属持续严重降帧，不能因短暂超过 10fps 漏判', () => {
  const watch = new VolcStartupWatch(60,0,{width:1920,height:1032});
  const trace = [
    [2174,13.486513486513486,1280,688],
    [4176,1.998001998001998,1280,688],
    [6180,6.986027944111776,1280,688],
    [8182,11.988011988011989,960,516],
  ];
  const triggers = trace.map(([at,output,width,height]) => watch.observe({...sample,encoderOutputFrameRate:output,encodedFrameWidth:width,encodedFrameHeight:height},at));
  assert.deepEqual(triggers,[false,false,false,true]);
  assert.equal(watch.snapshot().triggeredAt,8182);
});

test('异常门槛按所选帧率比例判断，已达到一半目标的低清流不触发', () => {
  for (const [target,input,output] of [[30,27,7],[60,55,14]]) {
    const watch = new VolcStartupWatch(target,0);
    assert.equal(watch.observe({...sample,inputFrameRate:input,encoderOutputFrameRate:output},4000),false);
    assert.equal(watch.observe({...sample,inputFrameRate:input,encoderOutputFrameRate:output},6000),false);
    assert.equal(watch.observe({...sample,inputFrameRate:input,encoderOutputFrameRate:output},8000),true);
    const slower = new VolcStartupWatch(target,0);
    for (const at of [4000,6000,8000,10000]) assert.equal(slower.observe({...sample,inputFrameRate:input,encoderOutputFrameRate:target/2},at),false);
  }
});

test('按实际报告的首次卡顿序列，第 8 秒触发一次；完成重发不等同确认恢复', () => {
  const watch = new VolcStartupWatch(60,0);
  const frames = [12.493753123438282,0,.49975012493753124,.4995004995004995];
  assert.deepEqual(frames.map((fps,i) => watch.observe({...sample,encoderOutputFrameRate:fps},(i+1)*2000)),[false,false,false,true]);
  assert.equal(watch.snapshot().reason,'healthy-input-encoder-stall');
  for (let now = 10000; now <= 20000; now += 2000) assert.equal(watch.observe(sample,now),false);
  watch.finish('republished',10000);
  assert.equal(watch.snapshot().status,'republished');
  const copy = watch.snapshot(); copy.status = 'failed'; assert.equal(watch.snapshot().status,'republished');
});

test('低清但高帧率、采集慢、丢包、高 RTT 或字段缺失都不能触发重发', () => {
  for (const override of [
    {encoderOutputFrameRate:55},{inputFrameRate:10},{videoLossRate:.05},{rtt:300},
    {videoLossRate:undefined},{rtt:undefined},{statsInterval:undefined},{statsInterval:5000},
    {encoderOutputFrameRate:NaN},{encoderOutputFrameRate:-1},{inputFrameRate:Infinity},
    {encodedFrameWidth:1920,encodedFrameHeight:1080},{encodedFrameWidth:undefined},
  ]) {
    const watch = new VolcStartupWatch(60,0);
    for (let now = 2000; now <= 22000; now += 2000) assert.equal(watch.observe({...sample,...override},now),false);
  }
  const slow = new VolcStartupWatch(15,0);
  for (let now = 2000; now <= 20000; now += 2000) assert.equal(slow.observe({...sample,inputFrameRate:15},now),false);
});

test('健康启动、采样重复、回调断档、观察窗口结束后都不误判首次卡顿', () => {
  const healthy = new VolcStartupWatch(60,0);
  for (const now of [2000,4000,6000]) assert.equal(healthy.observe({...sample,encoderOutputFrameRate:55},now),false);
  assert.equal(healthy.snapshot().status,'not-needed');
  for (const now of [8000,10000,12000]) assert.equal(healthy.observe(sample,now),false);
  const repeated = new VolcStartupWatch(60,0);
  for (let n = 0; n < 10; n++) assert.equal(repeated.observe(sample,8000),false);
  assert.equal(repeated.observe(sample,10000),false);
  assert.equal(repeated.observe(sample,15000),false);
  assert.equal(repeated.observe(sample,22000),false);
  assert.equal(repeated.snapshot().status,'expired');
});
