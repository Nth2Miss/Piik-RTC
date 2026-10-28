import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, providerLabel, roomLabel } from '../shared/log.js';

const request = (remoteAddress, headers = {}) => ({ socket:{ remoteAddress }, headers });

test('Docker 网关和本机代理通过转发头解析真实来源', () => {
  assert.equal(clientIp(request('172.25.0.1', { 'x-real-ip':'203.0.113.7' })), '203.0.113.7');
  assert.equal(clientIp(request('::ffff:172.25.0.1', { 'x-forwarded-for':'203.0.113.7, 172.25.0.1' })), '203.0.113.7');
  assert.equal(clientIp(request('127.0.0.1', { 'x-forwarded-for':'198.51.100.2' })), '198.51.100.2');
});
test('公网直连忽略可伪造的转发头', () => {
  assert.equal(clientIp(request('203.0.113.9', { 'x-forwarded-for':'198.51.100.1', 'x-real-ip':'198.51.100.1' })), '203.0.113.9');
  assert.equal(clientIp(request(undefined)), '-');
});
test('房间标签包含房间名与编号', () => {
  assert.equal(roomLabel({ name:'放映室', id:'abc123' }), '放映室（abc123）');
  assert.equal(roomLabel(undefined), '-');
  assert.equal(providerLabel('volc2'), 'volc2(火山引擎 2)');
});
