import { SpeexWorkletNode, loadSpeex } from '@sapphi-red/web-noise-suppressor';
import speexWorkletSource from '@sapphi-red/web-noise-suppressor/speexWorklet.js?raw';
import speexWasm from '@sapphi-red/web-noise-suppressor/speex.wasm?url';
import { addModule, type NoiseNode } from './noise.ts';

// The stock Speex worklet cannot change its suppression level. This lets it take the level as a
// message (and start with it), without shipping a modified copy of the library.
const speexWorklet = speexWorkletSource
  .replace('this.port.addEventListener(`message`,e=>{e.data===`destroy`&&this.destroy()})',
    'this.port.onmessage=e=>{if(e.data===`destroy`)this.destroy();else{globalThis.__ns=e.data;this.processor&&this.processor.setProperty(`noiseSuppress`,e.data)}}')
  .replace('e.denoise=!0', 'e.denoise=!0,e.noiseSuppress=globalThis.__ns??-25');

let workletUrl: string | null = null;

export async function createSpeex(ctx: AudioContext): Promise<NoiseNode> {
  const [wasmBinary] = await Promise.all([
    loadSpeex({ url: speexWasm }),
    addModule(ctx, 'speex', () => workletUrl ??= URL.createObjectURL(new Blob([speexWorklet], { type: 'text/javascript' })))
  ]);
  const node = new SpeexWorkletNode(ctx, { maxChannels: 1, wasmBinary });
  return {
    engine: 'speex', input: node, output: node,
    update: s => node.port.postMessage(Math.round(s.speexLevel)),
    destroy: () => { node.destroy(); node.disconnect(); }
  };
}
