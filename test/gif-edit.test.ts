import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import type { RawFrame } from '../src/lib/gif-edit.ts';

// gifenc's ESM build is picked by the app's bundler; node would take its CommonJS one and lose the named
// exports. So the module is bundled the way the app does it, and loaded from that.
const built = buildSync({ entryPoints: ['src/lib/gif-edit.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
const { encodeGif } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')) as typeof import('../src/lib/gif-edit.ts');

// A w x h frame of one color
const solid = (w: number, h: number, r: number, g: number, b: number, delay: number): RawFrame => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, 255], i * 4);
  return { data, delay };
};

test('frames come out as an animated GIF that loops', () => {
  const bytes = encodeGif([solid(16, 8, 255, 0, 0, 100), solid(16, 8, 0, 255, 0, 100), solid(16, 8, 0, 0, 255, 250)], 16, 8);
  assert.equal(String.fromCharCode(...bytes.slice(0, 6)), 'GIF89a');
  assert.equal(bytes[6] | (bytes[7] << 8), 16);
  assert.equal(bytes[8] | (bytes[9] << 8), 8);
  // One graphic control extension (0x21 0xF9) per frame
  let frames = 0;
  for (let i = 0; i < bytes.length - 1; i++) if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) frames++;
  assert.equal(frames, 3);
  // The NETSCAPE extension makes it loop
  assert.ok(Buffer.from(bytes).includes('NETSCAPE2.0'));
});

test('a frame never lasts under 20 ms', () => {
  const bytes = encodeGif([solid(4, 4, 9, 9, 9, 1), solid(4, 4, 200, 9, 9, 1)], 4, 4);
  const buf = Buffer.from(bytes);
  const at = buf.indexOf(Buffer.from([0x21, 0xf9, 0x04]));
  // GCE: 21 F9 04 <flags> <delay lo> <delay hi> ... (hundredths of a second)
  assert.equal(buf.readUInt16LE(at + 4), 2);
});

test('a frame only writes what changed from the one before', () => {
  const w = 64, h = 64;
  const frame = (x: number): RawFrame => {
    const f = solid(w, h, 20, 60, 140, 50);
    for (let y = 20; y < 30; y++) for (let i = x; i < x + 10; i++) f.data.set([240, 30, 30, 255], (y * w + i) * 4);
    return f;
  };
  const moving = encodeGif(Array.from({ length: 30 }, (_, i) => frame(i * 2)), w, h);
  const still = encodeGif([frame(0)], w, h);
  // Thirty frames of a small moving block cost far less than thirty whole pictures
  assert.ok(moving.length < still.length * 30 / 3, `${moving.length} vs ${still.length} x 30`);
});
