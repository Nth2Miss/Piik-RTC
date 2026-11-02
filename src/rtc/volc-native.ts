import type { CapturedScreen } from '../capture';
import { desktopBridge, type CaptureSelection, type DesktopBridge } from '../desktop/bridge.ts';
import { effectiveBitrate, encoderConfig, type Preferences } from '../preferences.ts';
import { browserVideoTrack } from './browser.ts';
import type { BrowserLocalVideoTrack, BrowserVideoTrack, LocalTrack, LocalVideoStats, MediaKind, RemoteVideoStats, RtcAdapter, RtcEventSink, RtcRemoteUser } from './types';
import { diagnosticNumber, encodingDiagnostics, statisticsObservation } from './diagnostics.ts';

type Command = NonNullable<DesktopBridge['nativeRtc']>;
type FrameTrack = BrowserVideoTrack & { getMediaStreamTrack(): MediaStreamTrack; close(): void };
const selections = new WeakMap<LocalTrack, CaptureSelection>();
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** The track is a native render handle; no dummy MediaStream is encoded in WebView2. */
export class VolcNativeAdapter implements RtcAdapter {
  private users = new Map<number, RtcRemoteUser>();
  private local: LocalVideoStats = {};
  private remote: Record<string, RemoteVideoStats> = {};
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private waiters = new Map<string, {resolve:()=>void; reject:(error:Error)=>void}>();
  private active = false;
  private revision = 0;
  private output = new Map<string, number>();
  private events: RtcEventSink;
  private command: Command;
  private frameConsumers = new Map<string, (frame: VideoFrame) => void>();
  constructor(events: RtcEventSink, command: Command) {
    this.events = events; this.command = command;
    desktopBridge?.onNativeFrame?.(({ frame, stream }) => {
      const consumer = this.frameConsumers.get(stream);
      if (consumer) consumer(frame); else frame.close();
    });
  }
  static async create(events: RtcEventSink) {
    if (!desktopBridge?.nativeRtc) return undefined;
    const command = desktopBridge.nativeRtc;
    const status = await command({operation:'available'});
    return status.available === true ? new VolcNativeAdapter(events,command) : undefined;
  }
  get remoteUsers() { return [...this.users.values()]; }
  private async request(operation: string, options: Record<string, unknown> = {}) { return this.command({operation,...options}); }
  private async confirmed(key: string, operation: () => Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const confirmation = new Promise<void>((resolve, reject) => {
      this.waiters.set(key,{resolve,reject});
      timer = setTimeout(() => reject(new Error('火山原生 SDK 确认超时。')),12000);
    });
    // Register before invoking the SDK: callbacks may arrive before the bridge reply.
    void confirmation.catch(() => {});
    try { await operation(); await confirmation; }
    finally { clearTimeout(timer); this.waiters.delete(key); }
  }
  private async poll() {
    if (this.polling || !this.active) return;
    const revision = this.revision;
    this.polling = true;
    try {
      const result = await this.request('poll');
      if (!this.active || revision !== this.revision) return;
      for (const event of Array.isArray(result.events) ? result.events : []) {
        if (!event || typeof event !== 'object') continue;
        this.receive(event as Record<string, unknown>);
      }
    } catch (error) {
      if (this.active && revision === this.revision) this.fail(error instanceof Error ? error : new Error('原生媒体事件读取失败。'));
    } finally { this.polling = false; }
  }
  private fail(error: Error) {
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.events.emit('screen-publish-error',error.message);
  }
  private receive(event: Record<string, unknown>) {
    if (event.type === 'connection') {
      if (event.state === 0) { this.waiters.get('join')?.resolve(); this.events.emit('connection-state-change','CONNECTED'); }
      else if (event.state === 1) this.fail(new Error(`火山原生连接失败（${number(event.reason)}）。`));
      else this.events.emit('connection-state-change','DISCONNECTED');
    } else if (event.type === 'token') this.events.emit('token-privilege-will-expire');
    else if (event.type === 'error') this.fail(new Error(`火山原生 SDK 错误（${number(event.code)}）。`));
    else if (event.type === 'publish-state') {
      if (event.state === 0) this.waiters.get('publish')?.resolve();
      else if (number(event.reason) > 1) this.fail(new Error(`火山原生发布失败（${number(event.reason)}）。`));
    } else if (event.type === 'local-stats') {
      this.local = {sendResolutionWidth:number(event.width),sendResolutionHeight:number(event.height),captureFrameRate:number(event.captureFps),sendFrameRate:number(event.sendFps),sendBitrate:number(event.bitrate),sendRttMs:number(event.rtt)};
      this.local.diagnostics = encodingDiagnostics({encoderOutputFps:diagnosticNumber(event.encoderFps)});
      this.local.observation = statisticsObservation('volc-native.onLocalStreamStats','callback',Date.now());
      this.output.set('',number(event.sendFps));
    } else if (event.type === 'remote-stats') {
      const user = this.remoteUsers.find(user => user.streamId === event.streamId);
      if (!user) return;
      this.remote[String(user.uid)] = {receiveResolutionWidth:number(event.width),receiveResolutionHeight:number(event.height),decodeFrameRate:number(event.decodeFps),renderFrameRate:number(event.renderFps),receiveBitrate:number(event.bitrate)};
      this.remote[String(user.uid)].observation = statisticsObservation('volc-native.onRemoteStreamStats','callback',Date.now());
      this.output.set(String(event.streamId),number(event.renderFps));
    } else if (event.type === 'publication') {
      const uid = Number(event.uid), kind = event.kind;
      if (!Number.isSafeInteger(uid) || uid <= 0 || (kind !== 'audio' && kind !== 'video') || typeof event.streamId !== 'string') return;
      let user = this.users.get(uid);
      if (!user) { user = {uid,hasVideo:false,hasAudio:false,streamId:event.streamId}; this.users.set(uid,user); }
      // A late removal for another stream cannot retire the current publication.
      if (event.published !== true && user.streamId !== event.streamId) return;
      if (user.streamId !== event.streamId) { user.videoTrack?.stop(); user.audioTrack?.stop(); user.videoTrack = undefined; user.audioTrack = undefined; user.hasVideo = user.hasAudio = false; }
      user.streamId = event.streamId;
      if (kind === 'video') { user.hasVideo = event.published === true; user.publicationRevision = (user.publicationRevision ?? 0) + 1; }
      else user.hasAudio = event.published === true;
      if (event.published !== true) { if (kind === 'video') {user.videoTrack?.stop();user.videoTrack = undefined;} else {user.audioTrack?.stop();user.audioTrack = undefined;} }
      this.events.emit(event.published === true ? 'user-published' : 'user-unpublished',user,kind);
    } else if (event.type === 'left') {
      const user = this.users.get(Number(event.uid));
      if (user) { user.videoTrack?.stop(); user.audioTrack?.stop(); this.users.delete(Number(event.uid)); this.events.emit('user-left',user); }
    }
  }
  async join(appId: string | number, room: string, token: string, uid: number) {
    this.active = true; this.revision++;
    this.events.emit('connection-state-change','CONNECTING');
    this.pollTimer = setInterval(() => { void this.poll(); },100);
    try { await this.confirmed('join',() => this.request('join',{appId:String(appId),room,token,uid:String(uid)})); return uid; }
    catch (error) { await this.leave(); throw error; }
  }
  async leave() {
    this.active = false; this.revision++; clearInterval(this.pollTimer);
    for (const waiter of this.waiters.values()) waiter.reject(new Error('媒体连接已取消。'));
    this.waiters.clear();
    this.users.forEach(user => {user.videoTrack?.stop();user.audioTrack?.stop();});
    await desktopBridge?.stopAudio?.().catch(() => {});
    await this.request('leave');
    this.users.clear(); this.remote = {}; this.local = {}; this.output.clear();
    this.events.emit('connection-state-change','DISCONNECTED');
  }
  private frameTrack(stream: string): FrameTrack {
    let generator: MediaStreamTrackGenerator | undefined;
    let writer: WritableStreamDefaultWriter<VideoFrame> | undefined;
    let view: BrowserVideoTrack | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let latest: VideoFrame | null = null;
    let writing = false;
    let closed = false;
    const ensureGenerator = () => {
      if (!generator) {
        generator = new MediaStreamTrackGenerator({ kind:'video' });
        writer = generator.writable.getWriter();
      }
      return generator;
    };
    const consume = (frame: VideoFrame) => {
      if (closed) { frame.close(); return; }
      if (latest) latest.close();
      latest = frame;
      if (writing) return;
      writing = true;
      void (async () => {
        while (latest && !closed) {
          const next = latest; latest = null;
          try { await writer?.write(next); } catch { /* dropped */ } finally { next.close(); }
        }
        writing = false;
      })();
    };
    const render = (visible: boolean) => { void this.request('render',{streamId:stream,visible}).catch(() => {}); };
    const unsubscribe = () => {
      clearInterval(timer); timer = undefined;
      this.frameConsumers.delete(stream);
      if (latest) latest.close();
      latest = null;
    };
    const track: FrameTrack = {
      getPlaybackState: () => view?.getPlaybackState?.() ?? { attached:false, readyState:0, paused:true, frames:0, droppedFrames:0, trackState: closed ? 'ended' : 'live' },
      getMediaStreamTrack() {
        if (closed) throw new Error('原生视频轨已关闭。');
        return ensureGenerator();
      },
      play: (container, options) => {
        if (closed) return;
        view ??= browserVideoTrack(ensureGenerator());
        view.play(container, options);
        this.frameConsumers.set(stream, consume);
        render(true);
        clearInterval(timer);
        timer = setInterval(() => { if (this.frameConsumers.has(stream)) render(true); },1000);
      },
      stop: () => {
        unsubscribe();
        view?.stop();
        render(false);
      },
      close: () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        view?.stop(); view = undefined;
        void writer?.abort().catch(() => {});
        writer = undefined; generator = undefined;
        render(false);
      },
    };
    return track;
  }
  async capture(selection: CaptureSelection, preferences: Preferences): Promise<CapturedScreen> {
    const config = encoderConfig(preferences);
    const size = await this.request('prepare',{sourceId:selection.sourceId,width:config.width || 7680,height:config.height || 4320});
    let closed = false;
    const preview = this.frameTrack('');
    const track: BrowserLocalVideoTrack = {
      trackMediaType:'video',get enabled() {return !closed;},
      getMediaStreamTrack() { return preview.getMediaStreamTrack(); },
      play:preview.play,stop:preview.stop,close:() => { closed = true; preview.close(); selections.delete(track); },
    };
    selections.set(track,selection);
    return {tracks:[track],width:number(size.width),height:number(size.height),hasAudio:preferences.audio && selection.audio !== 'none',surface:selection.kind === 'window' ? 'window' : 'monitor',onEnded() {},close:track.close};
  }
  async publish(tracks: LocalTrack[], preferences?: Preferences, size?: {width:number;height:number}) {
    const selection = selections.get(tracks[0]);
    if (!selection || !preferences || !size) throw new Error('原生共享来源已失效。');
    const audio = preferences.audio && selection.audio !== 'none';
    const externalAudio = audio && (selection.audio === 'app' || (selection.audio === 'system' && !!selection.filterPid));
    let audioStarted = false;
    if (externalAudio) {
      if (!desktopBridge?.startAudio) throw new Error('原生音频组件不可用，本次只能共享画面。');
      const mode = selection.audio === 'app' ? 'include' : 'exclude';
      const pid = selection.audio === 'app' ? selection.pid : selection.filterPid;
      await desktopBridge.startAudio({ mode, pid: pid ?? null, native: true });
      audioStarted = true;
    }
    try {
      await this.confirmed('publish',() => this.request('start',{sourceId:selection.sourceId,...size,fps:preferences.fps,bitrate:effectiveBitrate(preferences),audio,audioMode:selection.audio,externalAudio,externalVideo:true}));
    } catch (error) {
      if (audioStarted) void desktopBridge?.stopAudio?.().catch(() => {});
      throw error;
    }
  }
  async unpublish(_tracks: LocalTrack[]) { await desktopBridge?.stopAudio?.().catch(() => {}); await this.request('stop'); this.local = {}; this.output.delete(''); }
  async renewToken(token: string) { await this.request('token',{token}); }
  async subscribe(user: RtcRemoteUser, kind: MediaKind, signal?: AbortSignal) {
    const streamId = user.streamId, revision = user.publicationRevision;
    if (!streamId) throw new Error('原生流尚未就绪。');
    await this.request('subscribe',{streamId,kind,enabled:true});
    if (signal?.aborted || this.users.get(Number(user.uid)) !== user || user.streamId !== streamId || user.publicationRevision !== revision) {
      if (user.streamId === streamId && user.publicationRevision === revision) await this.request('subscribe',{streamId,kind,enabled:false});
      return;
    }
    if (kind === 'video') user.videoTrack = this.videoTrack(streamId);
    else {
      let volume = 80;
      const apply = (value: number) => { if (this.active && this.users.get(Number(user.uid)) === user && user.streamId === streamId && user.publicationRevision === revision) void this.request('volume',{volume:value}).catch(() => {}); };
      user.audioTrack = {setVolume:value=>{volume=value;apply(value);},play:()=>apply(volume),stop:()=>apply(0)};
    }
  }
  async unsubscribe(user: RtcRemoteUser) {
    user.videoTrack?.stop(); user.audioTrack?.stop();
    if (user.streamId) for (const kind of ['video','audio']) await this.request('subscribe',{streamId:user.streamId,kind,enabled:false});
    delete this.remote[String(user.uid)];
    if (user.streamId) this.output.delete(user.streamId);
    user.videoTrack = undefined; user.audioTrack = undefined;
  }
  private videoTrack(streamId: string): BrowserVideoTrack { return this.frameTrack(streamId); }
  getRTCStats() { return {RTT:this.local.sendRttMs,SendBitrate:this.local.sendBitrate ?? 0,RecvBitrate:Object.values(this.remote).reduce((sum,value)=>sum+(value.receiveBitrate??0),0),Duration:0,UserCount:this.users.size+1}; }
  getNetworkQuality() { return {uplinkNetworkQuality:0,downlinkNetworkQuality:0}; }
  getLocalVideoStats() { return {...this.local}; }
  getRemoteVideoStats() { return {...this.remote}; }
}
