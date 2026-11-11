import type { BannerView } from '../core/banner.ts';
import { load, save } from './storage.ts';

// Who has their background paused, kept on this computer only (never sent to anyone else).
// A paused GIF stands on its first frame; one that is not paused plays in full.
const keyOf = (u: { hash: string; name: string }) => u.hash || `name:${u.name}`;

class BackgroundPause {
  private saved = load<{ all: boolean; users: Record<string, boolean> }>('mumh5.bgPause', { all: false, users: {} });
  all = $state(!!this.saved.all);
  users = $state<Record<string, boolean>>({ ...(this.saved.users ?? {}) });

  paused(u: { hash: string; name: string } | null | undefined): boolean {
    return this.all || (!!u && !!this.users[keyOf(u)]);
  }

  // Stop one person's background (or bring it back)
  setUser(u: { hash: string; name: string }, on: boolean): void {
    if (on) this.users[keyOf(u)] = true;
    else delete this.users[keyOf(u)];
    this.persist();
  }

  // Stop every background (or bring them all back, including ones stopped one by one)
  setAll(on: boolean): void {
    this.all = on;
    if (!on) this.users = {};
    this.persist();
  }

  private persist(): void {
    save('mumh5.bgPause', { all: this.all, users: $state.snapshot(this.users) });
  }
}

export const bgPause = new BackgroundPause();

// Tiles show a GIF as its first frame only: the picture to draw for a background that must not move
class Stills {
  private frames = $state<Record<string, string>>({});
  private started = new Set<string>();

  // The picture for a view: the source itself, or for a GIF its first frame (null until it is ready)
  of(view: BannerView | null): string | null {
    if (!view || view.kind !== 'image') return null;
    if (view.mime !== 'image/gif') return view.src;
    const hit = this.frames[view.src];
    if (hit) return hit;
    void this.load(view.src);
    return null;
  }

  // Black or empty bars baked into a picture or GIF (a widescreen clip in a taller frame) are cut off, so
  // what is left fills the tile. An inset() for object-view-box, or null when there are no bars.
  private crops = $state<Record<string, string | null>>({});
  private scanning = new Set<string>();

  crop(view: BannerView | null): string | null {
    if (!view || view.kind !== 'image') return null;
    if (view.src in this.crops) return this.crops[view.src];
    void this.scan(view.src);
    return null;
  }

  private async scan(src: string): Promise<void> {
    if (this.scanning.has(src)) return;
    this.scanning.add(src);
    let result: string | null = null;
    try {
      const img = new Image();
      img.src = src;
      await img.decode();
      const w = Math.min(160, img.naturalWidth), h = Math.max(1, Math.round(img.naturalHeight * w / img.naturalWidth));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (g) {
        g.drawImage(img, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h).data;
        // A pixel is bar when it is nearly black or see-through
        const bar = (x: number, y: number) => { const i = (y * w + x) * 4; return d[i + 3] < 20 || (d[i] + d[i + 1] + d[i + 2]) / 3 < 22; };
        const rowBar = (y: number) => { let n = 0; for (let x = 0; x < w; x++) if (!bar(x, y)) n++; return n <= w * 0.01; };
        const colBar = (x: number) => { let n = 0; for (let y = 0; y < h; y++) if (!bar(x, y)) n++; return n <= h * 0.01; };
        let t = 0, b = 0, l = 0, r = 0;
        while (t < h && rowBar(t)) t++;
        if (t < h) {
          while (b < h - t && rowBar(h - 1 - b)) b++;
          while (l < w && colBar(l)) l++;
          while (r < w - l && colBar(w - 1 - r)) r++;
          // Only real bars (over 3%), and never so much that little picture is left
          const vb = (t + b) / h, hb = (l + r) / w;
          const ok = vb < 0.7 && hb < 0.7 && (vb >= 0.03 || hb >= 0.03);
          if (ok) result = `inset(${(t / h * 100).toFixed(2)}% ${(r / w * 100).toFixed(2)}% ${(b / h * 100).toFixed(2)}% ${(l / w * 100).toFixed(2)}%)`;
        }
      }
    } catch { /* leave the picture as it is */ }
    this.crops[src] = result;
  }

  private async load(src: string): Promise<void> {
    if (this.started.has(src)) return;
    this.started.add(src);
    try {
      const img = new Image();
      img.src = src;
      await img.decode();
      const width = Math.min(640, img.naturalWidth), height = Math.max(1, Math.round(img.naturalHeight * width / img.naturalWidth));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      if (!g) return;
      g.drawImage(img, 0, 0, width, height);
      this.frames[src] = canvas.toDataURL('image/png');
    } catch {
      this.started.delete(src);
    }
  }
}

export const stills = new Stills();
