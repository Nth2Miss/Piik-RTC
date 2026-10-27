import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageService } from '../quota/usage.js';
import { agoraUsage } from '../providers/agora/usage.js';
import { volcUsage } from '../providers/volc/usage.js';
import { createZegoUsage } from '../providers/zego/usage.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const agoraEnv = { AGORA_PROJECT_ID: 'project', AGORA_CUSTOMER_KEY: 'key', AGORA_CUSTOMER_SECRET: 'secret' };
const row = { durationAudioAll: 60, durationVideoHd: 60, durationVideo1080P: 60, durationVideo2K: 60, durationVideo4K: 60, durationVideoHdp: 0 };
const response = value => ({ ok: true, json: async () => value });

test('声网用量按说明换算，月份按北京时间计算', async () => {
  let requested;
  const result = await agoraUsage(agoraEnv, async url => { requested = url; return response({ usages: [{ usage: row }] }); }, new Date('2026-10-31T16:10:00Z'));
  assert.match(requested, /from_date=2026-11-01/);
  assert.equal(result.used, 66);
  assert.equal(result.remaining, 9934);
});

test('声网 HDP 汇总字段不重复计入用量', async () => {
  const result = await agoraUsage(agoraEnv, async () => response({ usages: [{ usage: { ...row, durationVideoHdp: 120 } }] }));
  assert.equal(result.used, 66);
});

test('火山资源包查询遍历分页并只汇总有效 RTC 分钟包', async () => {
  const calls = [];
  const env = { VOLC_ACCESS_KEY_ID: 'id', VOLC_ACCESS_KEY_SECRET: 'secret' };
  const pkg = { Product: 'veRTC', Status: 'Effective', Unit: '分钟', EffectiveTime: '2026-01-01T00:00:00Z', ExpiryTime: '2027-01-01T00:00:00Z', AvailableAmount: '200', TotalAmount: '1000' };
  const result = await volcUsage(env, async (_url, options) => {
    calls.push(JSON.parse(options.body));
    assert.match(options.headers.Authorization, /^HMAC-SHA256 Credential=id\//);
    return response({ Result: calls.length === 1 ? { List: [pkg], NextToken: 'next' } : { List: [pkg, { ...pkg, Product: 'other' }], NextToken:'0' } });
  }, new Date('2026-10-27T00:00:00Z'));
  assert.equal(calls[0].Product, 'veRTC');
  assert.equal(calls[0].MaxResults, '20');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].Product, 'veRTC');
  assert.equal(calls[1].NextToken, 'next');
  assert.equal(result.remaining, 400);
  assert.equal(result.total, 2000);
});

test('查询异常不会泄露上游错误，且各服务状态独立', async () => {
  const service = createUsageService(agoraEnv, async () => { throw new Error('secret'); });
  const result = await service();
  assert.deepEqual(result.agora, { status: 'error' });
  assert.equal(result.volc.status, 'unconfigured');
  assert.equal(result.zego.status, 'unconfigured');
});

test('即构控制台查询保存续期会话，但不把 Cookie 输出到结果', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zego-quota-')); t.after(() => rm(dir, {recursive:true, force:true}));
  const path = join(dir, 'cookie'); await writeFile(path, 'token=old; device_id=device');
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({url, cookie:options.headers.Cookie});
    return {ok:true, headers:{getSetCookie:() => url.includes('refresh_cookie') ? ['token=new; Path=/; HttpOnly'] : []}, json:async () => url.includes('refresh_cookie') ? {code:0} : {code:0,data:{remained_time:8765}}};
  };
  const query = createZegoUsage({ZEGO_COOKIE_FILE:path}, fetcher, () => 1000000);
  const result = await query();
  assert.deepEqual(result, {status:'ok', remaining:8765, total:10000, used:1235, unit:'标准分钟'});
  assert.match(calls[1].cookie, /token=new/);
  assert.match(await readFile(path, 'utf8'), /token=new/);
  await query(); assert.equal(calls.length, 3); // renewal is throttled
});

test('即构登录失效后停止重试，替换 Cookie 后可恢复查询', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zego-quota-')); t.after(() => rm(dir, {recursive:true, force:true}));
  const path = join(dir, 'cookie'); await writeFile(path, 'token=old'); let calls = 0;
  const fetcher = async (url, options) => { calls++; return {ok:true, headers:{getSetCookie:() => []}, json:async () => url.includes('refresh_cookie') ? {code:0} : options.headers.Cookie === 'token=old' ? {code:3} : {code:0,data:{remained_time:30}}}; };
  const query = createZegoUsage({ZEGO_COOKIE_FILE:path}, fetcher, () => 1000000);
  assert.equal((await query()).status, 'auth_expired');
  assert.equal((await query()).status, 'auth_expired'); assert.equal(calls, 2);
  await writeFile(path, 'token=new');
  assert.equal((await query()).remaining, 30); assert.equal(calls, 4);
});

test('火山查询接入缓存，错误不影响声网状态', async () => {
  const env = { ...agoraEnv, VOLC_ACCESS_KEY_ID:'id', VOLC_ACCESS_KEY_SECRET:'secret' };
  let calls = 0;
  const service = createUsageService(env, async url => {
    calls++;
    if (url.includes('agora.io')) return response({ usages:[{usage:row}] });
    return response({ Result:{ List:[{ Product:'veRTC', Status:'Effective', Unit:'分钟', EffectiveTime:'2026-01-01T00:00:00Z', ExpiryTime:'2027-01-01T00:00:00Z', AvailableAmount:'10000', TotalAmount:'10000' }], NextToken:'0' } });
  }, () => Date.parse('2026-10-27T00:00:00Z'));
  const status = await service();
  assert.equal(status.volc.remaining, 10000);
  assert.equal(status.agora.status, 'ok');
  assert.equal(await service(), status);
  assert.equal(calls, 2);
});

test('用量查询合并并发请求，缓存到期或跨月后重新查询', async () => {
  let now = Date.parse('2026-10-31T15:59:00Z'), calls = 0;
  const service = createUsageService({ ...agoraEnv, RTC_USAGE_CACHE_SECONDS:'300' }, async () => { calls++; return response({ usages:[{ usage:row }] }); }, () => now);
  const [first, simultaneous] = await Promise.all([service(), service()]);
  assert.equal(calls, 1); assert.equal(first, simultaneous); assert.equal(first.cacheSeconds, 300);
  now += 20_000; assert.equal(await service(), first); assert.equal(calls, 1);
  now += 45_000; const nextMonth = await service(); assert.equal(calls, 2); assert.equal(nextMonth.agora.from, '2026-11-01');
  now += 300_001; await service(); assert.equal(calls, 3);
});
