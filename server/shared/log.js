const providerNames = { agora:'声网', zego:'即构 ZEGO', volc:'火山引擎 1', volc2:'火山引擎 2' };
const printable = value => typeof value === 'string' && /[\s"]/.test(value) ? JSON.stringify(value) : String(value);
// Be explicit about the offset so the timestamp stays unambiguous regardless of the container timezone.
const beijingTime = () => new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00');

const ipv4Private = value => {
  const [first, second] = value.split('.').map(Number);
  if (!Number.isInteger(first) || !Number.isInteger(second)) return false;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
    || (first === 169 && second === 254) || (first === 100 && second >= 64 && second <= 127) || first === 127;
};
// Proxies on the same host or Docker network reach us from a loopback or private address; only then trust forwarding headers.
const internalAddress = value => {
  if (!value) return false;
  const address = value.startsWith('::ffff:') ? value.slice(7) : value;
  return address === '::1' || ipv4Private(address) || /^(fc|fd|fe[89ab])/i.test(address);
};

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

// Docker port mapping and same-host proxies hide the client behind the bridge gateway, so forwarded headers carry the real address.
export function clientIp(request) {
  const address = request?.socket?.remoteAddress || '-';
  if (!internalAddress(address)) return address;
  const real = request.headers?.['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  const forwarded = request.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return address;
}
