import { chinaMonth } from '../shared/usage.js';
import { agoraUsage } from '../providers/agora/usage.js';
import { volcUsage } from '../providers/volc/usage.js';
import { createZegoUsage } from '../providers/zego/usage.js';

export function createUsageService(env, fetcher = fetch, now = Date.now) {
  const seconds = Number(env.RTC_USAGE_CACHE_SECONDS);
  const cacheMs = Number.isInteger(seconds) && seconds >= 1 && seconds <= 86400 ? seconds * 1000 : 300_000;
  const zegoUsage = createZegoUsage(env, fetcher, now);
  let cached, expires = 0, pending, cachedMonth;
  return async function usage() {
    const current = now();
    const month = chinaMonth(new Date(current)).from;
    if (cached && current < expires && cachedMonth === month) return cached;
    if (pending) return pending.then(() => usage());
    const safe = async task => { try { return await task(); } catch { return { status: 'error' }; } };
    pending = Promise.all([safe(() => agoraUsage(env, fetcher, new Date(current))), safe(() => volcUsage(env, fetcher, new Date(current))), safe(zegoUsage)]).then(([agora, volc, zego]) => {
      const updated = now();
      cachedMonth = month;
      expires = updated + cacheMs;
      cached = { agora, volc, zego, updatedAt: new Date(updated).toISOString(), cacheSeconds: cacheMs / 1000 };
      return cached;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
