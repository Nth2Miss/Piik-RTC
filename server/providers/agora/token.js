import agora from 'agora-token';

export function agoraToken(appId, certificate, roomId, uid, lifetime) {
  return agora.RtcTokenBuilder.buildTokenWithUid(appId, certificate, roomId, uid, agora.RtcRole.PUBLISHER, lifetime, lifetime);
}
