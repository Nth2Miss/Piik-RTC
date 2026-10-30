import { PRESENCE_LIFETIME } from '../rooms/lifecycle.js';

const names = { agora:'声网', volc:'火山引擎 1', volc2:'火山引擎 2', zego:'即构' };
export const QUOTA_RESERVE_MINUTES = 500;
const monthOf = time => new Date(time + 8 * 3600_000).toISOString().slice(0, 7);
function nextMonth(time) {
  const [year, month] = monthOf(time).split('-').map(Number);
  return Date.UTC(year, month, 1) - 8 * 3600_000;
}
export function normalizeMedia(media) {
  const size = value => Number.isFinite(value) && value > 0 && value <= 16384 ? Math.ceil(value) : 0;
  return { connected:media.connected === true,
    selected:Number.isSafeInteger(media.selected) && media.selected > 0 ? media.selected : undefined,
    width:size(media.width), height:size(media.height), publishWidth:size(media.publishWidth), publishHeight:size(media.publishHeight),
    ...(Array.isArray(media.pulls) ? { pulls:media.pulls.slice(0, 100).filter(p => p && Number.isSafeInteger(p.uid) && p.uid > 0 && (p.kind === 'audio' || p.kind === 'video'))
      .map(p => ({ uid:p.uid, kind:p.kind, width:size(p.width), height:size(p.height) })) } : {}) };
}

// Each connected user consumes audio time unless receiving a remote video.
export function rateFor(provider, pixels) {
  // The free veRTC resource package deducts one minute per audio or video minute.
  if (provider === 'volc' || provider === 'volc2') return 1;
  if (!pixels) return 1;
  if (provider === 'zego') {
    if (pixels <= 640 * 360) return 1.7;
    if (pixels <= 1280 * 720) return 3.6;
    if (pixels <= 1920 * 1080) return 14;
    // These are price-equivalent estimates, not verified free-package deductions.
    return pixels <= 2560 * 1440 ? 16 : 36;
  }
  const limits = provider === 'volc' ? [1600 * 720, 2400 * 1080, 3200 * 1440] : [1280 * 720, 1920 * 1080, 2560 * 1440];
  const rates = [4, 9, 16, 36];
  const index = limits.findIndex(limit => pixels <= limit);
  return rates[index < 0 ? 3 : index];
}

