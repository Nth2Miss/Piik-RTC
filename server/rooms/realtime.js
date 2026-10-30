import { WebSocketServer, WebSocket } from 'ws';
import { normalizeMedia } from '../quota/monitor.js';
import { clientIp, logEvent, providerLabel, roomLabel } from '../shared/log.js';

const identityPattern = /^[\w-]{32}$/;
const cookieIdentity = header => header?.split(';').map(part => part.trim())
  .find(part => part.startsWith('screen_identity='))?.slice('screen_identity='.length);

export const REALTIME_LIMITS = { maxPayload:16 * 1024, maxBuffered:256 * 1024, maxClients:1000, perIp:50, perIdentity:8, burst:30, messagesPerSecond:10 };

export function attachRealtime(server, app, env = process.env, limits = REALTIME_LIMITS) {
  const { sessions, lifecycle, store } = app.locals;
  const wss = new WebSocketServer({ noServer: true, maxPayload:limits.maxPayload });
  const clients = new Set();
  const signatures = new Map();
  let closed = false;

  const originAllowed = (origin, host) => {
    if (!origin) return true;
    if (env.PUBLIC_ORIGIN) return origin === env.PUBLIC_ORIGIN;
    try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && url.host === host; } catch { return false; }
  };
  const send = (client, payload) => {
    if (closed) return;
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > limits.maxBuffered) { client.ws.terminate(); return; }
    try { client.ws.send(JSON.stringify(payload)); } catch { /* connection closed */ }
  };
  const roomPayload = (client) => {
    if (closed) return null;
    const room = store.get(client.roomId);
    if (!room) return null;
    return { type: 'room', quotaHealthy:app.locals.monitor.healthy(), participants: app.locals.participants(client.roomId),
      room: app.locals.publicRoom(room, client.identity) };
  };
  const sendRoom = (client) => {
    if (closed || !client.roomId) return;
    const payload = roomPayload(client);
    send(client, payload || { type: 'closed', reason:store.getAny(client.roomId)?.closeReason || undefined });
  };
  const broadcast = (roomId, force = false) => {
    if (closed || !roomId) return;
    const signature = JSON.stringify(app.locals.participants(roomId));
    if (!force && signatures.get(roomId) === signature) return;
    signatures.set(roomId, signature);
    for (const client of clients) if (client.roomId === roomId) sendRoom(client);
  };
  app.locals.notifyRoom = (roomId, force = false) => broadcast(roomId, force);

  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path !== '/ws') return;
    if (closed || !originAllowed(request.headers.origin, request.headers.host)) return socket.destroy();
    const identity = cookieIdentity(request.headers.cookie), ip = clientIp(request);
    const reject = code => { socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (!identityPattern.test(identity || '') || !store.profile(identity)) return reject('401 Unauthorized');
    if (clients.size >= limits.maxClients || [...clients].filter(client => client.identity === identity).length >= limits.perIdentity
      || [...clients].filter(client => client.ip === ip).length >= limits.perIp) return reject('429 Too Many Requests');
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });

  wss.on('connection', (ws, request) => {
    const identity = cookieIdentity(request.headers.cookie);
    if (!identityPattern.test(identity || '')) return ws.close(1008, 'unauthorized');
    const client = { ws, identity, ip:clientIp(request), roomId: undefined, sessionKey: undefined, alive: true, credits:limits.burst, creditedAt:performance.now() };
    clients.add(client);

    ws.on('pong', () => { client.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => {
      clients.delete(client);
      if (client.roomId) broadcast(client.roomId, true);
      if (![...clients].some(other => other.roomId === client.roomId)) signatures.delete(client.roomId);
    });
    ws.on('message', raw => {
      const now = performance.now();
      client.credits = Math.min(limits.burst, client.credits + (now - client.creditedAt) * limits.messagesPerSecond / 1000);
      client.creditedAt = now;
      if (client.credits < 1) { ws.terminate(); return; }
      client.credits--;
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type === 'subscribe' && typeof message.roomId === 'string' && typeof message.sessionKey === 'string') {
        app.locals.monitor.account();
        const session = sessions.get(message.sessionKey);
        if (!session || session.roomId !== message.roomId || session.userId !== identity || session.expiresAt <= Date.now()) {
          const reason = store.getAny(message.roomId)?.closeReason;
          send(client, reason ? { type:'closed', reason } : { type:'expired' });
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
        app.locals.monitor.account();
        const session = sessions.get(client.sessionKey);
        if (!session || session.roomId !== client.roomId || session.userId !== identity || session.expiresAt <= Date.now()) return;
        session.lastSeen = Date.now();
        const sharing = message.sharing === true;
        if (sharing !== session.sharing) {
          const room = store.get(client.roomId);
          logEvent(sharing ? '开始共享' : '结束共享',
            { ip:client.ip, room:room ? roomLabel(room) : client.roomId, name:session.name, provider:providerLabel(room?.provider) });
        }
        session.sharing = sharing;
        if (message.media && typeof message.media === 'object') session.media = normalizeMedia(message.media);
        store.occupied(client.roomId, Date.now());
        broadcast(client.roomId);
      }
    });
  });

  // A live socket keeps its session present, so clients no longer need to poll.
  const keepAlive = setInterval(() => {
    const now = Date.now();
    app.locals.monitor.account(now);
    for (const client of clients) {
      const session = sessions.get(client.sessionKey);
      if (!session || session.userId !== client.identity || session.roomId !== client.roomId) {
        const reason = client.roomId && store.getAny(client.roomId)?.closeReason;
        send(client, reason ? { type:'closed', reason } : { type:'expired' });
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
      if (app.locals.monitor.healthy(now)) send(client, { type:'quota-lease' });
    }
    for (const roomId of new Set([...clients].map(client => client.roomId).filter(Boolean))) {
      if (!store.get(roomId)) {
        signatures.delete(roomId);
        for (const client of clients) {
          if (client.roomId !== roomId) continue;
          send(client, { type: 'closed', reason:store.getAny(roomId)?.closeReason || undefined });
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
