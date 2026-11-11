// Cropping, turning, darkening and blurring a GIF without losing its movement: every frame is decoded,
// goes through the same drawing as a still picture (lib/image-edit.ts), and the frames are put
// back together as a new GIF. Used by ui/ImageEditor.svelte.
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { renderCrop, rotatedSize, type EditParams } from './image-edit.ts';

// Decoding a GIF frame by frame needs WebCodecs' ImageDecoder (Chromium, so the desktop app)
export const canEditGif = (): boolean => typeof ImageDecoder !== 'undefined';

// What a result may be like. Tried from the first attempt on, until one fits maxBytes (the last is kept
// even when it does not): `side` is the longest side in pixels, `frames` how many frames at most (a
// longer GIF is thinned out, its timing kept).
export interface GifOptions {
  attempts: { side: number; frames: number }[];
  maxBytes: number;
  // Frames are held in memory until the GIF is written; this keeps that to about this many bytes
  frameMemory?: number;
}

export const DEFAULT_GIF: GifOptions = {
  attempts: [640, 480, 360, 270].map(side => ({ side, frames: 150 })),
  maxBytes: 5 * 1024 * 1024
};

// A profile picture has to fit what the server takes (about 128 KB), so it is made smaller first, and only then shorter
export const avatarGif = (maxBytes: number): GifOptions => ({
  attempts: [{ side: 256, frames: 90 }, { side: 192, frames: 90 }, { side: 160, frames: 90 }, { side: 128, frames: 90 }, { side: 96, frames: 90 }, { side: 96, frames: 60 }, { side: 64, frames: 60 }, { side: 64, frames: 30 }],
  maxBytes
});

export interface RawFrame { data: Uint8ClampedArray; delay: number }

// How far (sum of the red, green and blue differences) a pixel may drift from what the GIF already shows
// there before it is written again. Small, so camera noise does not cost bytes.
const SAME_WITHIN = 20;

// The frames as a GIF that loops forever. One palette for all frames, so colors do not flicker and the
// file stays small. Each frame after the first only writes the pixels that changed (the rest is a see-through
// "same as before" color), which is what keeps a moving picture small. delay is in milliseconds (a browser
// plays under 20 ms as 100 ms, so not lower).
export function encodeGif(frames: RawFrame[], width: number, height: number): Uint8Array {
  if (!frames.length) throw new Error('No frames');
  // The palette comes from a handful of frames spread over the whole GIF
  const picks = Math.min(frames.length, 6);
  const parts: Uint8ClampedArray[] = [];
  for (let i = 0; i < picks; i++) parts.push(frames[Math.floor(i * frames.length / picks)].data);
  const sample = new Uint8ClampedArray(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { sample.set(p, at); at += p.length; }
  const palette = quantize(sample, 255);
  // The color after the last one is the see-through "same as before"
  const SAME = palette.length;
  const table = [...palette, [0, 0, 0]];
  const pr = Uint8Array.from(palette, c => c[0]), pg = Uint8Array.from(palette, c => c[1]), pb = Uint8Array.from(palette, c => c[2]);

  const gif = GIFEncoder();
  // What each pixel shows right now (a palette index)
  let shown: Uint8Array | null = null;
  frames.forEach((f, i) => {
    const idx = applyPalette(f.data, palette);
    let out = idx;
    if (shown) {
      out = new Uint8Array(idx.length);
      const d = f.data;
      for (let j = 0; j < idx.length; j++) {
        const s = shown[j];
        const diff = Math.abs(d[j * 4] - pr[s]) + Math.abs(d[j * 4 + 1] - pg[s]) + Math.abs(d[j * 4 + 2] - pb[s]);
        if (diff <= SAME_WITHIN) out[j] = SAME;
        else { out[j] = idx[j]; shown[j] = idx[j]; }
      }
    } else shown = Uint8Array.from(idx);
    gif.writeFrame(out, width, height, {
      ...(i === 0 && { palette: table }),
      delay: Math.max(20, Math.round(f.delay)),
      repeat: 0,
      // Later frames lay over the ones before them (disposal 1: leave in place)
      ...(i > 0 && { transparent: true, transparentIndex: SAME }),
      dispose: 1
    });
  });
  gif.finish();
  return gif.bytes();
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve));

// The GIF cropped, turned, darkened and blurred, still moving. Null: this browser cannot take a GIF apart,
// or the file is not one it can read.
export async function renderGif(file: File, p: EditParams, onProgress?: (done: number) => void, opts: GifOptions = DEFAULT_GIF): Promise<File | null> {
  if (!canEditGif()) return null;
  let decoder: ImageDecoder | null = null;
  try {
    decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount < 1) return null;
    const count = track.frameCount;

    let best: Uint8Array | null = null;
    let outW = 0, outH = 0;
    for (const { side, frames: maxFrames } of opts.attempts) {
      // The size of the result: the cropped part of the turned picture, no longer than `side`
      const first = await decoder.decode({ frameIndex: 0 });
      const w = first.image.displayWidth, h = first.image.displayHeight;
      first.image.close();
      const box = rotatedSize(w, h, p.rotation);
      const cw = p.crop.w * box.w, ch = p.crop.h * box.h;
      const k = Math.min(1, side / Math.max(cw, ch));
      outW = Math.max(1, Math.round(cw * k));
      outH = Math.max(1, Math.round(ch * k));

      const cap = Math.max(8, Math.min(maxFrames, Math.floor((opts.frameMemory ?? 48_000_000) / (outW * outH * 4))));
      const step = Math.max(1, Math.ceil(count / cap));
      const frames: RawFrame[] = [];
      for (let i = 0; i < count; i += step) {
        const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
        const canvas = renderCrop({ source: image, width: image.displayWidth, height: image.displayHeight }, p, outW, outH);
        // A frame lasts until the next one; thinned-out GIFs keep their speed
        const ms = (image.duration || 100_000) / 1000 * step;
        image.close();
        frames.push({ data: canvas.getContext('2d')!.getImageData(0, 0, outW, outH).data, delay: ms });
        onProgress?.(Math.min(1, (i + step) / count));
        if (frames.length % 4 === 0) await tick();
      }
      best = encodeGif(frames, outW, outH);
      if (best.length <= opts.maxBytes) break;
    }
    if (!best) return null;
    return new File([best as BlobPart], 'picture.gif', { type: 'image/gif' });
  } catch {
    return null;
  } finally {
    decoder?.close();
  }
}
