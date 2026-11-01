/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface MediaStreamTrackGeneratorInit {
  kind: 'video' | 'audio';
}
interface MediaStreamTrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame>;
}
declare const MediaStreamTrackGenerator: {
  new (init: MediaStreamTrackGeneratorInit): MediaStreamTrackGenerator;
};
