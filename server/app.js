import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes, randomInt } from 'node:crypto';
import { RoomStore } from './rooms/store.js';
import { RoomLifecycle, PRESENCE_LIFETIME, EMPTY_ROOM_TIMEOUT } from './rooms/lifecycle.js';
import { usernameError } from './rooms/username.js';
import { createUsageService } from './quota/usage.js';
import { agoraToken } from './providers/agora/token.js';
import { zegoToken } from './providers/zego/token.js';
import { volcToken } from './providers/volc/token.js';
import { QuotaMonitor, normalizeMedia, QUOTA_RESERVE_MINUTES } from './quota/monitor.js';
import { clientIp, logEvent, providerLabel, roomLabel } from './shared/log.js';

const secret = () => randomBytes(24).toString('base64url');
const hour = 3600;
// A bounded media token limits the lifetime of credentials already issued when a room closes.
// Ten minutes keeps routine renewals infrequent while still expiring soon after a room closes.
const rtcTokenLifetime = 600;
function roomFields(body, defaultName = '') {
  if (body?.name !== undefined && typeof body.name !== 'string') return null;
  const name = (body?.name?.trim() || defaultName);
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  if (!name || name.length > 40 || description.length > 160) return null;
  return { name, description };
}
export function createApp(env = process.env, store = new RoomStore(), options = {}) {
  const app = express();
  const sessions = new Map();
  app.locals.store = store;
  store.resetPresence(PRESENCE_LIFETIME);
  const lifecycle = new RoomLifecycle(store, sessions);
  lifecycle.sweep();
  const sweepTimer = setInterval(() => { monitor.account(); lifecycle.sweep(); }, 5000);
  sweepTimer.unref();
  app.locals.sweep = () => { monitor.account(); lifecycle.sweep(); };
  app.locals.close = () => { clearInterval(sweepTimer); clearInterval(quotaTimer); monitor.account(); store.close(); };
  app.locals.sessions = sessions;
  app.locals.lifecycle = lifecycle;
  app.locals.notifyRoom = () => {};
  const configured = /^[a-f\d]{32}$/i.test(env.AGORA_APP_ID || '') && /^[a-f\d]{32}$/i.test(env.AGORA_APP_CERTIFICATE || '');
  const zegoId = Number(env.ZEGO_APP_ID);
  const zegoConfigured = Number.isInteger(zegoId) && zegoId > 0 && zegoId <= 0xffffffff && Buffer.byteLength(env.ZEGO_SERVER_SECRET || '') === 32;
  const volcApps = {
    volc: { appId:env.VOLC_RTC_APP_ID, appKey:env.VOLC_RTC_APP_KEY },
    volc2: { appId:env.VOLC_RTC_APP_ID_2, appKey:env.VOLC_RTC_APP_KEY_2 },
  };
  const primary = volcApps.volc, secondary = volcApps.volc2;
  const primaryValid = typeof primary.appId === 'string' && primary.appId.length === 24 && !!primary.appKey;
  const secondaryValid = typeof secondary.appId === 'string' && secondary.appId.length === 24 && !!secondary.appKey && secondary.appId !== primary.appId;
  const providers = { agora:configured, zego:zegoConfigured,
    volc:primaryValid && store.bindVolcProvider('volc', primary.appId),
    volc2:secondaryValid && store.bindVolcProvider('volc2', secondary.appId) };
  const usage = options.usageService || createUsageService(env, undefined, undefined, store, providers);
  const monitor = new QuotaMonitor(store, sessions, usage, (room, reason) => {
    store.archive(room.id, reason);
    for (const [key, session] of sessions) if (session.roomId === room.id) sessions.delete(key);
    app.locals.notifyRoom(room.id, true);
  });
  app.locals.monitor = monitor;
  const quotaTimer = setInterval(() => { void monitor.check().catch(() => {}); }, 60_000);
  quotaTimer.unref();
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
  const duplicateName = (roomId, identity, name) => {
    const lower = name.toLocaleLowerCase();
    return lifecycle.active(roomId).some(s => s.userId !== identity && s.name.toLocaleLowerCase() === lower);
  };
  const publicRoom = (room, identity) => ({ id: room.id, name: room.name, description: room.description,
    createdAt: room.createdAt, updatedAt: room.updatedAt, inviteKey: room.inviteKey, provider: room.provider,
    isOwner: room.ownerId === identity, onlineCount: participants(room.id).length,
    closesAt: room.emptySince === null ? null : room.emptySince + EMPTY_ROOM_TIMEOUT });
  app.locals.participants = participants;
  app.locals.publicRoom = publicRoom;
  function access(req, res, next) {
    lifecycle.sweep();
    const room = store.get(req.params.id);
    if (!room) return res.status(404).json({ error: store.getAny(req.params.id)?.closeReason || '房间已关闭，可能已连续空置 15 分钟。' });
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
  app.get('/api/config', (_req, res) => res.json({ configured:Object.values(providers).some(Boolean), realtime:true, providers }));
  app.get('/api/service-status', async (_req, res) => res.json(await monitor.check()));
  app.get('/api/profile', (req, res) => res.json({ name: store.profile(req.identity)?.name || null }));
  app.post('/api/profile', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const invalid = usernameError(name);
    if (invalid) return res.status(400).json({ error: invalid });
    for (const session of sessions.values()) {
      if (session.userId === req.identity && duplicateName(session.roomId, req.identity, name)) {
        return res.status(409).json({ error: `房间内已有用户名为「${name}」的成员，请换一个。` });
      }
    }
    store.setProfile(req.identity, name);
    for (const session of sessions.values()) if (session.userId === req.identity) session.name = name;
    res.json({ name });
  });
  app.use('/api/rooms', (req, res, next) => {
    monitor.account();
    req.profile = store.profile(req.identity);
    if (!req.profile) return res.status(401).json({ error: '请先输入用户名，再选择房间。' });
    next();
  });
  app.get('/api/rooms', (req, res) => {
    lifecycle.sweep();
    res.json({ rooms: store.all().map(room => publicRoom(room, req.identity)) });
  });
  app.get('/api/rooms/:id', access, (req, res) => res.json(publicRoom(req.room, req.identity)));
  app.post('/api/rooms', async (req, res) => {
    const provider = req.body?.provider ?? 'agora';
    if (!Object.hasOwn(providers, provider)) return res.status(400).json({ error: '不支持的 RTC 服务商。' });
    if (!providers[provider]) return res.status(503).json({ error: '所选 RTC 服务商的服务端凭据尚未配置，或应用 ID 与已有用量记录不匹配。' });
    const fields = roomFields(req.body, req.profile.name);
    if (!fields) return res.status(400).json({ error: '房间名称最多 40 字，描述最多 160 字。' });
    const status = await monitor.check();
    const remaining = status[provider];
    if (remaining?.status === 'ok' && typeof remaining.remaining === 'number' && Number.isFinite(remaining.remaining) && remaining.remaining <= QUOTA_RESERVE_MINUTES) {
      return res.status(403).json({ error: '所选服务商剩余时长已达到 500 分钟保护线，请选择其他服务商。' });
    }
    lifecycle.sweep();
    if (store.count(req.identity) >= 50) return res.status(429).json({ error: '创建的房间太多，请关闭不用的房间。' });
    const now = Date.now();
    const room = { id: randomBytes(6).toString('hex'), ownerId: req.identity, inviteKey: secret(), provider, ...fields, createdAt: now, updatedAt: now };
    store.create(room);
    logEvent('创建房间', { ip:clientIp(req), room:roomLabel(room), name:room.name, provider:providerLabel(provider) });
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
    app.locals.notifyRoom(req.room.id);
    res.json({ ok: true });
  });
  app.post('/api/rooms/:id/save', access, (req, res) => {
    store.save(req.room.id, req.identity);
    res.json(publicRoom(req.room, req.identity));
  });
  app.post('/api/rooms/:id/token', access, async (req, res) => {
    if (!providers[req.room.provider || 'agora']) return res.status(503).json({ error: '该房间的服务端 RTC 凭据尚未配置，或应用 ID 与已有用量记录不匹配。' });
    const status = await monitor.check();
    if (status[req.room.provider || 'agora']?.remaining <= QUOTA_RESERVE_MINUTES || !store.get(req.room.id)) return res.status(403).json({ error: '服务商预计可用时长已达到 500 分钟保护线，房间已关闭。' });
    let session = req.body?.sessionKey && sessions.get(req.body.sessionKey);
    if (req.body?.sessionKey && (!session || session.roomId !== req.room.id || session.userId !== req.identity)) return res.status(403).json({ error: '会话已失效，请重新进入房间。' });
    let joined = false;
    if (!session) {
      const invalid = usernameError(req.profile.name);
      if (invalid) return res.status(400).json({ error: invalid });
      if (duplicateName(req.room.id, req.identity, req.profile.name)) {
        return res.status(409).json({ error: `房间内已有用户名为「${req.profile.name}」的成员，请更换用户名后再进入。` });
      }
      if ([...sessions.values()].filter(s => s.roomId === req.room.id).length >= 100) return res.status(429).json({ error: '房间会话已达上限，请稍后再试。' });
      const used = new Set([...sessions.values()].filter(s => s.roomId === req.room.id).map(s => s.uid));
      let uid;
      do { uid = randomInt(1, 2147483647); } while (used.has(uid));
      session = { uid, roomId: req.room.id, userId: req.identity, key: secret(), lastSeen: Date.now(), sharing: false, isOwner: req.room.ownerId === req.identity };
      sessions.set(session.key, session);
      joined = true;
    }
    session.name = req.profile.name;
    session.expiresAt = Date.now() + hour * 1000;
    store.occupied(req.room.id, Date.now());
    store.save(req.room.id, req.identity);
    if (joined) logEvent('加入房间', { ip:clientIp(req), room:roomLabel(req.room), name:session.name, provider:providerLabel(req.room.provider) });
    // Every invited member can publish and subscribe, including when co-host authentication is enabled.
    const volcApp = volcApps[req.room.provider];
    const token = req.room.provider === 'zego' ? zegoToken(zegoId, env.ZEGO_SERVER_SECRET, String(session.uid), req.room.id, rtcTokenLifetime) : volcApp ? volcToken(volcApp.appId, volcApp.appKey, req.room.id, String(session.uid), rtcTokenLifetime) :
      agoraToken(env.AGORA_APP_ID, env.AGORA_APP_CERTIFICATE, req.room.id, session.uid, rtcTokenLifetime);
    res.json({ appId: req.room.provider === 'zego' ? zegoId : volcApp ? volcApp.appId : env.AGORA_APP_ID, provider: req.room.provider, token, uid: session.uid, sessionKey: session.key,
      expiresAt: session.expiresAt, room: publicRoom(store.get(req.room.id), req.identity), displayName: session.name });
    app.locals.notifyRoom(req.room.id);
  });
  app.post('/api/rooms/:id/presence', access, ownSession, (req, res) => {
    if (req.session.expiresAt <= Date.now()) return res.status(403).json({ error: 'Token 已到期，请重新进入房间。' });
    req.session.lastSeen = Date.now();
    const sharing = req.body.sharing === true;
    if (sharing !== req.session.sharing) logEvent(sharing ? '开始共享' : '结束共享',
      { ip:clientIp(req), room:roomLabel(req.room), name:req.session.name, provider:providerLabel(req.room.provider) });
    req.session.sharing = sharing;
    if (req.body.media && typeof req.body.media === 'object') req.session.media = normalizeMedia(req.body.media);
    store.occupied(req.room.id, Date.now());
    app.locals.notifyRoom(req.room.id);
    res.json({ participants: participants(req.room.id), room: publicRoom(store.get(req.room.id), req.identity), quotaHealthy:monitor.healthy() });
  });
  app.post('/api/rooms/:id/leave', access, ownSession, (req, res) => {
    lifecycle.leave(req.session.key);
    logEvent('退出房间', { ip:clientIp(req), room:roomLabel(req.room), name:req.session.name, provider:providerLabel(req.room.provider) });
    app.locals.notifyRoom(req.room.id);
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((err, _req, res, _next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? '服务暂时不可用，请稍后再试。' : '请求格式不正确' });
  });
  return app;
}
