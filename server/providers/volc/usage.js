import { createHash, createHmac } from 'node:crypto';
import { json } from '../../shared/usage.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

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
