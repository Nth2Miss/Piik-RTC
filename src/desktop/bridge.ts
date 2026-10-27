export interface DesktopCapabilities {
  available: boolean;
  processLoopback: boolean;
  osBuild: number;
  arch?: string;
  message?: string;
}

export interface DesktopSource {
  id: string;
  name: string;
  kind: 'window' | 'screen';
  thumbnail: string;
  icon: string | null;
  displayId: string | null;
  hwnd: number | null;
  pid: number | null;
  appName: string | null;
  voice: boolean;
}

export interface DesktopApp {
  pid: number;
  name: string;
  exe: string;
  title: string;
  voice: boolean;
  windows: number;
}

export interface DesktopSourceList {
  sources: DesktopSource[];
  apps: DesktopApp[];
  capabilities: DesktopCapabilities;
}

export interface DesktopAudioFormat {
  sampleRate: number;
  channels: number;
  bits: number;
  encoding: 'pcm_s16le' | 'pcm_s32le' | 'pcm_f32le' | string;
  blockAlign: number;
  mode: string;
}

export interface DesktopSelectResult {
  ok: boolean;
  kind?: 'window' | 'screen';
  hwnd?: number | null;
  pid?: number | null;
  appName?: string | null;
  voice?: boolean;
  code?: string;
  message?: string;
}

export interface DesktopAudioStartResult {
  ok: boolean;
  sampleRate?: number;
  channels?: number;
  bits?: number;
  encoding?: string;
  blockAlign?: number;
  mode?: string;
  code?: string;
  message?: string;
}

export interface DesktopVideoFrame {
  data: string;
  width: number;
  height: number;
  seq: number;
}

export interface DesktopVideoFrameRaw {
  frame: VideoFrame;
  width: number;
  height: number;
  seq: number;
}

export interface DesktopVideoStartOptions {
  sourceId: string;
  width: number;
  height: number;
  fps: number;
  native?: boolean;
  raw?: boolean;
}

export interface DesktopVideoStartResult {
  ok: boolean;
  width?: number;
  height?: number;
  mode?: 'raw' | 'jpeg';
  code?: string;
  message?: string;
}

export interface DesktopBridge {
  isDesktop: true;
  captureMode?: 'webview2';
  platform: string;
  capabilities(): Promise<DesktopCapabilities>;
  listSources(): Promise<DesktopSourceList>;
  selectSource(id: string): Promise<DesktopSelectResult>;
  startVideo(options: DesktopVideoStartOptions): Promise<DesktopVideoStartResult>;
  stopVideo(): Promise<{ ok: boolean }>;
  onVideoFrame(handler: (frame: DesktopVideoFrame) => void): () => void;
  onVideoFrameRaw(handler: (frame: DesktopVideoFrameRaw) => void): () => void;
  onVideoEnded(handler: (info: { code: string; message: string }) => void): () => void;
  startAudio(options: { mode: 'system' | 'include' | 'exclude'; pid?: number | null }): Promise<DesktopAudioStartResult>;
  stopAudio(): Promise<{ ok: boolean }>;
  clearSource(): Promise<{ ok: boolean }>;
  onAudioData(handler: (data: Uint8Array) => void): () => void;
  onAudioEnded(handler: (info: { code: string; message: string }) => void): () => void;
  getConfig(): Promise<{ serverUrl: string; version: string; desktop: boolean; platform: string }>;
  setServer(url: string): Promise<{ ok: boolean; serverUrl?: string; message?: string }>;
  cancelSetup(): Promise<{ ok: boolean }>;
}

export interface CaptureSelection {
  sourceId: string;
  kind: 'window' | 'screen';
  name: string;
  pid: number | null;
  audio: 'none' | 'system' | 'app';
  filterPid?: number | null;
  filterName?: string | null;
}

declare global {
  interface Window {
    piikDesktop?: DesktopBridge;
  }
}

export const desktopBridge: DesktopBridge | undefined = typeof window === 'undefined' ? undefined : window.piikDesktop;
export const isDesktopApp = desktopBridge?.isDesktop === true;

export function desktopAudioLabel(selection: CaptureSelection, hasAudio: boolean): string {
  if (!hasAudio || selection.audio === 'none') return '仅画面';
  if (selection.audio === 'app') return '含程序音频';
  if (selection.filterPid) return `含系统音频（已过滤${selection.filterName ? ` ${selection.filterName}` : '语音软件'}）`;
  return '含系统音频';
}
