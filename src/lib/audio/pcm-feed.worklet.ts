/// <reference path="./worklet-env.d.ts" />
// Plays PCM that arrives as messages: interleaved signed 16-bit stereo at the context's sample
// rate. Used to turn captured system sound into an audio track. Starts after a short buffer and
// drops the oldest sound when the page falls behind, so the delay stays small.

class PcmFeedProcessor extends AudioWorkletProcessor {
  private chunks: Int16Array[] = [];
  private offset = 0;      // read position in chunks[0], in samples (both channels)
  private queued = 0;      // frames waiting
  private playing = false;
  private start = Math.round(sampleRate * 0.04);
  private max = Math.round(sampleRate * 0.4);

  constructor() {
    super();
    this.port.onmessage = e => {
      const pcm = new Int16Array(e.data as ArrayBuffer);
      this.chunks.push(pcm);
      this.queued += pcm.length >> 1;
      while (this.queued > this.max && this.chunks.length > 1) {
        const old = this.chunks.shift()!;
        this.queued -= (old.length - this.offset) >> 1;
        this.offset = 0;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const left = out[0], right = out[1] ?? out[0];
    const n = left.length;
    if (!this.playing && this.queued >= this.start) this.playing = true;
    if (!this.playing) return true;
    for (let i = 0; i < n; i++) {
      const chunk = this.chunks[0];
      if (!chunk) { this.playing = false; break; }
      left[i] = chunk[this.offset] / 32768;
      right[i] = chunk[this.offset + 1] / 32768;
      this.offset += 2;
      this.queued--;
      if (this.offset >= chunk.length) { this.chunks.shift(); this.offset = 0; }
    }
    return true;
  }
}

registerProcessor('pcm-feed', PcmFeedProcessor);
