export interface StartupSample {
  inputFrameRate?: number;
  encoderOutputFrameRate?: number;
  sentFrameRate?: number;
  videoLossRate?: number;
  rtt?: number;
  statsInterval?: number;
  encodedFrameWidth?: number;
  encodedFrameHeight?: number;
}
export interface StartupRecoverySnapshot {
  status: 'watching' | 'not-needed' | 'expired' | 'recovering' | 'republished' | 'failed' | 'cancelled';
  startedAt: number;
  triggeredAt?: number;
  completedAt?: number;
  reason?: 'healthy-input-encoder-stall';
  inputFps?: number;
  outputFps?: number;
  width?: number;
  height?: number;
}

// Only a cold publication with sustained healthy input and a stalled encoder
// is eligible. A low resolution alone is not evidence of a startup failure.
export class VolcStartupWatch {
  private state: StartupRecoverySnapshot;
  private targetFps: number;
  private size: {width:number; height:number};
  private previousAt?: number;
  private stalled = 0;
  private healthy = 0;
  constructor(targetFps: number, now: number, size = {width:1920,height:1080}) {
    this.targetFps = targetFps;
    this.size = size;
    this.state = {status:'watching',startedAt:now};
  }
  snapshot(): StartupRecoverySnapshot { return {...this.state}; }
  observe(sample: StartupSample, now: number): boolean {
    if (this.state.status !== 'watching') return false;
    if (now - this.state.startedAt > 20000) { this.state.status = 'expired'; return false; }
    if (this.previousAt !== undefined && now - this.previousAt < 500) return false;
    if (this.previousAt !== undefined && now - this.previousAt > 4000) { this.stalled = 0; this.healthy = 0; }
    this.previousAt = now;
    const input = sample.inputFrameRate, output = sample.encoderOutputFrameRate ?? sample.sentFrameRate;
    const valid = typeof input === 'number' && Number.isFinite(input) && typeof output === 'number' && Number.isFinite(output) && output >= 0
      && typeof sample.videoLossRate === 'number' && Number.isFinite(sample.videoLossRate) && sample.videoLossRate >= 0 && sample.videoLossRate <= .02
      && typeof sample.rtt === 'number' && Number.isFinite(sample.rtt) && sample.rtt >= 0 && sample.rtt <= 200
      && typeof sample.statsInterval === 'number' && sample.statsInterval >= 500 && sample.statsInterval <= 3000;
    if (!valid || this.targetFps < 30 || input < this.targetFps * .6) { this.stalled = 0; this.healthy = 0; return false; }
    this.healthy = output >= this.targetFps * .7 ? this.healthy + 1 : 0;
    if (this.healthy >= 3) { this.state.status = 'not-needed'; return false; }
    const width = sample.encodedFrameWidth, height = sample.encodedFrameHeight;
    const reduced = typeof width === 'number' && width > 0 && width <= this.size.width * .75
      && typeof height === 'number' && height > 0 && height <= this.size.height * .75;
    this.stalled = reduced && output <= this.targetFps * .25 ? this.stalled + 1 : 0;
    if (this.stalled < 3 || now - this.state.startedAt < 8000) return false;
    this.state = {...this.state,status:'recovering',triggeredAt:now,reason:'healthy-input-encoder-stall',inputFps:input,outputFps:output,width,height};
    return true;
  }
  finish(status: 'republished' | 'failed' | 'cancelled', now: number) {
    if (this.state.status === 'watching' || this.state.status === 'recovering') this.state = {...this.state,status,completedAt:now};
  }
}
