import type { IRTCEngine, LocalVideoStats as VolcLocalVideoStats, RemoteVideoStats as VolcRemoteVideoStats } from '@volcengine/rtc';
import { encoderConfig, effectiveBitrate, videoContentHint, type Preferences } from '../preferences.ts';
import { browserVideoTrack, StatsCache } from './browser.ts';
import { SubscriptionTasks } from './subscriptions.ts';
import { diagnosticNumber, encodingDiagnostics, statisticsObservation } from './diagnostics.ts';
import { VolcStartupWatch } from './volc-startup.ts';
import type { BrowserAudioTrack, LocalTrack, MediaKind, RemoteVideoStats, RtcAdapter, RtcEventSink, RtcRemoteUser } from './types';

type VolcModule = typeof import('@volcengine/rtc');

export class VolcRtcAdapter implements RtcAdapter {
  private engine?: IRTCEngine;
  private sdk?: VolcModule;
  private uid = 0;
  private roomReady = false;
  private remotes = new Map<number, RtcRemoteUser>();
  private localQuality = 0;
  private remoteQuality = new Map<number, number>();
  private remoteScreen = new Map<number, { at:number; stats:VolcRemoteVideoStats }>();
  private localScreen?: { at:number; stats:VolcLocalVideoStats };
  private cache = new StatsCache();
  private subscriptions = new SubscriptionTasks();
  private revision = 0;
  private screenTasks: Promise<void> = Promise.resolve();
  private screenEngine?: IRTCEngine;
  private coldPublication = true;
  private publication?: { engine:IRTCEngine; video:MediaStreamTrack; mediaType:Parameters<IRTCEngine['publishScreen']>[0]; watch?:VolcStartupWatch };
  private startupWatch?: VolcStartupWatch;
  private events: RtcEventSink;
  private loadSdk: () => Promise<VolcModule>;
  constructor(events: RtcEventSink, loadSdk = () => import('@volcengine/rtc')) { this.events = events; this.loadSdk = loadSdk; }
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
    const revision = ++this.revision;
    this.uid = uid;
    this.events.emit('connection-state-change', 'CONNECTING');
    const mod = await this.loadSdk(), rtc = mod.default;
    if (revision !== this.revision) throw new Error('媒体连接已取消。');
    this.sdk = mod;
    // The Web SDK gates remote stats callbacks behind this global switch; enable
    // it so onRemoteStreamStats carries screen video and audio statistics.
    try { rtc.setParameter('UPLOAD_REMOTE_STATS', 'video,audio'); } catch { /* older SDK builds */ }
    const engine = this.engine = rtc.createEngine(String(appId));
    this.roomReady = false;
    this.coldPublication = true; this.startupWatch = undefined;
    engine.on(rtc.events.onConnectionStateChanged, ({ state }) => {
      if (this.engine !== engine) return;
      if (state === 4) this.events.emit('connection-state-change', 'RECONNECTING');
      else if (state === 5) this.events.emit('connection-state-change', 'CONNECTED');
      else if (state === 1) this.events.emit('connection-state-change', 'DISCONNECTED');
    });
    const published = (index: 0 | 1) => ({ userId, mediaType }: {userId:string;mediaType:number}) => {
      if (this.engine !== engine) return;
      const user = this.remote(Number(userId));
      if (user.streamIndex !== undefined && user.streamIndex !== index) {
        user.videoTrack?.stop(); user.audioTrack?.stop(); user.videoTrack = undefined; user.audioTrack = undefined;
        user.hasAudio = false; user.hasVideo = false; this.subscriptions.cancel(user);
        user.publicationRevision = (user.publicationRevision ?? 0) + 1;
      }
      user.streamIndex = index;
      if ((mediaType & 2) && !user.hasVideo) user.publicationRevision = (user.publicationRevision ?? 0) + 1;
      if (mediaType & 1) user.hasAudio = true; if (mediaType & 2) user.hasVideo = true;
      if (mediaType & 2) this.events.emit('user-published', user, 'video'); if (mediaType & 1) this.events.emit('user-published', user, 'audio');
    };
    engine.on(rtc.events.onUserPublishScreen, published(1));
    if (rtc.events.onUserPublishStream) engine.on(rtc.events.onUserPublishStream, published(0));
    const unpublished = (index: 0 | 1) => ({ userId, mediaType }: {userId:string;mediaType:number}) => {
      if (this.engine !== engine) return;
      const user = this.remote(Number(userId));
      if ((user.streamIndex ?? 1) !== index) return;
      if (mediaType & 2) {
        user.hasVideo = false;
        user.videoTrack?.stop(); user.videoTrack = undefined;
        user.audioTrack?.stop(); user.audioTrack = undefined;
        user.publicationRevision = (user.publicationRevision ?? 0) + 1;
        this.subscriptions.cancel(user);
        this.remoteScreen.delete(Number(userId)); this.cache.delete(`volc:remote:${userId}`);
      }
      if (mediaType & 1) { user.hasAudio = false; user.audioTrack?.stop(); user.audioTrack = undefined; }
      if (mediaType & 2) this.events.emit('user-unpublished', user, 'video');
      if (mediaType & 1) this.events.emit('user-unpublished', user, 'audio');
    };
    engine.on(rtc.events.onUserUnpublishScreen, unpublished(1));
    if (rtc.events.onUserUnpublishStream) engine.on(rtc.events.onUserUnpublishStream, unpublished(0));
    engine.on(rtc.events.onUserLeave, ({ userInfo }) => {
      if (this.engine !== engine) return;
      const id = Number(userInfo?.userId), user = this.remotes.get(id);
      if (user) {
        user.videoTrack?.stop(); user.audioTrack?.stop(); user.videoTrack = undefined; user.audioTrack = undefined;
        user.publicationRevision = (user.publicationRevision ?? 0) + 1;
        user.hasAudio = false; user.hasVideo = false; this.subscriptions.cancel(user);
        this.remotes.delete(id); this.remoteScreen.delete(id); this.cache.delete(`volc:remote:${id}`);
        this.events.emit('user-left', user);
      }
    });
    engine.on(rtc.events.onTokenWillExpire, () => { if (this.engine === engine) this.events.emit('token-privilege-will-expire'); });
    // Screen audio is played by the RTC engine itself.
    engine.on(rtc.events.onLocalStreamStats, stats => {
      if (this.engine === engine && stats?.isScreen) this.localQuality = Number(stats.txQuality) || 0;
      if (this.engine === engine && stats?.isScreen && stats.videoStats) {
        this.localScreen = {at:Date.now(),stats:{...stats.videoStats}};
        const publication = this.publication;
        if (publication?.engine === engine && publication.watch?.observe(stats.videoStats, Date.now())) this.recoverStartup(publication);
      }
    });
    engine.on(rtc.events.onRemoteStreamStats, stats => {
      if (this.engine !== engine) return;
      const id = Number(stats?.userId);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      this.remoteQuality.set(id, Number(stats?.rxQuality) || 0);
      if ((stats?.isScreen || this.remotes.get(id)?.streamIndex === 0) && stats.videoStats) this.remoteScreen.set(id, { at:Date.now(), stats:{...stats.videoStats} });
    });
    try {
      await engine.joinRoom(token, room, { userId:String(uid) }, { isAutoPublish:false, isAutoSubscribeAudio:false, isAutoSubscribeVideo:false });
    } catch (error) {
      // A halved join leaves the engine without its internal _room; every
      // later subscribe/unsubscribe call would then throw inside the SDK.
      if (this.engine === engine) {
        this.engine = undefined; this.sdk = undefined; this.roomReady = false;
        try { rtc.destroyEngine(engine); } catch { /* already destroyed */ }
      }
      throw error;
    }
    if (this.engine !== engine) throw new Error('媒体连接已取消。');
    this.roomReady = true;
    this.events.emit('connection-state-change', 'CONNECTED');
    return uid;
  }
  async leave() {
    // Drop the ready flag before subscriptions.clear() runs the release
    // callbacks: leaveRoom tears every subscription down anyway, and the SDK
    // would otherwise touch its already-detached internal room state.
    this.roomReady = false;
    this.revision++; this.subscriptions.clear();
    this.cancelStartup();
    const engine = this.engine, sdk = this.sdk; this.engine = undefined; this.sdk = undefined;
    try {
      if (engine && sdk) {
        await this.screenTasks;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([engine.leaveRoom(true), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('等待退出媒体房间确认超时。')), 8000);
          })]);
        } finally { clearTimeout(timer); sdk.default.destroyEngine(engine); }
      }
    }
    finally {
      for (const user of this.remotes.values()) { user.audioTrack?.stop(); user.videoTrack?.stop(); }
      if (this.screenEngine === engine) this.screenEngine = undefined;
      this.remotes.clear(); this.localQuality = 0; this.remoteQuality.clear(); this.remoteScreen.clear(); this.localScreen = undefined; this.cache.clear();
      this.events.emit('billing-change'); this.events.emit('connection-state-change', 'DISCONNECTED');
    }
  }
  private screenTask(task: () => Promise<void>): Promise<void> {
    const pending = this.screenTasks.then(task);
    this.screenTasks = pending.catch(() => {});
    return pending;
  }
  private cancelStartup() {
    this.publication?.watch?.finish('cancelled', Date.now());
    this.publication = undefined;
  }
  private recoverStartup(publication: NonNullable<VolcRtcAdapter['publication']>) {
    const current = () => this.publication === publication && this.engine === publication.engine;
    void this.screenTask(async () => {
      if (!current()) return;
      const { engine, mediaType, video } = publication;
      const { sdk } = this.context();
      // Keep the capture and external-track bindings alive. Changing source
      // type destroys the SDK wrapper and stops its underlying native track.
      await engine.unpublishScreen(sdk.MediaType.AUDIO_AND_VIDEO);
      if (!current()) return;
      if (video.readyState !== 'live') throw new Error('共享视频轨已结束。');
      this.localScreen = undefined; this.cache.delete('volc:local');
      await engine.publishScreen(mediaType);
      if (current()) publication.watch?.finish('republished', Date.now());
    }).catch(() => {
      if (!current()) return;
      publication.watch?.finish('failed', Date.now());
      this.events.emit('screen-publish-error', '首次共享恢复失败，已停止共享。');
    });
  }
  private async releaseScreen(engine: IRTCEngine, sdk: VolcModule) {
    if (this.screenEngine !== engine) return;
    const index = sdk.StreamIndex.STREAM_INDEX_SCREEN;
    // Always release both bindings, including when unpublishing or one reset fails.
    const failures: unknown[] = [];
    for (const operation of [
      () => engine.unpublishScreen(sdk.MediaType.AUDIO_AND_VIDEO),
      () => engine.setVideoSourceType(index, sdk.VideoSourceType.VIDEO_SOURCE_TYPE_INTERNAL),
      () => engine.setAudioSourceType(index, sdk.AudioSourceType.AUDIO_SOURCE_TYPE_INTERNAL),
    ]) {
      try { await operation(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
    this.screenEngine = undefined;
  }
  async publish(tracks: LocalTrack[], preferences?: Preferences, size?: { width:number; height:number }) {
    const { engine, sdk } = this.context(), index = sdk.StreamIndex.STREAM_INDEX_SCREEN;
    const revision = this.revision;
    const raw = tracks.map(track => track.getMediaStreamTrack());
    const video = raw.find(track => track.kind === 'video');
    if (!video) throw new Error('共享画面缺少视频轨，请重新选择。');
    // Use the actual captured size so a transient low getSettings() value does
    // not override the selected resolution on the first share.
    const config = preferences ? encoderConfig(preferences, size ?? video.getSettings()) : undefined;
    const contentHint = preferences ? videoContentHint(preferences) : undefined;
    const screenConfig = preferences && config ? {
      width:Number(config.width) || 1920, height:Number(config.height) || 1080, frameRate:Number(config.frameRate) || 30,
      maxKbps:effectiveBitrate(preferences), ...(contentHint ? { contentHint } : {}),
    } : undefined;
    const audio = raw.find(track => track.kind === 'audio');
    return this.screenTask(async () => {
      const check = () => {
        if (this.engine !== engine || this.revision !== revision) throw new Error('共享发布已取消。');
      };
      check();
      this.cancelStartup();
      this.localScreen = undefined; this.cache.delete('volc:local');
      await this.releaseScreen(engine, sdk);
      check();
      this.screenEngine = engine;
      try {
        // Configure before creating the SDK wrapper. A config change after
        // publish also updates the live publisher inside the Volc SDK.
        if (screenConfig) { await engine.setScreenEncoderConfig(screenConfig); check(); }
        await engine.setVideoSourceType(index, sdk.VideoSourceType.VIDEO_SOURCE_TYPE_EXTERNAL); check();
        video.contentHint = contentHint ?? '';
        await engine.setExternalVideoTrack(index, video); check();
        if (audio) {
          await engine.setAudioSourceType(index, sdk.AudioSourceType.AUDIO_SOURCE_TYPE_EXTERNAL); check();
          await engine.setExternalAudioTrack(index, audio); check();
        }
        await engine.publishScreen(audio ? sdk.MediaType.AUDIO_AND_VIDEO : sdk.MediaType.VIDEO); check();
        const watch = this.coldPublication && screenConfig ? new VolcStartupWatch(screenConfig.frameRate, Date.now(), screenConfig) : undefined;
        this.coldPublication = false;
        this.startupWatch = watch;
        this.publication = {engine,video,mediaType:audio ? sdk.MediaType.AUDIO_AND_VIDEO : sdk.MediaType.VIDEO,watch};
      } catch (error) {
        try { await this.releaseScreen(engine, sdk); } catch { /* keep the original publish error; unpublish can retry cleanup */ }
        throw error;
      }
    });
  }
  unpublish(_tracks: LocalTrack[]) {
    this.cancelStartup();
    const engine = this.engine, sdk = this.sdk;
    return this.screenTask(async () => {
      if (this.publication?.engine === engine) this.cancelStartup();
      this.localScreen = undefined; this.cache.delete('volc:local');
      if (engine && sdk) await this.releaseScreen(engine, sdk);
    });
  }
  private playbackTrack(uid: number): BrowserAudioTrack {
    const id = String(uid);
    const { engine, sdk } = this.context();
    const user = this.remotes.get(uid), publicationRevision = user?.publicationRevision;
    let volume = 100, playing = false;
    const apply = () => {
      if (this.engine === engine && this.remotes.get(uid) === user && user?.publicationRevision === publicationRevision)
        engine.setPlaybackVolume(id, user?.streamIndex === 0 ? sdk.StreamIndex.STREAM_INDEX_MAIN : sdk.StreamIndex.STREAM_INDEX_SCREEN, playing ? volume : 0);
    };
    // The engine starts audio on subscription; hold it until the controller plays it.
    apply();
    return {
      setVolume:value => { volume = Math.max(0, Math.min(400, value)); apply(); },
      play:() => { playing = true; apply(); },
      stop:() => { playing = false; apply(); },
    };
  }
  async subscribe(user: RtcRemoteUser, kind: MediaKind, signal?: AbortSignal) {
    const { engine, sdk } = this.context();
    // The SDK reads engine._room.remoteStreams without a null check in
    // subscribeStream/subscribeScreen; calling it before joinRoom resolves or
    // after leaveRoom would throw "Cannot read properties of undefined".
    if (!this.roomReady) throw new Error('媒体连接尚未就绪，请稍后重试。');
    const publicationRevision = user.publicationRevision;
    const mediaType = kind === 'audio' ? sdk.MediaType.AUDIO : sdk.MediaType.VIDEO;
    await this.subscriptions.run(user, signal, () => user.streamIndex === 0 ? engine.subscribeStream(String(user.uid), mediaType) : engine.subscribeScreen(String(user.uid), mediaType), () => {
      if (kind === 'audio') { user.audioTrack = this.playbackTrack(Number(user.uid)); return; }
      const track = engine.getRemoteStreamTrack(String(user.uid), user.streamIndex === 0 ? sdk.StreamIndex.STREAM_INDEX_MAIN : sdk.StreamIndex.STREAM_INDEX_SCREEN, kind);
      if (track) user.videoTrack = browserVideoTrack(track);
    }, () => {
      if (this.engine === engine && this.roomReady && user.publicationRevision === publicationRevision) return user.streamIndex === 0 ? engine.unsubscribeStream(String(user.uid), mediaType) : engine.unsubscribeScreen(String(user.uid), mediaType);
    });
  }
  async unsubscribe(user: RtcRemoteUser) {
    const publicationRevision = user.publicationRevision;
    this.subscriptions.cancel(user);
    user.audioTrack?.stop(); user.videoTrack?.stop();
    const engine = this.engine, sdk = this.sdk;
    if (this.roomReady && engine && sdk && (user.hasVideo || user.hasAudio)) await (user.streamIndex === 0 ? engine.unsubscribeStream(String(user.uid), sdk.MediaType.AUDIO_AND_VIDEO) : engine.unsubscribeScreen(String(user.uid), sdk.MediaType.AUDIO_AND_VIDEO));
    if (user.publicationRevision !== publicationRevision) return;
    this.remoteScreen.delete(Number(user.uid));
    this.cache.delete(`volc:remote:${user.uid}`);
    user.videoTrack = undefined; user.audioTrack = undefined;
  }
  async renewToken(token: string) { await this.context().engine.updateToken(token); }
  private localStats(): VolcLocalVideoStats | undefined {
    if (!this.engine) return undefined;
    if (this.localScreen) return this.localScreen.stats;
    return this.cache.read('volc:local', 1000, () => this.context().engine.getLocalVideoStats())?.screenVideoStats;
  }
  private remoteStats(uid: number): VolcRemoteVideoStats | undefined {
    if (!this.engine) return undefined;
    // The SDK's public getRemoteVideoStats() reads an async stats object
    // synchronously and can return an empty record, so prefer the stream stats
    // already pushed by onRemoteStreamStats.
    const pushed = this.remoteScreen.get(uid);
    if (pushed) return pushed.stats;
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
      RTT:local?.rtt ?? remote?.totalRtt,
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
    if (!stats) {
      if (this.startupWatch) return {startupRecovery:this.startupWatch.snapshot()};
      throw new Error('暂未获取到统计信息。');
    }
    return {
      startupRecovery:this.startupWatch?.snapshot(),
      observation:statisticsObservation(this.localScreen ? 'volc.onLocalStreamStats' : 'volc.getLocalVideoStats',this.localScreen ? 'callback' : 'poll',
        this.localScreen?.at ?? this.cache.observedAt('volc:local') ?? Date.now(),stats.statsInterval),
      diagnostics:encodingDiagnostics({encoderOutputFps:diagnosticNumber(stats.encoderOutputFrameRate),rendererOutputFps:diagnosticNumber(stats.rendererOutputFrameRate),
        targetFps:diagnosticNumber(stats.targetFrameRate),encodedFrames:diagnosticNumber(stats.encodedFrameCount),
        encodedBitrateBps:diagnosticNumber(typeof stats.encodedBitrate === 'number' ? stats.encodedBitrate * 1000 : undefined),
        uplinkLossPercent:diagnosticNumber(typeof stats.videoLossRate === 'number' ? stats.videoLossRate * 100 : undefined)}),
      sendResolutionWidth:Math.round(stats.encodedFrameWidth || 0), sendResolutionHeight:Math.round(stats.encodedFrameHeight || 0),
      captureResolutionWidth:Math.round(stats.encodedFrameWidth || 0), captureResolutionHeight:Math.round(stats.encodedFrameHeight || 0),
      captureFrameRate:stats.inputFrameRate, sendFrameRate:stats.sentFrameRate,
      codecType:stats.codecType, sendBitrate:Math.round((stats.sentKBitrate || 0) * 1000),
      targetSendBitrate:typeof stats.targetKBitrate === 'number' ? Math.round(stats.targetKBitrate * 1000) : undefined, sendRttMs:stats.rtt,
    };
  }
  getRemoteVideoStats() {
    const result: Record<string, RemoteVideoStats> = {};
    for (const user of this.remotes.values()) {
      if (!user.videoTrack) continue;
      const stats = this.remoteStats(Number(user.uid));
      if (stats) result[String(user.uid)] = {
        observation:statisticsObservation(this.remoteScreen.has(Number(user.uid)) ? 'volc.onRemoteStreamStats' : 'volc.getRemoteVideoStats',
          this.remoteScreen.has(Number(user.uid)) ? 'callback' : 'poll',this.remoteScreen.get(Number(user.uid))?.at ?? this.cache.observedAt(`volc:remote:${user.uid}`) ?? Date.now(),stats.statsInterval),
        receiveResolutionWidth:Math.round(stats.width || 0), receiveResolutionHeight:Math.round(stats.height || 0),
        decodeFrameRate:stats.decoderOutputFrameRate, renderFrameRate:stats.rendererOutputFrameRate, codecType:stats.codecType,
        receiveBitrate:Math.round((stats.receivedKBitrate || 0) * 1000),
        packetLossRate:(stats.videoLossRate || 0) * 100, currentPacketLossRate:(stats.videoLossRate || 0) * 100,
        receiveDelay:Math.round(stats.totalRtt || 0), transportDelay:Math.round(stats.totalRtt || 0),
        end2EndDelay:Math.round(stats.e2eDelay || 0),
      };
    }
    return result;
  }
}
