import type { IAgoraRTC, ILocalAudioTrack, ILocalVideoTrack } from 'agora-rtc-sdk-ng';
import type { CapturedScreen } from '../capture.ts';
import { encoderConfig, type Preferences } from '../preferences.ts';
import { desktopBridge, type CaptureSelection, type DesktopBridge, type DesktopVideoFrame } from './bridge.ts';
import { startProcessAudio, type ProcessAudio } from './audio.ts';

interface NativeVideo {
  track: MediaStreamTrack;
  width: number;
  height: number;
  onEnded: (handler: () => void) => void;
  stop: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The native host sends JPEG frames; a canvas turns them into a MediaStreamTrack. */
async function startNativeVideo(bridge: DesktopBridge, selection: CaptureSelection, preferences: Preferences): Promise<NativeVideo> {
  const native = preferences.resolution === 'native';
  const target = encoderConfig(preferences);
  let frameSink: ((frame: DesktopVideoFrame) => void) | null = null;
  let pendingFrame: DesktopVideoFrame | null = null;
  let ended = false;
  let endedHandler: (() => void) | null = null;
  let stopped = false;

  const offFrame = bridge.onVideoFrame(frame => {
    if (frameSink) frameSink(frame);
    else if (!pendingFrame) pendingFrame = frame;
  });
  const offEnded = bridge.onVideoEnded(() => {
    ended = true;
    endedHandler?.();
  });

  let started;
  try {
    started = await bridge.startVideo({
      sourceId: selection.sourceId,
      width: native ? 0 : Number(target.width),
      height: native ? 0 : Number(target.height),
      fps: preferences.fps,
      native,
    });
  } catch (error) {
    offFrame();
    offEnded();
    throw error;
  }
  if (!started.ok || !started.width || !started.height) {
    offFrame();
    offEnded();
    throw new Error(started.message || '无法开始画面采集。');
  }

  const width = Number(started.width);
  const height = Number(started.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!context) {
    offFrame();
    offEnded();
    canvas.remove();
    void bridge.stopVideo().catch(() => {});
    throw new Error('无法创建视频画布。');
  }
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);

  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  if (typeof track.requestFrame !== 'function') {
    track.stop();
    stream = canvas.captureStream(preferences.fps);
    track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  }
  const requestFrame = typeof track.requestFrame === 'function' ? () => track.requestFrame() : () => {};

  let decoding = false;
  let latest: DesktopVideoFrame | null = null;
  const draw = async (frame: DesktopVideoFrame) => {
    if (stopped) return;
    if (decoding) { latest = frame; return; }
    decoding = true;
    try {
      const bitmap = await createImageBitmap(new Blob([base64ToBytes(frame.data)], { type: 'image/jpeg' }));
      if (!stopped) {
        context.drawImage(bitmap, 0, 0, width, height);
        requestFrame();
      }
      bitmap.close();
    } catch {
      /* a damaged frame must not stop the share */
    }
    decoding = false;
    if (latest) {
      const next = latest;
      latest = null;
      void draw(next);
    }
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    offFrame();
    offEnded();
    latest = null;
    frameSink = null;
    try { await bridge.stopVideo(); } catch { /* host may already be stopped */ }
    try { track.stop(); } catch { /* already stopped */ }
    canvas.remove();
  };

  frameSink = frame => { void draw(frame); };
  if (pendingFrame) {
    const first = pendingFrame;
    pendingFrame = null;
    void draw(first);
  }

  return {
    track,
    width,
    height,
    onEnded: handler => {
      endedHandler = handler;
      if (ended) handler();
    },
    stop,
  };
}

/** Pick the audio source that matches the user's choice in the picker. */
async function startDesktopAudio(
  selection: CaptureSelection,
  onWarning: (message: string) => void,
): Promise<ProcessAudio | undefined> {
  if (selection.audio === 'none') return undefined;
  const includeApp = selection.audio === 'app';
  const pid = includeApp ? selection.pid : selection.filterPid ?? null;
  if (includeApp && !pid) {
    onWarning('无法识别该程序的进程，本次只共享画面。');
    return undefined;
  }
  const mode = includeApp ? 'include' : pid ? 'exclude' : 'system';
  try {
    return await startProcessAudio({
      mode,
      pid,
      onEnded: info => onWarning(info.message),
    });
  } catch (error) {
    if (mode === 'exclude') {
      try {
        const fallback = await startProcessAudio({
          mode: 'system',
          onEnded: info => onWarning(info.message),
        });
        onWarning(`过滤程序已退出，已改为共享系统声音：${errorMessage(error)}`);
        return fallback;
      } catch (fallbackError) {
        onWarning(`音频共享失败，本次只共享画面：${errorMessage(fallbackError)}`);
        return undefined;
      }
    }
    onWarning(`音频共享失败，本次只共享画面：${errorMessage(error)}`);
    return undefined;
  }
}

export async function captureDesktopScreen(
  selection: CaptureSelection,
  preferences: Preferences,
  sdk: Pick<IAgoraRTC, 'createCustomVideoTrack' | 'createCustomAudioTrack'>,
  onWarning: (message: string) => void,
): Promise<CapturedScreen> {
  const bridge = desktopBridge;
  if (!bridge) throw new Error('桌面采集组件不可用。');

  const tracks: (ILocalVideoTrack | ILocalAudioTrack)[] = [];
  let video: NativeVideo | undefined;
  let audio: ProcessAudio | undefined;
  let closed = false;

  try {
    video = await startNativeVideo(bridge, selection, preferences);
    const config = encoderConfig(preferences, { width: video.width, height: video.height });
    const videoTrack = sdk.createCustomVideoTrack({
      mediaStreamTrack: video.track,
      ...config,
      optimizationMode: preferences.optimization,
    });
    tracks.push(videoTrack);

    audio = await startDesktopAudio(selection, message => { if (!closed) onWarning(message); });
    if (audio) {
      tracks.push(sdk.createCustomAudioTrack({ mediaStreamTrack: audio.track, encoderConfig: 'music_standard' }));
    }

    let endedCallback: (() => void) | undefined;
    let videoEnded = false;
    video.onEnded(() => { videoEnded = true; if (!closed) endedCallback?.(); });

    const close = () => {
      if (closed) return;
      closed = true;
      void video?.stop();
      void audio?.stop();
      for (const track of tracks) {
        try { track.stop(); track.close(); } catch { /* already closed */ }
      }
    };

    return {
      tracks,
      surface: selection.kind === 'screen' ? 'monitor' : 'window',
      hasAudio: tracks.length > 1,
      onEnded: handler => { endedCallback = handler; if (videoEnded) handler(); },
      close,
    };
  } catch (error) {
    closed = true;
    void video?.stop();
    void audio?.stop();
    for (const track of tracks) {
      try { track.stop(); track.close(); } catch { /* already closed */ }
    }
    throw error;
  }
}
