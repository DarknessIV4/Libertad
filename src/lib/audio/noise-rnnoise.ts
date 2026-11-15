import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletSource from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?raw';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import { addModule, type NoiseNode } from './noise.ts';

// RNNoise delays its output by 512 samples (see its worklet); the untouched copy is delayed the same for the strength mix
const RNNOISE_LATENCY = 512 / 48000;

// RNNoise rates each 10 ms frame by how likely it is speech; the stock worklet drops that number.
// This sends it out on request ('probe'), and makes its stop message arrive (it was never listened for).
const rnnoiseWorklet = [
  ['let t=e.createDenoiseState(),n=e=>{u(e),t.processFrame(e),d(e)}', 'let vp=0,t=e.createDenoiseState(),n=e=>{u(e),vp=t.processFrame(e),d(e)}'],
  ['return{process:(e,t)=>{if(i.set(e,a)', 'return{vp:()=>vp,process:(e,t)=>{if(i.set(e,a)'],
  ['return{process:(e,t)=>{let i=Math.min(e.length,n)', 'return{vp:()=>r[0].vp(),process:(e,t)=>{let i=Math.min(e.length,n)'],
  ['this.processor.process(e[0],t[0]),!0)', 'this.processor.process(e[0],t[0]),this.probe&&this.processor&&this.port.postMessage(this.processor.vp()),!0)'],
  ['this.port.addEventListener(`message`,e=>{e.data===`destroy`&&this.destroy()})', 'this.port.onmessage=e=>{e.data===`destroy`?this.destroy():this.probe=!0}']
].reduce((src, [a, b]) => src.replace(a, b), rnnoiseWorkletSource);
let rnnoiseModuleUrl: string | undefined;

export async function createRnnoiseNode(ctx: AudioContext): Promise<RnnoiseWorkletNode> {
  const [wasmBinary] = await Promise.all([
    loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm }),
    addModule(ctx, 'rnnoise', () => rnnoiseModuleUrl ??= URL.createObjectURL(new Blob([rnnoiseWorklet], { type: 'text/javascript' })))
  ]);
  return new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
}

export async function createRnnoise(ctx: AudioContext): Promise<NoiseNode> {
  const node = await createRnnoiseNode(ctx);
  const input = new GainNode(ctx), output = new GainNode(ctx);
  const wet = new GainNode(ctx), dry = new GainNode(ctx), delay = new DelayNode(ctx, { delayTime: RNNOISE_LATENCY });
  input.connect(node).connect(wet).connect(output);
  input.connect(delay).connect(dry).connect(output);
  return {
    engine: 'rnnoise', input, output,
    update: s => { wet.gain.value = s.rnnoiseStrength / 100; dry.gain.value = 1 - s.rnnoiseStrength / 100; },
    destroy: () => { node.destroy(); for (const n of [input, node, wet, delay, dry, output]) n.disconnect(); }
  };
}
