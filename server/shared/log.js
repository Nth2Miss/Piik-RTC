const providerNames = { agora:'声网', zego:'即构 ZEGO', volc:'火山引擎 1', volc2:'火山引擎 2' };
const loopback = address => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
const printable = value => typeof value === 'string' && /[\s"]/.test(value) ? JSON.stringify(value) : String(value);
// Be explicit about the offset so the timestamp stays unambiguous regardless of the container timezone.
const beijingTime = () => new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00');

export function providerLabel(provider) {
  return providerNames[provider] ? `${provider}(${providerNames[provider]})` : provider || '-';
}

export const roomLabel = room => room ? `${room.name}（${room.id}）` : '-';

// One line per event so `docker compose logs` stays greppable by event name.
export function logEvent(event, fields = {}) {
  const parts = [`[${beijingTime()}]`, event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${printable(value)}`);
  }
  console.log(parts.join(' '));
}

// Reverse proxies running on the same host connect from loopback, so their X-Forwarded-For carries the real client.
export function clientIp(request) {
  const address = request?.socket?.remoteAddress;
  const forwarded = request?.headers?.['x-forwarded-for'];
  if (address && loopback(address) && typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return address || '-';
}
