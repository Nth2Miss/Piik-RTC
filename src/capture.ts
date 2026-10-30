import type { IAgoraRTC, ILocalVideoTrack, ILocalAudioTrack } from 'agora-rtc-sdk-ng';
import { encoderConfig, videoOptimization, sourceContentHint, type Preferences } from './preferences.ts';

export function displayOptions(p: Preferences) {
  const { width, height } = encoderConfig(p);
  const frameRate = { ideal: p.fps, max: p.fps };
  return {
    video: p.resolution === 'native' ? { frameRate } : { width: { ideal: width as number }, height: { ideal: height as number }, frameRate },
    audio: p.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    windowAudio: p.audio ? 'window' : 'exclude',
    systemAudio: p.audio ? 'include' : 'exclude',
    selfBrowserSurface: p.includeSelf ? 'include' : 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  };
}
export interface CapturedScreen {
  tracks: (ILocalVideoTrack | ILocalAudioTrack)[];
  surface: string;
  hasAudio: boolean;
  onEnded: (callback: () => void) => void;
  close: () => void;
}
export function knownWindowAudioSupport(userAgent: string): boolean {
  // Older engines may ignore windowAudio and return system loopback for windows.
  // Only known Chromium versions are allowed window audio; tabs remain supported separately.
  const version = /(?:Chrome|Chromium|Edg)\/(\d+)/.exec(userAgent);
  return !!version && Number(version[1]) >= 141 && !/iPhone|iPad|CriOS/.test(userAgent);
}
export async function captureScreen(
  p: Preferences,
  sdk: Pick<IAgoraRTC, 'createCustomVideoTrack' | 'createCustomAudioTrack'>,
  acquire: (options: ReturnType<typeof displayOptions>) => Promise<MediaStream> = options => navigator.mediaDevices.getDisplayMedia(options as DisplayMediaStreamOptions),
  windowAudioSupported = knownWindowAudioSupport(typeof navigator === 'undefined' ? '' : navigator.userAgent),
  max1080 = false,
): Promise<CapturedScreen> {
  // Call immediately from the share button, before any await that could lose activation.
  const stream = await acquire(displayOptions(p));
  const tracks: (ILocalVideoTrack | ILocalAudioTrack)[] = [];
  try {
    const rawVideo = stream.getVideoTracks()[0];
    if (!rawVideo) throw new Error('浏览器没有返回共享画面，请重新选择。');
    // Tell the browser encoder whether to favour frame rate or sharpness;
    // this matches the selected optimisation used by the RTC SDKs.
    rawVideo.contentHint = sourceContentHint(p);
    const target = encoderConfig(p);
    // getDisplayMedia uses ideal dimensions for its picker; apply hard bounds
    // after selection so a 4K display does not silently become a 4K encoder input.
    try {
      await rawVideo.applyConstraints({ frameRate:{ ideal:p.fps, max:p.fps },
        ...(p.resolution !== 'native' || max1080 ? {
          width:{ max:max1080 ? Math.min(Number(target.width), 1920) : Number(target.width) },
          height:{ max:max1080 ? Math.min(Number(target.height), 1080) : Number(target.height) },
        } : {}) });
    } catch { throw new Error('无法应用所选共享画质，请降低帧率或分辨率后重试。'); }
    if (max1080) {
      const { width, height } = rawVideo.getSettings();
      if (!width || !height || width > 1920 || height > 1080) throw new Error('无法确认即构共享画面不超过 1080P，请更换浏览器或共享来源。');
    }
    const surface = rawVideo.getSettings().displaySurface || 'unknown';
    const settings = rawVideo.getSettings();
    const config = encoderConfig(p, { width: settings.width, height: settings.height });
    const video = sdk.createCustomVideoTrack({ mediaStreamTrack: rawVideo, ...config, optimizationMode: videoOptimization(p) });
    tracks.push(video);
    // Match audio to the selected source; unknown/older window captures cannot
    // fall back to system loopback. Full-screen capture may include system audio.
    const allowAudio = p.audio && (surface === 'browser' || surface === 'monitor' || (surface === 'window' && windowAudioSupported));
    for (const audio of stream.getAudioTracks()) {
      if (allowAudio && tracks.length === 1) { audio.contentHint = 'music'; tracks.push(sdk.createCustomAudioTrack({ mediaStreamTrack: audio, encoderConfig: 'music_standard' })); }
      else audio.stop();
    }
    let callback: (() => void) | undefined;
    const ended = () => callback?.();
    rawVideo.addEventListener('ended', ended);
    return {
      tracks, surface, hasAudio: tracks.length > 1,
      onEnded: handler => { callback = handler; if (rawVideo.readyState === 'ended') handler(); },
      close: () => {
        rawVideo.removeEventListener('ended', ended);
        for (const track of tracks) { track.stop(); track.close(); }
        for (const track of stream.getTracks()) track.stop();
      },
    };
  } catch (error) {
    for (const track of tracks) track.close();
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
}
