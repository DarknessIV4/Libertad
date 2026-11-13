// Cropping, turning, darkening and blurring a picture on a canvas (used by ui/ImageEditor.svelte).
// Everything is drawn by the same function, small for the preview and large for the result, so what
// the person sees is what they get.

// The dark the card and the banner are filled with where the picture does not reach (a turned picture has corners)
export const FILL = '#1a1b1f';

// The width of a profile card in the app, which blur is measured against: a blur of 10 is 10 px on a
// card, whatever size the picture is made at
export const CARD_WIDTH = 320;

export interface Crop { x: number; y: number; w: number; h: number }
export interface EditParams {
  rotation: number;   // degrees, 0 to 360
  flipH?: boolean;    // mirrored left to right, as it looks after turning
  flipV?: boolean;    // mirrored top to bottom
  crop: Crop;         // 0 to 1, of the box around the turned picture
  darkness: number;   // 0 to 95 (percent)
  blur: number;       // 0 to 40 (px on a card)
}
export interface Drawable { source: CanvasImageSource; width: number; height: number }

export const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };

// The box around a picture of this size turned by this much
export function rotatedSize(w: number, h: number, degrees: number): { w: number; h: number } {
  const r = degrees * Math.PI / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  return { w: w * c + h * s, h: w * s + h * c };
}

// Whether these settings leave the picture exactly as it was
export function isUnchanged(p: EditParams): boolean {
  return p.rotation % 360 === 0 && !p.flipH && !p.flipV && p.darkness === 0 && p.blur === 0
    && p.crop.x < 0.002 && p.crop.y < 0.002 && p.crop.w > 0.996 && p.crop.h > 0.996;
}

// The cropped part of the turned picture at outW pixels wide (the height follows from the crop's shape)
export function renderCrop(src: Drawable, p: EditParams, outW: number, outH: number): HTMLCanvasElement {
  const box = rotatedSize(src.width, src.height, p.rotation);
  const cropW = p.crop.w * box.w;
  const k = outW / cropW;
  const blurPx = p.blur > 0 ? p.blur / CARD_WIDTH * outW : 0;
  // Extra room around the part that is kept, so the blur at its edges blends with the picture beside it
  const pad = Math.ceil(blurPx * 3);
  const canvas = document.createElement('canvas');
  canvas.width = outW + pad * 2;
  canvas.height = outH + pad * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = FILL;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  if (blurPx) ctx.filter = `blur(${blurPx}px)`;
  ctx.translate(pad, pad);
  ctx.scale(k, k);
  ctx.translate(-p.crop.x * box.w, -p.crop.y * box.h);
  ctx.translate(box.w / 2, box.h / 2);
  // The mirror comes after the turning, so it flips what is seen
  ctx.scale(p.flipH ? -1 : 1, p.flipV ? -1 : 1);
  ctx.rotate(p.rotation * Math.PI / 180);
  ctx.drawImage(src.source, -src.width / 2, -src.height / 2);
  let out = canvas;
  if (pad) {
    out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    out.getContext('2d')!.drawImage(canvas, pad, pad, outW, outH, 0, 0, outW, outH);
  }
  if (p.darkness > 0) {
    const c = out.getContext('2d')!;
    // Without a blur there was no padding, and this is still the canvas the picture was drawn on: undo its turning and scaling
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.filter = 'none';
    c.fillStyle = `rgb(0 0 0 / ${p.darkness / 100})`;
    c.fillRect(0, 0, outW, outH);
  }
  return out;
}

// The result at full quality: a JPEG no longer than maxSide on its long side
export async function renderFile(bmp: ImageBitmap, p: EditParams, maxSide: number): Promise<File | null> {
  const box = rotatedSize(bmp.width, bmp.height, p.rotation);
  const cw = p.crop.w * box.w, ch = p.crop.h * box.h;
  const k = Math.min(1, maxSide / Math.max(cw, ch));
  const outW = Math.max(1, Math.round(cw * k)), outH = Math.max(1, Math.round(ch * k));
  const canvas = renderCrop({ source: bmp, width: bmp.width, height: bmp.height }, p, outW, outH);
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.92));
  return blob ? new File([blob], 'picture.jpg', { type: 'image/jpeg' }) : null;
}
