import type { UID } from 'agora-rtc-sdk-ng';
import type { AudioTrack, LocalVideoTrack, RtcAdapter, RtcRemoteUser, VideoTrack } from './rtc/types';
type Options = {
  client: Pick<RtcAdapter, 'subscribe' | 'unsubscribe'>;
  remote: (uid: UID) => RtcRemoteUser | undefined;
  video: (track: VideoTrack) => void;
  empty: () => void;
  error: (error: unknown) => void;
};

/** Only the selected source is subscribed. Local preview never closes the capture track. */
export class SourceController {
  selected: UID | undefined;
  private options: Options;
  private local: { uid: UID; track: LocalVideoTrack } | undefined;
  private subscribed: RtcRemoteUser | undefined;
  private subscribedRevision?: number;
  private playing: VideoTrack | undefined;
  private audioPlaying: AudioTrack | undefined;
  private revision = 0;
  private chain: Promise<void> = Promise.resolve();
  private subscribing?: AbortController;
  private volume = 80;
  private muted = false;
  private paused = false;
  private republishTimer?: ReturnType<typeof setTimeout>;
  constructor(options: Options) { this.options = options; }
  get isPaused() { return this.paused; }
  setLocal(uid: UID, track?: LocalVideoTrack) { this.local = track ? { uid, track } : undefined; }
  setAudio(volume: number, muted: boolean) {
    this.volume = volume; this.muted = muted; this.applyAudio();
  }
  setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    // Pause audio through its own track. Agora setVolume here can interfere
    // with the video player, and volume changes must survive playback resume.
    if (paused) this.audioPlaying?.stop(); else this.audioPlaying?.play();
  }
  private applyAudio() {
    this.subscribed?.audioTrack?.setVolume(this.muted ? 0 : this.volume);
  }
  private async subscribe(user: RtcRemoteUser, media: 'video' | 'audio') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    this.subscribing = abort;
    let onAbort: () => void = () => {};
    try {
      await Promise.race([this.options.client.subscribe(user, media, abort.signal), new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abort.signal.reason);
        abort.signal.addEventListener('abort', onAbort, { once:true });
        timer = setTimeout(() => abort.abort(new Error('接收共享画面超时，请重新点击成员或检查网络。')), 12000);
      })]);
    } finally {
      clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort);
      if (this.subscribing === abort) this.subscribing = undefined;
    }
  }
  private async syncAudio(user: RtcRemoteUser, revision: number) {
    if (!user.hasAudio) {
      this.audioPlaying?.stop(); this.audioPlaying = undefined;
      return;
    }
    if (this.audioPlaying && this.audioPlaying === user.audioTrack) { this.applyAudio(); return; }
    try {
      await this.subscribe(user, 'audio');
      if (revision !== this.revision) return;
      this.audioPlaying = user.audioTrack;
      if (this.paused) this.audioPlaying?.stop();
      this.applyAudio(); if (!this.paused) this.audioPlaying?.play();
    } catch (error) { if (revision === this.revision) this.options.error(error); }
  }
  async select(uid?: UID, refresh = false): Promise<void> {
    clearTimeout(this.republishTimer); this.republishTimer = undefined;
    this.selected = uid;
    const revision = ++this.revision;
    this.subscribing?.abort(new Error('已切换共享来源。'));
    this.chain = this.chain.then(async () => {
      if (revision !== this.revision) return;
      const current = uid === undefined ? undefined : this.options.remote(uid);
      if (refresh && current && current === this.subscribed && current.hasVideo && this.subscribedRevision === current.publicationRevision) {
        this.playing?.stop(); this.playing = undefined;
        await this.subscribe(current, 'video');
        if (revision !== this.revision) return;
        if (current.videoTrack) { this.playing = current.videoTrack; this.options.video(current.videoTrack); }
        await this.syncAudio(current, revision); return;
      }
      // Audio publication and repeated selection must not tear down a healthy
      // video subscription and wait for another keyframe.
      if (current && current === this.subscribed && this.subscribedRevision === current.publicationRevision && current.hasVideo && this.playing && this.playing === current.videoTrack) {
        await this.syncAudio(current, revision);
        return;
      }
      if (this.local && this.local.uid === uid && this.playing === this.local.track) return;
      this.playing?.stop(); this.playing = undefined;
      if (this.subscribed) {
        if (this.subscribedRevision === this.subscribed.publicationRevision) {
          this.subscribed.audioTrack?.stop(); this.subscribed.videoTrack?.stop();
          try { await this.options.client.unsubscribe(this.subscribed); } catch { /* user may have left */ }
        }
        this.subscribed = undefined;
        this.subscribedRevision = undefined;
      }
      this.audioPlaying = undefined;
      if (revision !== this.revision) return;
      this.options.empty();
      if (uid === undefined) return;
      if (this.local?.uid === uid) {
        this.playing = this.local.track;
        this.options.video(this.playing);
        return;
      }
      const user = this.options.remote(uid);
      if (!user?.hasVideo) return;
      this.subscribed = user;
      this.subscribedRevision = user.publicationRevision;
      await this.subscribe(user, 'video');
      if (revision !== this.revision) return;
      if (user.videoTrack) { this.playing = user.videoTrack; this.options.video(user.videoTrack); }
      await this.syncAudio(user, revision);
    }).catch(error => { if (revision === this.revision) this.options.error(error); });
    return this.chain;
  }
  resumeAudio() { if (!this.paused) this.audioPlaying?.play(); }
  holdForRepublish(uid: UID, unavailable: () => void) {
    if (this.selected !== uid) return;
    void this.select(uid);
    const revision = this.revision;
    this.republishTimer = setTimeout(() => {
      this.republishTimer = undefined;
      if (revision === this.revision && this.selected === uid && !this.options.remote(uid)?.hasVideo) unavailable();
    }, 2000);
  }
}
