import type { IAgoraRTCClient, IAgoraRTCRemoteUser, ILocalVideoTrack, IRemoteVideoTrack, UID } from 'agora-rtc-sdk-ng';
type Video = ILocalVideoTrack | IRemoteVideoTrack;
type Options = {
  client: Pick<IAgoraRTCClient, 'subscribe' | 'unsubscribe'>;
  remote: (uid: UID) => IAgoraRTCRemoteUser | undefined;
  video: (track: Video) => void;
  empty: () => void;
  error: (error: unknown) => void;
};

/** Only the selected source is subscribed. Local preview never closes the capture track. */
export class SourceController {
  selected: UID | undefined;
  private options: Options;
  private local: { uid: UID; track: ILocalVideoTrack } | undefined;
  private subscribed: IAgoraRTCRemoteUser | undefined;
  private playing: Video | undefined;
  private revision = 0;
  private chain: Promise<void> = Promise.resolve();
  private volume = 80;
  private muted = false;
  constructor(options: Options) { this.options = options; }
  setLocal(uid: UID, track?: ILocalVideoTrack) { this.local = track ? { uid, track } : undefined; }
  setAudio(volume: number, muted: boolean) {
    this.volume = volume; this.muted = muted;
    this.subscribed?.audioTrack?.setVolume(muted ? 0 : volume);
  }
  private async subscribe(user: IAgoraRTCRemoteUser, media: 'video' | 'audio') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.options.client.subscribe(user, media), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('接收共享画面超时，请重新点击成员或检查网络。')), 12000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async select(uid?: UID): Promise<void> {
    this.selected = uid;
    const revision = ++this.revision;
    this.chain = this.chain.then(async () => {
      if (revision !== this.revision) return;
      this.playing?.stop(); this.playing = undefined;
      if (this.subscribed) {
        this.subscribed.audioTrack?.stop(); this.subscribed.videoTrack?.stop();
        try { await this.options.client.unsubscribe(this.subscribed); } catch { /* user may have left */ }
        this.subscribed = undefined;
      }
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
      await this.subscribe(user, 'video');
      if (revision !== this.revision) return;
      if (user.videoTrack) { this.playing = user.videoTrack; this.options.video(user.videoTrack); }
      if (user.hasAudio) {
        try {
          await this.subscribe(user, 'audio');
          if (revision !== this.revision) return;
          user.audioTrack?.setVolume(this.muted ? 0 : this.volume);
          user.audioTrack?.play();
        } catch (error) { if (revision === this.revision) this.options.error(error); }
      }
    }).catch(error => { if (revision === this.revision) this.options.error(error); });
    return this.chain;
  }
  resumeAudio() { this.subscribed?.audioTrack?.play(); }
}
