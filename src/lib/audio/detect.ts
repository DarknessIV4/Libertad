// Only the detector that is chosen is loaded: Silero (onnxruntime and its model) and the RNNoise probe each live in
// their own module, imported when first needed.
// A speech detector: prob is the latest chance (0..1) that the microphone carries speech.
export interface Probe {
  prob: number;
  push?(frame: Float32Array): void;  // 10 ms of audio at 48 kHz, for detectors that run here
  destroy(): void;
}

export async function createSilero(): Promise<Probe> {
  return (await import('./detect-silero.ts')).createSilero();
}

// RNNoise rates every 10 ms how likely it is speech. A second RNNoise listens next to the
// microphone path and its sound goes nowhere.
export async function createRnnoiseProbe(ctx: AudioContext, from: AudioNode): Promise<Probe> {
  const { createRnnoiseNode } = await import('./noise-rnnoise.ts');
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
