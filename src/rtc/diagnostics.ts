export type DiagnosticValue<T> = { status:'available'; value:T } | { status:'unavailable'; value:null; reason:string };
export interface StatisticsObservation {
  source: string;
  kind: 'poll' | 'callback';
  observedAt: number;
  readAt: number;
  observationAgeMs: number;
  sdkSampleAt: null;
  sdkSampleAgeMs: null;
  stale: boolean | null;
  intervalMs: number | null;
}
export interface EncodingDiagnostics {
  qualityLimitationReason: DiagnosticValue<string>;
  encoderImplementation: DiagnosticValue<string>;
  hardwareAccelerated: DiagnosticValue<boolean>;
  meanEncodeTimeMs: DiagnosticValue<number>;
  encoderOutputFps: DiagnosticValue<number>;
  rendererOutputFps: DiagnosticValue<number>;
  targetFps: DiagnosticValue<number>;
  encodedFrames: DiagnosticValue<number>;
  encodedBitrateBps: DiagnosticValue<number>;
  uplinkLossPercent: DiagnosticValue<number>;
}
export const unavailable = <T>(reason = 'not-exposed-by-sdk'): DiagnosticValue<T> => ({status:'unavailable',value:null,reason});
export const diagnosticNumber = (value: unknown): DiagnosticValue<number> => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? {status:'available',value} : unavailable('not-reported');
export const diagnosticBoolean = (value: unknown): DiagnosticValue<boolean> => typeof value === 'boolean'
  ? {status:'available',value} : unavailable('not-reported');
export function encodingDiagnostics(values: Partial<EncodingDiagnostics> = {}): EncodingDiagnostics {
  return {qualityLimitationReason:unavailable(),encoderImplementation:unavailable(),hardwareAccelerated:unavailable(),meanEncodeTimeMs:unavailable(),
    encoderOutputFps:unavailable(),rendererOutputFps:unavailable(),targetFps:unavailable(),encodedFrames:unavailable(),encodedBitrateBps:unavailable(),uplinkLossPercent:unavailable(),...values};
}
export function statisticsObservation(source: string, kind: StatisticsObservation['kind'], observedAt: number, interval?: number): StatisticsObservation {
  const readAt = Date.now(), age = Math.max(0,readAt - observedAt);
  return {source,kind,observedAt,readAt,observationAgeMs:age,sdkSampleAt:null,sdkSampleAgeMs:null,
    stale:kind === 'callback' ? age > 6000 : null,intervalMs:typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : null};
}
