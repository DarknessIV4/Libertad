// Only the engine that is chosen is loaded: each lives in its own module (noise-rnnoise.ts, noise-speex.ts,
// noise-deepfilter.ts) that is imported when first needed, so the others' code, worklet sources and wasm never load.
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


// A worklet module can be added to a context only once
const modules = new WeakMap<AudioContext, Set<string>>();
export async function addModule(ctx: AudioContext, name: string, url: () => string): Promise<void> {
  const loaded = modules.get(ctx) ?? modules.set(ctx, new Set()).get(ctx)!;
  if (loaded.has(name)) return;
  loaded.add(name);
  await ctx.audioWorklet.addModule(url()).catch(e => { loaded.delete(name); throw e; });
}

export async function createNoise(ctx: AudioContext, engine: NoiseEngine, s: NoiseSettings): Promise<NoiseNode> {
  if (engine === 'rnnoise') return (await import('./noise-rnnoise.ts')).createRnnoise(ctx);
  if (engine === 'speex') return (await import('./noise-speex.ts')).createSpeex(ctx);
  return (await import('./noise-deepfilter.ts')).createDeepFilter(ctx, s);
}
