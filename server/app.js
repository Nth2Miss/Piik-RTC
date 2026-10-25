import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes, randomInt } from 'node:crypto';
import agora from 'agora-token';
import { RoomStore } from './room-store.js';
import { RoomLifecycle, PRESENCE_LIFETIME, EMPTY_ROOM_TIMEOUT } from './room-lifecycle.js';

const secret = () => randomBytes(24).toString('base64url');
const hour = 3600;
function roomFields(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  if (!name || name.length > 40 || description.length > 160) return null;
  return { name, description };
}
export function createApp(env = process.env, store = new RoomStore()) {
  const app = express();
  const sessions = new Map();
  app.locals.store = store;
  store.resetPresence(PRESENCE_LIFETIME);
  const lifecycle = new RoomLifecycle(store, sessions);
  lifecycle.sweep();
  const sweepTimer = setInterval(() => lifecycle.sweep(), 5000);
  sweepTimer.unref();
  app.locals.sweep = () => lifecycle.sweep();
  app.locals.close = () => { clearInterval(sweepTimer); store.close(); };
  const configured = /^[a-f\d]{32}$/i.test(env.AGORA_APP_ID || '') && /^[a-f\d]{32}$/i.test(env.AGORA_APP_CERTIFICATE || '');
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use(express.json({ limit: '4kb' }));
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET') {
      const origin = req.get('origin');
      const expected = env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
      if (origin && origin !== expected) return res.status(403).json({ error: '请求来源不受信任' });
    }
    const cookie = req.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('screen_identity='))?.slice('screen_identity='.length);
    req.identity = /^[\w-]{32}$/.test(cookie || '') ? cookie : secret();
    if (!cookie || req.identity !== cookie) {
      res.cookie('screen_identity', req.identity, { httpOnly: true, sameSite: 'lax', secure: !!env.PUBLIC_ORIGIN?.startsWith('https://'), maxAge: 365 * 24 * hour * 1000, path: '/' });
    }
    next();
  });
  const participants = id => lifecycle.active(id)
    .map(s => ({ uid: s.uid, name: s.name, sharing: s.sharing, isOwner: s.isOwner }));
  const publicRoom = (room, identity) => ({ id: room.id, name: room.name, description: room.description,
    createdAt: room.createdAt, updatedAt: room.updatedAt, inviteKey: room.inviteKey,
    isOwner: room.ownerId === identity, onlineCount: participants(room.id).length,
    closesAt: room.emptySince === null ? null : room.emptySince + EMPTY_ROOM_TIMEOUT });
  function access(req, res, next) {
    lifecycle.sweep();
    const room = store.get(req.params.id);
    if (!room) return res.status(404).json({ error: '房间已关闭，可能已连续空置 15 分钟。' });
    req.room = room;
    next();
  }
  function ownSession(req, res, next) {
    const session = sessions.get(req.body?.sessionKey);
    if (!session || session.roomId !== req.room.id || session.userId !== req.identity || session.expiresAt + 300_000 < Date.now()) {
      return res.status(403).json({ error: '会话已失效，请重新进入房间。' });
    }
    req.session = session;
    next();
  }
  app.get('/api/config', (_req, res) => res.json({ configured }));
  app.get('/api/profile', (req, res) => res.json({ name: store.profile(req.identity)?.name || null }));
  app.post('/api/profile', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 24) return res.status(400).json({ error: '请输入 1–24 字的用户名。' });
    store.setProfile(req.identity, name);
    for (const session of sessions.values()) if (session.userId === req.identity) session.name = name;
    res.json({ name });
  });
  app.use('/api/rooms', (req, res, next) => {
    req.profile = store.profile(req.identity);
    if (!req.profile) return res.status(401).json({ error: '请先输入用户名，再选择房间。' });
    next();
  });
  app.get('/api/rooms', (req, res) => {
    lifecycle.sweep();
    res.json({ rooms: store.all().map(room => publicRoom(room, req.identity)) });
  });
  app.get('/api/rooms/:id', access, (req, res) => res.json(publicRoom(req.room, req.identity)));
  app.post('/api/rooms', (req, res) => {
    if (!configured) return res.status(503).json({ error: '请先在服务端 .env 配置 App ID 和 App Certificate，并重启服务。' });
    const fields = roomFields(req.body);
    if (!fields) return res.status(400).json({ error: '房间名称需为 1–40 字，描述最多 160 字。' });
    lifecycle.sweep();
    if (store.count(req.identity) >= 50) return res.status(429).json({ error: '创建的房间太多，请关闭不用的房间。' });
    const now = Date.now();
    const room = { id: randomBytes(6).toString('hex'), ownerId: req.identity, inviteKey: secret(), ...fields, createdAt: now, updatedAt: now };
    store.create(room);
    res.status(201).json(publicRoom(store.get(room.id), req.identity));
  });
  app.patch('/api/rooms/:id', access, (req, res) => {
    if (req.room.ownerId !== req.identity) return res.status(403).json({ error: '只有房主可以修改房间。' });
    const fields = roomFields(req.body);
    if (!fields) return res.status(400).json({ error: '请填写有效房间名称和描述。' });
    store.update(req.room.id, fields.name, fields.description);
    res.json(publicRoom(store.get(req.room.id), req.identity));
  });
  app.delete('/api/rooms/:id', access, (req, res) => {
    if (req.room.ownerId !== req.identity) return res.status(403).json({ error: '只有创建者可以关闭房间。' });
    store.archive(req.room.id);
    for (const [key, s] of sessions) if (s.roomId === req.room.id) sessions.delete(key);
    res.json({ ok: true });
  });
  app.post('/api/rooms/:id/save', access, (req, res) => {
    store.save(req.room.id, req.identity);
    res.json(publicRoom(req.room, req.identity));
  });
  app.post('/api/rooms/:id/token', access, (req, res) => {
    if (!configured) return res.status(503).json({ error: '服务端声网凭据尚未配置。' });
    let session = req.body?.sessionKey && sessions.get(req.body.sessionKey);
    if (req.body?.sessionKey && (!session || session.roomId !== req.room.id || session.userId !== req.identity)) return res.status(403).json({ error: '会话已失效，请重新进入房间。' });
    if (!session) {
      if ([...sessions.values()].filter(s => s.roomId === req.room.id).length >= 100) return res.status(429).json({ error: '房间会话已达上限，请稍后再试。' });
      const used = new Set([...sessions.values()].filter(s => s.roomId === req.room.id).map(s => s.uid));
      let uid;
      do { uid = randomInt(1, 2147483647); } while (used.has(uid));
      session = { uid, roomId: req.room.id, userId: req.identity, key: secret(), lastSeen: Date.now(), sharing: false, isOwner: req.room.ownerId === req.identity };
      sessions.set(session.key, session);
    }
    session.name = req.profile.name;
    session.expiresAt = Date.now() + hour * 1000;
    store.occupied(req.room.id, Date.now());
    store.save(req.room.id, req.identity);
    // Every invited member can publish and subscribe, including when co-host authentication is enabled.
    const token = agora.RtcTokenBuilder.buildTokenWithUid(env.AGORA_APP_ID, env.AGORA_APP_CERTIFICATE, req.room.id,
      session.uid, agora.RtcRole.PUBLISHER, hour, hour);
    res.json({ appId: env.AGORA_APP_ID, token, uid: session.uid, sessionKey: session.key,
      expiresAt: session.expiresAt, room: publicRoom(store.get(req.room.id), req.identity), displayName: session.name });
  });
  app.post('/api/rooms/:id/presence', access, ownSession, (req, res) => {
    if (req.session.expiresAt <= Date.now()) return res.status(403).json({ error: 'Token 已到期，请重新进入房间。' });
    req.session.lastSeen = Date.now();
    req.session.sharing = req.body.sharing === true;
    store.occupied(req.room.id, Date.now());
    res.json({ participants: participants(req.room.id), room: publicRoom(store.get(req.room.id), req.identity) });
  });
  app.post('/api/rooms/:id/leave', access, ownSession, (req, res) => {
    lifecycle.leave(req.session.key);
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((err, _req, res, _next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? '服务暂时不可用，请稍后再试。' : '请求格式不正确' });
  });
  return app;
}
