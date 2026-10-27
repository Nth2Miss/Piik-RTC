export function chinaMonth(now) {
  const date = new Date(now.getTime() + 8 * 3600_000);
  const today = date.toISOString().slice(0, 10);
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

export async function json(fetcher, url, options) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('上游接口请求失败');
  return response.json();
}
