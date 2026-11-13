import feedUrl from './pcm-feed.worklet.ts?worker&url';

// Turns the PCM the desktop app captures from the system (everything except this app) into an
// audio track. Nothing is played through the speakers. Stopping the track releases everything.
export async function systemAudioTrack(
  onPcm: (fn: (chunk: Uint8Array) => void) => () => void,
  start: () => Promise<void>,
  stop: () => void
): Promise<MediaStreamTrack> {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  let off: (() => void) | null = null;
  try {
    await ctx.audioWorklet.addModule(feedUrl);
    const node = new AudioWorkletNode(ctx, 'pcm-feed', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    off = onPcm(chunk => {
      // A copy: the chunk may be a view into a larger buffer
      const copy = chunk.slice().buffer;
      node.port.postMessage(copy, [copy]);
    });
    await start();
    if (ctx.state !== 'running') await ctx.resume();
    const track = dest.stream.getAudioTracks()[0];
    const original = track.stop.bind(track);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      off?.();
      stop();
      ctx.close().catch(() => {});
    };
    track.stop = () => { original(); release(); };
    return track;
  } catch (e) {
    off?.();
    ctx.close().catch(() => {});
    throw e;
  }
}
