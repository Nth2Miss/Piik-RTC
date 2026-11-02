import type { ZegoExpressEngine } from 'zego-express-engine-webrtc';
import { encoderConfig, effectiveBitrate, videoOptimization, ZEGO_MAX_BITRATE, type Preferences } from '../preferences.ts';
import { browserAudioTrack, browserVideoTrack, StatsCache } from './browser.ts';
import { SubscriptionTasks } from './subscriptions.ts';
import { diagnosticBoolean, diagnosticNumber, encodingDiagnostics, statisticsObservation } from './diagnostics.ts';
import type { LocalTrack, MediaKind, RemoteVideoStats, RtcAdapter, RtcEventSink, RtcRemoteUser, ZegoPull } from './types';

type ZegoPublishStats = NonNullable<ReturnType<ZegoExpressEngine['getPublishingStreamQuality']>>;
type ZegoPlayStats = NonNullable<ReturnType<ZegoExpressEngine['getPlayingStreamQuality']>>;
// Zego reports qualities from 0 (excellent) to 4 (bad); the UI follows the
// Agora/Volcengine scale from 1 (excellent) to 6 (disconnected).
const zegoQuality = (value?: number) => [1, 2, 3, 5, 6][Number(value)] || 0;
const packetLossPercent = (value?: number) => {
  if (!Number.isFinite(value) || !value || value <= 0) return 0;
  return value <= 1 ? value * 100 : value;
};

