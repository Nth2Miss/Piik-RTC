import AgoraRTC from 'agora-rtc-sdk-ng';
import { encoderConfig, ZEGO_MAX_BITRATE, type Preferences } from './preferences';
import type { RtcProvider } from './types';

type Kind = 'audio' | 'video';
type Remote = { uid:number; hasAudio:boolean; hasVideo:boolean; videoTrack?:any; audioTrack?:any; streamId?:string; stream?:MediaStream };

function videoTrack(track: MediaStreamTrack) {
  let element: HTMLVideoElement | undefined;
  return {
    getMediaStreamTrack() { return track; },
    play(container: HTMLElement, options?: { fit?: string }) {
      element = document.createElement('video'); element.autoplay = true; element.playsInline = true; element.muted = true;
      element.style.width = '100%'; element.style.height = '100%'; element.style.objectFit = options?.fit || 'contain';
      element.srcObject = new MediaStream([track]); container.replaceChildren(element); void element.play().catch(() => {});
    },
    stop() { if (element) { element.pause(); element.srcObject = null; element.remove(); element = undefined; } },
  };
}
function audioTrack(track: MediaStreamTrack) {
  let volume = 80, element: HTMLAudioElement | undefined;
  const resume = () => { if (element) void element.play().catch(() => {}); };
  return { setVolume(value:number) { volume = value; if (element) element.volume = value / 100; },
    play() { if (!element) { element = document.createElement('audio'); element.autoplay = true; element.srcObject = new MediaStream([track]); } element.volume = volume / 100; void element.play().catch(() => document.addEventListener('click', resume, { once:true })); },
    stop() { document.removeEventListener('click', resume); if (element) { element.pause(); element.srcObject = null; element = undefined; } },
  };
}
// Zego reports qualities from 0 (excellent) to 4 (bad); the UI labels follow
// Agora/Volcengine's 1 (excellent) to 6 (disconnected) scale.
const zegoQuality = (value?: number) => [1, 2, 3, 5, 6][Number(value)] || 0;
const packetLossPercent = (value?: number) => {
  if (!Number.isFinite(value) || !value || value <= 0) return 0;
  return value <= 1 ? value * 100 : value;
};

