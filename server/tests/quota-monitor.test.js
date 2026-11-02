import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../rooms/store.js';
import { QuotaMonitor, normalizeMedia, rateFor } from '../quota/monitor.js';

const empty = async () => ({ agora:{ status:'unconfigured' }, zego:{ status:'unavailable' }, volc:{ status:'unavailable' } });
function room(store, id, provider, now) { store.create({ id, provider, ownerId:'owner', name:id, description:'', inviteKey:'key', createdAt:now, updatedAt:now }); }
function session(roomId, uid, now, media) { return { roomId, uid, lastSeen:now, expiresAt:now + 1_000_000, media }; }

test('各服务商按分辨率和指定倍率计算', () => {
  assert.equal(rateFor('agora', 0), 1);
  assert.equal(rateFor('agora', 1280 * 720), 4);
  assert.equal(rateFor('agora', 1920 * 1080), 9);
  assert.equal(rateFor('volc', 1920 * 1080), 1);
  assert.equal(rateFor('volc', 2560 * 1440), 1);
  assert.equal(rateFor('volc', 3840 * 2160), 1);
  assert.equal(rateFor('volc2', 3840 * 2160), 1);
  assert.equal(rateFor('zego', 640 * 360), 1.7);
  assert.equal(rateFor('zego', 640 * 360 + 1), 3.6);
  assert.equal(rateFor('zego', 1280 * 720), 3.6);
  assert.equal(rateFor('zego', 1920 * 1080), 14);
  assert.equal(rateFor('zego', 2560 * 1440), 16);
});

test('按连接成员、观看的视频档位和多个房间累计，未连接不计', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  let now = Date.parse('2026-10-20T00:00:00Z'); room(store, 'a', 'zego', now); room(store, 'b', 'zego', now);
  const sessions = new Map([
    ['a1', session('a', 1, now, { connected:true, publishWidth:1920, publishHeight:1080, pulls:[] })],
    ['a2', session('a', 2, now, { connected:true, selected:1, width:1920, height:1080, pulls:[{uid:1,kind:'video',width:1920,height:1080}] })],
    ['b1', session('b', 3, now, { connected:true, pulls:[] })],
    ['b2', session('b', 4, now, { connected:false })],
  ]);
  const monitor = new QuotaMonitor(store, sessions, empty, () => {}, () => now);
  now += 60_000; for (const s of sessions.values()) s.lastSeen = now;
  const status = await monitor.snapshot();
  assert.equal(status.zego.localUsed, 14); // only the actual video pull
  assert.equal(status.zego.remaining, 9986);
  const rows = store.db.prepare('SELECT roomId, estimated FROM rtc_room_usage ORDER BY roomId').all();
  assert.deepEqual(rows.map(r => [r.roomId, r.estimated]), [['a',14]]);
});

test('即构按实际拉流逐路计费，切换或停止后按新状态累计', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  let now = Date.parse('2026-10-20T00:00:00Z'); room(store, 'a', 'zego', now);
  const viewer = session('a', 2, now, normalizeMedia({connected:true, selected:1, pulls:[]}));
  const sessions = new Map([['a', viewer]]);
  const monitor = new QuotaMonitor(store, sessions, empty, () => {}, () => now);
  const tick = () => { now += 60_000; viewer.lastSeen = now; monitor.account(); };
  tick(); // merely selecting a source does not start billing
  viewer.media = normalizeMedia({connected:true, pulls:[{uid:1,kind:'video',width:640,height:360},{uid:3,kind:'audio'}]});
  tick();
  viewer.media = normalizeMedia({connected:true, pulls:[{uid:1,kind:'video',width:1280,height:720}]});
  tick();
  viewer.media = normalizeMedia({connected:true, pulls:[{uid:1,kind:'video',width:1920,height:1080}]});
  tick();
  viewer.media = normalizeMedia({connected:true, pulls:[]});
  tick();
  assert.ok(Math.abs(store.quota('zego', '2026-10').estimated - 20.3) < 1e-9);
});

