export interface PlaybackSnapshot {
  fps: number;
  dropped: number;
  total: number;
  droppedPercent: number;
}
interface FrameCounters { totalVideoFrames: number; droppedVideoFrames: number }

export class PlaybackSampler {
  private previous?: { at: number; total: number; dropped: number };
  sample(quality: FrameCounters, at: number): PlaybackSnapshot | undefined {
    const { totalVideoFrames: total, droppedVideoFrames: dropped } = quality;
    const previous = this.previous;
    this.previous = { at, total, dropped };
    if (!previous || at <= previous.at || total < previous.total || dropped < previous.dropped) return;
    const frames = total - previous.total, lost = Math.min(frames, dropped - previous.dropped);
    return { fps:Math.max(0, frames - lost) * 1000 / (at - previous.at),
      total:frames, dropped:lost, droppedPercent:frames ? lost * 100 / frames : 0 };
  }
}