/** Presents the existing room controller with the same transport operations for each SDK. */
export class RtcClient {
  // H.264 is available in desktop Chrome/Edge and usually hardware accelerated,
  // which keeps 1080p screen sharing from saturating the CPU.
  private agora = AgoraRTC.createClient({ mode:'rtc', codec:'h264' });
  private provider: 'agora'|'zego'|'volc' = 'agora';
  private engine: any;
  private sdk: any;
  private room = '';
  private uid = 0;
  private zegoLocal?: MediaStream;
  private remotes = new Map<number, Remote>();
  private handlers = new Map<string, ((...args:any[]) => void)[]>();
  private volcLocalQuality = 0;
  private volcRemoteQuality = new Map<number, number>();
  private statsCache = new Map<string, { at:number; value:any }>();
  constructor() {
    for (const event of ['connection-state-change', 'user-joined', 'user-published', 'user-unpublished', 'user-left', 'token-privilege-will-expire', 'token-privilege-did-expire']) {
      (this.agora as any).on(event, (...args:any[]) => { if (this.provider === 'agora') this.emit(event, ...args); });
    }
  }
  on(event:string, handler:(...args:any[]) => void) { this.handlers.set(event, [...(this.handlers.get(event) || []), handler]); }
  private emit(event:string, ...args:any[]) { for (const handler of this.handlers.get(event) || []) handler(...args); }
  private cached(key:string, ttl:number, read:() => any) {
    const hit = this.statsCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    let value: any;
    try { value = read(); } catch { value = undefined; }
    this.statsCache.set(key, { at:Date.now(), value });
    return value;
  }
  get remoteUsers(): any[] { return this.provider === 'agora' ? this.agora.remoteUsers : [...this.remotes.values()]; }
  get zegoPulls() {
    if (this.provider !== 'zego') return undefined;
    return [...this.remotes.values()].filter(user => user.stream).map(user => {
      const video = user.stream!.getVideoTracks().find(track => track.readyState !== 'ended');
      const audio = user.stream!.getAudioTracks().find(track => track.readyState !== 'ended');
      const settings = video?.getSettings();
      // A newly started screen stream can expose its tracks asynchronously.
      return { uid:user.uid, kind:video || (!audio && user.hasVideo) ? 'video' : 'audio', width:settings?.width || 0, height:settings?.height || 0 };
    });
  }
  async setProvider(provider:RtcProvider) {
    this.provider = provider === 'volc2' ? 'volc' : provider;
    this.remotes.clear(); this.engine = undefined; this.sdk = undefined;
    this.volcLocalQuality = 0; this.volcRemoteQuality.clear(); this.statsCache.clear();
  }
  private remote(uid:number):Remote { let user = this.remotes.get(uid); if (!user) { user = { uid, hasAudio:false, hasVideo:false }; this.remotes.set(uid, user); } return user; }
  async join(appId:string|number, room:string, token:string, uid:number) {
    if (this.provider === 'agora') return this.agora.join(String(appId), room, token, uid);
    this.room = room; this.uid = uid;
    this.emit('connection-state-change', 'CONNECTING');
    if (this.provider === 'zego') {
      const { ZegoExpressEngine } = await import('zego-express-engine-webrtc');
      const engine = this.engine = new ZegoExpressEngine(Number(appId), '');
      engine.on('roomStateChanged', (_room:string, reason:string) => {
        if (this.engine !== engine) return;
        if (reason === 'RECONNECTING') this.emit('connection-state-change', 'RECONNECTING');
        else if (reason === 'RECONNECTED') this.emit('connection-state-change', 'CONNECTED');
        else if (reason === 'RECONNECT_FAILED' || reason === 'KICKOUT') this.emit('connection-state-change', 'DISCONNECTED');
      });
      engine.on('roomStreamUpdate', (_room:string, action:'ADD'|'DELETE', streams:any[]) => {
        for (const stream of streams) {
          const id = Number(stream.user.userID); if (!Number.isSafeInteger(id) || id === this.uid) continue;
          const user = this.remote(id); user.streamId = stream.streamID;
          if (action === 'ADD') { user.hasAudio = true; user.hasVideo = true; this.emit('user-published', user, 'video'); }
          else { user.hasAudio = false; user.hasVideo = false; this.emit('user-unpublished', user, 'video'); this.remotes.delete(id); this.emit('billing-change'); }
        }
      });
      engine.on('tokenWillExpire', () => this.emit('token-privilege-will-expire'));
      const ok = await engine.loginRoom(room, token, { userID:String(uid), userName:String(uid) }, { userUpdate:true });
      if (!ok) throw new Error('即构房间连接失败。');
    } else {
      const mod = await import('@volcengine/rtc'); const rtc = mod.default;
      this.sdk = { ...mod, events:rtc.events, destroyEngine:(engine:any) => rtc.destroyEngine(engine) };
      const engine = this.engine = rtc.createEngine(String(appId));
      engine.on(rtc.events.onConnectionStateChanged, ({ state }:any) => {
        if (this.engine !== engine) return;
        if (state === 4) this.emit('connection-state-change', 'RECONNECTING');
        else if (state === 5) this.emit('connection-state-change', 'CONNECTED');
        else if (state === 1) this.emit('connection-state-change', 'DISCONNECTED');
      });
      engine.on(rtc.events.onUserPublishScreen, ({ userId, mediaType }:any) => {
        const user = this.remote(Number(userId)); if (mediaType & 1) user.hasAudio = true; if (mediaType & 2) user.hasVideo = true;
        if (mediaType & 2) this.emit('user-published', user, 'video'); if (mediaType & 1) this.emit('user-published', user, 'audio');
      });
      engine.on(rtc.events.onUserUnpublishScreen, ({ userId, mediaType }:any) => {
        const user = this.remote(Number(userId)); if (mediaType & 1) { user.hasAudio = false; this.emit('user-unpublished', user, 'audio'); } if (mediaType & 2) { user.hasVideo = false; this.emit('user-unpublished', user, 'video'); }
      });
      engine.on(rtc.events.onUserLeave, ({ userInfo }:any) => { const id = Number(userInfo?.userId); const user = this.remotes.get(id); if (user) { this.remotes.delete(id); this.emit('user-left', user); } });
      engine.on(rtc.events.onTokenWillExpire, () => this.emit('token-privilege-will-expire'));
      // Screen audio is played by the RTC engine itself; setPlaybackVolume controls it.
      engine.on(rtc.events.onLocalStreamStats, (stats:any) => {
        if (this.engine === engine && stats?.isScreen) this.volcLocalQuality = Number(stats.txQuality) || 0;
      });
      engine.on(rtc.events.onRemoteStreamStats, (stats:any) => {
        if (this.engine !== engine) return;
        const id = Number(stats?.userId);
        if (Number.isSafeInteger(id) && id > 0) this.volcRemoteQuality.set(id, Number(stats?.rxQuality) || 0);
      });
      await engine.joinRoom(token, room, { userId:String(uid) }, { isAutoPublish:false, isAutoSubscribeAudio:false, isAutoSubscribeVideo:false });
    }
    this.emit('connection-state-change', 'CONNECTED');
    return uid;
  }
  async leave() {
    if (this.provider === 'agora') return this.agora.leave();
    const engine = this.engine; this.engine = undefined;
    if (engine) { if (this.provider === 'zego') { engine.logoutRoom(this.room); engine.destroyEngine(); } else { await engine.leaveRoom(); this.sdk.destroyEngine(engine); } }
    this.remotes.clear(); this.volcLocalQuality = 0; this.volcRemoteQuality.clear(); this.statsCache.clear();
    this.emit('billing-change'); this.emit('connection-state-change', 'DISCONNECTED');
  }
  async publish(tracks:any[], preferences?:Preferences) {
    if (this.provider === 'agora') return this.agora.publish(tracks);
    const raw = tracks.map(track => track.getMediaStreamTrack());
    if (this.provider === 'zego') {
      // Forward the selected bitrate and optimisation mode; otherwise the
      // custom stream keeps Zego's own publish defaults.
      const stream = await this.engine.createStream({ custom: {
        source:new MediaStream(raw),
        ...(preferences ? { bitrate:Math.min(preferences.bitrate, ZEGO_MAX_BITRATE), audioBitrate:128,
          videoOptimizationMode:preferences.optimization === 'motion' ? 'motion' : preferences.optimization === 'detail' ? 'detail' : 'default' } : {}),
      } });
      this.zegoLocal = stream;
      if (!this.engine.startPublishingStream(`${this.room}_${this.uid}`, stream)) { this.engine.destroyStream(stream); this.zegoLocal = undefined; throw new Error('即构推流失败。'); }
    }
    else {
      const rtc = this.sdk, index = rtc.StreamIndex.STREAM_INDEX_SCREEN;
      const video = raw.find((t:MediaStreamTrack) => t.kind === 'video');
      if (!video) throw new Error('共享画面缺少视频轨，请重新选择。');
      if (preferences) {
        const config = encoderConfig(preferences);
        const settings = video.getSettings();
        // Without this the engine publishes screen video at its 15 fps,
        // 3000 kbps default regardless of the sharing settings. Use the
        // captured size so non-16:9 windows keep their aspect ratio.
        await this.engine.setScreenEncoderConfig({
          width:settings.width || config.width, height:settings.height || config.height, frameRate:config.frameRate,
          maxKbps:preferences.bitrate, contentHint:preferences.optimization === 'motion' ? 'motion' : 'detail',
        });
      }
      await this.engine.setVideoSourceType(index, rtc.VideoSourceType.VIDEO_SOURCE_TYPE_EXTERNAL);
      await this.engine.setExternalVideoTrack(index, video);
      const audio = raw.find((t:MediaStreamTrack) => t.kind === 'audio');
      if (audio) { await this.engine.setAudioSourceType(index, rtc.AudioSourceType.AUDIO_SOURCE_TYPE_EXTERNAL); await this.engine.setExternalAudioTrack(index, audio); }
      await this.engine.publishScreen(audio ? rtc.MediaType.AUDIO_AND_VIDEO : rtc.MediaType.VIDEO);
    }
  }
  async unpublish(tracks:any[]) {
    if (this.provider === 'agora') return this.agora.unpublish(tracks);
    if (!this.engine) return;
    if (this.provider === 'zego') { this.engine.stopPublishingStream(`${this.room}_${this.uid}`); if (this.zegoLocal) this.engine.destroyStream(this.zegoLocal); this.zegoLocal = undefined; }
    else {
      await this.engine.unpublishScreen(this.sdk.MediaType.AUDIO_AND_VIDEO);
      // unpublishScreen keeps the external screen track, so the next share's
      // setScreenEncoderConfig would apply constraints to the stopped track and
      // the browser rejects it ("Source failed to restart"). Switching back to
      // internal capture makes the SDK release that track.
      const index = this.sdk.StreamIndex.STREAM_INDEX_SCREEN;
      await this.engine.setVideoSourceType(index, this.sdk.VideoSourceType.VIDEO_SOURCE_TYPE_INTERNAL);
      await this.engine.setAudioSourceType(index, this.sdk.AudioSourceType.AUDIO_SOURCE_TYPE_INTERNAL);
    }
    this.statsCache.delete('zego:publish');
  }
  async subscribe(user:Remote, kind:Kind) {
    if (this.provider === 'agora') return this.agora.subscribe(user as any, kind);
    if (this.provider === 'zego') { if (!user.stream) { user.stream = await this.engine.startPlayingStream(user.streamId); this.emit('billing-change'); } }
    else {
      await this.engine.subscribeScreen(String(user.uid), kind === 'audio' ? this.sdk.MediaType.AUDIO : this.sdk.MediaType.VIDEO);
      // The engine auto-plays subscribed screen audio. A second <audio>
      // element would duplicate the sound and ignore SDK volume changes.
      if (kind === 'audio') { user.audioTrack = this.volcAudioTrack(user.uid); return; }
    }
    const track:MediaStreamTrack | undefined = this.provider === 'zego' ? (kind === 'video' ? user.stream?.getVideoTracks()[0] : user.stream?.getAudioTracks()[0]) : this.engine.getRemoteStreamTrack(String(user.uid), this.sdk.StreamIndex.STREAM_INDEX_SCREEN, kind);
    if (track) { if (kind === 'video') user.videoTrack = videoTrack(track); else user.audioTrack = audioTrack(track); }
  }
  private volcAudioTrack(uid:number) {
    const engine = this.engine, sdk = this.sdk, id = String(uid);
    return {
      setVolume(value:number) { engine?.setPlaybackVolume(id, sdk.StreamIndex.STREAM_INDEX_SCREEN, Math.max(0, Math.min(400, value))); },
      play() { /* Playback is owned by the RTC engine. */ },
      stop() { /* unsubscribeScreen stops playback. */ },
    };
  }
  async unsubscribe(user:Remote) {
    if (this.provider === 'agora') return this.agora.unsubscribe(user as any);
    if (this.provider === 'zego') { if (user.streamId) this.engine?.stopPlayingStream(user.streamId); user.stream = undefined; this.emit('billing-change'); }
    else if (this.engine) await this.engine.unsubscribeScreen(String(user.uid), this.sdk.MediaType.AUDIO_AND_VIDEO);
    user.videoTrack = undefined; user.audioTrack = undefined;
  }
  async renewToken(token:string) { if (this.provider === 'agora') return this.agora.renewToken(token); if (this.provider === 'zego') { if (!this.engine.renewToken(token, this.room)) throw new Error('即构 Token 续期失败。'); } else await this.engine.updateToken(token); }
  private zegoPublishStats() {
    if (!this.engine) return undefined;
    return this.cached('zego:publish', 2500, () => this.engine.getPublishingStreamQuality(`${this.room}_${this.uid}`));
  }
  private zegoPlayStats(streamId:string) {
    if (!this.engine) return undefined;
    return this.cached(`zego:play:${streamId}`, 2500, () => this.engine.getPlayingStreamQuality(streamId));
  }
  private volcLocalStats() {
    if (!this.engine) return undefined;
    return this.cached('volc:local', 1000, () => this.engine.getLocalVideoStats())?.screenVideoStats;
  }
  private volcRemoteStats(uid:number) {
    if (!this.engine) return undefined;
    return this.cached(`volc:remote:${uid}`, 1000, () => {
      const entry = this.engine.getRemoteVideoStats()?.[String(uid)];
      const items = Array.isArray(entry) ? entry : entry ? [entry] : [];
      return items.find((item:any) => item?.screenVideoStats?.width)?.screenVideoStats
        ?? items.find((item:any) => item?.mainVideoStats?.width)?.mainVideoStats
        ?? items[0]?.screenVideoStats ?? items[0]?.mainVideoStats;
    });
  }
  getRTCStats(selected?:number) {
    if (this.provider === 'agora') return this.agora.getRTCStats();
    let local:any, play:any, remote:any;
    const watched = selected === undefined || selected === this.uid ? undefined : this.remotes.get(selected);
    const first = selected === this.uid ? undefined : watched ?? (this.provider === 'zego'
      ? [...this.remotes.values()].find(user => user.streamId)
      : [...this.remotes.values()][0]);
    if (this.provider === 'zego') {
      local = this.zegoPublishStats();
      play = first?.streamId ? this.zegoPlayStats(first.streamId) : undefined;
    } else {
      local = this.volcLocalStats();
      remote = first ? this.volcRemoteStats(first.uid) : undefined;
    }
    return {
      RTT: Math.round((this.provider === 'volc' ? (local?.rtt || remote?.totalRtt) : 0) || 0),
      OutgoingAvailableBandwidth: 0,
      RecvBitrate: Math.round(((this.provider === 'zego' ? play?.video?.videoBitrate : remote?.receivedKBitrate) || 0) * 1000),
      SendBitrate: Math.round(((this.provider === 'zego' ? local?.video?.videoBitrate : local?.sentKBitrate) || 0) * 1000),
      Duration: 0,
      UserCount: this.remotes.size + 1,
    };
  }
  getNetworkQuality(selected?:number) {
    if (this.provider === 'agora') return this.agora.getNetworkQuality();
    if (this.provider === 'zego') {
      const user = selected === undefined ? undefined : this.remotes.get(selected);
      const first = user ?? [...this.remotes.values()].find(item => item.streamId);
      return { uplinkNetworkQuality:zegoQuality(this.zegoPublishStats()?.video?.videoQuality),
        downlinkNetworkQuality:zegoQuality(first?.streamId ? this.zegoPlayStats(first.streamId)?.video?.videoQuality : undefined) };
    }
    const user = selected === undefined ? undefined : this.remotes.get(selected);
    return { uplinkNetworkQuality:this.volcLocalQuality, downlinkNetworkQuality:user ? this.volcRemoteQuality.get(user.uid) || 0 : 0 };
  }
  getLocalVideoStats() {
    if (this.provider === 'agora') return this.agora.getLocalVideoStats();
    if (this.provider === 'zego') {
      const stats = this.zegoPublishStats()?.video;
      if (!stats) throw new Error('暂未获取到统计信息。');
      return {
        sendResolutionWidth:Math.round(stats.frameWidth || 0), sendResolutionHeight:Math.round(stats.frameHeight || 0),
        captureResolutionWidth:Math.round(stats.frameWidth || 0), captureResolutionHeight:Math.round(stats.frameHeight || 0),
        captureFrameRate:stats.videoFPS || 0, sendFrameRate:stats.videoFPS || 0,
        codecType:stats.googCodecName, sendBitrate:Math.round((stats.videoBitrate || 0) * 1000),
        targetSendBitrate:0, sendRttMs:0, encodeDelay:0,
      };
    }
    const stats = this.volcLocalStats();
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
    if (this.provider === 'agora') return this.agora.getRemoteVideoStats();
    const result: Record<string, any> = {};
    for (const user of this.remotes.values()) {
      if (this.provider === 'zego') {
        if (!user.stream || !user.streamId) continue;
        const stats = this.zegoPlayStats(user.streamId);
        const video = stats?.video;
        if (video) result[String(user.uid)] = {
          receiveResolutionWidth:Math.round(video.frameWidth || 0), receiveResolutionHeight:Math.round(video.frameHeight || 0),
          receiveFrameRate:video.videoFPS || 0, decodeFrameRate:video.videoTransferFPS || video.videoRenderFPS || 0,
          codecType:video.googCodecName, receiveBitrate:Math.round((video.videoBitrate || 0) * 1000),
          packetLossRate:packetLossPercent(video.videoPacketsLostRate), currentPacketLossRate:packetLossPercent(video.videoPacketsLostRate),
          receiveDelay:Math.round(stats?.peerToPeerDelay || 0), transportDelay:Math.round(stats?.peerToPeerDelay || 0),
          end2EndDelay:Math.round(stats?.peerToPeerDelay || 0),
        };
      } else {
        const stats = this.volcRemoteStats(user.uid);
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
    }
    return result;
  }
}
