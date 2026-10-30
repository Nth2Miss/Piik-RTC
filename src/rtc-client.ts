import type { UID } from 'agora-rtc-sdk-ng';
import type { Preferences } from './preferences';
import type { RtcProvider } from './types';
import { AgoraRtcAdapter } from './rtc/agora';
import { VolcRtcAdapter } from './rtc/volc';
import { ZegoRtcAdapter } from './rtc/zego';
import type { LocalTrack, MediaKind, RtcAdapter, RtcEventMap, RtcEventName, RtcEventSink, RtcListener, RtcRemoteUser } from './rtc/types';

/** Keeps room orchestration independent from provider-specific RTC SDKs. */
export class RtcClient {
  private adapter?: RtcAdapter;
  private handlers = new Map<RtcEventName, unknown[]>();
  private events: RtcEventSink = {
    emit:<K extends RtcEventName>(event:K, ...args:RtcEventMap[K]) => this.emit(event, ...args),
  };
  on<K extends RtcEventName>(event: K, handler: RtcListener<K>) {
    const handlers = this.handlers.get(event) as RtcListener<K>[] | undefined;
    if (handlers) handlers.push(handler); else this.handlers.set(event, [handler]);
  }
  private emit<K extends RtcEventName>(event: K, ...args: RtcEventMap[K]) {
    const handlers = this.handlers.get(event) as RtcListener<K>[] | undefined;
    for (const handler of handlers || []) handler(...args);
  }
  private current(): RtcAdapter {
    if (!this.adapter) throw new Error('媒体组件尚未初始化。');
    return this.adapter;
  }
  get remoteUsers(): RtcRemoteUser[] { return this.adapter?.remoteUsers ?? []; }
  get zegoPulls() { return this.adapter?.zegoPulls; }
  async setProvider(provider: RtcProvider) {
    if (provider === 'agora') this.adapter = await AgoraRtcAdapter.create(this.events);
    else if (provider === 'zego') this.adapter = new ZegoRtcAdapter(this.events);
    else this.adapter = new VolcRtcAdapter(this.events);
  }
  join(appId: string | number, room: string, token: string, uid: number): Promise<UID> {
    return this.current().join(appId, room, token, uid);
  }
  leave() { return this.adapter?.leave() ?? Promise.resolve(); }
  publish(tracks: LocalTrack[], preferences?: Preferences) { return this.current().publish(tracks, preferences); }
  unpublish(tracks: LocalTrack[]) { return this.current().unpublish(tracks); }
  subscribe(user: RtcRemoteUser, kind: MediaKind) { return this.current().subscribe(user, kind); }
  unsubscribe(user: RtcRemoteUser) { return this.current().unsubscribe(user); }
  renewToken(token: string) { return this.current().renewToken(token); }
  getRTCStats(selected?: number) { return this.current().getRTCStats(selected); }
  getNetworkQuality(selected?: number) { return this.current().getNetworkQuality(selected); }
  getLocalVideoStats() { return this.current().getLocalVideoStats(); }
  getRemoteVideoStats() { return this.current().getRemoteVideoStats(); }
}