test('即构同月同档位跨房间累计后按分钟向上取整，不按每次监控取整', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  let now = Date.parse('2026-10-20T00:00:00Z'); room(store, 'a', 'zego', now); room(store, 'b', 'zego', now);
  const pulls = [{uid:9,kind:'video',width:1920,height:1080}];
  const a = session('a', 1, now, normalizeMedia({connected:true, pulls}));
  const b = session('b', 2, now, normalizeMedia({connected:true, pulls}));
  const monitor = new QuotaMonitor(store, new Map([['a', a], ['b', b]]), empty, () => {}, () => now);
  const advance = async ms => { now += ms; a.lastSeen = b.lastSeen = now; return (await monitor.snapshot()).zego; };
  assert.equal((await advance(10_000)).localUsed, 14);
  assert.equal((await advance(20_000)).localUsed, 14); // 30 seconds x 2 streams = one minute
  assert.equal((await advance(1_000)).localUsed, 28);
  assert.ok(Math.abs(store.quota('zego', '2026-10').estimated - 14 * 62 / 60) < 1e-9);
  const restarted = new QuotaMonitor(store, new Map(), empty, () => {}, () => now);
  assert.equal((await restarted.snapshot()).zego.localUsed, 28);
});

test('即构各档位及自然月分别累计，历史估算保持不变', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  let now = Date.parse('2026-10-31T15:59:50Z'); room(store, 'a', 'zego', now);
  store.addUsage('zego', '2026-10', 'a', 2.5); // pre-migration total has no tier detail
  const viewer = session('a', 1, now, normalizeMedia({connected:true, pulls:[{uid:2,kind:'audio'},{uid:3,kind:'video',width:1280,height:720}]}));
  const monitor = new QuotaMonitor(store, new Map([['a', viewer]]), empty, () => {}, () => now);
  now += 30_000; viewer.lastSeen = now; const result = await monitor.snapshot();
  assert.ok(Math.abs(result.zego.localUsed - 4.6) < 1e-9);
  assert.ok(Math.abs(store.quota('zego', '2026-10').estimated + store.zegoRoundingReserve('2026-10') - 7.1) < 1e-9);
});

test('批量用量写入共用一个事务，失败时整批回滚', t => {
  const store = new RoomStore(); t.after(() => store.close());
  let begins = 0;
  const exec = store.db.exec.bind(store.db);
  store.db.exec = sql => { if (sql === 'BEGIN') begins++; return exec(sql); };
  store.addUsageBatch([
    {provider:'agora',month:'2026-10',roomId:'a',amount:2},
    {provider:'zego',month:'2026-10',roomId:'b',amount:7,zegoRate:14,milliseconds:30000},
  ]);
  assert.equal(begins, 1);
  assert.equal(store.db.prepare('SELECT estimated FROM rtc_quota WHERE provider=? AND month=?').get('agora','2026-10').estimated, 2);
  assert.equal(store.db.prepare('SELECT milliseconds FROM zego_tier_duration WHERE month=? AND rate=?').get('2026-10',14).milliseconds, 30000);
  assert.throws(() => store.addUsageBatch([
    {provider:'volc',month:'2026-10',roomId:'rollback',amount:3},
    {provider:null,month:'2026-10',roomId:'invalid',amount:1},
  ]));
  assert.equal(store.db.prepare('SELECT estimated FROM rtc_quota WHERE provider=? AND month=?').get('volc','2026-10'), undefined);
  assert.equal(store.db.prepare('SELECT estimated FROM rtc_room_usage WHERE provider=? AND roomId=?').get('volc','rollback'), undefined);
});

