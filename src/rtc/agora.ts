import type { IAgoraRTCClient, IAgoraRTCRemoteUser, UID } from 'agora-rtc-sdk-ng';
import { loadAgoraSdk } from '../agora-sdk';
import type { LocalTrack, MediaKind, RtcAdapter, RtcEventSink, RtcRemoteUser } from './types';

export class AgoraRtcAdapter implements RtcAdapter {
  private constructor(private client: IAgoraRTCClient, private events: RtcEventSink) {}
  static async create(events: RtcEventSink): Promise<AgoraRtcAdapter> {
    const sdk = await loadAgoraSdk();
    // H.264 is hardware accelerated in desktop Chrome/Edge more often than VP8.
    const adapter = new AgoraRtcAdapter(sdk.createClient({ mode:'rtc', codec:'h264' }), events);
    const client = adapter.client;
    client.on('connection-state-change', current => events.emit('connection-state-change', current));
    client.on('user-joined', () => events.emit('user-joined'));
    client.on('user-published', (user, kind) => { if (kind !== 'datachannel') events.emit('user-published', user, kind); });
    client.on('user-unpublished', (user, kind) => { if (kind !== 'datachannel') events.emit('user-unpublished', user, kind); });
    client.on('user-left', user => events.emit('user-left', user));
    client.on('token-privilege-will-expire', () => events.emit('token-privilege-will-expire'));
    client.on('token-privilege-did-expire', () => events.emit('token-privilege-did-expire'));
    return adapter;
  }
  get remoteUsers(): RtcRemoteUser[] { return this.client.remoteUsers; }
  join(appId: string | number, room: string, token: string, uid: number): Promise<UID> {
    return this.client.join(String(appId), room, token, uid);
  }
  async leave() { await this.client.leave(); }
  async publish(tracks: LocalTrack[]) { await this.client.publish(tracks); }
  async unpublish(tracks: LocalTrack[]) { await this.client.unpublish(tracks); }
  async subscribe(user: RtcRemoteUser, kind: MediaKind) {
    await this.client.subscribe(user as IAgoraRTCRemoteUser, kind);
  }
  async unsubscribe(user: RtcRemoteUser) { await this.client.unsubscribe(user as IAgoraRTCRemoteUser); }
  async renewToken(token: string) { await this.client.renewToken(token); }
  getRTCStats() { return this.client.getRTCStats(); }
  getNetworkQuality() { return this.client.getNetworkQuality(); }
  getLocalVideoStats() { return this.client.getLocalVideoStats(); }
  getRemoteVideoStats() { return this.client.getRemoteVideoStats(); }
}
