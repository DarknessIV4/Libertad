import { RnnoiseWorkletNode, SpeexWorkletNode, loadRnnoise, loadSpeex } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletSource from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?raw';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import speexWorkletSource from '@sapphi-red/web-noise-suppressor/speexWorklet.js?raw';
import speexWasm from '@sapphi-red/web-noise-suppressor/speex.wasm?url';
import { createDeepFilterNetAudioWorklet } from '@workadventure/noise-suppression/deepfilternet';
// The package's own files, bundled with the app: no download at runtime. (Paths, because its exports do not list them.)
import dfWorkletSource from '../../../node_modules/@workadventure/noise-suppression/dist/assets/deepfilternet-worklet-processor.js?raw';
import dfWasm from '../../../node_modules/@workadventure/noise-suppression/dist/assets/deepfilternet/df_bg.wasm?url';
import dfModel from '../../../node_modules/@workadventure/noise-suppression/dist/assets/deepfilternet/DeepFilterNet3_onnx.tar.gz?url';

export type NoiseEngine = 'rnnoise' | 'speex' | 'deepfilter';

// The settings each engine reads
export interface NoiseSettings {
  rnnoiseStrength: number;  // 0..100 %, how much of the cleaned signal is mixed in
  speexLevel: number;       // dB of noise reduction, -60..-5
  dfLevel: number;          // dB of noise reduction, 6..100
}

export interface NoiseNode {
  engine: NoiseEngine;
  input: AudioNode;
  output: AudioNode;
  update(s: NoiseSettings): void;
  destroy(): void;
}

// RNNoise delays its output by 512 samples (see its worklet); the untouched copy is delayed the same for the strength mix
const RNNOISE_LATENCY = 512 / 48000;

// The stock Speex worklet cannot change its suppression level. This lets it take the level as a
// message (and start with it), without shipping a modified copy of the library.
const speexWorklet = speexWorkletSource
  .replace('this.port.addEventListener(`message`,e=>{e.data===`destroy`&&this.destroy()})',
    'this.port.onmessage=e=>{if(e.data===`destroy`)this.destroy();else{globalThis.__ns=e.data;this.processor&&this.processor.setProperty(`noiseSuppress`,e.data)}}')
  .replace('e.denoise=!0', 'e.denoise=!0,e.noiseSuppress=globalThis.__ns??-25');

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

// A worklet module can be added to a context only once
const modules = new WeakMap<AudioContext, Set<string>>();
async function addModule(ctx: AudioContext, name: string, url: () => string): Promise<void> {
  const loaded = modules.get(ctx) ?? modules.set(ctx, new Set()).get(ctx)!;
  if (loaded.has(name)) return;
  loaded.add(name);
  await ctx.audioWorklet.addModule(url()).catch(e => { loaded.delete(name); throw e; });
}

// Same for DeepFilterNet3: its worklet takes no level changes after it starts. The wasm module has the call for it.
const dfWorklet = dfWorkletSource.replace('if (event.data.type === "dispose") this.state = void 0;',
  'if (event.data.type === "dispose") this.state = void 0; else if (event.data.type === "atten" && this.state !== void 0) wasm.df_set_atten_lim(this.state, event.data.value);');
let dfModuleUrl: string | undefined;

export async function createRnnoiseNode(ctx: AudioContext): Promise<RnnoiseWorkletNode> {
  const [wasmBinary] = await Promise.all([
    loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm }),
    addModule(ctx, 'rnnoise', () => rnnoiseModuleUrl ??= URL.createObjectURL(new Blob([rnnoiseWorklet], { type: 'text/javascript' })))
  ]);
  return new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
}

export async function createNoise(ctx: AudioContext, engine: NoiseEngine, s: NoiseSettings): Promise<NoiseNode> {
  if (engine === 'rnnoise') {
    const node = await createRnnoiseNode(ctx);
    const input = new GainNode(ctx), output = new GainNode(ctx);
    const wet = new GainNode(ctx), dry = new GainNode(ctx), delay = new DelayNode(ctx, { delayTime: RNNOISE_LATENCY });
    input.connect(node).connect(wet).connect(output);
    input.connect(delay).connect(dry).connect(output);
    return {
      engine, input, output,
      update: s => { wet.gain.value = s.rnnoiseStrength / 100; dry.gain.value = 1 - s.rnnoiseStrength / 100; },
      destroy: () => { node.destroy(); for (const n of [input, node, wet, delay, dry, output]) n.disconnect(); }
    };
  }

  if (engine === 'speex') {
    const [wasmBinary] = await Promise.all([
      loadSpeex({ url: speexWasm }),
      addModule(ctx, engine, () => URL.createObjectURL(new Blob([speexWorklet], { type: 'text/javascript' })))
    ]);
    const node = new SpeexWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    return {
      engine, input: node, output: node,
      update: s => node.port.postMessage(Math.round(s.speexLevel)),
      destroy: () => { node.destroy(); node.disconnect(); }
    };
  }

  // DeepFilterNet3, without its pause gate (the voice activity setting does that job)
  dfModuleUrl ??= URL.createObjectURL(new Blob([dfWorklet], { type: 'text/javascript' }));
  const df = await createDeepFilterNetAudioWorklet(ctx, {
    speechAttenuationDb: s.dfLevel, pauseAttenuationDb: 0, moduleUrl: dfModuleUrl, wasmUrl: dfWasm, modelUrl: dfModel
  });
  return {
    engine, input: df.node, output: df.node,
    update: s => df.node.port.postMessage({ type: 'atten', value: s.dfLevel }),
    destroy: () => df.dispose()
  };
}
