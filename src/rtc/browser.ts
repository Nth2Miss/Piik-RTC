import type { BrowserAudioTrack, BrowserVideoTrack, VideoPlaybackState } from './types';

export function hasVideoOutput(state: VideoPlaybackState): boolean {
  return state.attached && (state.readyState ?? 0) >= 2 && !state.paused && state.trackState !== 'ended'
    && (state.frames === undefined || state.frames > (state.droppedFrames ?? 0));
}

export function browserVideoTrack(track: MediaStreamTrack): BrowserVideoTrack {
  let element: HTMLVideoElement | undefined;
  let playError: 'blocked' | 'failed' | undefined;
  const resume = () => { if (element) start(element); };
  const start = (video: HTMLVideoElement) => {
    void video.play().then(() => {
      if (element !== video) return;
      playError = undefined; document.removeEventListener('click', resume);
    }).catch((error: unknown) => {
      if (element !== video) return;
      playError = error instanceof DOMException && error.name === 'NotAllowedError' ? 'blocked' : 'failed';
      if (playError === 'blocked') document.addEventListener('click', resume, {once:true});
    });
  };
  return {
    getPlaybackState() {
      const quality = element?.getVideoPlaybackQuality?.();
      return {attached:!!element,readyState:element?.readyState,paused:element?.paused,
        frames:quality?.totalVideoFrames,droppedFrames:quality?.droppedVideoFrames,playError,errorCode:element?.error?.code,
        trackState:track.readyState,trackMuted:track.muted};
    },
    play(container, options) {
      document.removeEventListener('click', resume); playError = undefined;
      element = document.createElement('video'); element.autoplay = true; element.playsInline = true; element.muted = true;
      element.style.width = '100%'; element.style.height = '100%'; element.style.objectFit = options?.fit || 'contain';
      element.srcObject = new MediaStream([track]); container.replaceChildren(element); start(element);
    },
    stop() { if (element) { document.removeEventListener('click', resume); element.pause(); element.srcObject = null; element.remove(); element = undefined; } playError = undefined; },
  };
}

export function browserAudioTrack(track: MediaStreamTrack): BrowserAudioTrack {
  let volume = 80, element: HTMLAudioElement | undefined;
  const resume = () => { if (element) void element.play().catch(() => {}); };
  return {
    setVolume(value) { volume = value; if (element) element.volume = value / 100; },
    play() {
      if (!element) { element = document.createElement('audio'); element.autoplay = true; element.srcObject = new MediaStream([track]); }
      element.volume = volume / 100; void element.play().catch(() => document.addEventListener('click', resume, { once:true }));
    },
    stop() { document.removeEventListener('click', resume); if (element) { element.pause(); element.srcObject = null; element = undefined; } },
  };
}

export class StatsCache {
  private values = new Map<string, { at:number; value:unknown }>();
  read<T>(key: string, ttl: number, read: () => T): T | undefined {
    const hit = this.values.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    try { const value = read(); this.values.set(key, { at:Date.now(), value }); return value; }
    catch { return undefined; }
  }
  delete(key: string) { this.values.delete(key); }
  observedAt(key: string) { return this.values.get(key)?.at; }
  clear() { this.values.clear(); }
}
