import type { ILocalAudioTrack, ILocalVideoTrack, IRemoteAudioTrack, IRemoteVideoTrack, UID } from 'agora-rtc-sdk-ng';
import type { Preferences } from '../preferences';

export type MediaKind = 'audio' | 'video';
export interface BrowserVideoTrack {
  play(container: HTMLElement, options?: { fit?: string; mirror?: boolean }): void;
  stop(): void;
}
export interface BrowserAudioTrack {
  setVolume(value: number): void;
  play(): void;
  stop(): void;
}
export interface BrowserLocalTrack {
  readonly trackMediaType: MediaKind;
  readonly enabled: boolean;
  getMediaStreamTrack(): MediaStreamTrack;
  stop(): void;
  close(): void;
}
export interface BrowserLocalVideoTrack extends BrowserLocalTrack, BrowserVideoTrack { readonly trackMediaType: 'video'; }
export interface BrowserLocalAudioTrack extends BrowserLocalTrack { readonly trackMediaType: 'audio'; }
export type LocalTrack = ILocalAudioTrack | ILocalVideoTrack | BrowserLocalAudioTrack | BrowserLocalVideoTrack;
export type LocalVideoTrack = ILocalVideoTrack | BrowserLocalVideoTrack;
export type VideoTrack = LocalVideoTrack | IRemoteVideoTrack | BrowserVideoTrack;
export type AudioTrack = IRemoteAudioTrack | BrowserAudioTrack;
export interface RtcRemoteUser {
  uid: UID;
  hasAudio: boolean;
  hasVideo: boolean;
  videoTrack?: IRemoteVideoTrack | BrowserVideoTrack;
  audioTrack?: AudioTrack;
  streamId?: string;
  stream?: MediaStream;
}
export interface ZegoPull {
  uid: UID;
  kind: MediaKind;
  width: number;
  height: number;
}
export interface RtcStats {
  RTT: number;
  OutgoingAvailableBandwidth: number;
  RecvBitrate: number;
  SendBitrate: number;
  Duration: number;
  UserCount: number;
}
export interface NetworkQuality {
  uplinkNetworkQuality: number;
  downlinkNetworkQuality: number;
}
export interface LocalVideoStats {
  sendResolutionWidth?: number;
  sendResolutionHeight?: number;
  captureResolutionWidth?: number;
  captureResolutionHeight?: number;
  captureFrameRate?: number;
  sendFrameRate?: number;
  codecType?: string;
  sendBitrate?: number;
  targetSendBitrate?: number;
  sendRttMs?: number;
  encodeDelay?: number;
}
export interface RemoteVideoStats {
  receiveResolutionWidth?: number;
  receiveResolutionHeight?: number;
  receiveFrameRate?: number;
  decodeFrameRate?: number;
  codecType?: string;
  receiveBitrate?: number;
  packetLossRate?: number;
  currentPacketLossRate?: number;
  receiveDelay?: number;
  transportDelay?: number;
  end2EndDelay?: number;
}
export interface RtcEventMap {
  'connection-state-change': [connection: string];
  'user-joined': [];
  'user-published': [user: RtcRemoteUser, kind: MediaKind];
  'user-unpublished': [user: RtcRemoteUser, kind: MediaKind];
  'user-left': [user: RtcRemoteUser];
  'token-privilege-will-expire': [];
  'token-privilege-did-expire': [];
  'billing-change': [];
}
export type RtcEventName = keyof RtcEventMap;
export type RtcListener<K extends RtcEventName> = (...args: RtcEventMap[K]) => void;
export interface RtcEventSink {
  emit<K extends RtcEventName>(event: K, ...args: RtcEventMap[K]): void;
}
export interface RtcAdapter {
  readonly remoteUsers: RtcRemoteUser[];
  readonly zegoPulls?: ZegoPull[];
  join(appId: string | number, room: string, token: string, uid: number): Promise<UID>;
  leave(): Promise<void>;
  publish(tracks: LocalTrack[], preferences?: Preferences): Promise<void>;
  unpublish(tracks: LocalTrack[]): Promise<void>;
  subscribe(user: RtcRemoteUser, kind: MediaKind): Promise<void>;
  unsubscribe(user: RtcRemoteUser): Promise<void>;
  renewToken(token: string): Promise<void>;
  getRTCStats(selected?: number): RtcStats;
  getNetworkQuality(selected?: number): NetworkQuality;
  getLocalVideoStats(): LocalVideoStats;
  getRemoteVideoStats(): Record<string, RemoteVideoStats>;
}
