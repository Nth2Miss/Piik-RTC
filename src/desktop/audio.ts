import { desktopBridge, type DesktopAudioFormat } from './bridge.ts';

const WORKLET_SOURCE = String.raw`
class PiikPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputChannels = 2;
    this.queue = [];
    this.readOffset = 0;
    this.queued = 0;
    this.started = false;
    this.prebufferFrames = Math.round(sampleRate * 0.08);
    this.maxFrames = Math.round(sampleRate * 4);
    this.peak = 0;
    this.lastReport = 0;
    this.port.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'config') {
        this.inputChannels = Math.max(1, Math.min(8, data.channels || 2));
        this.prebufferFrames = Math.round(sampleRate * 0.08);
        this.maxFrames = Math.round(sampleRate * 4);
      } else if (data.type === 'data' && data.samples instanceof Float32Array) {
        this.queue.push(data.samples);
        this.queued += data.samples.length;
        this.trim();
      }
    };
  }
  trim() {
    const maxSamples = this.maxFrames * this.inputChannels;
    while (this.queued > maxSamples && this.queue.length) {
      const head = this.queue[0];
      const available = head.length - this.readOffset;
      const excess = this.queued - maxSamples;
      if (available <= excess) {
        this.queue.shift();
        this.readOffset = 0;
        this.queued -= available;
      } else {
        this.readOffset += excess;
        this.queued -= excess;
      }
    }
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    for (let channel = 0; channel < output.length; channel++) output[channel].fill(0);
    if (!this.started) {
      if (this.queued < this.prebufferFrames * this.inputChannels) return true;
      this.started = true;
    }
    let written = 0;
    while (written < frames) {
      const head = this.queue[0];
      if (!head) break;
      const available = head.length - this.readOffset;
      if (available < this.inputChannels) {
        this.queue.shift();
        this.readOffset = 0;
        this.queued -= Math.max(0, available);
        continue;
      }
      const framesAvailable = Math.floor(available / this.inputChannels);
      const take = Math.min(framesAvailable, frames - written);
      for (let frame = 0; frame < take; frame++) {
        const base = this.readOffset + frame * this.inputChannels;
        const left = head[base] || 0;
        const right = this.inputChannels > 1 ? head[base + 1] || 0 : left;
        output[0][written + frame] = left;
        if (output[1]) output[1][written + frame] = right;
        const leftPeak = Math.abs(left);
        const rightPeak = Math.abs(right);
        if (leftPeak > this.peak) this.peak = leftPeak;
        if (rightPeak > this.peak) this.peak = rightPeak;
      }
      const consumed = take * this.inputChannels;
      this.readOffset += consumed;
      this.queued -= consumed;
      written += take;
      if (this.readOffset >= head.length) {
        this.queue.shift();
        this.readOffset = 0;
      }
    }
    if (written < frames) this.started = false;
    if (currentTime - this.lastReport >= 0.25) {
      this.port.postMessage({
        type: 'level',
        peak: this.peak,
        bufferedMs: Math.round((this.queued / this.inputChannels / sampleRate) * 1000),
      });
      this.peak = 0;
      this.lastReport = currentTime;
    }
    return true;
  }
}
registerProcessor('piik-pcm-player', PiikPcmPlayer);
`;

export interface ProcessAudioOptions {
  mode: 'system' | 'include' | 'exclude';
  pid?: number | null;
  onEnded?: (info: { code: string; message: string }) => void;
  onLevel?: (peak: number, bufferedMs: number) => void;
}

export interface ProcessAudio {
  track: MediaStreamTrack;
  format: DesktopAudioFormat;
  stop: () => Promise<void>;
}

function pcmToFloat32(chunk: Uint8Array, format: DesktopAudioFormat): Float32Array {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (format.encoding === 'pcm_f32le') {
    const count = Math.floor(chunk.byteLength / 4);
    const samples = new Float32Array(count);
    for (let index = 0; index < count; index++) samples[index] = view.getFloat32(index * 4, true);
    return samples;
  }
  if (format.encoding === 'pcm_s32le') {
    const count = Math.floor(chunk.byteLength / 4);
    const samples = new Float32Array(count);
    for (let index = 0; index < count; index++) samples[index] = view.getInt32(index * 4, true) / 2147483648;
    return samples;
  }
  if (format.encoding === 'pcm_s16le') {
    const count = Math.floor(chunk.byteLength / 2);
    const samples = new Float32Array(count);
    for (let index = 0; index < count; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
    return samples;
  }
  throw new Error(`不支持的音频格式：${format.encoding}`);
}

export async function startProcessAudio(options: ProcessAudioOptions): Promise<ProcessAudio> {
  const bridge = desktopBridge;
  if (!bridge) throw new Error('桌面音频采集不可用。');

  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let track: MediaStreamTrack | undefined;
  let sink: ((data: Uint8Array) => void) | undefined;
  let leftover: Uint8Array = new Uint8Array(0);
  const pending: Uint8Array[] = [];
  let stopped = false;

  const offData = bridge.onAudioData(data => {
    if (stopped) return;
    if (sink) sink(data);
    else if (pending.length < 600) pending.push(data);
  });
  const offEnded = bridge.onAudioEnded(info => {
    if (!stopped) options.onEnded?.(info);
  });

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    offData();
    offEnded();
    sink = undefined;
    try { await bridge.stopAudio(); } catch { /* already stopped */ }
    try { node?.disconnect(); } catch { /* disconnected */ }
    try { destination?.disconnect(); } catch { /* disconnected */ }
    try { track?.stop(); } catch { /* already stopped */ }
    try { await context?.close(); } catch { /* already closed */ }
  };

  let started;
  try {
    started = await bridge.startAudio({ mode: options.mode, pid: options.pid ?? null });
  } catch (error) {
    await stop();
    throw error;
  }
  if (!started.ok) {
    await stop();
    throw new Error(started.message || '无法开始音频采集。');
  }

  const format: DesktopAudioFormat = {
    sampleRate: Number(started.sampleRate) || 48000,
    channels: Number(started.channels) || 2,
    bits: Number(started.bits) || 16,
    encoding: String(started.encoding || 'pcm_s16le'),
    blockAlign: Number(started.blockAlign) || 4,
    mode: String(started.mode || options.mode),
  };

  try {
    context = new AudioContext({ sampleRate: format.sampleRate, latencyHint: 'interactive' });
    const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await context.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    node = new AudioWorkletNode(context, 'piik-pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
    destination.channelCountMode = 'explicit';
    node.connect(destination);
    node.port.postMessage({ type: 'config', channels: format.channels, sampleRate: format.sampleRate });
    node.port.onmessage = event => {
      const data = event.data;
      if (data?.type === 'level' && !stopped) options.onLevel?.(Number(data.peak) || 0, Number(data.bufferedMs) || 0);
    };
    await context.resume();
    track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('无法创建音频轨道。');

    sink = data => {
      leftover = leftover.length ? new Uint8Array([...leftover, ...data]) : data;
      const frameBytes = Math.max(2, format.blockAlign);
      const usable = leftover.length - (leftover.length % frameBytes);
      if (!usable) return;
      const chunk = leftover.subarray(0, usable);
      leftover = leftover.subarray(usable);
      const samples = pcmToFloat32(chunk, format);
      node?.port.postMessage({ type: 'data', samples }, [samples.buffer]);
    };
    for (const chunk of pending.splice(0)) sink(chunk);
  } catch (error) {
    await stop();
    throw error;
  }

  return { track, format, stop };
}
