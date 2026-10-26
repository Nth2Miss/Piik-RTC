import { WebSocketServer, WebSocket } from 'ws';

const identityPattern = /^[\w-]{32}$/;
const cookieIdentity = header => header?.split(';').map(part => part.trim())
  .find(part => part.startsWith('screen_identity='))?.slice('screen_identity='.length);

export function attachRealtime(server, app, env = process.env) {
  const { sessions, lifecycle, store } = app.locals;
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();
  const signatures = new Map();
  let closed = false;

  const originAllowed = origin => !origin || !env.PUBLIC_ORIGIN || origin === env.PUBLIC_ORIGIN;
  const send = (client, payload) => {
    if (closed) return;
    try { client.ws.send(JSON.stringify(payload)); } catch { /* connection closed */ }
  };
  const roomPayload = (client) => {
    if (closed) return null;
    const room = store.get(client.roomId);
    if (!room) return null;
    return { type: 'room', participants: app.locals.participants(client.roomId),
      room: app.locals.publicRoom(room, client.identity) };
  };
  const sendRoom = (client) => {
    if (closed || !client.roomId) return;
    const payload = roomPayload(client);
    send(client, payload || { type: 'closed' });
  };
  const broadcast = (roomId, force = false) => {
    if (closed || !roomId) return;
    const signature = JSON.stringify(app.locals.participants(roomId));
    if (!force && signatures.get(roomId) === signature) return;
    signatures.set(roomId, signature);
    for (const client of clients) if (client.roomId === roomId) sendRoom(client);
  };
  app.locals.notifyRoom = roomId => broadcast(roomId);

  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path !== '/ws') return;
    if (!originAllowed(request.headers.origin)) return socket.destroy();
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });

  wss.on('connection', (ws, request) => {
    const identity = cookieIdentity(request.headers.cookie);
    if (!identityPattern.test(identity || '')) return ws.close(1008, 'unauthorized');
    const client = { ws, identity, roomId: undefined, sessionKey: undefined, alive: true };
    clients.add(client);

    ws.on('pong', () => { client.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => {
      clients.delete(client);
      if (client.roomId) broadcast(client.roomId, true);
    });
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type === 'subscribe' && typeof message.roomId === 'string' && typeof message.sessionKey === 'string') {
        const session = sessions.get(message.sessionKey);
        if (!session || session.roomId !== message.roomId || session.userId !== identity || session.expiresAt <= Date.now()) {
          send(client, { type: 'expired' });
          return;
        }
        client.roomId = message.roomId;
        client.sessionKey = message.sessionKey;
        session.lastSeen = Date.now();
        store.occupied(client.roomId, Date.now());
        signatures.delete(client.roomId);
        sendRoom(client);
        broadcast(client.roomId, true);
        return;
      }
      if (message?.type === 'presence' && client.roomId) {
        const session = sessions.get(client.sessionKey);
        if (!session || session.roomId !== client.roomId || session.userId !== identity) return;
        session.lastSeen = Date.now();
        session.sharing = message.sharing === true;
        store.occupied(client.roomId, Date.now());
        broadcast(client.roomId);
      }
    });
  });

  // A live socket keeps its session present, so clients no longer need to poll.
  const keepAlive = setInterval(() => {
    const now = Date.now();
    for (const client of clients) {
      const session = sessions.get(client.sessionKey);
      if (!session || session.userId !== client.identity || session.roomId !== client.roomId) {
        send(client, { type: 'expired' });
        client.roomId = undefined; client.sessionKey = undefined;
        continue;
      }
      if (session.expiresAt <= now) {
        send(client, { type: 'expired' });
        client.roomId = undefined; client.sessionKey = undefined;
        continue;
      }
      session.lastSeen = now;
      store.occupied(client.roomId, now);
    }
    for (const roomId of new Set([...clients].map(client => client.roomId).filter(Boolean))) {
      if (!store.get(roomId)) {
        signatures.delete(roomId);
        for (const client of clients) {
          if (client.roomId !== roomId) continue;
          send(client, { type: 'closed' });
          client.roomId = undefined; client.sessionKey = undefined;
        }
      } else {
        broadcast(roomId);
      }
    }
  }, 10_000);
  keepAlive.unref();

  const ping = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) { client.ws.terminate(); continue; }
      client.alive = false;
      try { client.ws.ping(); } catch { /* already closed */ }
    }
  }, 30_000);
  ping.unref();

  return {
    close() {
      closed = true;
      clearInterval(keepAlive); clearInterval(ping);
      for (const client of clients) client.ws.close();
      clients.clear();
      wss.close();
    },
  };
}
