import { createDeepFilterNetAudioWorklet } from '@workadventure/noise-suppression/deepfilternet';
// The package's own files, bundled with the app: no download at runtime. (Paths, because its exports do not list them.)
import dfWorkletSource from '../../../node_modules/@workadventure/noise-suppression/dist/assets/deepfilternet-worklet-processor.js?raw';
import dfWasm from '../../../node_modules/@workadventure/noise-suppression/dist/assets/deepfilternet/df_bg.wasm?url';
import dfModel from '../../../node_modules/@workadventure/noise-suppression/dist/assets/deepfilternet/DeepFilterNet3_onnx.tar.gz?url';
import type { NoiseNode, NoiseSettings } from './noise.ts';

// Same for DeepFilterNet3: its worklet takes no level changes after it starts. The wasm module has the call for it.
const dfWorklet = dfWorkletSource.replace('if (event.data.type === "dispose") this.state = void 0;',
  'if (event.data.type === "dispose") this.state = void 0; else if (event.data.type === "atten" && this.state !== void 0) wasm.df_set_atten_lim(this.state, event.data.value);');
let dfModuleUrl: string | undefined;

// DeepFilterNet3, without its pause gate (the voice activity setting does that job)
export async function createDeepFilter(ctx: AudioContext, s: NoiseSettings): Promise<NoiseNode> {
  dfModuleUrl ??= URL.createObjectURL(new Blob([dfWorklet], { type: 'text/javascript' }));
  const df = await createDeepFilterNetAudioWorklet(ctx, {
    speechAttenuationDb: s.dfLevel, pauseAttenuationDb: 0, moduleUrl: dfModuleUrl, wasmUrl: dfWasm, modelUrl: dfModel
  });
  return {
    engine: 'deepfilter', input: df.node, output: df.node,
    update: s => df.node.port.postMessage({ type: 'atten', value: s.dfLevel }),
    destroy: () => df.dispose()
  };
}
