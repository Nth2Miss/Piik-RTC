import { effectiveBitrate, encoderConfig, normalizePreferences, sourceContentHint, videoOptimization, type Preferences } from './preferences.ts';
import type { CapturedScreen, CapturePipelineStats } from './capture.ts';
import type { RtcProvider } from './types';

export interface ShareAttemptSnapshot {
  id: string;
  roomId: string;
  provider: RtcProvider;
  startedAt: number;
  publishedAt?: number;
  endedAt?: number;
  status: 'starting' | 'publishing' | 'sharing' | 'stopped' | 'failed';
  requested: Preferences;
  applied: Preferences;
  encoderRequest: ReturnType<typeof encoderConfig> & { bitrateKbps:number; optimizationMode:Preferences['optimization']; sourceContentHint:string };
  capture?: { surface:string; width:number; height:number; hasAudio:boolean; path?:CapturePipelineStats['path'] };
  finalPipeline?: CapturePipelineStats;
}

/** Export copies so later UI settings and stop events cannot rewrite old samples. */
export class ShareDiagnostics {
  private attempts: ShareAttemptSnapshot[] = [];
  private activeId?: string;
  get shareId() { return this.activeId; }
  begin(roomId: string, provider: RtcProvider, requested: Preferences, applied: Preferences, at = Date.now()) {
    const id = crypto.randomUUID();
    const selected = normalizePreferences(applied);
    this.attempts.push({id,roomId,provider,startedAt:at,status:'starting',requested:normalizePreferences(requested),applied:selected,
      encoderRequest:{...encoderConfig(selected),bitrateKbps:effectiveBitrate(selected),optimizationMode:videoOptimization(selected),sourceContentHint:sourceContentHint(selected)}});
    if (this.attempts.length > 30) this.attempts.shift();
    this.activeId = id;
    return id;
  }
  captured(id: string, capture: Pick<CapturedScreen,'width' | 'height' | 'hasAudio' | 'surface' | 'diagnostics'>) {
    const entry = this.attempts.find(item => item.id === id);
    if (!entry || this.activeId !== id) return;
    entry.status = 'publishing';
    entry.capture = {width:capture.width,height:capture.height,hasAudio:capture.hasAudio,surface:capture.surface,path:capture.diagnostics?.().path};
    entry.encoderRequest = {...entry.encoderRequest,...encoderConfig(entry.applied,capture)};
  }
  published(id: string, at = Date.now()) {
    const entry = this.attempts.find(item => item.id === id);
    if (entry && this.activeId === id) { entry.status = 'sharing'; entry.publishedAt = at; }
  }
  finish(id: string | undefined, status: 'stopped' | 'failed', pipeline?: CapturePipelineStats, at = Date.now()) {
    const entry = this.attempts.find(item => item.id === id);
    if (!entry || this.activeId !== id) return;
    entry.status = status; entry.endedAt = at;
    if (pipeline) entry.finalPipeline = {...pipeline};
    this.activeId = undefined;
  }
  export(): ShareAttemptSnapshot[] { return structuredClone(this.attempts); }
}
