// gifenc ships no types; this is the part lib/gif-edit.ts uses
declare module 'gifenc' {
  export type Palette = number[][];
  export interface FrameOptions {
    palette?: Palette;
    delay?: number;       // milliseconds
    repeat?: number;      // -1 once, 0 forever
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
  }
  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: FrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(): Encoder;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: string }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: string): Uint8Array;
}
