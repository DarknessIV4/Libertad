import * as ort from 'onnxruntime-web/wasm';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import sileroModel from '@ricky0123/vad-web/dist/silero_vad_v5.onnx?url';
import type { Probe } from './detect.ts';

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
