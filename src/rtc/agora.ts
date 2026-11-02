import type { IAgoraRTCClient, IAgoraRTCRemoteUser, ILocalAudioTrack, ILocalVideoTrack, UID } from 'agora-rtc-sdk-ng';
import { loadAgoraSdk } from '../agora-sdk.ts';
import { SubscriptionTasks } from './subscriptions.ts';
import { diagnosticNumber, encodingDiagnostics, statisticsObservation } from './diagnostics.ts';
import type { LocalTrack, MediaKind, RemoteVideoStats, RtcAdapter, RtcEventSink, RtcRemoteUser } from './types';

export class AgoraRtcAdapter implements RtcAdapter {
  private client: IAgoraRTCClient;
  private subscriptions = new SubscriptionTasks();
  private constructor(client: IAgoraRTCClient) { this.client = client; }
  static async create(events: RtcEventSink, loadSdk = loadAgoraSdk): Promise<AgoraRtcAdapter> {
    const sdk = await loadSdk();
    // H.264 is hardware accelerated in desktop Chrome/Edge more often than VP8.
    const adapter = new AgoraRtcAdapter(sdk.createClient({ mode:'rtc', codec:'h264' }));
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
  async leave() { this.subscriptions.clear(); await this.client.leave(); }
  async publish(tracks: LocalTrack[]) { await this.client.publish(tracks as (ILocalAudioTrack | ILocalVideoTrack)[]); }
  async unpublish(tracks: LocalTrack[]) { await this.client.unpublish(tracks as (ILocalAudioTrack | ILocalVideoTrack)[]); }
  async subscribe(user: RtcRemoteUser, kind: MediaKind, signal?: AbortSignal) {
    await this.subscriptions.run(user, signal, () => this.client.subscribe(user as IAgoraRTCRemoteUser, kind), () => {},
      () => this.client.unsubscribe(user as IAgoraRTCRemoteUser, kind));
  }
  async unsubscribe(user: RtcRemoteUser) { this.subscriptions.cancel(user); await this.client.unsubscribe(user as IAgoraRTCRemoteUser); }
  async renewToken(token: string) { await this.client.renewToken(token); }
  getRTCStats() { return this.client.getRTCStats(); }
  getNetworkQuality() { return this.client.getNetworkQuality(); }
  getLocalVideoStats() {
    const stats = this.client.getLocalVideoStats();
    return {...stats,observation:statisticsObservation('agora.getLocalVideoStats','poll',Date.now()),
      diagnostics:encodingDiagnostics({meanEncodeTimeMs:diagnosticNumber(stats.encodeDelay)})};
  }
  getRemoteVideoStats() {
    const result: Record<string, RemoteVideoStats> = {};
    for (const [uid, stats] of Object.entries(this.client.getRemoteVideoStats())) {
      result[uid] = {
        observation:statisticsObservation('agora.getRemoteVideoStats','poll',Date.now()),
        receiveResolutionWidth:Math.round(stats.receiveResolutionWidth || 0),
        receiveResolutionHeight:Math.round(stats.receiveResolutionHeight || 0),
        receiveFrameRate:stats.receiveFrameRate || 0, decodeFrameRate:stats.decodeFrameRate,
        codecType:stats.codecType, receiveBitrate:Math.round(stats.receiveBitrate || 0),
        // Agora reports packet loss as a 0..1 fraction; the UI prints percent.
        packetLossRate:(stats.packetLossRate || 0) * 100, currentPacketLossRate:(stats.currentPacketLossRate || 0) * 100,
        receiveDelay:Math.round(stats.receiveDelay || 0), transportDelay:Math.round(stats.transportDelay || 0),
        end2EndDelay:Math.round(stats.end2EndDelay || 0),
      };
    }
    return result;
  }
}
