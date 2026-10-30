import type { IRTCEngine, LocalVideoStats as VolcLocalVideoStats, RemoteVideoStats as VolcRemoteVideoStats } from '@volcengine/rtc';
import { encoderConfig, effectiveBitrate, videoContentHint, type Preferences } from '../preferences';
import { browserVideoTrack, StatsCache } from './browser';
import type { BrowserAudioTrack, LocalTrack, MediaKind, RemoteVideoStats, RtcAdapter, RtcEventSink, RtcRemoteUser } from './types';

type VolcModule = typeof import('@volcengine/rtc');

export class VolcRtcAdapter implements RtcAdapter {
  private engine?: IRTCEngine;
  private sdk?: VolcModule;
  private uid = 0;
  private remotes = new Map<number, RtcRemoteUser>();
  private localQuality = 0;
  private remoteQuality = new Map<number, number>();
  private cache = new StatsCache();
  constructor(private events: RtcEventSink) {}
  get remoteUsers(): RtcRemoteUser[] { return [...this.remotes.values()]; }
  private context(): { engine:IRTCEngine; sdk:VolcModule } {
    if (!this.engine || !this.sdk) throw new Error('火山媒体组件尚未连接。');
    return { engine:this.engine, sdk:this.sdk };
  }
  private remote(uid: number): RtcRemoteUser {
    let user = this.remotes.get(uid);
    if (!user) { user = { uid, hasAudio:false, hasVideo:false }; this.remotes.set(uid, user); }
    return user;
  }
  async join(appId: string | number, room: string, token: string, uid: number) {
    this.uid = uid;
    this.events.emit('connection-state-change', 'CONNECTING');
    const mod = await import('@volcengine/rtc'), rtc = mod.default;
    this.sdk = mod;
    const engine = this.engine = rtc.createEngine(String(appId));
    engine.on(rtc.events.onConnectionStateChanged, ({ state }) => {
      if (this.engine !== engine) return;
      if (state === 4) this.events.emit('connection-state-change', 'RECONNECTING');
      else if (state === 5) this.events.emit('connection-state-change', 'CONNECTED');
      else if (state === 1) this.events.emit('connection-state-change', 'DISCONNECTED');
    });
    engine.on(rtc.events.onUserPublishScreen, ({ userId, mediaType }) => {
      if (this.engine !== engine) return;
      const user = this.remote(Number(userId)); if (mediaType & 1) user.hasAudio = true; if (mediaType & 2) user.hasVideo = true;
      if (mediaType & 2) this.events.emit('user-published', user, 'video'); if (mediaType & 1) this.events.emit('user-published', user, 'audio');
    });
    engine.on(rtc.events.onUserUnpublishScreen, ({ userId, mediaType }) => {
      if (this.engine !== engine) return;
      const user = this.remote(Number(userId));
      if (mediaType & 1) { user.hasAudio = false; this.events.emit('user-unpublished', user, 'audio'); }
      if (mediaType & 2) { user.hasVideo = false; this.events.emit('user-unpublished', user, 'video'); }
    });
    engine.on(rtc.events.onUserLeave, ({ userInfo }) => {
      if (this.engine !== engine) return;
      const id = Number(userInfo?.userId), user = this.remotes.get(id);
      if (user) { this.remotes.delete(id); this.events.emit('user-left', user); }
    });
    engine.on(rtc.events.onTokenWillExpire, () => { if (this.engine === engine) this.events.emit('token-privilege-will-expire'); });
    // Screen audio is played by the RTC engine itself.
    engine.on(rtc.events.onLocalStreamStats, stats => {
      if (this.engine === engine && stats?.isScreen) this.localQuality = Number(stats.txQuality) || 0;
    });
    engine.on(rtc.events.onRemoteStreamStats, stats => {
      if (this.engine !== engine) return;
      const id = Number(stats?.userId);
      if (Number.isSafeInteger(id) && id > 0) this.remoteQuality.set(id, Number(stats?.rxQuality) || 0);
    });
    await engine.joinRoom(token, room, { userId:String(uid) }, { isAutoPublish:false, isAutoSubscribeAudio:false, isAutoSubscribeVideo:false });
    this.events.emit('connection-state-change', 'CONNECTED');
    return uid;
  }
  async leave() {
    const engine = this.engine, sdk = this.sdk; this.engine = undefined; this.sdk = undefined;
    if (engine && sdk) { await engine.leaveRoom(); sdk.default.destroyEngine(engine); }
    this.remotes.clear(); this.localQuality = 0; this.remoteQuality.clear(); this.cache.clear();
    this.events.emit('billing-change'); this.events.emit('connection-state-change', 'DISCONNECTED');
  }
  async publish(tracks: LocalTrack[], preferences?: Preferences) {
    const { engine, sdk } = this.context(), index = sdk.StreamIndex.STREAM_INDEX_SCREEN;
    const raw = tracks.map(track => track.getMediaStreamTrack());
    const video = raw.find(track => track.kind === 'video');
    if (!video) throw new Error('共享画面缺少视频轨，请重新选择。');
    if (preferences) {
      const config = encoderConfig(preferences, video.getSettings());
      const contentHint = videoContentHint(preferences);
      // Use the captured size so non-16:9 windows keep their aspect ratio.
      await engine.setScreenEncoderConfig({
        width:Number(config.width) || 1920, height:Number(config.height) || 1080, frameRate:Number(config.frameRate) || 30,
        maxKbps:effectiveBitrate(preferences), ...(contentHint ? { contentHint } : {}),
      });
    }
    await engine.setVideoSourceType(index, sdk.VideoSourceType.VIDEO_SOURCE_TYPE_EXTERNAL);
    await engine.setExternalVideoTrack(index, video);
    if (preferences) video.contentHint = videoContentHint(preferences);
    const audio = raw.find(track => track.kind === 'audio');
    if (audio) { await engine.setAudioSourceType(index, sdk.AudioSourceType.AUDIO_SOURCE_TYPE_EXTERNAL); await engine.setExternalAudioTrack(index, audio); }
    await engine.publishScreen(audio ? sdk.MediaType.AUDIO_AND_VIDEO : sdk.MediaType.VIDEO);
  }
  async unpublish(_tracks: LocalTrack[]) {
    if (!this.engine || !this.sdk) return;
    const { engine, sdk } = this.context();
    await engine.unpublishScreen(sdk.MediaType.AUDIO_AND_VIDEO);
    // Release the external track before the next share applies new constraints.
    const index = sdk.StreamIndex.STREAM_INDEX_SCREEN;
    await engine.setVideoSourceType(index, sdk.VideoSourceType.VIDEO_SOURCE_TYPE_INTERNAL);
    await engine.setAudioSourceType(index, sdk.AudioSourceType.AUDIO_SOURCE_TYPE_INTERNAL);
  }
  private playbackTrack(uid: number): BrowserAudioTrack {
    const id = String(uid);
    return {
      setVolume:value => {
        if (!this.engine || !this.sdk) return;
        this.engine.setPlaybackVolume(id, this.sdk.StreamIndex.STREAM_INDEX_SCREEN, Math.max(0, Math.min(400, value)));
      },
      play() { /* Playback is owned by the RTC engine. */ },
      stop() { /* unsubscribeScreen stops playback. */ },
    };
  }
  async subscribe(user: RtcRemoteUser, kind: MediaKind) {
    const { engine, sdk } = this.context();
    await engine.subscribeScreen(String(user.uid), kind === 'audio' ? sdk.MediaType.AUDIO : sdk.MediaType.VIDEO);
    if (kind === 'audio') { user.audioTrack = this.playbackTrack(Number(user.uid)); return; }
    const track = engine.getRemoteStreamTrack(String(user.uid), sdk.StreamIndex.STREAM_INDEX_SCREEN, kind);
    if (track) user.videoTrack = browserVideoTrack(track);
  }
  async unsubscribe(user: RtcRemoteUser) {
    if (this.engine && this.sdk) await this.engine.unsubscribeScreen(String(user.uid), this.sdk.MediaType.AUDIO_AND_VIDEO);
    user.videoTrack = undefined; user.audioTrack = undefined;
  }
  async renewToken(token: string) { await this.context().engine.updateToken(token); }
  private localStats(): VolcLocalVideoStats | undefined {
    if (!this.engine) return undefined;
    return this.cache.read('volc:local', 1000, () => this.context().engine.getLocalVideoStats())?.screenVideoStats;
  }
  private remoteStats(uid: number): VolcRemoteVideoStats | undefined {
    if (!this.engine) return undefined;
    return this.cache.read(`volc:remote:${uid}`, 1000, () => {
      const items = this.context().engine.getRemoteVideoStats()[String(uid)] || [];
      return items.find(item => item?.screenVideoStats?.width)?.screenVideoStats
        ?? items.find(item => item?.mainVideoStats?.width)?.mainVideoStats
        ?? items[0]?.screenVideoStats ?? items[0]?.mainVideoStats;
    });
  }
  getRTCStats(selected?: number) {
    const watched = selected === undefined || selected === this.uid ? undefined : this.remotes.get(selected);
    const first = selected === this.uid ? undefined : watched ?? this.remoteUsers[0];
    const local = this.localStats(), remote = first ? this.remoteStats(Number(first.uid)) : undefined;
    return {
      RTT:Math.round((local?.rtt || remote?.totalRtt || 0)), OutgoingAvailableBandwidth:0,
      RecvBitrate:Math.round((remote?.receivedKBitrate || 0) * 1000),
      SendBitrate:Math.round((local?.sentKBitrate || 0) * 1000),
      Duration:0, UserCount:this.remotes.size + 1,
    };
  }
  getNetworkQuality(selected?: number) {
    const user = selected === undefined ? undefined : this.remotes.get(selected);
    return { uplinkNetworkQuality:this.localQuality, downlinkNetworkQuality:user ? this.remoteQuality.get(Number(user.uid)) || 0 : 0 };
  }
  getLocalVideoStats() {
    const stats = this.localStats();
    if (!stats) throw new Error('暂未获取到统计信息。');
    return {
      sendResolutionWidth:Math.round(stats.encodedFrameWidth || 0), sendResolutionHeight:Math.round(stats.encodedFrameHeight || 0),
      captureResolutionWidth:Math.round(stats.encodedFrameWidth || 0), captureResolutionHeight:Math.round(stats.encodedFrameHeight || 0),
      captureFrameRate:stats.inputFrameRate || stats.sentFrameRate || 0, sendFrameRate:stats.sentFrameRate || 0,
      codecType:stats.codecType, sendBitrate:Math.round((stats.sentKBitrate || 0) * 1000),
      targetSendBitrate:Math.round((stats.targetKBitrate || 0) * 1000), sendRttMs:Math.round(stats.rtt || 0), encodeDelay:0,
    };
  }
  getRemoteVideoStats() {
    const result: Record<string, RemoteVideoStats> = {};
    for (const user of this.remotes.values()) {
      const stats = this.remoteStats(Number(user.uid));
      if (stats) result[String(user.uid)] = {
        receiveResolutionWidth:Math.round(stats.width || 0), receiveResolutionHeight:Math.round(stats.height || 0),
        receiveFrameRate:stats.decoderOutputFrameRate || stats.rendererOutputFrameRate || 0,
        decodeFrameRate:stats.decoderOutputFrameRate || 0, codecType:stats.codecType,
        receiveBitrate:Math.round((stats.receivedKBitrate || 0) * 1000),
        packetLossRate:(stats.videoLossRate || 0) * 100, currentPacketLossRate:(stats.videoLossRate || 0) * 100,
        receiveDelay:Math.round(stats.totalRtt || 0), transportDelay:Math.round(stats.totalRtt || 0),
        end2EndDelay:Math.round(stats.e2eDelay || 0),
      };
    }
    return result;
  }
}