export class QuotaMonitor {
  constructor(store, sessions, usage, closeRoom, now = Date.now) {
    this.store = store; this.sessions = sessions; this.usage = usage; this.closeRoom = closeRoom; this.now = now;
    this.last = now(); this.pending = undefined; this.lastSuccessfulCheck = 0;
  }
  healthy(at = this.now()) { return this.lastSuccessfulCheck > 0 && at - this.lastSuccessfulCheck <= 90000; }
  account(at = this.now()) {
    const from = this.last;
    if (at <= from) return;
    const rooms = new Map(this.store.all().map(room => [room.id, room]));
    const members = new Map(), sharers = new Map();
    const entries = [];
    for (const session of this.sessions.values()) {
      if (!members.has(session.roomId)) members.set(session.roomId, new Map());
      members.get(session.roomId).set(session.uid, session);
      if (session.sharing) sharers.set(session.roomId, (sharers.get(session.roomId) || 0) + 1);
    }
    for (const session of this.sessions.values()) {
      const room = rooms.get(session.roomId);
      if (!room || session.media?.connected === false) continue;
      const end = Math.min(at, session.expiresAt || at, (session.lastSeen || from) + PRESENCE_LIFETIME);
      let start = Math.max(from, session.mediaSince || from);
      if (end <= start) continue;
      const media = session.media;
      const provider = room.provider || 'agora';
      let pixels = 0;
      if (media?.selected && media.selected !== session.uid) {
        const other = members.get(session.roomId)?.get(media.selected);
        const width = Math.max(media.width || 0, other?.media?.publishWidth || 0);
        const height = Math.max(media.height || 0, other?.media?.publishHeight || 0);
        pixels = width && height ? width * height : 2560 * 1440;
      } else if (!media && (sharers.get(session.roomId) || 0) > (session.sharing ? 1 : 0)) {
        // Older clients do not report media state; choose a conservative tier.
        pixels = 2560 * 1440;
      }
      let rates = [rateFor(provider, pixels)];
      if (provider === 'zego' && Array.isArray(media?.pulls)) {
        rates = media.pulls.filter(pull => pull.uid !== session.uid).map(pull => {
          if (pull.kind === 'audio') return 1;
          const other = members.get(session.roomId)?.get(pull.uid);
          const width = pull.width || other?.media?.publishWidth || 0;
          const height = pull.height || other?.media?.publishHeight || 0;
          return rateFor(provider, width && height ? width * height : 2560 * 1440);
        });
      }
      if (!rates.length) continue;
      while (start < end) {
        const stop = Math.min(end, nextMonth(start));
        for (const rate of rates) {
          const month = monthOf(start), milliseconds = stop - start;
          entries.push({ provider, month, roomId:room.id, amount:milliseconds / 60000 * rate,
            ...(provider === 'zego' ? { zegoRate:rate, milliseconds } : {}) });
        }
        start = stop;
      }
    }
    this.store.addUsageBatch(entries);
    this.last = at;
  }
  project(raw, at = this.now()) {
    this.account(at);
    const month = monthOf(at), output = { ...raw };
    for (const provider of ['agora', 'zego', 'volc', 'volc2']) {
      let q = this.store.quota(provider, month);
      // RTC usage is an app-level estimate, so never reuse old billing-package anchors.
      const isVolc = provider === 'volc' || provider === 'volc2';
      const anchorKey = isVolc ? `${provider}-usage` : provider;
      let anchor = isVolc ? this.store.quota(anchorKey, month) : q;
      const upstream = raw[provider];
      // Reserve a full minute for each partially used ZEGO tier across the billing month.
      const estimated = provider === 'zego'
        ? Math.round((q.estimated + this.store.zegoRoundingReserve(month)) * 1e9) / 1e9
        : q.estimated;
      if (upstream?.status === 'ok' && Number.isFinite(upstream.remaining) && anchor.anchor_remaining === null) {
        this.store.setQuotaAnchor(anchorKey, month, upstream.remaining, estimated);
        anchor = this.store.quota(anchorKey, month);
      }
      if (provider === 'agora' && anchor.anchor_remaining === null) {
        output[provider] = { ...upstream, status:upstream?.status || 'unavailable', supplier:upstream || {status:'unavailable'}, localUsed:q.estimated, basis:'等待供应商余量' };
        continue;
      }
      let remaining = Math.max(0, anchor.anchor_remaining === null ? 10000 - estimated : anchor.anchor_remaining - Math.max(0, estimated - anchor.anchor_estimated));
      if (upstream?.status === 'ok' && Number.isFinite(upstream.remaining)) remaining = Math.max(0, Math.min(remaining, upstream.remaining));
      if (provider === 'zego' || isVolc) remaining = Math.min(remaining, Math.max(0, 10000 - estimated));
      output[provider] = { ...upstream, status:'ok', total:upstream?.total ?? 10000, remaining, unit:upstream?.unit || '标准分钟', estimated:true, localUsed:estimated,
        supplier:upstream || {status:'unavailable'},
        basis:anchor.anchor_remaining !== null ? (provider === 'zego' ? '控制台余量与本地估算' : '供应商用量推算与本地估算') : '本地估算' };
    }
    return output;
  }
  async snapshot() { return this.project(await this.usage()); }
  async check() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const status = await this.snapshot();
      for (const room of this.store.all()) {
        const provider = room.provider || 'agora';
        if (status[provider]?.remaining <= QUOTA_RESERVE_MINUTES) this.closeRoom(room, `${names[provider]}预计可用时长已达到 500 分钟保护线，房间已关闭。`);
      }
      this.lastSuccessfulCheck = this.now();
      return status;
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
