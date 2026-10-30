import type { ScreenVideoTrackInitConfig, VideoEncoderConfiguration } from 'agora-rtc-sdk-ng';

export interface Preferences {
  resolution: '480' | '720' | '1080' | '1440' | 'native';
  fps: 15 | 24 | 30 | 60;
  bitrate: 1000 | 2000 | 3000 | 5000 | 8000 | 10000 | 12000 | 16000;
  bitrateMode: 'auto' | 'manual';
  optimization: 'detail' | 'motion' | 'balanced';
  audio: boolean;
  filterVoice: boolean;
  includeSelf: boolean;
  volume: number;
  muted: boolean;
  fit: 'contain' | 'cover' | 'fill';
  wide: boolean;
}
export const defaults: Preferences = { resolution: '1080', fps: 30, bitrate: 3000, bitrateMode: 'auto', optimization: 'detail', audio: true, filterVoice: true, includeSelf: false, volume: 80, muted: false, fit: 'contain', wide: false };
/** Zego's Web SDK rejects custom-stream bitrates above 10 Mbps. */
export const ZEGO_MAX_BITRATE = 10000;
export const presets: Record<string, Partial<Preferences>> = {
  document: { resolution: '1080', fps: 15, bitrate: 3000, optimization: 'detail' },
  movie: { resolution: '1080', fps: 30, bitrate: 5000, optimization: 'motion' },
  game: { resolution: '1080', fps: 60, bitrate: 8000, optimization: 'motion' },
  economy: { resolution: '720', fps: 15, bitrate: 1000, optimization: 'balanced' },
};
export function automaticBitrate(p: Pick<Preferences, 'resolution' | 'fps'>): Preferences['bitrate'] {
  if (p.resolution === '480') return p.fps >= 50 ? 2000 : 1000;
  if (p.resolution === '720') return p.fps >= 50 ? 5000 : p.fps >= 24 ? 3000 : 2000;
  if (p.resolution === '1080') return p.fps >= 50 ? 8000 : p.fps >= 24 ? 5000 : 3000;
  return p.fps >= 50 ? 16000 : p.fps >= 24 ? 10000 : 5000;
}
export function effectiveBitrate(p: Preferences): Preferences['bitrate'] {
  return p.bitrateMode === 'auto' ? automaticBitrate(p) : p.bitrate;
}
// High-frame-rate balanced sharing should preserve motion instead of inheriting
// the screen-sharing SDKs' detail-first default.
export function videoOptimization(p: Preferences): Preferences['optimization'] {
  return p.optimization === 'balanced' && p.fps >= 50 ? 'motion' : p.optimization;
}
export function videoContentHint(p: Preferences): '' | 'motion' | 'detail' {
  const mode = videoOptimization(p);
  return mode === 'balanced' ? '' : mode;
}
export function sourceContentHint(p: Preferences): '' | 'motion' | 'detail' {
  return p.optimization === 'motion' ? 'motion' : p.optimization === 'detail' ? 'detail' : '';
}
export function normalizePreferences(value: unknown): Preferences {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    resolution: ['480', '720', '1080', '1440', 'native'].includes(String(v.resolution)) ? String(v.resolution) as Preferences['resolution'] : defaults.resolution,
    fps: [15, 24, 30, 60].includes(Number(v.fps)) ? Number(v.fps) as Preferences['fps'] : defaults.fps,
    bitrate: [1000, 2000, 3000, 5000, 8000, 10000, 12000, 16000].includes(Number(v.bitrate)) ? Number(v.bitrate) as Preferences['bitrate'] : defaults.bitrate,
    bitrateMode: v.bitrateMode === 'manual' ? 'manual' : 'auto',
    optimization: ['detail', 'motion', 'balanced'].includes(String(v.optimization)) ? v.optimization as Preferences['optimization'] : defaults.optimization,
    audio: typeof v.audio === 'boolean' ? v.audio : defaults.audio,
    filterVoice: typeof v.filterVoice === 'boolean' ? v.filterVoice : defaults.filterVoice,
    includeSelf: typeof v.includeSelf === 'boolean' ? v.includeSelf : defaults.includeSelf,
    volume: typeof v.volume === 'number' && Number.isFinite(v.volume) ? Math.round(Math.max(0, Math.min(100, v.volume))) : defaults.volume,
    muted: typeof v.muted === 'boolean' ? v.muted : defaults.muted,
    fit: v.fit === 'cover' || v.fit === 'fill' ? v.fit : 'contain',
    wide: typeof v.wide === 'boolean' ? v.wide : defaults.wide,
  };
}
export function encoderConfig(p: Preferences, source?: { width?: number; height?: number }): VideoEncoderConfiguration {
  const dimensions = { '480': [854, 480], '720': [1280, 720], '1080': [1920, 1080], '1440': [2560, 1440] } as const;
  const [width, height] = p.resolution === 'native'
    ? [source?.width || 1920, source?.height || 1080]
    : dimensions[p.resolution];
  const sourceWidth = source?.width, sourceHeight = source?.height;
  const scale = sourceWidth && sourceHeight ? Math.min(1, width / sourceWidth, height / sourceHeight) : 1;
  return { width: Math.max(2, Math.floor((sourceWidth ? sourceWidth * scale : width) / 2) * 2),
    height: Math.max(2, Math.floor((sourceHeight ? sourceHeight * scale : height) / 2) * 2), frameRate: p.fps, bitrateMax: effectiveBitrate(p) };
}
export function captureConfig(p: Preferences): ScreenVideoTrackInitConfig {
  return { encoderConfig: encoderConfig(p), optimizationMode: videoOptimization(p),
    selfBrowserSurface: p.includeSelf ? 'include' : 'exclude',
    surfaceSwitching: 'include', systemAudio: p.audio ? 'include' : 'exclude' };
}