test('同批 200 路用量按服务商、月份、房间和即构档位合并，只写各个汇总行', t => {
  const store = new RoomStore(); t.after(() => store.close());
  const writes = [], prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith('INSERT INTO')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { writes.push(sql); return run(...args); };
    }
    return statement;
  };
  const entries = Array.from({length:200}, (_, index) => ({provider:'zego',month:'2026-10',roomId:index % 2 ? 'a' : 'b',amount:7,zegoRate:14,milliseconds:30000}));
  store.addUsageBatch(entries);
  assert.equal(writes.length, 4); // one provider total, two rooms, one tier
  assert.equal(store.quota('zego','2026-10').estimated, 1400);
  assert.equal(store.db.prepare('SELECT milliseconds FROM zego_tier_duration').get().milliseconds, 6_000_000);
  assert.deepEqual(store.db.prepare('SELECT estimated FROM rtc_room_usage ORDER BY roomId').all().map(row => row.estimated), [700,700]);
  store.addUsageBatch([{provider:'volc',month:'2026-10',roomId:'a',amount:1},{provider:'volc2',month:'2026-10',roomId:'a',amount:2},{provider:'volc',month:'2026-11',roomId:'a',amount:3}]);
  assert.equal(store.quota('volc','2026-10').estimated, 1);
  assert.equal(store.quota('volc2','2026-10').estimated, 2);
  assert.equal(store.quota('volc','2026-11').estimated, 3);
});

test('重复心跳不结算，切换画质前按旧档位结算，停止后不再计费', t => {
  const store = new RoomStore(); t.after(() => store.close());
  let now = Date.parse('2026-10-20T00:00:00Z'); room(store,'a','zego',now);
  const payload = {sharing:false,media:{connected:true,pulls:[{uid:7,kind:'video',width:1280,height:720}]}};
  const viewer = {...session('a',1,now,normalizeMedia(payload.media)),sharing:false};
  const monitor = new QuotaMonitor(store,new Map([['a',viewer]]),empty,() => {},() => now);
  let batches = 0;
  const write = store.addUsageBatch.bind(store); store.addUsageBatch = entries => { if (entries.length) batches++; write(entries); };
  for (let i = 0; i < 100; i++) { now += 100; monitor.updatePresence(viewer,payload); }
  assert.equal(batches, 0);
  now += 20_000; monitor.account();
  assert.equal(batches, 1); assert.equal(store.quota('zego','2026-10').estimated, 1.8);
  now += 10_000; monitor.updatePresence(viewer,{sharing:false,media:{connected:true,pulls:[{uid:7,kind:'video',width:1920,height:1080}]}});
  assert.ok(Math.abs(store.quota('zego','2026-10').estimated - 2.4) < 1e-9);
  now += 30_000; monitor.updatePresence(viewer,{sharing:false,media:{connected:false,pulls:[]}});
  const total = store.quota('zego','2026-10').estimated;
  assert.ok(Math.abs(total - 9.4) < 1e-9);
  now += 20_000; monitor.account(); assert.equal(store.quota('zego','2026-10').estimated, total);
});

test('心跳恢复不补收离线间隔，跨月仍按北京时间分段', t => {
  const store = new RoomStore(); t.after(() => store.close());
  let now = Date.parse('2026-10-31T15:59:30Z'); room(store,'a','volc',now);
  const viewer = {...session('a',1,now,normalizeMedia({connected:true})),sharing:false};
  const monitor = new QuotaMonitor(store,new Map([['a',viewer]]),empty,() => {},() => now);
  now += 60_000; monitor.updatePresence(viewer,{sharing:false,media:{connected:true}});
  assert.equal(store.quota('volc','2026-10').estimated, 0.5);
  assert.equal(store.quota('volc','2026-11').estimated, 0.25);
  now += 30_000; monitor.account();
  assert.equal(store.quota('volc','2026-11').estimated, 0.75);
});