export class ZegoRtcAdapter implements RtcAdapter {
  private engine?: ZegoExpressEngine;
  private room = '';
  private uid = 0;
  private local?: MediaStream;
  private remotes = new Map<number, RtcRemoteUser>();
  private cache = new StatsCache();
  private subscriptions = new SubscriptionTasks();
  private revision = 0;
  private events: RtcEventSink;
  private loadSdk: () => Promise<typeof import('zego-express-engine-webrtc')>;
  constructor(events: RtcEventSink, loadSdk = () => import('zego-express-engine-webrtc')) { this.events = events; this.loadSdk = loadSdk; }
  get remoteUsers(): RtcRemoteUser[] { return [...this.remotes.values()]; }
  get zegoPulls(): ZegoPull[] {
    return this.remoteUsers.flatMap(user => {
      const stream = user.stream;
      if (!stream) return [];
      const video = stream.getVideoTracks().find(track => track.readyState !== 'ended');
      const audio = stream.getAudioTracks().find(track => track.readyState !== 'ended');
      const settings = video?.getSettings();
      // A newly started screen stream can expose its tracks asynchronously.
      return [{ uid:user.uid, kind:video || (!audio && user.hasVideo) ? 'video' : 'audio', width:settings?.width || 0, height:settings?.height || 0 }];
    });
  }
  private requireEngine(): ZegoExpressEngine {
    if (!this.engine) throw new Error('即构媒体组件尚未连接。');
    return this.engine;
  }
  private remote(uid: number): RtcRemoteUser {
    let user = this.remotes.get(uid);
    if (!user) { user = { uid, hasAudio:false, hasVideo:false }; this.remotes.set(uid, user); }
    return user;
  }
  async join(appId: string | number, room: string, token: string, uid: number) {
    const revision = ++this.revision;
    this.room = room; this.uid = uid;
    this.events.emit('connection-state-change', 'CONNECTING');
    const { ZegoExpressEngine } = await this.loadSdk();
    if (revision !== this.revision) throw new Error('媒体连接已取消。');
    const engine = this.engine = new ZegoExpressEngine(Number(appId), '');
    engine.on('roomStateChanged', (_room, reason) => {
      if (this.engine !== engine) return;
      if (reason === 'RECONNECTING') this.events.emit('connection-state-change', 'RECONNECTING');
      else if (reason === 'RECONNECTED') this.events.emit('connection-state-change', 'CONNECTED');
      else if (reason === 'RECONNECT_FAILED' || reason === 'KICKOUT') this.events.emit('connection-state-change', 'DISCONNECTED');
    });
    engine.on('roomStreamUpdate', (_room, action, streams) => {
      if (this.engine !== engine) return;
      for (const stream of streams) {
        const id = Number(stream.user.userID); if (!Number.isSafeInteger(id) || id === this.uid) continue;
        const user = this.remote(id); user.streamId = stream.streamID;
        if (action === 'ADD') { user.hasAudio = true; user.hasVideo = true; this.events.emit('user-published', user, 'video'); }
        else { user.hasAudio = false; user.hasVideo = false; this.events.emit('user-unpublished', user, 'video'); this.remotes.delete(id); this.events.emit('billing-change'); }
      }
    });
    engine.on('tokenWillExpire', () => { if (this.engine === engine) this.events.emit('token-privilege-will-expire'); });
    const ok = await engine.loginRoom(room, token, { userID:String(uid), userName:String(uid) }, { userUpdate:true });
    if (this.engine !== engine) throw new Error('媒体连接已取消。');
    if (!ok) throw new Error('即构房间连接失败。');
    this.events.emit('connection-state-change', 'CONNECTED');
    return uid;
  }
  async leave() {
    this.revision++; this.subscriptions.clear();
    const engine = this.engine; this.engine = undefined;
    try { if (engine) { try { engine.logoutRoom(this.room); } finally { engine.destroyEngine(); } } }
    finally {
      for (const user of this.remotes.values()) { user.audioTrack?.stop(); user.videoTrack?.stop(); }
      this.remotes.clear(); this.cache.clear(); this.local = undefined;
      this.events.emit('billing-change'); this.events.emit('connection-state-change', 'DISCONNECTED');
    }
  }
  async publish(tracks: LocalTrack[], preferences?: Preferences, size?: { width:number; height:number }) {
    this.cache.delete('zego:publish');
    const engine = this.requireEngine();
    const raw = tracks.map(track => track.getMediaStreamTrack());
    const video = raw.find(track => track.kind === 'video');
    const config = preferences && video ? encoderConfig(preferences, size ?? video.getSettings()) : undefined;
    const stream = await engine.createStream({ custom: {
      source:new MediaStream(raw),
      ...(preferences ? { bitrate:Math.min(effectiveBitrate(preferences), ZEGO_MAX_BITRATE), audioBitrate:128,
        videoOptimizationMode:videoOptimization(preferences) === 'motion' ? 'motion' : preferences.optimization === 'detail' ? 'detail' : 'default' } : {}),
    } });
    this.local = stream;
    if (config && preferences) {
      try {
        // Without an explicit video config Zego can start the custom stream at
        // its default resolution/frame rate, which is visible as a blurry
        // first share. Set it before publishing.
        await engine.setVideoConfig(stream, {
          width:Number(config.width) || 1280, height:Number(config.height) || 720,
          frameRate:Number(config.frameRate) || 30,
          maxBitrate:Math.min(effectiveBitrate(preferences), ZEGO_MAX_BITRATE),
        });
      } catch { /* older Zego SDKs apply the config after publishing */ }
    }
    if (!engine.startPublishingStream(`${this.room}_${this.uid}`, stream)) { engine.destroyStream(stream); this.local = undefined; throw new Error('即构推流失败。'); }
  }
  async unpublish(_tracks: LocalTrack[]) {
    if (!this.engine) return;
    this.engine.stopPublishingStream(`${this.room}_${this.uid}`);
    if (this.local) this.engine.destroyStream(this.local);
    this.local = undefined; this.cache.delete('zego:publish');
  }
  async subscribe(user: RtcRemoteUser, kind: MediaKind, signal?: AbortSignal) {
    const engine = this.requireEngine(), streamId = user.streamId;
    if (!streamId) throw new Error('共享流尚未准备好，请稍后重试。');
    await this.subscriptions.run(user, signal, () => user.stream ? Promise.resolve(user.stream) : engine.startPlayingStream(streamId), stream => {
      user.stream = stream;
      const track = kind === 'video' ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
      if (track) { if (kind === 'video') user.videoTrack = browserVideoTrack(track); else user.audioTrack = browserAudioTrack(track); }
      this.events.emit('billing-change');
    }, () => { if (this.engine === engine) engine.stopPlayingStream(streamId); });
  }
  async unsubscribe(user: RtcRemoteUser) {
    this.subscriptions.cancel(user);
    user.audioTrack?.stop(); user.videoTrack?.stop();
    if (user.streamId) this.engine?.stopPlayingStream(user.streamId);
    if (user.streamId) this.cache.delete(`zego:play:${user.streamId}`);
    user.stream = undefined; user.videoTrack = undefined; user.audioTrack = undefined; this.events.emit('billing-change');
  }
  async renewToken(token: string) {
    if (!this.requireEngine().renewToken(token, this.room)) throw new Error('即构 Token 续期失败。');
  }
  private publishStats(): ZegoPublishStats | null | undefined {
    if (!this.engine) return undefined;
    return this.cache.read<ZegoPublishStats | null>('zego:publish', 2500, () => this.requireEngine().getPublishingStreamQuality(`${this.room}_${this.uid}`));
  }
  private playStats(streamId: string): ZegoPlayStats | null | undefined {
    if (!this.engine) return undefined;
    return this.cache.read<ZegoPlayStats | null>(`zego:play:${streamId}`, 2500, () => this.requireEngine().getPlayingStreamQuality(streamId));
  }
  getRTCStats(selected?: number) {
    const watched = selected === undefined || selected === this.uid ? undefined : this.remotes.get(selected);
    const first = selected === this.uid ? undefined : watched ?? this.remoteUsers.find(user => user.streamId);
    const local = this.publishStats(), play = first?.streamId ? this.playStats(first.streamId) : undefined;
    return {
      RecvBitrate:Math.round((play?.video?.videoBitrate || 0) * 1000),
      SendBitrate:Math.round((local?.video?.videoBitrate || 0) * 1000),
      Duration:0, UserCount:this.remotes.size + 1,
    };
  }
  getNetworkQuality(selected?: number) {
    const user = selected === undefined ? undefined : this.remotes.get(selected);
    const first = user ?? this.remoteUsers.find(item => item.streamId);
    return { uplinkNetworkQuality:zegoQuality(this.publishStats()?.video?.videoQuality),
      downlinkNetworkQuality:zegoQuality(first?.streamId ? this.playStats(first.streamId)?.video?.videoQuality : undefined) };
  }
  getLocalVideoStats() {
    const stats = this.publishStats()?.video;
    if (!stats) throw new Error('暂未获取到统计信息。');
    return {
      observation:statisticsObservation('zego.getPublishingStreamQuality','poll',this.cache.observedAt('zego:publish') ?? Date.now()),
      diagnostics:encodingDiagnostics({hardwareAccelerated:diagnosticBoolean(stats.isHardwareEncode),encoderOutputFps:diagnosticNumber(stats.videoTransferFPS),
        uplinkLossPercent:diagnosticNumber(typeof stats.videoPacketsLostRate === 'number' ? packetLossPercent(stats.videoPacketsLostRate) : undefined)}),
      sendResolutionWidth:Math.round(stats.frameWidth || 0), sendResolutionHeight:Math.round(stats.frameHeight || 0),
      captureResolutionWidth:Math.round(stats.frameWidth || 0), captureResolutionHeight:Math.round(stats.frameHeight || 0),
      sendFrameRate:stats.videoFPS,
      codecType:stats.googCodecName, sendBitrate:Math.round((stats.videoBitrate || 0) * 1000),
    };
  }
  getRemoteVideoStats() {
    const result: Record<string, RemoteVideoStats> = {};
    for (const user of this.remotes.values()) {
      if (!user.stream || !user.streamId) continue;
      const stats = this.playStats(user.streamId), video = stats?.video;
      if (video) result[String(user.uid)] = {
        observation:statisticsObservation('zego.getPlayingStreamQuality','poll',this.cache.observedAt(`zego:play:${user.streamId}`) ?? Date.now()),
        receiveResolutionWidth:Math.round(video.frameWidth || 0), receiveResolutionHeight:Math.round(video.frameHeight || 0),
        decodeFrameRate:video.videoTransferFPS, renderFrameRate:video.videoRenderFPS,
        codecType:video.googCodecName, receiveBitrate:Math.round((video.videoBitrate || 0) * 1000),
        packetLossRate:packetLossPercent(video.videoPacketsLostRate), currentPacketLossRate:packetLossPercent(video.videoPacketsLostRate),
        receiveDelay:Math.round(stats?.peerToPeerDelay || 0), transportDelay:Math.round(stats?.peerToPeerDelay || 0),
        end2EndDelay:Math.round(stats?.peerToPeerDelay || 0),
      };
    }
    return result;
  }
}
