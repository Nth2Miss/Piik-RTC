import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ShareDiagnostics} from '../../src/share-diagnostics.ts';
import {defaults} from '../../src/preferences.ts';

test('每次共享独立记录实际编码请求，设置变更和导出结果不会改写旧配置', () => {
  const log = new ShareDiagnostics();
  const preferences = {...defaults,fps:60,optimization:'balanced'};
  const first = log.begin('room','volc',preferences,preferences,1000);
  log.captured(first,{width:1920,height:1032,hasAudio:false,surface:'window'});
  log.published(first,1100);
  preferences.optimization = 'detail'; preferences.fps = 30;
  const copy = log.export(); copy[0].applied.fps = 15;
  assert.equal(log.export()[0].applied.fps,60);
  assert.equal(log.export()[0].encoderRequest.optimizationMode,'balanced');
  assert.equal(log.export()[0].encoderRequest.height,1032);
  log.finish(first,'stopped',undefined,2000);
  assert.equal(log.shareId,undefined);
  const second = log.begin('room','volc',preferences,preferences,3000);
  log.finish(first,'failed',undefined,4000);
  assert.equal(log.shareId,second);
  assert.equal(log.export()[0].status,'stopped');
  assert.equal(log.export()[1].encoderRequest.bitrateKbps,5000);
});

test('保留请求值、降级后参数及失败记录，剔除非设置字段并限制记录数量', () => {
  const log = new ShareDiagnostics();
  for (let i = 0; i < 35; i++) {
    const id = log.begin('room','zego',{...defaults,resolution:'1440',fps:60,token:'must-not-export'}, {...defaults,resolution:'1080',fps:60,bitrateMode:'manual',bitrate:10000});
    log.finish(id,'failed');
  }
  const entries = log.export();
  assert.equal(entries.length,30); assert.equal(entries[0].requested.resolution,'1440');
  assert.equal(entries[0].applied.resolution,'1080'); assert.equal(entries[0].encoderRequest.bitrateKbps,10000);
  assert.equal(JSON.stringify(entries).includes('must-not-export'),false);
  assert.equal(entries[0].status,'failed');
});
