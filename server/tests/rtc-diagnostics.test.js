import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticBoolean,diagnosticNumber,encodingDiagnostics,statisticsObservation} from '../../src/rtc/diagnostics.ts';

test('统一指标保留有效 0/false，对缺失、负数和非有限数明确标不可用', () => {
  assert.deepEqual(diagnosticNumber(0),{status:'available',value:0});
  assert.deepEqual(diagnosticBoolean(false),{status:'available',value:false});
  for (const value of [undefined,null,NaN,Infinity,-1]) assert.equal(diagnosticNumber(value).status,'unavailable');
  assert.equal(encodingDiagnostics().qualityLimitationReason.value,null);
  assert.equal(encodingDiagnostics().hardwareAccelerated.status,'unavailable');
});

test('统计读取时间不冒充 SDK 源采样时间，回调和轮询分别处理陈旧状态', t => {
  t.mock.method(Date,'now',() => 10000);
  const callback = statisticsObservation('callback','callback',1000,2000);
  assert.equal(callback.stale,true); assert.equal(callback.observationAgeMs,9000);
  assert.equal(callback.sdkSampleAt,null); assert.equal(callback.sdkSampleAgeMs,null);
  assert.equal(statisticsObservation('poll','poll',1000).stale,null);
});
