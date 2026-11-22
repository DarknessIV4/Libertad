// Screen sharing OUT on Android. Android's WebView has no getDisplayMedia, so the screen is captured natively
// (MediaProjection -> MediaCodec H.264, mobile/android/templates/LibertadCapture*.java, a Capacitor plugin of this app)
// and arrives here as encoded frames. They are decoded with WebCodecs, drawn on a canvas, and the canvas' captureStream()
// is what getDisplayMedia() returns. From there share.svelte.ts treats it like any desktop capture: same WebRTC
// connection, same quality settings, same stop button. Nothing else in the app knows about Android.
//
//   Java encoder --(base64 JSON events)--> CaptureSource --> VideoDecoder --> <canvas> --> captureStream() --> RTCPeerConnection
//
// Sound of the phone (AudioPlaybackCapture, Android 10+) arrives as 48 kHz stereo PCM and becomes the stream's audio track.
// A rotation makes the native side start a new encoder; its keyframe has a new SPS and the decoder is configured again.
// Watching shares and the camera need nothing from here: they are plain WebRTC / getUserMedia in the WebView.

import { loadPlugin } from './capacitor-plugin.ts';

export interface CaptureFrame {
  key: boolean;
  // microseconds
  ts: number;
  data: Uint8Array;
}

export interface CaptureStart {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  audio: boolean;
}

export interface CaptureHandlers {
  frame(f: CaptureFrame): void;
  // 16-bit little-endian interleaved stereo, 48 kHz, ~20 ms
  audio?(pcm: Uint8Array): void;
  // The native side ended it (the user stopped it from the notification, the system revoked the projection)
  stopped(): void;
}

export interface CaptureSource {
  // Asks the person for permission (the system's "start recording or casting?" dialog) and starts the encoder.
  // Rejects with name NotAllowedError when they refuse. `codec` is a WebCodecs codec string when the source knows it
  // (H.264 sources leave it out: it is read from the first keyframe).
  start(options: CaptureStart, handlers: CaptureHandlers): Promise<{ width: number; height: number; codec?: string; audio?: boolean }>;
  stop(): Promise<void>;
}

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// The plugin ("LibertadCapture"). Frames come as events; a refusal comes as a rejected start().
export function capacitorCapture(): CaptureSource {
  type Handle = { remove(): Promise<void> };
  interface Plugin {
    start(o: CaptureStart): Promise<{ width: number; height: number; audio?: boolean }>;
    stop(): Promise<void>;
    addListener(event: 'frame', cb: (e: { data: string; key: boolean; ts: number }) => void): Promise<Handle>;
    addListener(event: 'audio', cb: (e: { data: string }) => void): Promise<Handle>;
    addListener(event: 'stopped', cb: () => void): Promise<Handle>;
  }
  const get = () => loadPlugin<Plugin>('LibertadCapture');
  let handles: Handle[] = [];
  const unlisten = async () => { const h = handles; handles = []; await Promise.all(h.map(x => x.remove().catch(() => {}))); };
  return {
    async start(options, handlers) {
      const p = await get();
      await unlisten();
      handles = [
        await p.addListener('frame', e => handlers.frame({ key: e.key, ts: e.ts, data: fromB64(e.data) })),
        await p.addListener('audio', e => handlers.audio?.(fromB64(e.data))),
        await p.addListener('stopped', () => handlers.stopped())
      ];
      try {
        return await p.start(options);
      } catch (e) {
        await unlisten();
        const message = (e as Error)?.message ?? String(e);
        // Capacitor rejects with the Java message; the system dialog's "Cancel" is reported as "denied"
        throw new DOMException(message, /denied|cancel|refus/i.test(message) ? 'NotAllowedError' : 'AbortError');
      }
    },
    async stop() {
      const p = await get();
      await p.stop().catch(() => {});
      await unlisten();
    }
  };
}

// "avc1.PPCCLL" from the first sequence parameter set (NAL type 7) in an Annex B buffer, or null
export const h264CodecOf = (data: Uint8Array): string | null => h264Sps(data)?.codec ?? null;

// The codec string and a fingerprint of the whole SPS (a different size or level gives a different one)
export function h264Sps(data: Uint8Array): { codec: string; key: string } | null {
  for (let i = 0; i + 7 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
      const at = i + (data[i + 2] === 1 ? 3 : 4);
      if ((data[at] & 0x1f) === 7) {
        const hex = (n: number) => n.toString(16).padStart(2, '0');
        let end = at + 1;
        while (end < data.length && !(data[end] === 0 && data[end + 1] === 0 && (data[end + 2] === 1 || (data[end + 2] === 0 && data[end + 3] === 1)))) end++;
        return { codec: `avc1.${hex(data[at + 1])}${hex(data[at + 2])}${hex(data[at + 3])}`, key: Array.from(data.subarray(at, end), hex).join('') };
      }
    }
  }
  return null;
}

const clampNumber = (v: unknown, fallback: number): number => {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') {
    const c = v as { ideal?: number; exact?: number; max?: number };
    return c.exact ?? c.ideal ?? c.max ?? fallback;
  }
  return fallback;
};

// What the decoded picture is drawn on. Kept out of the page and sized by the first frame.
function makeCanvas(): HTMLCanvasElement {
  return document.createElement('canvas');
}

