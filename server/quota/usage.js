import { chinaMonth } from '../shared/usage.js';
import { agoraUsage } from '../providers/agora/usage.js';
import { volcRtcUsage } from '../providers/volc/usage.js';
import { createZegoUsage } from '../providers/zego/usage.js';

export function createUsageService(env, fetcher = fetch, now = Date.now, store, providers) {
  const seconds = Number(env.RTC_USAGE_CACHE_SECONDS);
  const cacheMs = Number.isInteger(seconds) && seconds >= 1 && seconds <= 86400 ? seconds * 1000 : 300_000;
  const zegoUsage = createZegoUsage(env, fetcher, now);
  let cached, expires = 0, pending, cachedMonth, lastVolcRequest = 0;
  let volcQueue = Promise.resolve();
  const queryVolc = (slot, current) => {
    const appId = slot === 'volc' ? env.VOLC_RTC_APP_ID : env.VOLC_RTC_APP_ID_2;
    if (!appId || (providers && !providers[slot])) return Promise.resolve({status:'unconfigured'});
    const task = volcQueue.then(async () => {
      const wait = Math.max(0, 600 - (Date.now() - lastVolcRequest));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      lastVolcRequest = Date.now();
      return volcRtcUsage({...env, VOLC_RTC_APP_ID:appId}, fetcher, new Date(current), store);
    });
    volcQueue = task.catch(() => {});
    return task;
  };
  return async function usage() {
    const current = now();
    const month = chinaMonth(new Date(current)).from;
    if (cached && current < expires && cachedMonth === month) return cached;
    if (pending) return pending.then(() => usage());
    const safe = async task => { try { return await task(); } catch { return { status: 'error' }; } };
    pending = Promise.all([safe(() => agoraUsage(env, fetcher, new Date(current))), safe(() => queryVolc('volc', current)), safe(() => queryVolc('volc2', current)), safe(zegoUsage)]).then(([agora, volc, volc2, zego]) => {
      const updated = now();
      cachedMonth = month;
      expires = updated + cacheMs;
      cached = { agora, volc, volc2, zego, updatedAt: new Date(updated).toISOString(), cacheSeconds: cacheMs / 1000 };
      return cached;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
