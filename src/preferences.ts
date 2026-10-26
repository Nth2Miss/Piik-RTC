import type { ScreenVideoTrackInitConfig, VideoEncoderConfiguration } from 'agora-rtc-sdk-ng';

export interface Preferences {
  resolution: '480' | '720' | '1080' | '1440';
  fps: 15 | 24 | 30 | 60;
  bitrate: 1000 | 2000 | 3000 | 5000 | 8000 | 12000 | 16000;
  optimization: 'detail' | 'motion' | 'balanced';
  audio: boolean;
  includeSelf: boolean;
  volume: number;
  muted: boolean;
  fit: 'contain' | 'cover' | 'fill';
  wide: boolean;
}
export const defaults: Preferences = { resolution: '1080', fps: 30, bitrate: 3000, optimization: 'detail', audio: true, includeSelf: false, volume: 80, muted: false, fit: 'contain', wide: false };
export const presets: Record<string, Partial<Preferences>> = {
  document: { resolution: '1080', fps: 15, bitrate: 3000, optimization: 'detail' },
  movie: { resolution: '1080', fps: 30, bitrate: 5000, optimization: 'motion' },
  game: { resolution: '1080', fps: 60, bitrate: 8000, optimization: 'motion' },
  economy: { resolution: '720', fps: 15, bitrate: 1000, optimization: 'balanced' },
};
export function normalizePreferences(value: unknown): Preferences {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    resolution: ['480', '720', '1080', '1440'].includes(String(v.resolution)) ? String(v.resolution) as Preferences['resolution'] : defaults.resolution,
    fps: [15, 24, 30, 60].includes(Number(v.fps)) ? Number(v.fps) as Preferences['fps'] : defaults.fps,
    bitrate: [1000, 2000, 3000, 5000, 8000, 12000, 16000].includes(Number(v.bitrate)) ? Number(v.bitrate) as Preferences['bitrate'] : defaults.bitrate,
    optimization: ['detail', 'motion', 'balanced'].includes(String(v.optimization)) ? v.optimization as Preferences['optimization'] : defaults.optimization,
    audio: typeof v.audio === 'boolean' ? v.audio : defaults.audio,
    includeSelf: typeof v.includeSelf === 'boolean' ? v.includeSelf : defaults.includeSelf,
    volume: typeof v.volume === 'number' && Number.isFinite(v.volume) ? Math.round(Math.max(0, Math.min(100, v.volume))) : defaults.volume,
    muted: typeof v.muted === 'boolean' ? v.muted : defaults.muted,
    fit: v.fit === 'cover' || v.fit === 'fill' ? v.fit : 'contain',
    wide: typeof v.wide === 'boolean' ? v.wide : defaults.wide,
  };
}
export function encoderConfig(p: Preferences): VideoEncoderConfiguration {
  const dimensions = { '480': [854, 480], '720': [1280, 720], '1080': [1920, 1080], '1440': [2560, 1440] };
  const [width, height] = dimensions[p.resolution];
  return { width, height, frameRate: p.fps, bitrateMax: p.bitrate };
}
export function captureConfig(p: Preferences): ScreenVideoTrackInitConfig {
  return { encoderConfig: encoderConfig(p), optimizationMode: p.optimization,
    selfBrowserSurface: p.includeSelf ? 'include' : 'exclude',
    surfaceSwitching: 'include', systemAudio: p.audio ? 'include' : 'exclude' };
}
