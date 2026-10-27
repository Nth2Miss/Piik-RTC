import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageService } from '../quota/usage.js';
import { agoraUsage } from '../providers/agora/usage.js';
import { volcUsage, volcRtcUsage } from '../providers/volc/usage.js';
import { createZegoUsage } from '../providers/zego/usage.js';
import { RoomStore } from '../rooms/store.js';
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
  assert.equal(result.kind, 'usage_estimate');
});

test('声网 HDP 汇总字段不重复计入用量', async () => {
  const result = await agoraUsage(agoraEnv, async () => response({ usages: [{ usage: { ...row, durationVideoHdp: 120 } }] }));
  assert.equal(result.used, 66);
});

test('声网日期覆盖 30 天、31 天、闰年和北京时间月切换', async () => {
  for (const [now, from, to] of [['2026-04-30T15:59:59Z','2026-04-01','2026-04-30'], ['2026-10-31T15:59:59Z','2026-10-01','2026-10-31'], ['2024-02-29T08:00:00Z','2024-02-01','2024-02-29'], ['2026-10-31T16:00:00Z','2026-11-01','2026-11-01']]) {
    let query;
    const result = await agoraUsage(agoraEnv, async url => { query = new URL(url).searchParams; return response({usages:[]}); }, new Date(now));
    assert.equal(query.get('from_date'), from); assert.equal(query.get('to_date'), to);
    assert.equal(result.from, from); assert.equal(result.to, to);
  }
});

test('火山 RTC 逐日用量按 1:1 汇总，覆盖 2K、4K 和 30 天限制', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  const env = {VOLC_RTC_APP_ID:'app', VOLC_ACCESS_KEY_ID:'id', VOLC_ACCESS_KEY_SECRET:'secret'};
  const calls = [];
  const fetcher = async (url, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    assert.match(url, /Action=ListUsages&Version=2024-03-01/);
    assert.match(options.headers.Authorization, /\/cn-north-1\/rtc\/request/);
    const first = request.StartTime.startsWith('2026-10-01');
    return response({Result:{Usages:[...(first ? [{TimeStamp:'2026-10-01T00:00:00+08:00',Audio:5,VideoSDM:2,VideoSD:3,VideoHD:4,Video2K:6,Video4K:7}] : []),{TimeStamp:'2026-10-02T00:00:00+08:00', Audio:10}]}});
  };
  const first = await volcRtcUsage(env, fetcher, new Date('2026-10-30T04:00:00Z'), store);
  assert.equal(first.used, 37); assert.equal(first.remaining, 9963);
  assert.equal(calls[0].StartTime, '2026-10-01T00:00:00+08:00');
  const later = await volcRtcUsage(env, fetcher, new Date('2026-10-31T04:00:00Z'), store);
  assert.equal(calls[1].StartTime, '2026-10-02T00:00:00+08:00');
  assert.equal(later.used, 37); assert.equal(later.remaining, 9963); assert.deepEqual(later.missingDays, []);
  const fresh = new RoomStore(); t.after(() => fresh.close());
  const incomplete = await volcRtcUsage(env, fetcher, new Date('2026-10-31T04:00:00Z'), fresh);
  assert.equal(incomplete.status, 'partial'); assert.equal(incomplete.used, 10);
  assert.equal(incomplete.remaining, undefined); assert.deepEqual(incomplete.missingDays, ['2026-10-01']);
});

test('火山日期以北京时间自然月开始并标识权限不足', async () => {
  const env = {VOLC_RTC_APP_ID:'app',VOLC_ACCESS_KEY_ID:'id',VOLC_ACCESS_KEY_SECRET:'secret'};
  let request;
  const denied = await volcRtcUsage(env, async (_url, options) => { request = JSON.parse(options.body); return {ok:false,status:403,json:async () => ({ResponseMetadata:{Error:{Code:'AccessDenied'}}})}; }, new Date('2024-02-29T04:00:00Z'));
  assert.equal(request.StartTime, '2024-02-01T00:00:00+08:00');
  assert.equal(request.EndTime, '2024-02-29T12:00:00+08:00');
  assert.equal(denied.status, 'forbidden');
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
  assert.deepEqual(result, {status:'ok', kind:'console_quota', remaining:8765, total:10000, used:1235, unit:'标准分钟'});
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
  const env = { ...agoraEnv, VOLC_RTC_APP_ID:'app', VOLC_ACCESS_KEY_ID:'id', VOLC_ACCESS_KEY_SECRET:'secret' };
  let calls = 0;
  const service = createUsageService(env, async url => {
    calls++;
    if (url.includes('agora.io')) return response({ usages:[{usage:row}] });
    return response({ Result:{ Usages:[{TimeStamp:'2026-10-01T00:00:00+08:00',Audio:10,Video2K:3}] } });
  }, () => Date.parse('2026-10-27T00:00:00Z'));
  const status = await service();
  assert.equal(status.volc.remaining, 9987);
  assert.equal(status.agora.status, 'ok');
  assert.equal(await service(), status);
  assert.equal(calls, 2);
});

test('两个火山应用共用访问密钥、分别查询和汇总用量', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  const env = {VOLC_RTC_APP_ID:'first-app', VOLC_RTC_APP_ID_2:'second-app', VOLC_ACCESS_KEY_ID:'id', VOLC_ACCESS_KEY_SECRET:'secret'};
  const requests = [];
  const service = createUsageService(env, async (url, options) => {
    const payload = JSON.parse(options.body); requests.push({app:payload.AppId, at:Date.now(), authorization:options.headers.Authorization});
    return response({Result:{Usages:[{TimeStamp:'2026-10-01T00:00:00+08:00',Audio:payload.AppId === 'first-app' ? 100 : 250}]}});
  }, () => Date.parse('2026-10-27T00:00:00Z'), store);
  const status = await service();
  assert.equal(status.volc.used, 100); assert.equal(status.volc.remaining, 9900);
  assert.equal(status.volc2.used, 250); assert.equal(status.volc2.remaining, 9750);
  assert.deepEqual(requests.map(r => r.app), ['first-app','second-app']);
  assert.ok(requests[1].at - requests[0].at >= 500);
  assert.ok(requests.every(r => r.authorization.startsWith('HMAC-SHA256 Credential=id/')));
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