test('合并写入失败保留计费时间和媒体状态，下次可完整重试', t => {
  const store = new RoomStore(); t.after(() => store.close());
  let now = Date.parse('2026-10-20T00:00:00Z'); room(store,'a','volc',now);
  const viewer = {...session('a',1,now,normalizeMedia({connected:true})),sharing:false};
  const monitor = new QuotaMonitor(store,new Map([['a',viewer]]),empty,() => {},() => now);
  const start = now, write = store.addUsageBatch.bind(store);
  store.addUsageBatch = () => { throw new Error('write failed'); };
  now += 30_000;
  assert.throws(() => monitor.updatePresence(viewer,{sharing:false,media:{connected:false}}), /write failed/);
  assert.equal(monitor.last, start); assert.equal(viewer.media.connected, true);
  store.addUsageBatch = write;
  monitor.updatePresence(viewer,{sharing:false,media:{connected:false}});
  assert.equal(store.quota('volc','2026-10').estimated, 0.5);
  assert.equal(viewer.media.connected, false);
});

test('余额达到 500 分钟保护线时关闭该服务商所有房间', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  const now = Date.parse('2026-10-20T00:00:00Z'); room(store, 'one', 'volc', now); room(store, 'two', 'volc', now); room(store, 'other', 'zego', now);
  store.addUsage('volc', '2026-10', 'one', 9499.99);
  const closed = [];
  const monitor = new QuotaMonitor(store, new Map(), empty, (room, reason) => { closed.push([room.id, reason]); store.archive(room.id, reason); }, () => now);
  await monitor.check(); assert.equal(closed.length, 0);
  store.addUsage('volc', '2026-10', 'two', 0.01);
  await monitor.check(); assert.deepEqual(closed.map(x => x[0]).sort(), ['one','two']);
  assert.match(closed[0][1], /500 分钟保护线/); assert.ok(store.get('other'));
});

test('额度检查即时结算重复心跳期间的用量，达到 500 分钟仍关闭房间', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  let now = Date.parse('2026-10-20T00:00:00Z'); room(store,'a','volc2',now);
  store.addUsage('volc2','2026-10','a',9499.5);
  const viewer = {...session('a',1,now,normalizeMedia({connected:true})),sharing:false};
  const closed = [];
  const monitor = new QuotaMonitor(store,new Map([['a',viewer]]),empty,room => closed.push(room.id),() => now);
  for (let i = 0; i < 30; i++) { now += 1000; monitor.updatePresence(viewer,{sharing:false,media:{connected:true}}); }
  assert.equal(store.quota('volc2','2026-10').estimated, 9499.5);
  assert.equal((await monitor.check()).volc2.remaining, 500);
  assert.deepEqual(closed, ['a']);
});

test('监控成功后提供短期存活确认，超时后停止确认', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  let now = Date.parse('2026-10-20T00:00:00Z');
  const monitor = new QuotaMonitor(store, new Map(), empty, () => {}, () => now);
  assert.equal(monitor.healthy(), false); await monitor.check(); assert.equal(monitor.healthy(), true);
  now += 90_001; assert.equal(monitor.healthy(), false);
});

test('跨北京时间自然月分段入账，并保留声网供应商快照后的本地消耗', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  let now = Date.parse('2026-10-31T15:59:30Z'); room(store, 'a', 'agora', now);
  const sessions = new Map([['a', session('a', 1, now, { connected:true })]]);
  const monitor = new QuotaMonitor(store, sessions, async () => ({ agora:{ status:'ok', remaining:40, total:10000 }, zego:{status:'unavailable'}, volc:{status:'unavailable'} }), () => {}, () => now);
  assert.equal((await monitor.snapshot()).agora.remaining, 40);
  now += 60_000; sessions.get('a').lastSeen = now;
  const status = await monitor.snapshot();
  assert.equal(store.quota('agora','2026-10').estimated, 0.5);
  assert.equal(store.quota('agora','2026-11').estimated, 0.5);
  assert.equal(status.agora.remaining, 40);
});

test('声网供应商快照与本地增量取保守值，不将已上报的用量重复相加', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  const now = Date.parse('2026-10-20T00:00:00Z'); let upstream = 40;
  const monitor = new QuotaMonitor(store, new Map(), async () => ({ agora:{ status:'ok', remaining:upstream }, zego:{status:'unavailable'}, volc:{status:'unavailable'} }), () => {}, () => now);
  assert.equal((await monitor.snapshot()).agora.remaining, 40);
  store.addUsage('agora', '2026-10', 'room', 4);
  upstream = 37; assert.equal((await monitor.snapshot()).agora.remaining, 36);
  upstream = 34; assert.equal((await monitor.snapshot()).agora.remaining, 34);
});

