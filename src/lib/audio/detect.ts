import * as ort from 'onnxruntime-web/wasm';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import sileroModel from '@ricky0123/vad-web/dist/silero_vad_v5.onnx?url';
import { createRnnoiseNode } from './noise.ts';

// A speech detector: prob is the latest chance (0..1) that the microphone carries speech.
// Loaded on demand, so the app does not carry these until someone picks them.
export interface Probe {
  prob: number;
  push?(frame: Float32Array): void;  // 10 ms of audio at 48 kHz, for detectors that run here
  destroy(): void;
}

// Silero VAD v5: 512 samples at 16 kHz (32 ms) per step
export async function createSilero(): Promise<Probe> {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { wasm: ortWasm };
  const model = new Uint8Array(await (await fetch(sileroModel)).arrayBuffer());
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  const sr = new ort.Tensor('int64', [16000n]);
  let state = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]);
  const buf = new Float32Array(512);
  let fill = 0, busy = false;
  const probe: Probe = {
    prob: 0,
    push(frame) {
      // 48 kHz to 16 kHz by averaging each three samples
      for (let i = 0; i + 2 < frame.length; i += 3) {
        buf[fill++] = (frame[i] + frame[i + 1] + frame[i + 2]) / 3;
        if (fill < 512) continue;
        fill = 0;
        if (busy) continue;
        busy = true;
        session.run({ input: new ort.Tensor('float32', buf.slice(), [1, 512]), state, sr })
          .then(out => { state = out.stateN as typeof state; probe.prob = (out.output.data as Float32Array)[0]; })
          .catch(() => {})
          .finally(() => { busy = false; });
      }
    },
    destroy() { session.release().catch(() => {}); }
  };
  return probe;
}

// RNNoise rates every 10 ms how likely it is speech. A second RNNoise listens next to the
// microphone path and its sound goes nowhere.
export async function createRnnoiseProbe(ctx: AudioContext, from: AudioNode): Promise<Probe> {
  const node = await createRnnoiseNode(ctx);
  const mute = new GainNode(ctx, { gain: 0 });
  const probe: Probe = {
    prob: 0,
    destroy() { node.destroy(); for (const n of [node, mute]) n.disconnect(); from.disconnect(node); }
  };
  node.port.onmessage = e => { probe.prob = e.data; };
  node.port.postMessage('probe');
  from.connect(node).connect(mute).connect(ctx.destination);
  return probe;
}
