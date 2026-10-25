import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { RoomStore } from './room-store.js';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

const credentials = { AGORA_APP_ID: 'a'.repeat(32), AGORA_APP_CERTIFICATE: 'b'.repeat(32) };
async function server(t, env = credentials) {
  const app = createApp(env);
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
  assert.deepEqual(config.data, { configured: false });
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.equal((await owner('/api/rooms', { name: '测试房间' })).status, 503);
});
test('username is required before browsing the public room lobby', async t => {
  const { browser } = await server(t);
  const visitor = browser();
  assert.equal((await visitor('/api/rooms')).status, 401);
  assert.equal((await visitor('/api/profile', { name: '  ' })).status, 400);
  assert.equal((await visitor('/api/profile', { name: '新朋友' })).status, 200);
  assert.equal((await visitor('/api/rooms')).status, 200);
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
  assert.equal((await owner('/api/rooms', { name: '  ' })).status, 400);
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
  const filename = join(tmpdir(), `screen-room-test-${randomUUID()}.sqlite`);
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
