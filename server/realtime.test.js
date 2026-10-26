import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { createApp } from './app.js';
import { attachRealtime } from './realtime.js';

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
