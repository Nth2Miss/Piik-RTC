import type { IAgoraRTC, ILocalVideoTrack, ILocalAudioTrack } from 'agora-rtc-sdk-ng';
import { encoderConfig, type Preferences } from './preferences.ts';

export function displayOptions(p: Preferences) {
  const { width, height } = encoderConfig(p);
  return {
    video: { width: { ideal: width as number }, height: { ideal: height as number }, frameRate: { ideal: p.fps, max: p.fps } },
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
): Promise<CapturedScreen> {
  // Call immediately from the share button, before any await that could lose activation.
  const stream = await acquire(displayOptions(p));
  const tracks: (ILocalVideoTrack | ILocalAudioTrack)[] = [];
  try {
    const rawVideo = stream.getVideoTracks()[0];
    if (!rawVideo) throw new Error('浏览器没有返回共享画面，请重新选择。');
    const surface = rawVideo.getSettings().displaySurface || 'unknown';
    const config = encoderConfig(p);
    const video = sdk.createCustomVideoTrack({ mediaStreamTrack: rawVideo, ...config, optimizationMode: p.optimization });
    tracks.push(video);
    // Match audio to the selected source; unknown/older window captures cannot
    // fall back to system loopback. Full-screen capture may include system audio.
    const allowAudio = p.audio && (surface === 'browser' || surface === 'monitor' || (surface === 'window' && windowAudioSupported));
    for (const audio of stream.getAudioTracks()) {
      if (allowAudio && tracks.length === 1) tracks.push(sdk.createCustomAudioTrack({ mediaStreamTrack: audio, encoderConfig: 'music_standard' }));
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
