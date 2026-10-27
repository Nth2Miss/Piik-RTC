import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const headers = { 'Content-Type':'application/json', Accept:'application/json', Origin:'https://console.zego.im', Referer:'https://console.zego.im/' };

function mergeCookies(cookie, values) {
  const jar = new Map(cookie.split(';').map(s => s.trim()).filter(s => s.includes('=')).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
  for (const value of values) {
    const first = value.split(';')[0], i = first.indexOf('=');
    if (i < 1) continue;
    const name = first.slice(0, i).trim(), token = first.slice(i + 1).trim();
    if (!token || /expires=Thu, 01 Jan 1970/i.test(value)) jar.delete(name); else jar.set(name, token);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function createZegoUsage(env, fetcher = fetch, now = Date.now) {
  const path = env.ZEGO_COOKIE_FILE;
  let lastRefresh = 0, expiredCookie;
  return async () => {
    if (!path) return {status:'unconfigured'};
    let cookie;
    try { cookie = (await readFile(path, 'utf8')).trim(); }
    catch (error) { if (error.code === 'ENOENT') return {status:'unconfigured'}; throw error; }
    if (!cookie || /[\r\n]/.test(cookie)) return {status:'unconfigured'};
    const request = async (url, options) => {
      const res = await fetcher(url, { ...options, headers:{...headers, ...options.headers, Cookie:cookie}, signal:AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('即构查询失败');
      const result = await res.json();
      const updates = res.headers?.getSetCookie?.() || [];
      if (updates.length) {
        const merged = mergeCookies(cookie, updates);
        if (merged !== cookie) {
          const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
          try { await writeFile(temp, merged, {mode:0o600, flag:'wx'}); await rename(temp, path); }
          catch (error) { await unlink(temp).catch(() => {}); throw new Error('即构登录态保存失败', {cause:error}); }
          cookie = merged;
        }
      }
      return result;
    };
    // A replaced cookie can be retried after the next cached query, without exposing it.
    if (expiredCookie === cookie) return {status:'auth_expired'};
    if (expiredCookie) { expiredCookie = undefined; lastRefresh = 0; }
    if (!lastRefresh || now() - lastRefresh >= 15 * 60_000) {
      lastRefresh = now();
      const match = cookie.match(/(?:^|;\s*)device_id=([^;]+)/);
      let device;
      if (match) { try { const decoded = decodeURIComponent(match[1]); try { device = String(JSON.parse(decoded)); } catch { device = decoded.replace(/^"+|"+$/g, ''); } } catch { /* optional header */ } }
      try { await request('https://unified-auth-api.zego.im/v1/auth/refresh_cookie', {method:'GET', headers:{'x-client-type':'web','x-biz-type':'1', ...(device ? {'x-device-id':device} : {})}}); }
      catch (error) { if (error.message === '即构登录态保存失败') throw error; /* The existing session can still be valid. */ }
    }
    const result = await request('https://console-api.zego.im/v2/get_1w_remained_time', {method:'POST', body:'{}'});
    if (result?.code === 3 || result?.code === 5) { expiredCookie = cookie; return {status:'auth_expired'}; }
    if (result?.code !== 0 || result.data?.remained_time === null || result.data?.remained_time === undefined || String(result.data.remained_time).trim() === '') throw new Error('即构余量响应无效');
    const remaining = Number(result.data.remained_time);
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 10000) throw new Error('即构余量响应无效');
    return {status:'ok', remaining, total:10000, used:10000 - remaining, unit:'标准分钟'};
  };
}