test('火山按应用用量推算余量并扣除后续本地用量，不沿用旧资源包快照', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  const now = Date.parse('2026-10-20T00:00:00Z'); let upstream = 9500;
  store.quota('volc','2026-10'); store.setQuotaAnchor('volc','2026-10',20000,0);
  const usage = async () => ({ agora:{status:'unconfigured'}, zego:{status:'unavailable'}, volc:{status:'ok',remaining:upstream,total:10000,unit:'分钟'} });
  const monitor = new QuotaMonitor(store, new Map(), usage, () => {}, () => now);
  assert.equal((await monitor.snapshot()).volc.remaining, 9500);
  store.addUsage('volc', '2026-10', 'room', 4);
  assert.equal((await monitor.snapshot()).volc.remaining, 9496);
  upstream = 9490;
  assert.equal((await monitor.snapshot()).volc.remaining, 9490);
});

test('两个火山应用各自累计和保护，只关闭达到保护线的应用房间', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  const now = Date.parse('2026-10-20T00:00:00Z');
  room(store, 'first', 'volc', now); room(store, 'second', 'volc2', now);
  store.addUsage('volc', '2026-10', 'first', 9500);
  store.addUsage('volc2', '2026-10', 'second', 100);
  const closed = [];
  const monitor = new QuotaMonitor(store, new Map(), empty, (room, reason) => {closed.push([room.id,reason]); store.archive(room.id,reason);}, () => now);
  const status = await monitor.check();
  assert.equal(status.volc.remaining, 500); assert.equal(status.volc2.remaining, 9900);
  assert.deepEqual(closed.map(([id]) => id), ['first']); assert.ok(store.get('second'));
});

test('火山应用槽位绑定 AppID，防止更换后误用旧用量', t => {
  const store = new RoomStore(); t.after(() => store.close());
  assert.equal(store.bindVolcProvider('volc','first'), true);
  assert.equal(store.bindVolcProvider('volc','first'), true);
  assert.equal(store.bindVolcProvider('volc','different'), false);
  assert.equal(store.bindVolcProvider('volc2','first'), false);
  assert.equal(store.bindVolcProvider('volc2','second'), true);
});

test('即构供应商额度与本地估算分别显示，并按保守值保护', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  const now = Date.parse('2026-10-20T00:00:00Z'); let upstream = {status:'ok', remaining:80, total:10000, unit:'标准分钟'};
  const monitor = new QuotaMonitor(store, new Map(), async () => ({agora:{status:'unconfigured'},volc:{status:'unavailable'},zego:upstream}), () => {}, () => now);
  let result = (await monitor.snapshot()).zego;
  assert.equal(result.supplier.remaining, 80); assert.equal(result.remaining, 80);
  store.addUsage('zego', '2026-10', 'r', 10);
  result = (await monitor.snapshot()).zego;
  assert.equal(result.supplier.remaining, 80); assert.equal(result.localUsed, 10); assert.equal(result.remaining, 70);
  upstream = {status:'auth_expired'};
  result = (await monitor.snapshot()).zego;
  assert.equal(result.supplier.status, 'auth_expired'); assert.equal(result.remaining, 70);
});

test('未取得声网供应商余额时不把本地 10000 误称为真实余额', async t => {
  const store = new RoomStore(); t.after(() => store.close());
  const now = Date.parse('2026-10-20T00:00:00Z');
  const monitor = new QuotaMonitor(store, new Map(), empty, () => {}, () => now);
  const result = await monitor.snapshot();
  assert.equal(result.agora.status, 'unconfigured'); assert.equal(result.agora.remaining, undefined);
  assert.equal(result.volc.remaining, 10000); assert.equal(result.zego.remaining, 10000);
});
