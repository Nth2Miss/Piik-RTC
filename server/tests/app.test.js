import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { RoomStore } from '../rooms/store.js';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createDecipheriv, createHmac } from 'node:crypto';
import { rm } from 'node:fs/promises';

const credentials = { AGORA_APP_ID: 'a'.repeat(32), AGORA_APP_CERTIFICATE: 'b'.repeat(32) };
async function server(t, env = credentials, options = {}) {
  const app = createApp(env, new RoomStore(), options);
  const instance = app.listen(0, '127.0.0.1');
  await new Promise(resolve => instance.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => instance.close(resolve)); app.locals.close(); });
  const base = `http://127.0.0.1:${instance.address().port}`;
  const browser = (name) => {
    let cookie = '';
    let registered = false;
    const request = async (route, body, method, headers = {}) => {
      const response = await fetch(base + route, { method: method || (body === undefined ? 'GET' : 'POST'),
        headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
      return { status: response.status, data: await response.json(), headers: response.headers };
    };
    return async (...args) => {
      if (name && !registered) { await request('/api/profile', { name }); registered = true; }
      return request(...args);
    };
  };
  return { app, browser, owner: browser('房主'), guest: browser('朋友'), stranger: browser('路人') };
}
function privileges(token) {
  const buffer = inflateSync(Buffer.from(token.slice(3), 'base64')); let offset = 0;
  const u16 = () => { const n = buffer.readUInt16LE(offset); offset += 2; return n; };
  const skip = () => { const n = u16(); offset += n; };
  skip(); skip(); offset += 12; assert.equal(u16(), 1); assert.equal(u16(), 1);
  const count = u16(), result = [];
  for (let i = 0; i < count; i++) { result.push(u16()); offset += 4; }
  return result;
}
test('configuration contains no credentials and missing config fails explicitly', async t => {
  const { owner } = await server(t, {});
  const config = await owner('/api/config');
  assert.deepEqual(config.data, { configured: false, realtime: true, providers: { agora: false, zego: false, volc: false } });
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.equal((await owner('/api/rooms', { name: '测试房间' })).status, 503);
});
test('创建房间时空名称使用创建者用户名，编辑时仍需填写名称', async t => {
  const { owner } = await server(t);
  for (const body of [{}, {name:''}, {name:'   '}, {name:' 自定义 '}]) {
    const result = await owner('/api/rooms', body);
    assert.equal(result.status, 201);
    assert.equal(result.data.name, body.name?.trim() || '房主');
    if (!body.name?.trim()) assert.equal((await owner(`/api/rooms/${result.data.id}`, {name:'   '}, 'PATCH')).status, 400);
  }
  assert.equal((await owner('/api/rooms', {name:'x'.repeat(41)})).status, 400);
  assert.equal((await owner('/api/rooms', {name:123})).status, 400);
});
test('创建房间拒绝达到 500 分钟保护线的服务商，超过保护线允许', async t => {
  const status = { agora:{ status:'ok', remaining:500 }, zego:{ status:'unavailable' }, volc:{ status:'unavailable' } };
  const env = { ...credentials, ZEGO_APP_ID:'123456', ZEGO_SERVER_SECRET:'s'.repeat(32) };
  const { owner } = await server(t, env, { usageService:async () => status });
  const blocked = await owner('/api/rooms', { name:'低余量', provider:'agora' });
  assert.equal(blocked.status, 403); assert.match(blocked.data.error, /500 分钟保护线/);
  assert.equal((await owner('/api/rooms', { name:'未知余量', provider:'zego' })).status, 201);
  status.agora.remaining = 500.01;
  const boundary = await server(t, env, { usageService:async () => status });
  assert.equal((await boundary.owner('/api/rooms', { name:'边界余量', provider:'agora' })).status, 201);
});
test('即构房间固定服务商并签发限房间和推流的 Token', async t => {
  const secret = 's'.repeat(32), env = { ...credentials, ZEGO_APP_ID: '2102769203', ZEGO_SERVER_SECRET: secret };
  const { owner, guest } = await server(t, env);
  const created = await owner('/api/rooms', { name: '即构房间', provider: 'zego' });
  assert.equal(created.status, 201);
  assert.equal(created.data.provider, 'zego');
  assert.equal((await guest(`/api/rooms/${created.data.id}`)).data.provider, 'zego');
  const response = await guest(`/api/rooms/${created.data.id}/token`, {});
  assert.equal(response.data.provider, 'zego');
  assert.equal(response.data.appId, 2102769203);
  const packed = Buffer.from(response.data.token.slice(2), 'base64');
  let offset = 8; const ivLength = packed.readUInt16BE(offset); offset += 2;
  const iv = packed.subarray(offset, offset += ivLength);
  const encryptedLength = packed.readUInt16BE(offset); offset += 2;
  const encrypted = packed.subarray(offset, offset += encryptedLength);
  assert.equal(packed[offset], 1);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(secret), iv);
  decipher.setAuthTag(encrypted.subarray(-16));
  const contents = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString());
  const payload = JSON.parse(contents.payload);
  assert.equal(payload.room_id, created.data.id);
  assert.deepEqual(payload.stream_id_list, [`${created.data.id}_${response.data.uid}`]);
  assert.equal(contents.user_id, String(response.data.uid));
});
test('火山房间令牌绑定房间与用户并包含发布和订阅权限', async t => {
  const env = { ...credentials, VOLC_RTC_APP_ID: 'a'.repeat(24), VOLC_RTC_APP_KEY: 'secret' };
  const { owner, guest } = await server(t, env);
  const created = await owner('/api/rooms', { name:'火山房间', provider:'volc' });
  assert.equal(created.data.provider, 'volc');
  const response = await guest(`/api/rooms/${created.data.id}/token`, {});
  assert.equal(response.data.provider, 'volc');
  const token = response.data.token; assert.equal(token.slice(0,27), `001${env.VOLC_RTC_APP_ID}`);
  const packed = Buffer.from(token.slice(27), 'base64');
  const msgLen = packed.readUInt16LE(0); const msg = packed.subarray(2, 2 + msgLen);
  const sigLen = packed.readUInt16LE(2 + msgLen); const signature = packed.subarray(4 + msgLen, 4 + msgLen + sigLen);
  assert.deepEqual(signature, createHmac('sha256', env.VOLC_RTC_APP_KEY).update(msg).digest());
  let pos = 12; const take = () => { const n = msg.readUInt16LE(pos); pos += 2; const s = msg.subarray(pos, pos + n).toString(); pos += n; return s; };
  assert.equal(take(), created.data.id); assert.equal(take(), String(response.data.uid));
  const count = msg.readUInt16LE(pos); pos += 2; const rights = [];
  for (let i = 0; i < count; i++) { rights.push(msg.readUInt16LE(pos)); pos += 6; }
  assert.deepEqual(rights, [0, 1, 2, 3, 4]);
});
test('username is required before browsing the public room lobby', async t => {
  const { browser } = await server(t);
  const visitor = browser();
  assert.equal((await visitor('/api/rooms')).status, 401);
  assert.equal((await visitor('/api/profile', { name: '  ' })).status, 400);
  assert.equal((await visitor('/api/profile', { name: '新朋友' })).status, 200);
  assert.equal((await visitor('/api/rooms')).status, 200);
});
test('rejects weak usernames', async t => {
  const { browser } = await server(t);
  const visitor = browser();
  for (const name of ['1', '11', '111', '123', 'aaa', 'abc', 'qwerty']) {
    assert.equal((await visitor('/api/profile', { name })).status, 400, name);
  }
  assert.equal((await visitor('/api/profile', { name: '李四' })).status, 200);
});
test('rejects duplicate names inside the same room', async t => {
  const { browser, owner, guest } = await server(t);
  const twin = browser('房主');
  const room = (await owner('/api/rooms', { name: '重名测试' })).data;
  const route = `/api/rooms/${room.id}/token`;
  assert.equal((await owner(route, {})).status, 200);
  assert.equal((await twin(route, {})).status, 409);
  assert.equal((await guest(route, {})).status, 200);
  assert.equal((await guest('/api/profile', { name: '房主' })).status, 409);
});
test('all named users see the same room lobby without exposing creator credentials', async t => {
  const { owner, guest, stranger } = await server(t);
  const room = (await owner('/api/rooms', { name: '周末放映室', description: '一起看电影' })).data;
  assert.equal(room.isOwner, true); assert.equal(room.ownerId, undefined);
  assert.equal((await owner('/api/rooms')).data.rooms.length, 1);
  assert.equal((await guest('/api/rooms')).data.rooms.length, 1);
  assert.equal((await stranger(`/api/rooms/${room.id}/token`, {})).status, 200);
  assert.equal((await guest(`/api/rooms/${room.id}`)).data.isOwner, false);
  assert.equal((await guest('/api/rooms')).data.rooms[0].name, room.name);
  assert.equal((await stranger('/api/rooms')).data.rooms.length, 1);
  assert.equal((await owner('/api/rooms', { name: '  ' })).data.name, '房主');
});
test('multiple members receive unique publisher UIDs and session renewal is identity-bound', async t => {
  const { owner, guest } = await server(t);
  const room = (await owner('/api/rooms', { name: '多人共享' })).data;
  const route = `/api/rooms/${room.id}/token`;
  const host = (await owner(route, { displayName: '房主' })).data;
  const friend = (await guest(route, { key: room.inviteKey, displayName: '朋友' })).data;
  assert.deepEqual(privileges(host.token), [1, 2, 3, 4]);
  assert.deepEqual(privileges(friend.token), [1, 2, 3, 4]);
  assert.notEqual(host.uid, friend.uid);
  assert.equal((await owner(route, { sessionKey: host.sessionKey })).data.uid, host.uid);
  assert.equal((await guest(route, { sessionKey: host.sessionKey })).status, 403);
  assert.equal(JSON.stringify(host).includes(credentials.AGORA_APP_CERTIFICATE), false);
  const presence = `/api/rooms/${room.id}/presence`;
  await owner(presence, { sessionKey: host.sessionKey, sharing: true });
  const members = (await guest(presence, { sessionKey: friend.sessionKey, sharing: true })).data.participants;
  assert.equal(members.length, 2); assert.equal(members.every(p => p.sharing), true);
  assert.equal(members.find(p => p.uid === friend.uid).name, '朋友');
  assert.equal(members[0].sessionKey, undefined);
  await owner(`/api/rooms/${room.id}/leave`, { sessionKey: host.sessionKey });
  assert.equal((await guest(presence, { sessionKey: friend.sessionKey, sharing: true })).data.participants.length, 1);
});
test('only the creator can edit or manually close a room', async t => {
  const { owner, guest } = await server(t);
  const room = (await owner('/api/rooms', { name: '原名称' })).data;
  await guest(`/api/rooms/${room.id}/save`, { key: room.inviteKey });
  assert.equal((await guest(`/api/rooms/${room.id}`, { name: '越权修改' }, 'PATCH')).status, 403);
  assert.equal((await owner(`/api/rooms/${room.id}`, { name: '新名称', description: '新描述' }, 'PATCH')).data.name, '新名称');
  assert.equal((await guest(`/api/rooms/${room.id}`, {}, 'DELETE')).status, 403);
  assert.equal((await guest('/api/rooms')).data.rooms.length, 1);
  assert.equal((await owner('/api/rooms')).data.rooms.length, 1);
  await owner(`/api/rooms/${room.id}`, {}, 'DELETE');
  assert.equal((await guest(`/api/rooms/${room.id}/save`, { key: room.inviteKey })).status, 404);
});
test('presence expires after disconnect and late renewal preserves identity', async t => {
  const { owner, guest } = await server(t);
  const room = (await owner('/api/rooms', { name: '续期测试' })).data;
  const route = `/api/rooms/${room.id}`;
  const host = (await owner(`${route}/token`, { displayName: '房主' })).data;
  const friend = (await guest(`${route}/token`, { key: room.inviteKey })).data;
  await owner(`${route}/presence`, { sessionKey: host.sessionKey, sharing: true });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 46_000);
  assert.equal((await guest(`${route}/presence`, { sessionKey: friend.sessionKey })).data.participants.length, 1);
  for (let step = 1; step <= 5; step++) {
    t.mock.method(Date, 'now', () => now + step * 600_000);
    assert.equal((await guest(`${route}/presence`, { sessionKey: friend.sessionKey })).status, 200);
  }
  t.mock.method(Date, 'now', () => now + 3601_000);
  assert.equal((await owner(`${route}/token`, { sessionKey: host.sessionKey })).data.uid, host.uid);
  assert.equal((await owner('/api/rooms')).data.rooms[0].id, room.id);
});
test('never-joined rooms close exactly at the 15 minute boundary', async t => {
  const { owner, app } = await server(t);
  const room = (await owner('/api/rooms', { name: '空房间' })).data;
  assert.equal(room.closesAt, room.createdAt + 900_000);
  t.mock.method(Date, 'now', () => room.createdAt + 899_999);
  assert.equal((await owner('/api/rooms')).data.rooms.length, 1);
  t.mock.method(Date, 'now', () => room.createdAt + 900_000);
  app.locals.sweep(); // same sweep runs on the server timer, with no browser request required
  assert.equal(app.locals.store.get(room.id), undefined);
  assert.equal((await owner(`/api/rooms/${room.id}/token`, {})).status, 404);
});
test('last leave starts timeout and a new member cancels the pending close', async t => {
  const { owner, guest } = await server(t);
  const room = (await owner('/api/rooms', { name: '重新加入' })).data;
  const base = `/api/rooms/${room.id}`;
  const a = (await owner(`${base}/token`, {})).data;
  const b = (await guest(`${base}/token`, {})).data;
  await owner(`${base}/leave`, { sessionKey: a.sessionKey });
  assert.equal((await guest(base)).data.closesAt, null);
  const leftAt = Date.now();
  await guest(`${base}/leave`, { sessionKey: b.sessionKey });
  const deadline = (await owner(base)).data.closesAt;
  assert.ok(deadline >= leftAt + 900_000);
  t.mock.method(Date, 'now', () => deadline - 1);
  const rejoin = await owner(`${base}/token`, {});
  assert.equal(rejoin.status, 200); assert.equal(rejoin.data.room.closesAt, null);
  t.mock.method(Date, 'now', () => deadline + 1);
  assert.equal((await owner(base)).status, 200);
});
test('rejects cross-origin writes and disables API response caching', async t => {
  const { owner } = await server(t);
  assert.equal((await owner('/api/rooms', { name: 'test' }, 'POST', { Origin: 'https://untrusted.example' })).status, 403);
  const created = await owner('/api/rooms', { name: '正常请求' });
  assert.equal(created.status, 201); assert.equal(created.headers.get('cache-control'), 'no-store');
});
test('rooms and memberships persist after closing and reopening SQLite', async () => {
  const filename = join(tmpdir(), `piik-sw-test-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new RoomStore(filename);
    store.create({ id: 'abc', ownerId: 'owner', name: '持久房间', description: '', inviteKey: 'invite', createdAt: Date.now(), updatedAt: Date.now() });
    store.save('abc', 'member'); store.close();
    store = new RoomStore(filename);
    assert.equal(store.list('owner')[0].name, '持久房间');
    assert.equal(store.list('member')[0].id, 'abc');
    assert.equal(store.list('stranger').length, 0);
  } finally {
    store?.close();
    for (const suffix of ['', '-wal', '-shm']) await rm(filename + suffix, { force: true });
  }
});
