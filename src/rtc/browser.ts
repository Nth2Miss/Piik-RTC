import type { BrowserAudioTrack, BrowserVideoTrack } from './types';

export function browserVideoTrack(track: MediaStreamTrack): BrowserVideoTrack {
  let element: HTMLVideoElement | undefined;
  return {
    play(container, options) {
      element = document.createElement('video'); element.autoplay = true; element.playsInline = true; element.muted = true;
      element.style.width = '100%'; element.style.height = '100%'; element.style.objectFit = options?.fit || 'contain';
      element.srcObject = new MediaStream([track]); container.replaceChildren(element); void element.play().catch(() => {});
    },
    stop() { if (element) { element.pause(); element.srcObject = null; element.remove(); element = undefined; } },
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
  clear() { this.values.clear(); }
}
