import { putBlob, getBlob, deleteBlob } from './blobstore.ts';
import { load, save } from './storage.ts';

// Pictures, GIFs and videos used as the app's background, kept on this computer only (nothing is sent to
// anyone). 'whole' is one background spread over the left panel, the middle and the right panel, cut
// between them; the others are one panel on its own, which then covers the whole background there.
// A color is not kept here: it is a color of the custom color scheme (see custom-bg-actions.ts).
export const PANELS = ['left', 'middle', 'right'] as const;
export type Panel = typeof PANELS[number];
export type Slot = 'whole' | Panel;
export const SLOTS: Slot[] = ['whole', ...PANELS];
export type MediaKind = 'none' | 'image' | 'video';

const MAX_BYTES = 300 * 1024 * 1024;
const key = (slot: Slot) => `custom-bg-${slot}`;

interface Entry { kind: MediaKind; darkness: number; blur: number; url: string | null }
type Saved = Record<Slot, { kind: MediaKind; darkness: number; blur: number }>;

const clamp = (v: unknown, max: number) => Math.min(max, Math.max(0, Math.round(Number(v)) || 0));

class CustomBackground {
  slots = $state<Record<Slot, Entry>>(this.initial());
  readonly loaded: Promise<void>;

  constructor() {
    this.loaded = this.restore().catch(() => {});
  }

  private initial(): Record<Slot, Entry> {
    const empty = { kind: 'none', darkness: 0, blur: 0 } as const;
    const saved = load<Partial<Saved>>('mumh5.customBgs', {});
    const out = {} as Record<Slot, Entry>;
    for (const s of SLOTS) {
      const e = saved[s] ?? empty;
      out[s] = { kind: e.kind === 'image' || e.kind === 'video' ? e.kind : 'none', darkness: clamp(e.darkness, 95), blur: clamp(e.blur, 40), url: null };
    }
    return out;
  }

  private async restore(): Promise<void> {
    for (const s of SLOTS) {
      if (this.slots[s].kind === 'none') continue;
      const blob = await getBlob(key(s));
      if (blob && !this.slots[s].url) this.slots[s].url = URL.createObjectURL(blob);
      else if (!blob) this.slots[s].kind = 'none';
    }
  }

  private persist(): void {
    const out = {} as Saved;
    for (const s of SLOTS) out[s] = { kind: this.slots[s].kind, darkness: this.slots[s].darkness, blur: this.slots[s].blur };
    save('mumh5.customBgs', out);
  }

  has(slot: Slot): boolean { return this.slots[slot].kind !== 'none'; }
  get any(): boolean { return SLOTS.some(s => this.has(s)); }

  // What a panel shows from here: its own picture, else the whole background's, else nothing
  effective(panel: Panel): Slot | null {
    return this.has(panel) ? panel : this.has('whole') ? 'whole' : null;
  }

  // A picture, GIF or video from a file. Returns what went wrong, or ''.
  async setFile(slot: Slot, file: File): Promise<string> {
    const kind: MediaKind | null = file.type.startsWith('video/') ? 'video' : /^image\/(gif|png|jpeg|webp)$/.test(file.type) ? 'image' : null;
    if (!kind) return 'This file is not a picture, GIF or video that can be used.';
    if (file.size > MAX_BYTES) return 'This file is too large (the limit is 300 MB).';
    try { await putBlob(key(slot), file); } catch { return 'This computer could not keep the file.'; }
    const e = this.slots[slot];
    if (e.url) URL.revokeObjectURL(e.url);
    e.url = URL.createObjectURL(file);
    e.kind = kind;
    this.persist();
    return '';
  }

  async clear(slot: Slot): Promise<void> {
    const e = this.slots[slot];
    if (e.url) URL.revokeObjectURL(e.url);
    e.url = null;
    e.kind = 'none';
    await deleteBlob(key(slot)).catch(() => {});
    this.persist();
  }

  setDarkness(slot: Slot, v: number): void { this.slots[slot].darkness = clamp(v, 95); this.persist(); }
  setBlur(slot: Slot, v: number): void { this.slots[slot].blur = clamp(v, 40); this.persist(); }
}

export const customBg = new CustomBackground();
