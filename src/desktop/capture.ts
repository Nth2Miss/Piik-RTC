import type { CaptureTrackFactory, CapturedScreen, CapturePipelineStats } from '../capture.ts';
import { encoderConfig, videoOptimization, sourceContentHint, type Preferences } from '../preferences.ts';
import type { LocalTrack } from '../rtc/types.ts';
import { desktopBridge, type CaptureSelection, type DesktopBridge, type DesktopVideoFrame, type DesktopVideoStartResult } from './bridge.ts';
import { startProcessAudio, type ProcessAudio } from './audio.ts';
import { CaptureProgress } from './capture-progress.ts';
import type { RtcProvider } from '../types';

interface NativeVideo {
  track: MediaStreamTrack;
  width: number;
  height: number;
  progress: CaptureProgress;
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

function createCanvasVideoTrack(preferences: Preferences, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!context) {
    canvas.remove();
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
  return { canvas, context, track, requestFrame };
}

function relaxNativeTrack(track: MediaStreamTrack) {
  // RTC SDKs apply width/height/frameRate constraints while configuring a
  // custom track. MediaStreamTrackGenerator rejects those constraints, which
  // surfaces as OverconstrainedError even though the host already produces
  // frames at this size and pace. Acknowledge them instead of failing.
  try {
    Object.defineProperty(track, 'applyConstraints', {
      configurable: true,
      value: () => Promise.resolve(),
    });
  } catch { /* keep the native implementation */ }
}

/** The native host sends raw BGRA frames, with JPEG as the fallback. */
export async function startNativeVideo(bridge: DesktopBridge, selection: CaptureSelection, preferences: Preferences, provider?: RtcProvider): Promise<NativeVideo> {
  const native = preferences.resolution === 'native';
  const target = encoderConfig(preferences);
  const progress = new CaptureProgress({path:'canvas-jpeg',width:0,height:0,targetFps:preferences.fps,received:0,written:0,dropped:0,errors:0});
  let ended = false;
  let endedHandler: (() => void) | null = null;
  const offEnded = bridge.onVideoEnded(() => {
    ended = true;
    progress.stop();
    endedHandler?.();
  });

  let started: DesktopVideoStartResult;
  try {
    const rawSupported = typeof VideoFrame === 'function';
    started = await bridge.startVideo({
      sourceId: selection.sourceId,
      width: native ? 0 : Number(target.width),
      height: native ? 0 : Number(target.height),
      fps: preferences.fps,
      native,
      raw: rawSupported,
    });
  } catch (error) {
    offEnded();
    throw error;
  }
  if (!started.ok || !started.width || !started.height) {
    offEnded();
    throw new Error(started.message || '无法开始画面采集。');
  }

  const width = Number(started.width);
  const height = Number(started.height);
  const raw = started.mode === 'raw' && typeof VideoFrame === 'function';
  progress.stats.width = width; progress.stats.height = height;

  let generator: MediaStreamTrackGenerator | undefined;
  let writer: WritableStreamDefaultWriter<VideoFrame> | undefined;
  const useGenerator = provider !== 'volc' && provider !== 'volc2';
  if (raw && useGenerator && typeof MediaStreamTrackGenerator === 'function') {
    try {
      generator = new MediaStreamTrackGenerator({ kind:'video' });
      writer = generator.writable.getWriter();
    } catch {
      generator = undefined; writer = undefined;
    }
  }

  let canvas: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | undefined;
  let requestFrame = () => {};
  let track: MediaStreamTrack;
  if (generator) {
    track = generator;
  } else {
    try {
      const created = createCanvasVideoTrack(preferences, width, height);
      canvas = created.canvas; context = created.context; track = created.track; requestFrame = created.requestFrame;
    } catch (error) {
      offEnded();
      void bridge.stopVideo().catch(() => {});
      throw error;
    }
  }
  if (generator) relaxNativeTrack(track);
  progress.stats.path = generator ? 'generator' : raw ? 'canvas-raw' : 'canvas-jpeg';

  let stopped = false;
  let frameSink: ((frame: DesktopVideoFrame) => void) | null = null;
  let pendingFrame: DesktopVideoFrame | null = null;
  let writingRaw = false;
  let latestRaw: VideoFrame | null = null;

  // Keep only the newest frame while the previous one is being consumed.
  const queueRaw = (frame: VideoFrame, consume: (frame: VideoFrame) => void | Promise<void>) => {
    if (stopped) { frame.close(); return; }
    progress.received();
    if (latestRaw) progress.stats.dropped++;
    latestRaw?.close();
    latestRaw = frame;
    if (writingRaw) return;
    writingRaw = true;
    void (async () => {
      while (latestRaw && !stopped) {
        const next = latestRaw;
        latestRaw = null;
        try { await consume(next); progress.written(); } catch (error) { progress.failed(error); }
        finally { next.close(); }
      }
      writingRaw = false;
    })();
  };

  let pushRaw: (frame: VideoFrame) => void;
  if (generator) {
    // A generator track keeps publishing independent of page rendering, which
    // Chromium throttles while the host window is hidden or occluded.
    pushRaw = frame => {
      const target = writer;
      if (!target) { frame.close(); return; }
      queueRaw(frame, next => target.write(next));
    };
  } else {
    // WGC frames arrive as BGRA VideoFrames. Drawing them straight onto the
    // canvas avoids the JPEG encode/decode round trip while keeping a canvas
    // track, which is supported by every RTC SDK.
    pushRaw = frame => {
      const ctx = context;
      if (!ctx) { frame.close(); return; }
      queueRaw(frame, next => { ctx.drawImage(next, 0, 0, width, height); requestFrame(); });
    };
  }

  const offRaw = raw ? bridge.onVideoFrameRaw(({ frame }) => pushRaw(frame)) : undefined;
  const offFrame = raw ? undefined : bridge.onVideoFrame(frame => {
    progress.received();
    if (frameSink) frameSink(frame);
    else if (!pendingFrame) pendingFrame = frame;
  });

  let decoding = false;
  let latest: DesktopVideoFrame | null = null;
  const drawJpeg = async (frame: DesktopVideoFrame) => {
    if (stopped) return;
    if (decoding) { latest = frame; return; }
    decoding = true;
    try {
      const bitmap = await createImageBitmap(new Blob([base64ToBytes(frame.data)], { type: 'image/jpeg' }));
      if (!stopped && context) {
        context.drawImage(bitmap, 0, 0, width, height);
        requestFrame();
        progress.written();
      }
      bitmap.close();
    } catch (error) {
      progress.failed(error);
    }
    decoding = false;
    if (latest) {
      const next = latest;
      latest = null;
      void drawJpeg(next);
    }
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    progress.stop();
    offRaw?.();
    offFrame?.();
    offEnded();
    latest = null;
    latestRaw?.close();
    latestRaw = null;
    frameSink = null;
    pendingFrame = null;
    try { track.stop(); } catch { /* already stopped */ }
    void writer?.abort().catch(() => { /* already closed */ });
    canvas?.remove();
    try { await bridge.stopVideo(); } catch { /* host may already be stopped */ }
  };

  if (!raw) {
    frameSink = frame => { void drawJpeg(frame); };
    if (pendingFrame) {
      const first = pendingFrame;
      pendingFrame = null;
      void drawJpeg(first);
    }
  }

  return {
    track,
    width,
    height,
    progress,
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
  sdk: CaptureTrackFactory,
  onWarning: (message: string) => void,
  options: { provider?: RtcProvider; bridge?: DesktopBridge; onDiagnostics?: (stats: CapturePipelineStats) => void } = {},
): Promise<CapturedScreen> {
  const bridge = options.bridge ?? desktopBridge;
  if (!bridge) throw new Error('桌面采集组件不可用。');

  const tracks: LocalTrack[] = [];
  let video: NativeVideo | undefined;
  let audio: ProcessAudio | undefined;
  let closed = false;

  try {
    video = await startNativeVideo(bridge, selection, preferences, options.provider);
    // Generator writes may be backpressured until RTC consumes the track.
    // Wait only for input here, then verify output after publishing.
    await video.progress.wait('received');
    if (video.progress.stats.path !== 'generator') await video.progress.wait('written');
    video.track.contentHint = sourceContentHint(preferences);
    const config = encoderConfig(preferences, { width: video.width, height: video.height });
    const videoTrack = sdk.createCustomVideoTrack({
      mediaStreamTrack: video.track,
      ...config,
      optimizationMode: videoOptimization(preferences),
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
      width: video.width,
      height: video.height,
      diagnostics:() => ({...video!.progress.stats}),
      waitForOutput:() => video!.progress.wait('written'),
      onEnded: handler => { endedCallback = handler; if (videoEnded) handler(); },
      close,
    };
  } catch (error) {
    closed = true;
    if (video) options.onDiagnostics?.({...video.progress.stats});
    void video?.stop();
    void audio?.stop();
    for (const track of tracks) {
      try { track.stop(); track.close(); } catch { /* already closed */ }
    }
    throw error;
  }
}