// PCM in, a MediaStream audio track out: an AudioWorklet plays a small queue into a MediaStreamAudioDestinationNode.
// The queue is kept short (0.3 s) so the sound never drifts behind the picture; a gap plays as silence.
const WORKLET = `
registerProcessor('libertad-pcm', class extends AudioWorkletProcessor {
  constructor() { super(); this.q = []; this.at = 0; this.n = 0;
    this.port.onmessage = e => { this.q.push(e.data); this.n += e.data[0].length; while (this.n - this.at > 14400 && this.q.length > 1) { this.n -= this.q.shift()[0].length; this.at = 0; } }; }
  process(_in, out) {
    const l = out[0][0], r = out[0][1] || l;
    for (let i = 0; i < l.length; i++) {
      const c = this.q[0];
      if (!c) { l[i] = 0; r[i] = 0; continue; }
      l[i] = c[0][this.at]; r[i] = c[1][this.at];
      if (++this.at >= c[0].length) { this.n -= c[0].length; this.q.shift(); this.at = 0; }
    }
    return true;
  }
});`;

async function pcmTrack(): Promise<{ track: MediaStreamTrack; push(pcm: Uint8Array): void; close(): void }> {
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  const node = new AudioWorkletNode(context, 'libertad-pcm', { numberOfInputs: 0, outputChannelCount: [2] });
  const destination = context.createMediaStreamDestination();
  node.connect(destination);
  void context.resume().catch(() => {});
  return {
    track: destination.stream.getAudioTracks()[0],
    push(pcm) {
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
      const frames = samples.length >> 1;
      const left = new Float32Array(frames), right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) { left[i] = samples[2 * i] / 32768; right[i] = samples[2 * i + 1] / 32768; }
      node.port.postMessage([left, right], [left.buffer, right.buffer]);
    },
    close() { void context.close().catch(() => {}); }
  };
}

export function installAndroidDisplayMedia(source: CaptureSource = capacitorCapture()): void {
  const devices = navigator.mediaDevices;
  if (!devices || (devices as { getDisplayMedia?: unknown }).getDisplayMedia) return;
  let active: Promise<void> = Promise.resolve();
  let running = false;
  let stopCurrent: (() => void) | null = null;

  devices.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions): Promise<MediaStream> => {
    if (typeof VideoDecoder === 'undefined') throw new DOMException('This WebView cannot decode video (WebCodecs)', 'NotSupportedError');
    // One capture at a time: the system allows one projection, and the share dialog only ever holds one preview.
    // A new request replaces the one before it (a preview the dialog forgot to stop, a capture that never ended), so the
    // person is never stuck with "being captured already".
    if (running) {
      stopCurrent?.();
      await active;
      if (running) throw new DOMException('The screen is being captured already', 'InvalidStateError');
    }
    const video = constraints?.video;
    const wish = typeof video === 'object' ? video : {};
    const options: CaptureStart = {
      width: clampNumber(wish.width, 1280),
      height: clampNumber(wish.height, 720),
      fps: Math.max(5, Math.min(60, clampNumber(wish.frameRate, 30))),
      bitrate: 3_000_000,
      audio: !!constraints?.audio
    };
    running = true;
    const canvas = makeCanvas();
    const context = canvas.getContext('2d', { alpha: false });
    let decoder: VideoDecoder | null = null;
    let configured = false;
    let ended = false;
    let track: MediaStreamTrack | null = null;
    let spsKey = '';
    // Made before the system dialog, while the tap that started this still counts as a user gesture (AudioContext)
    const sound = options.audio ? pcmTrack().catch(() => null) : null;

    const finish = (fromNative: boolean) => {
      if (ended) return;
      ended = true;
      running = false;
      try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch { /* closed already */ }
      void sound?.then(p => p?.close());
      active = active.then(() => (fromNative ? Promise.resolve() : source.stop())).catch(() => {});
      if (fromNative && track) {
        track.stop();
        track.dispatchEvent(new Event('ended'));
      }
    };

    stopCurrent = () => finish(false);

    let started: { width: number; height: number; codec?: string; audio?: boolean };
    try {
      started = await source.start(options, {
        frame(f) {
          if (ended) return;
          // After a rotation the native side starts a new encoder: its keyframe has another SPS, so decode afresh
          const sps = f.key && !started?.codec ? h264Sps(f.data) : null;
          if (configured && sps && sps.key !== spsKey && decoder && decoder.state === 'configured') {
            spsKey = sps.key;
            decoder.configure({ codec: sps.codec, optimizeForLatency: true });
          }
          if (!configured) {
            if (!f.key) return;
            const codec = started?.codec ?? sps?.codec;
            if (!codec) return;
            spsKey = sps?.key ?? '';
            decoder = new VideoDecoder({
              output(frame) {
                if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                  canvas.width = frame.displayWidth;
                  canvas.height = frame.displayHeight;
                }
                context?.drawImage(frame, 0, 0);
                frame.close();
              },
              error() { finish(false); }
            });
            decoder.configure({ codec, optimizeForLatency: true });
            configured = true;
          }
          // A slow decoder would only add delay: skip ahead to the next keyframe instead
          if (!decoder || decoder.state !== 'configured') return;
          if (decoder.decodeQueueSize > 6 && !f.key) return;
          decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.ts, data: f.data }));
        },
        audio: pcm => { void sound?.then(p => p?.push(pcm)); },
        stopped: () => finish(true)
      });
    } catch (e) {
      running = false;
      void sound?.then(p => p?.close());
      throw e;
    }
    try {
      canvas.width = started.width;
      canvas.height = started.height;
      context?.fillRect(0, 0, canvas.width, canvas.height);

      const stream = canvas.captureStream(options.fps);
      track = stream.getVideoTracks()[0];
      // The sound is only offered when the native side could capture it (Android 10+, permission given)
      const pcm = started.audio ? await sound : null;
      if (pcm) stream.addTrack(pcm.track);
      else void sound?.then(p => p?.close());
      const nativeStop = track.stop.bind(track);
      track.stop = () => { nativeStop(); finish(false); };
      return stream;
    } catch (e) {
      // Whatever went wrong after the capture started must not leave it running
      finish(false);
      throw e;
    }
  };
}
