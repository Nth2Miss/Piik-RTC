import { createCipheriv, randomBytes, randomInt } from 'node:crypto';

// Token04 wire format follows ZEGO's server assistant: AES-256-GCM,
// big-endian expiry, length-prefixed nonce/ciphertext, and mode byte 1.
export function zegoToken(appId, secret, userId, roomId, lifetime = 3600) {
  if (!Number.isInteger(appId) || appId <= 0 || appId > 0xffffffff || Buffer.byteLength(secret) !== 32 || !userId || !roomId) throw new Error('即构凭据或房间信息无效');
  const now = Math.floor(Date.now() / 1000), expire = now + lifetime;
  const payload = JSON.stringify({ room_id: roomId, privilege: { 1: 1, 2: 1 }, stream_id_list: [`${roomId}_${userId}`] });
  const data = JSON.stringify({ app_id: appId, user_id: userId, ctime: now, expire, nonce: randomInt(0, 0x7fffffff), payload });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret), iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(10); header.writeBigInt64BE(BigInt(expire)); header.writeUInt16BE(iv.length, 8);
  const size = Buffer.alloc(2); size.writeUInt16BE(encrypted.length);
  return `04${Buffer.concat([header, iv, size, encrypted, Buffer.from([1])]).toString('base64')}`;
}
