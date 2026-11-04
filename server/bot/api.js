import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { EMPTY_ROOM_TIMEOUT } from '../rooms/lifecycle.js';
import { clientIp, logEvent, providerLabel, roomLabel } from '../shared/log.js';

export const PROVIDER_ORDER = ['volc', 'volc2', 'agora', 'zego'];
const providerNames = { volc:'火山引擎 1', volc2:'火山引擎 2', agora:'声网', zego:'即构' };

function sameSecret(provided, expected) {
  const left = Buffer.from(provided || ''), right = Buffer.from(expected || '');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * 给 Oopz bot 等外部程序使用的接口，使用 Bearer Token 鉴权。
 * 与浏览器接口不同，这里没有 cookie 身份，房间统一归属 BOT_IDENTITY。
 */
export function attachBotRoutes(app, { env, providers, createRoomFor }) {
  const token = String(env.BOT_API_TOKEN || '').trim();
  const identity = String(env.BOT_IDENTITY || 'oopz-bot').trim() || 'oopz-bot';
  const botName = String(env.BOT_NAME || 'OopzBot').trim() || 'OopzBot';
  const router = express.Router();

  router.use((req, res, next) => {
    if (!token) return res.status(503).json({ error: 'bot 接口未启用：服务端未配置 BOT_API_TOKEN。' });
    // X-Bot-Token 让 Authorization 留给反向代理的 Basic Auth。
    const header = req.get('authorization') || '';
    const provided = (req.get('x-bot-token') || header.replace(/^Bearer\s+/i, '')).trim();
    if (!sameSecret(provided, token)) return res.status(401).json({ error: 'bot 鉴权失败。' });
    next();
  });

  const originOf = req => (env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const roomView = (req, room) => {
    const participants = app.locals.participants(room.id);
    return {
      id: room.id, name: room.name, description: room.description,
      provider: room.provider || 'agora', providerLabel: providerNames[room.provider] || room.provider,
      initiator: room.initiator || null,
      createdAt: room.createdAt, updatedAt: room.updatedAt,
      onlineCount: participants.length, sharingCount: participants.filter(p => p.sharing).length,
      participants, webUrl: `${originOf(req)}/#room=${room.id}`,
      closesAt: room.emptySince === null ? null : room.emptySince + EMPTY_ROOM_TIMEOUT,
    };
  };
  const providersView = quota => PROVIDER_ORDER.map(name => ({
    name, label: providerNames[name], available: !!providers[name],
    status: quota?.[name]?.status || 'unavailable',
    remaining: typeof quota?.[name]?.remaining === 'number' ? quota[name].remaining : null,
    unit: quota?.[name]?.unit || null,
  }));
  const notFound = (req, res) => res.status(404).json({
    error: app.locals.store.getAny(req.params.id)?.closeReason || '房间不存在或已关闭。',
  });

  router.get('/status', async (_req, res) => {
    const quota = await app.locals.monitor.check();
    const rooms = app.locals.store.all();
    res.json({
      configured: Object.values(providers).some(Boolean),
      providers: providersView(quota),
      rooms: { total: rooms.length, active: rooms.filter(room => app.locals.participants(room.id).length > 0).length },
      quota,
    });
  });

  router.get('/rooms', (req, res) => {
    app.locals.lifecycle.sweep();
    const activeOnly = req.query.active === '1' || req.query.active === 'true';
    const sharingOnly = req.query.sharing === '1' || req.query.sharing === 'true';
    const initiator = String(req.query.initiator || '').trim();
    const rooms = app.locals.store.all()
      .filter(room => !initiator || room.initiator === initiator)
      .map(room => roomView(req, room))
      .filter(room => (!activeOnly || room.onlineCount > 0) && (!sharingOnly || room.sharingCount > 0))
      // 有人和正在共享的房间排在前面，同组内按创建时间倒序。
      .sort((left, right) => (right.onlineCount > 0) - (left.onlineCount > 0)
        || (right.sharingCount > 0) - (left.sharingCount > 0)
        || right.createdAt - left.createdAt);
    res.json({ rooms, total: rooms.length });
  });

  router.get('/rooms/:id', (req, res) => {
    app.locals.lifecycle.sweep();
    const room = app.locals.store.get(req.params.id);
    if (!room) return notFound(req, res);
    res.json({ room: roomView(req, room) });
  });

  router.post('/rooms', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const initiator = String(body.initiatorId || body.initiator_id || '').trim();
    if (initiator) {
      app.locals.lifecycle.sweep();
      const existing = app.locals.store.findByInitiator(initiator);
      if (existing) return res.json({ room: roomView(req, existing), reused: true });
    }
    const result = await createRoomFor(identity, body, { defaultName: botName, minVersion: null, requireProvider: true, initiator });
    if (!result.room) return res.status(result.status).json({ error: result.error, ...(result.providers ? { providers: result.providers } : {}) });
    logEvent('bot 创建房间', { ip:clientIp(req), room:roomLabel(result.room), name:result.room.name, provider:providerLabel(result.room.provider) });
    res.status(201).json({ room: roomView(req, app.locals.store.get(result.room.id)), reused: false });
  });

  // Oopz bot 没有 RTC 能力，进入房间即返回可交给用户打开的邀请链接。
  router.post('/rooms/:id/enter', (req, res) => {
    app.locals.lifecycle.sweep();
    const room = app.locals.store.get(req.params.id);
    if (!room) return notFound(req, res);
    if (!providers[room.provider || 'agora']) return res.status(503).json({ error: '该房间的 RTC 服务商凭据尚未配置。' });
    res.json({ room: roomView(req, room) });
  });

  router.delete('/rooms/:id', (req, res) => {
    const room = app.locals.store.get(req.params.id);
    if (!room) return notFound(req, res);
    const initiator = String(req.query.initiatorId || '').trim();
    // 旧房间没有 initiator，视为无主房间，允许 bot 代管清理。
    if (room.initiator && room.initiator !== initiator) {
      return res.status(403).json({ error: '只有房间创建者可以关闭这个房间。' });
    }
    app.locals.store.archive(room.id, 'bot 关闭');
    for (const [key, session] of app.locals.sessions) if (session.roomId === room.id) app.locals.sessions.delete(key);
    app.locals.notifyRoom(room.id);
    logEvent('bot 关闭房间', { ip:clientIp(req), room:roomLabel(room) });
    res.json({ ok: true });
  });

  app.use('/api/bot', router);
}
