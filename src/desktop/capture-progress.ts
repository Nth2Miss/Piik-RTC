import type { CapturePipelineStats } from '../capture.ts';

export class CaptureProgress {
  private stopped = false;
  private listeners = new Set<() => void>();
  readonly stats: CapturePipelineStats;
  constructor(stats: CapturePipelineStats) { this.stats = stats; }
  received() {
    this.stats.received++; this.stats.lastInputAt = Date.now(); this.stats.firstInputAt ??= this.stats.lastInputAt;
    this.listeners.forEach(listener => listener());
  }
  written() {
    if (this.stopped) return;
    this.stats.written++; this.stats.lastOutputAt = Date.now(); this.stats.firstOutputAt ??= this.stats.lastOutputAt;
    this.listeners.forEach(listener => listener());
  }
  failed(error: unknown) { this.stats.errors++; this.stats.lastError = String(error instanceof Error ? error.message : error).slice(0, 200); }
  stop() { this.stopped = true; this.listeners.forEach(listener => listener()); }
  wait(stage: 'received' | 'written', timeout = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); this.listeners.delete(check); if (error) reject(error); else resolve(); };
      const check = () => {
        if (this.stopped) finish(new Error('画面采集已停止，请重新选择。'));
        else if (this.stats[stage] > 0) finish();
      };
      const timer = setTimeout(() => finish(new Error(stage === 'received' ? '未收到原生采集画面，请恢复共享窗口后重试。' : '采集画面未成功输出，请重新选择采集来源后重试。')), timeout);
      this.listeners.add(check); check();
    });
  }
}
