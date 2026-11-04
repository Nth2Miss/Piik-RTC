import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { RoomStore } from '../rooms/store.js';

const credentials = { AGORA_APP_ID: 'a'.repeat(32), AGORA_APP_CERTIFICATE: 'b'.repeat(32) };
const token = 'test-bot-token';
const healthy = () => ({ agora:{ status:'ok', remaining:9000, total:10000, unit:'标准分钟' }, zego:{ status:'unavailable' }, volc:{ status:'unavailable' }, volc2:{ status:'unavailable' } });

async function server(t, env = { ...credentials, BOT_API_TOKEN: token }, options = { usageService: async () => healthy() }) {
  const app = createApp(env, new RoomStore(), options);
  const instance = app.listen(0, '127.0.0.1');
  await new Promise(resolve => instance.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => instance.close(resolve)); app.locals.close(); });
  const base = `http://127.0.0.1:${instance.address().port}`;
  const bot = async (route, body, method, headers = {}) => {
    const response = await fetch(base + route, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const browser = name => {
    let cookie = '', registered = false;
    const request = async (route, body, method, headers = {}) => {
      const response = await fetch(base + route, { method: method || (body === undefined ? 'GET' : 'POST'),
        headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
      return { status: response.status, data: await response.json() };
    };
    return async (...args) => {
      if (name && !registered) { await request('/api/profile', { name }); registered = true; }
      return request(...args);
    };
  };
  return { app, bot, browser, base };
}

test('bot 接口未配置 token 时禁用，错误 token 被拒绝', async t => {
  const disabled = await server(t, credentials);
  assert.equal((await disabled.bot('/api/bot/status')).status, 503);

  const { bot } = await server(t);
  assert.equal((await bot('/api/bot/status', undefined, 'GET', { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await bot('/api/bot/status', undefined, 'GET', { Authorization: '' })).status, 401);
});

test('bot 接口支持 X-Bot-Token，兼容反向代理的 Basic Auth', async t => {
  const { base } = await server(t);
  const response = await fetch(base + '/api/bot/status', { headers: { 'X-Bot-Token': token } });
  assert.equal(response.status, 200);
  const bad = await fetch(base + '/api/bot/status', { headers: { 'X-Bot-Token': 'wrong' } });
  assert.equal(bad.status, 401);

  // Authorization 被 Basic Auth 占用时，X-Bot-Token 仍然能通过。
  const basic = await fetch(base + '/api/bot/status', {
    headers: { Authorization: 'Basic ' + Buffer.from('user:pass').toString('base64'), 'X-Bot-Token': token },
  });
  assert.equal(basic.status, 200);
});

test('bot 状态返回可用服务商与用量', async t => {
  const { bot } = await server(t);
  const result = await bot('/api/bot/status');
  assert.equal(result.status, 200);
  assert.equal(result.data.configured, true);
  const agora = result.data.providers.find(provider => provider.name === 'agora');
  assert.equal(agora.available, true);
  assert.equal(agora.remaining, 9000);
  assert.equal(result.data.providers.find(provider => provider.name === 'volc').available, false);
  assert.deepEqual(result.data.rooms, { total: 0, active: 0 });
});

test('bot 创建房间必须选择服务商，并使用传入的发起者名字', async t => {
  const { bot } = await server(t, { ...credentials, BOT_API_TOKEN: token, PUBLIC_ORIGIN: 'https://piik.example.com' });
  const missing = await bot('/api/bot/rooms', { name: '小明' });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.data.providers, ['agora']);

  const created = await bot('/api/bot/rooms', { name: ' 小明 ', provider: 'agora', description: '一起看电影' });
  assert.equal(created.status, 201);
  assert.equal(created.data.room.name, '小明');
  assert.equal(created.data.room.description, '一起看电影');
  assert.equal(created.data.room.provider, 'agora');
  assert.equal(created.data.room.onlineCount, 0);
  assert.equal(created.data.room.webUrl, `https://piik.example.com/#room=${created.data.room.id}`);
});

test('bot 创建房间沿用 500 分钟保护线和名称长度限制', async t => {
  const low = { agora:{ status:'ok', remaining:500 } };
  const { bot } = await server(t, { ...credentials, BOT_API_TOKEN: token }, { usageService: async () => low });
  assert.equal((await bot('/api/bot/rooms', { name: '小明', provider: 'agora' })).status, 403);

  const { bot: normal } = await server(t);
  assert.equal((await normal('/api/bot/rooms', { name: 'x'.repeat(41), provider: 'agora' })).status, 400);
  assert.equal((await normal('/api/bot/rooms', { name: '小明', provider: 'nope' })).status, 400);
});

test('bot 房间列表与详情显示在线成员和共享状态', async t => {
  const { bot, browser } = await server(t);
  const created = await bot('/api/bot/rooms', { name: '小明', provider: 'agora' });
  const id = created.data.room.id;
  const guest = browser('小明');
  const joined = await guest(`/api/rooms/${id}/token`, {});
  assert.equal(joined.status, 200);
  assert.equal((await guest(`/api/rooms/${id}/presence`, { sessionKey: joined.data.sessionKey, sharing: true })).status, 200);

  const list = await bot('/api/bot/rooms');
  const room = list.data.rooms.find(item => item.id === id);
  assert.equal(room.onlineCount, 1);
  assert.equal(room.sharingCount, 1);
  assert.equal(room.participants[0].name, '小明');
  assert.equal(room.participants[0].sharing, true);

  const sharingOnly = await bot('/api/bot/rooms?sharing=1');
  assert.deepEqual(sharingOnly.data.rooms.map(item => item.id), [id]);
  const activeOnly = await bot('/api/bot/rooms?active=1');
  assert.equal(activeOnly.data.rooms.length, 1);

  const detail = await bot(`/api/bot/rooms/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.room.onlineCount, 1);
  assert.equal((await bot('/api/bot/rooms/nope')).status, 404);
});

test('bot 进入房间返回邀请链接，关闭后不可再进入', async t => {
  const { bot } = await server(t);
  const created = await bot('/api/bot/rooms', { name: '小明', provider: 'agora' });
  const id = created.data.room.id;

  const entered = await bot(`/api/bot/rooms/${id}/enter`, {});
  assert.equal(entered.status, 200);
  assert.equal(entered.data.room.id, id);
  assert.match(entered.data.room.webUrl, /#room=[a-f0-9]{12}$/);

  assert.equal((await bot(`/api/bot/rooms/${id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await bot(`/api/bot/rooms/${id}/enter`, {})).status, 404);
  assert.equal((await bot(`/api/bot/rooms/${id}`)).status, 404);
});

test('bot 接口不暴露 inviteKey', async t => {
  const { bot } = await server(t);
  const created = await bot('/api/bot/rooms', { name: '小明', provider: 'agora' });
  assert.equal(created.data.room.inviteKey, undefined);
  assert.equal((await bot('/api/bot/rooms')).data.rooms[0].inviteKey, undefined);
});

test('同一个发起者重复创建返回已有房间，不同发起者互不影响', async t => {
  const { bot } = await server(t);
  const first = await bot('/api/bot/rooms', { name: '小明', provider: 'agora', initiatorId: 'u1' });
  assert.equal(first.status, 201);
  assert.equal(first.data.reused, false);

  const second = await bot('/api/bot/rooms', { name: '小明', provider: 'agora', initiatorId: 'u1' });
  assert.equal(second.status, 200);
  assert.equal(second.data.reused, true);
  assert.equal(second.data.room.id, first.data.room.id);

  const other = await bot('/api/bot/rooms', { name: '小红', provider: 'agora', initiatorId: 'u2' });
  assert.equal(other.status, 201);
  assert.notEqual(other.data.room.id, first.data.room.id);

  assert.equal((await bot('/api/bot/rooms')).data.total, 2);

  // 没带发起者标识时保持原来的行为，每次都新建。
  const anonymousA = await bot('/api/bot/rooms', { name: '小明', provider: 'agora' });
  const anonymousB = await bot('/api/bot/rooms', { name: '小明', provider: 'agora' });
  assert.notEqual(anonymousA.data.room.id, anonymousB.data.room.id);
});

test('房间关闭后同一个发起者可以重新创建', async t => {
  const { bot } = await server(t);
  const first = await bot('/api/bot/rooms', { name: '小明', provider: 'agora', initiatorId: 'u1' });
  assert.equal((await bot(`/api/bot/rooms/${first.data.room.id}?initiatorId=u1`, undefined, 'DELETE')).status, 200);

  const again = await bot('/api/bot/rooms', { name: '小明', provider: 'agora', initiatorId: 'u1' });
  assert.equal(again.status, 201);
  assert.equal(again.data.reused, false);
  assert.notEqual(again.data.room.id, first.data.room.id);
});

test('bot 关闭房间校验发起者，无主旧房间仍可清理', async t => {
  const { bot } = await server(t);
  const created = await bot('/api/bot/rooms', { name: '小明', provider: 'agora', initiatorId: 'u1' });
  const id = created.data.room.id;

  assert.equal((await bot(`/api/bot/rooms/${id}?initiatorId=u2`, undefined, 'DELETE')).status, 403);
  assert.equal((await bot(`/api/bot/rooms/${id}`, undefined, 'DELETE')).status, 403);
  assert.equal((await bot(`/api/bot/rooms/${id}?initiatorId=u1`, undefined, 'DELETE')).status, 200);

  const legacy = await bot('/api/bot/rooms', { name: '旧房间', provider: 'agora' });
  assert.equal(legacy.data.room.initiator, null);
  assert.equal((await bot(`/api/bot/rooms/${legacy.data.room.id}`, undefined, 'DELETE')).status, 200);
});

test('bot 按发起者过滤房间，有人的房间排在前面', async t => {
  const { bot, browser } = await server(t);
  const first = await bot('/api/bot/rooms', { name: '小明', provider: 'agora', initiatorId: 'u1' });
  const second = await bot('/api/bot/rooms', { name: '小红', provider: 'agora', initiatorId: 'u2' });
  assert.equal(first.data.room.initiator, 'u1');
  assert.equal(second.data.room.initiator, 'u2');

  const mine = await bot('/api/bot/rooms?initiator=u1');
  assert.deepEqual(mine.data.rooms.map(room => room.id), [first.data.room.id]);

  const guest = browser('小红');
  const joined = await guest(`/api/rooms/${second.data.room.id}/token`, {});
  await guest(`/api/rooms/${second.data.room.id}/presence`, { sessionKey: joined.data.sessionKey, sharing: true });

  const all = await bot('/api/bot/rooms');
  assert.equal(all.data.rooms[0].id, second.data.room.id);
  assert.equal(all.data.rooms[0].initiator, 'u2');
  assert.equal(all.data.rooms[1].id, first.data.room.id);
});
