import { createHmac, randomBytes } from 'node:crypto';

// Copyright 2025 Beijing Volcano Engine Technology Co., Ltd. All Rights Reserved.
// RTC token wire format follows the Volcengine RTC sample (BSD-3-Clause).
export function volcToken(appId, appKey, roomId, userId, lifetime = 3600) {
  if (typeof appId !== 'string' || appId.length !== 24 || !appKey || !roomId || !userId) throw new Error('火山 RTC 凭据或房间信息无效');
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const bytes = value => { const b = Buffer.from(value); return Buffer.concat([u16(b.length), b]); };
  const now = Math.floor(Date.now() / 1000), expiry = now + lifetime;
  const privileges = [0, 1, 2, 3, 4].map(id => Buffer.concat([u16(id), u32(expiry)]));
  const message = Buffer.concat([randomBytes(4), u32(now), u32(expiry), bytes(roomId), bytes(userId), u16(privileges.length), ...privileges]);
  const signature = createHmac('sha256', appKey).update(message).digest();
  return `001${appId}${Buffer.concat([bytes(message), bytes(signature)]).toString('base64')}`;
}
