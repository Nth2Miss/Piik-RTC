import { chinaMonth, json } from '../../shared/usage.js';

export async function agoraUsage(env, fetcher = fetch, now = new Date()) {
  if (!env.AGORA_PROJECT_ID || !env.AGORA_CUSTOMER_KEY || !env.AGORA_CUSTOMER_SECRET) return { status: 'unconfigured' };
  const { from, to } = chinaMonth(now);
  const query = new URLSearchParams({ project_id: env.AGORA_PROJECT_ID, business: 'default', from_date: from, to_date: to });
  const authorization = Buffer.from(`${env.AGORA_CUSTOMER_KEY}:${env.AGORA_CUSTOMER_SECRET}`).toString('base64');
  const data = await json(fetcher, `https://api.agora.io/dev/v3/usage?${query}`, { headers: { Authorization: `Basic ${authorization}` } });
  if (!Array.isArray(data.usages)) throw new Error('声网用量响应无效');
  let seconds = 0;
  for (const row of data.usages) {
    const usage = row?.usage;
    if (!usage || typeof usage !== 'object') throw new Error('声网用量响应无效');
    // HDP is an aggregate of video tiers already accounted for below.
    for (const [key, factor] of Object.entries({ durationAudioAll: 1, durationVideoHd: 4, durationVideo1080P: 9, durationVideo2K: 16, durationVideo4K: 36 })) {
      const amount = Number(usage[key]);
      if (!Number.isFinite(amount) || amount < 0) throw new Error('声网用量响应无效');
      seconds += amount * factor;
    }
  }
  const used = seconds / 60;
  return { status: 'ok', kind:'usage_estimate', used, remaining: Math.max(0, 10000 - used), total: 10000, unit: '标准分钟', from, to };
}
