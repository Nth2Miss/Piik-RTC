import AgoraRTC from 'agora-rtc-sdk-ng';

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

/** Presents the existing room controller with the same transport operations for each SDK. */
export class RtcClient {
  private agora = AgoraRTC.createClient({ mode:'rtc', codec:'vp8' });
  private provider: 'agora'|'zego'|'volc' = 'agora';
  private engine: any;
  private sdk: any;
  private room = '';
  private uid = 0;
  private zegoLocal?: MediaStream;
  private remotes = new Map<number, Remote>();
  private handlers = new Map<string, ((...args:any[]) => void)[]>();
  constructor() {
    for (const event of ['connection-state-change', 'user-joined', 'user-published', 'user-unpublished', 'user-left', 'token-privilege-will-expire', 'token-privilege-did-expire']) {
      (this.agora as any).on(event, (...args:any[]) => { if (this.provider === 'agora') this.emit(event, ...args); });
    }
  }
  on(event:string, handler:(...args:any[]) => void) { this.handlers.set(event, [...(this.handlers.get(event) || []), handler]); }
  private emit(event:string, ...args:any[]) { for (const handler of this.handlers.get(event) || []) handler(...args); }
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
  async setProvider(provider:'agora'|'zego'|'volc') { this.provider = provider; this.remotes.clear(); this.engine = undefined; this.sdk = undefined; }
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
      await engine.joinRoom(token, room, { userId:String(uid) }, { isAutoPublish:false, isAutoSubscribeAudio:false, isAutoSubscribeVideo:false });
    }
    this.emit('connection-state-change', 'CONNECTED');
    return uid;
  }
  async leave() {
    if (this.provider === 'agora') return this.agora.leave();
    const engine = this.engine; this.engine = undefined;
    if (engine) { if (this.provider === 'zego') { engine.logoutRoom(this.room); engine.destroyEngine(); } else { await engine.leaveRoom(); this.sdk.destroyEngine(engine); } }
    this.remotes.clear(); this.emit('billing-change'); this.emit('connection-state-change', 'DISCONNECTED');
  }
  async publish(tracks:any[]) {
    if (this.provider === 'agora') return this.agora.publish(tracks);
    const raw = tracks.map(track => track.getMediaStreamTrack());
    if (this.provider === 'zego') {
      const stream = await this.engine.createStream({ custom: { source:new MediaStream(raw) } });
      this.zegoLocal = stream;
      if (!this.engine.startPublishingStream(`${this.room}_${this.uid}`, stream)) { this.engine.destroyStream(stream); this.zegoLocal = undefined; throw new Error('即构推流失败。'); }
    }
    else {
      const rtc = this.sdk, index = rtc.StreamIndex.STREAM_INDEX_SCREEN;
      await this.engine.setVideoSourceType(index, rtc.VideoSourceType.VIDEO_SOURCE_TYPE_EXTERNAL);
      await this.engine.setExternalVideoTrack(index, raw.find((t:MediaStreamTrack) => t.kind === 'video'));
      const audio = raw.find((t:MediaStreamTrack) => t.kind === 'audio');
      if (audio) { await this.engine.setAudioSourceType(index, rtc.AudioSourceType.AUDIO_SOURCE_TYPE_EXTERNAL); await this.engine.setExternalAudioTrack(index, audio); }
      await this.engine.publishScreen(audio ? rtc.MediaType.AUDIO_AND_VIDEO : rtc.MediaType.VIDEO);
    }
  }
  async unpublish(tracks:any[]) {
    if (this.provider === 'agora') return this.agora.unpublish(tracks);
    if (!this.engine) return;
    if (this.provider === 'zego') { this.engine.stopPublishingStream(`${this.room}_${this.uid}`); if (this.zegoLocal) this.engine.destroyStream(this.zegoLocal); this.zegoLocal = undefined; }
    else await this.engine.unpublishScreen(this.sdk.MediaType.AUDIO_AND_VIDEO);
  }
  async subscribe(user:Remote, kind:Kind) {
    if (this.provider === 'agora') return this.agora.subscribe(user as any, kind);
    if (this.provider === 'zego') { if (!user.stream) { user.stream = await this.engine.startPlayingStream(user.streamId); this.emit('billing-change'); } }
    else { await this.engine.subscribeScreen(String(user.uid), kind === 'audio' ? this.sdk.MediaType.AUDIO : this.sdk.MediaType.VIDEO); }
    const track:MediaStreamTrack | undefined = this.provider === 'zego' ? (kind === 'video' ? user.stream?.getVideoTracks()[0] : user.stream?.getAudioTracks()[0]) : this.engine.getRemoteStreamTrack(String(user.uid), this.sdk.StreamIndex.STREAM_INDEX_SCREEN, kind);
    if (track) { if (kind === 'video') user.videoTrack = videoTrack(track); else user.audioTrack = audioTrack(track); }
  }
  async unsubscribe(user:Remote) {
    if (this.provider === 'agora') return this.agora.unsubscribe(user as any);
    if (this.provider === 'zego') { if (user.streamId) this.engine?.stopPlayingStream(user.streamId); user.stream = undefined; this.emit('billing-change'); }
    else if (this.engine) await this.engine.unsubscribeScreen(String(user.uid), this.sdk.MediaType.AUDIO_AND_VIDEO);
    user.videoTrack = undefined; user.audioTrack = undefined;
  }
  async renewToken(token:string) { if (this.provider === 'agora') return this.agora.renewToken(token); if (this.provider === 'zego') { if (!this.engine.renewToken(token, this.room)) throw new Error('即构 Token 续期失败。'); } else await this.engine.updateToken(token); }
  getRTCStats() { if (this.provider !== 'agora') throw new Error('暂无统计'); return this.agora.getRTCStats(); }
  getNetworkQuality() { if (this.provider !== 'agora') throw new Error('暂无统计'); return this.agora.getNetworkQuality(); }
  getLocalVideoStats() { if (this.provider !== 'agora') throw new Error('暂无统计'); return this.agora.getLocalVideoStats(); }
  getRemoteVideoStats() { if (this.provider !== 'agora') throw new Error('暂无统计'); return this.agora.getRemoteVideoStats(); }
}
