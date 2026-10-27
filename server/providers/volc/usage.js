import { createHash, createHmac } from 'node:crypto';
import { json } from '../../shared/usage.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

const dayMs = 86400_000, offset = 8 * 3600_000;
const chinaDay = time => new Date(time + offset).toISOString().slice(0, 10);
const dayStart = time => Math.floor((time + offset) / dayMs) * dayMs - offset;
const rfc3339 = time => `${new Date(time + offset).toISOString().slice(0, 19)}+08:00`;

export function volcRtcHeaders(env, body, now = new Date()) {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8), scope = `${day}/cn-north-1/rtc/request`;
  const signed = 'content-type;host;x-date';
  const canonical = `POST\n/\nAction=ListUsages&Version=2024-03-01\ncontent-type:application/json\nhost:rtc.volcengineapi.com\nx-date:${date}\n\n${signed}\n${sha(body)}`;
  const stringToSign = `HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`;
  const key = hmac(hmac(hmac(hmac(env.VOLC_ACCESS_KEY_SECRET, day), 'cn-north-1'), 'rtc'), 'request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return { 'Content-Type':'application/json', 'X-Date':date, Authorization:`HMAC-SHA256 Credential=${env.VOLC_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}

// ListUsages has a rolling 30-day lookback. Retain previously queried days so
// the first day of a 31-day month remains available after it leaves that window.
export async function volcRtcUsage(env, fetcher = fetch, now = new Date(), store) {
  if (!env.VOLC_RTC_APP_ID || !env.VOLC_ACCESS_KEY_ID || !env.VOLC_ACCESS_KEY_SECRET) return {status:'unconfigured'};
  const current = now.getTime(), today = dayStart(current);
  const [year, month] = chinaDay(current).split('-').map(Number);
  const monthStart = Date.UTC(year, month - 1, 1) - offset;
  const cutoff = current - 30 * dayMs;
  const firstAvailable = dayStart(cutoff) + (dayStart(cutoff) < cutoff ? dayMs : 0);
  const start = Math.max(monthStart, firstAvailable);
  if (current <= start) return {status:'unavailable'};
  const body = JSON.stringify({AppId:env.VOLC_RTC_APP_ID, StartTime:rfc3339(start), EndTime:rfc3339(current)});
  const res = await fetcher('https://rtc.volcengineapi.com/?Action=ListUsages&Version=2024-03-01', {method:'POST', headers:volcRtcHeaders(env, body, now), body, signal:AbortSignal.timeout(10000)});
  let data;
  try { data = await res.json(); } catch { throw new Error('火山用量响应无效'); }
  if (res.status === 403 || data.ResponseMetadata?.Error?.Code === 'AccessDenied') return {status:'forbidden'};
  if (!res.ok || data.ResponseMetadata?.Error || !Array.isArray(data.Result?.Usages)) throw new Error('火山用量响应无效');
  const daily = new Map();
  for (const row of data.Result.Usages) {
    const time = Date.parse(row?.TimeStamp);
    if (!Number.isFinite(time) || dayStart(time) !== time || time < start || time > today || daily.has(chinaDay(time))) throw new Error('火山用量日期无效');
    let minutes = 0;
    for (const key of ['Audio','VideoSDM','VideoSD','VideoHD','Video2K','Video4K']) {
      const value = row[key] ?? 0;
      if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('火山用量数值无效');
      minutes += Number(value);
    }
    daily.set(chinaDay(time), minutes);
  }
  const previous = store ? store.volcDaily(env.VOLC_RTC_APP_ID, chinaDay(monthStart).slice(0, 7)) : [];
  const merged = new Map(previous.map(row => [row.day, row.minutes]));
  for (let time = start; time <= today; time += dayMs) {
    const day = chinaDay(time);
    if (daily.has(day)) merged.set(day, daily.get(day));
    else if (!merged.has(day)) merged.set(day, 0);
  }
  if (store) store.saveVolcDaily(env.VOLC_RTC_APP_ID, [...merged].map(([day, minutes]) => ({day, minutes})));
  const missing = [];
  for (let time = monthStart; time < start; time += dayMs) if (!merged.has(chinaDay(time))) missing.push(chinaDay(time));
  const used = [...merged.values()].reduce((total, value) => total + value, 0);
  const result = {status:missing.length ? 'partial' : 'ok', kind:'usage_estimate', used, total:10000, unit:'分钟', from:chinaDay(monthStart), to:chinaDay(current), queriedFrom:chinaDay(start), missingDays:missing, delayHours:8};
  if (!missing.length) result.remaining = Math.max(0, 10000 - used);
  return result;
}

export function volcHeaders(env, body, now = new Date()) {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8), scope = `${day}/cn-beijing/billing/request`;
  const signed = 'content-type;host;x-date';
  const canonical = `POST\n/\nAction=ListResourcePackages&Version=2022-01-01\ncontent-type:application/json\nhost:billing.volcengineapi.com\nx-date:${date}\n\n${signed}\n${sha(body)}`;
  const stringToSign = `HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`;
  const key = hmac(hmac(hmac(hmac(env.VOLC_ACCESS_KEY_SECRET, day), 'cn-beijing'), 'billing'), 'request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return { 'Content-Type': 'application/json', 'X-Date': date, Authorization: `HMAC-SHA256 Credential=${env.VOLC_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}

export async function volcUsage(env, fetcher = fetch, now = new Date()) {
  if (!env.VOLC_ACCESS_KEY_ID || !env.VOLC_ACCESS_KEY_SECRET) return { status: 'unconfigured' };
  const packages = [], seen = new Set();
  let next;
  do {
    const body = JSON.stringify({ MaxResults: '20', ResourceType: 'Package', Product: 'veRTC', ...(next ? { NextToken: next } : {}) });
    const data = await json(fetcher, 'https://billing.volcengineapi.com/?Action=ListResourcePackages&Version=2022-01-01', { method: 'POST', headers: volcHeaders(env, body, now), body });
    if (data.ResponseMetadata?.Error || !Array.isArray(data.Result?.List)) throw new Error('火山资源包响应无效');
    packages.push(...data.Result.List);
    next = data.Result.NextToken;
    // Billing returns the string "0" when pagination has reached the end.
    if (next === '0' || next === 0) next = undefined;
    if (next && (seen.has(next) || seen.size >= 100)) throw new Error('火山资源包分页异常');
    if (next) seen.add(next);
  } while (next);
  const active = packages.filter(p => p.Product === 'veRTC' && p.Status === 'Effective' && Date.parse(p.EffectiveTime) <= now.getTime() && Date.parse(p.ExpiryTime) > now.getTime());
  if (active.some(p => p.Unit !== '分钟' || !Number.isFinite(Number(p.AvailableAmount)) || !Number.isFinite(Number(p.TotalAmount)))) throw new Error('火山资源包单位或数量无法识别');
  return { status: 'ok', remaining: active.reduce((n, p) => n + Number(p.AvailableAmount), 0), total: active.reduce((n, p) => n + Number(p.TotalAmount), 0), unit: '分钟', packages: active.length };
}
