import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../app.js';
import { attachRealtime, REALTIME_LIMITS } from '../rooms/realtime.js';
import { RoomStore } from '../rooms/store.js';

const credentials = { AGORA_APP_ID: 'a'.repeat(32), AGORA_APP_CERTIFICATE: 'b'.repeat(32) };

async function call(base, cookie, route, body, method) {
  const response = await fetch(base + route, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const next = response.headers.get('set-cookie')?.split(';')[0] || cookie;
  return { status: response.status, data: await response.json(), cookie: next };
}
function connect(port, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}
function waitFor(socket, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('websocket message timeout')); }, timeout);
    const listener = raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer); socket.off('message', listener); resolve(message);
    };
    socket.on('message', listener);
  });
}
async function limitedServer(t, overrides = {}) {
  const app = createApp({});
  const server = createServer(app);
  const realtime = attachRealtime(server, app, {}, {...REALTIME_LIMITS,...overrides});
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    realtime.close(); await new Promise(resolve => server.close(resolve)); app.locals.close();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const cookie = (await call(`http://127.0.0.1:${port}`, undefined, '/api/profile', {name:'测试成员'})).cookie;
  return {port,cookie,connect:async () => { const socket = await connect(port,cookie); sockets.push(socket); return socket; }};
}
test('WebSocket 在升级前拒绝未登记身份和超出连接上限的用户', async t => {
  const server = await limitedServer(t, {perIdentity:1});
  await assert.rejects(connect(server.port, 'screen_identity=' + 'x'.repeat(32)), /401/);
  await server.connect();
  await assert.rejects(server.connect(), /429/);
});
test('WebSocket 限制单条消息大小和消息突发频率', async t => {
  const server = await limitedServer(t, {maxPayload:256,burst:3,messagesPerSecond:0});
  const oversized = await server.connect();
  oversized.on('error', () => {});
  const oversizeClosed = new Promise(resolve => oversized.once('close', resolve));
  oversized.send('x'.repeat(257));
  assert.equal(await oversizeClosed, 1009);
  const noisy = await server.connect();
  const closed = new Promise(resolve => noisy.once('close', resolve));
  for (let i = 0; i < 4; i++) noisy.send('{}');
  await closed;
  assert.equal(noisy.readyState, WebSocket.CLOSED);
});
test('未配置 PUBLIC_ORIGIN 时仍拒绝异站 WebSocket 来源', async t => {
  const server = await limitedServer(t);
  await assert.rejects(new Promise((resolve,reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {headers:{Cookie:server.cookie},origin:'https://untrusted.example'});
    socket.once('open', () => { socket.terminate(); resolve(); }); socket.once('error', reject);
  }));
});

test('websocket pushes sharing changes without client polling', async t => {
  const app = createApp(credentials);
  const server = createServer(app);
  const realtime = attachRealtime(server, app, credentials);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    realtime.close();
    await new Promise(resolve => server.close(resolve));
    app.locals.close();
  });

  const owner = (await call(base, undefined, '/api/profile', { name: '房主' })).cookie;
  const guest = (await call(base, undefined, '/api/profile', { name: '朋友' })).cookie;
  const room = (await call(base, owner, '/api/rooms', { name: '实时房间' })).data;
  const host = (await call(base, owner, `/api/rooms/${room.id}/token`, {})).data;
  const friend = (await call(base, guest, `/api/rooms/${room.id}/token`, {})).data;

  const hostSocket = await connect(port, owner); sockets.push(hostSocket);
  const guestSocket = await connect(port, guest); sockets.push(guestSocket);
  hostSocket.send(JSON.stringify({ type: 'subscribe', roomId: room.id, sessionKey: host.sessionKey }));
  await waitFor(hostSocket, message => message.type === 'room');
  guestSocket.send(JSON.stringify({ type: 'subscribe', roomId: room.id, sessionKey: friend.sessionKey }));
  await waitFor(guestSocket, message => message.type === 'room');

  const update = waitFor(guestSocket, message => message.type === 'room'
    && message.participants.some(person => person.uid === host.uid && person.sharing));
  hostSocket.send(JSON.stringify({ type: 'presence', sharing: true }));
  const pushed = await update;
  assert.equal(pushed.participants.find(person => person.uid === host.uid).sharing, true);
});

test('达到 500 分钟保护线时通知成员并拒绝房间续期', async t => {
  let remaining = 10000;
  const app = createApp(credentials, new RoomStore(), { usageService: async () => ({ agora:{ status:'ok', remaining, total:10000 }, volc:{ status:'unavailable' }, zego:{ status:'unavailable' } }) });
  const server = createServer(app); const realtime = attachRealtime(server, app, credentials);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  const cookie = (await call(base, undefined, '/api/profile', { name:'房主' })).cookie;
  const room = (await call(base, cookie, '/api/rooms', { name:'限额房间' })).data;
  const token = (await call(base, cookie, `/api/rooms/${room.id}/token`, {})).data;
  const socket = await connect(port, cookie);
  t.after(async () => { socket.terminate(); realtime.close(); await new Promise(resolve => server.close(resolve)); app.locals.close(); });
  socket.send(JSON.stringify({ type:'subscribe', roomId:room.id, sessionKey:token.sessionKey }));
  await waitFor(socket, message => message.type === 'room');
  const closed = waitFor(socket, message => message.type === 'closed');
  remaining = 500; await app.locals.monitor.check();
  assert.match((await closed).reason, /500 分钟保护线/);
  const renewal = await call(base, cookie, `/api/rooms/${room.id}/token`, { sessionKey:token.sessionKey });
  assert.equal(renewal.status, 404); assert.match(renewal.data.error, /500 分钟保护线/);
});
