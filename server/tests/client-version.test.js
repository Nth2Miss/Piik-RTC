import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { RoomStore } from '../rooms/store.js';

const credentials = { AGORA_APP_ID: 'a'.repeat(32), AGORA_APP_CERTIFICATE: 'b'.repeat(32) };
async function server(t) {
  const app = createApp(credentials, new RoomStore());
  const instance = app.listen(0, '127.0.0.1');
  await new Promise(resolve => instance.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => instance.close(resolve)); app.locals.close(); });
  const base = `http://127.0.0.1:${instance.address().port}`;
  const browser = name => {
    let cookie = '';
    let registered = false;
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
  return { owner: browser('房主'), guest: browser('朋友') };
}

test('房间记录创建版本，低于该版本的客户端禁止进入', async t => {
  const { owner, guest } = await server(t);
  const created = await owner('/api/rooms', { name: '新版本房间' }, 'POST', { 'X-Client-Version': '1.2.1' });
  assert.equal(created.status, 201);
  assert.equal(created.data.minVersion, '1.2.1');
  assert.equal(created.data.joinable, true);

  const listed = await guest('/api/rooms', undefined, 'GET', { 'X-Client-Version': '1.1.7' });
  const room = listed.data.rooms.find(item => item.id === created.data.id);
  assert.equal(room.minVersion, '1.2.1');
  assert.equal(room.joinable, false);

  const blocked = await guest(`/api/rooms/${created.data.id}/token`, {}, 'POST', { 'X-Client-Version': '1.1.7' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /v1\.2\.1/);
  assert.equal(blocked.data.minVersion, '1.2.1');

  const unknown = await guest(`/api/rooms/${created.data.id}/token`, {});
  assert.equal(unknown.status, 403);

  const allowed = await guest(`/api/rooms/${created.data.id}/token`, {}, 'POST', { 'X-Client-Version': '1.2.1' });
  assert.equal(allowed.status, 200);
});

test('页面与桌面端版本不同时按较低版本判断', async t => {
  const { owner, guest } = await server(t);
  const created = await owner('/api/rooms', { name: '混合版本' }, 'POST', { 'X-Client-Version': '1.2.1', 'X-Desktop-Version': '1.1.7' });
  assert.equal(created.data.minVersion, '1.1.7');

  const blocked = await guest(`/api/rooms/${created.data.id}/token`, {}, 'POST', { 'X-Client-Version': '1.1.6', 'X-Desktop-Version': '1.1.6' });
  assert.equal(blocked.status, 403);

  const allowed = await guest(`/api/rooms/${created.data.id}/token`, {}, 'POST', { 'X-Client-Version': '1.2.1', 'X-Desktop-Version': '1.1.7' });
  assert.equal(allowed.status, 200);
});

test('未上报版本创建的房间不限制进入', async t => {
  const { owner, guest } = await server(t);
  const created = await owner('/api/rooms', { name: '未标记版本' });
  assert.equal(created.data.minVersion, null);
  const joined = await guest(`/api/rooms/${created.data.id}/token`, {}, 'POST', { 'X-Client-Version': '1.0.0' });
  assert.equal(joined.status, 200);
});
