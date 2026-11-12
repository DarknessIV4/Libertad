// The picture on the tile of someone who is hosting. While you share your screen or host a watch
// together session, a small frame of it goes to the people in your channel, and their tile for you
// shows that instead of your avatar. The frame is taken when you start, again whenever someone
// enters the channel (so they have one right away), and every 5 minutes after that. A YouTube watch
// together shows the video's preview picture (the one link previews show), and a new one when the
// video changes. A torrent watch together has none.
import { untrack } from 'svelte';
import { THUMB_DATA_ID, MAX_THUMB_BYTES, encodeThumb, ThumbAssembler } from '../core/thumb-signal.ts';
import { sessions, type Session } from './session.svelte.ts';
import { share } from './share.svelte.ts';
import { watchTogether } from './watch-together.svelte.ts';
import { desktop } from './native.ts';

const REFRESH_MS = 5 * 60 * 1000;
// Someone arriving gets the frame a moment later (their client is still settling), and several
// arrivals together share one
const ARRIVAL_DELAY_MS = 1500;
// Frames from one sender faster than this are ignored
const MIN_GAP_MS = 1500;
const WIDTH = 320;

type Source = { source: CanvasImageSource; width: number; height: number; close?: () => void };

class Thumbs {
  private assembler = new ThumbAssembler();
  private lastFrom = new Map<number, number>();
  private timer: number | null = null;
  private arrival: number | null = null;
  private hostingOn: Session | null = null;
  private started = false;
  private lastVideo: string | null = null;

  // Starts watching whether this person is hosting (once, from the first session that gets going)
  entered(_s: Session): void {
    if (this.started) return;
    this.started = true;
    $effect.root(() => {
      $effect(() => {
        const s = sessions.active;
        const hosting = !!s && (
          (share.host === s && !!share.stream && share.kind === 'screen') ||
          (watchTogether.isHost && (watchTogether.isWatching || watchTogether.hasActiveParty) && watchTogether.mode !== 3));
        untrack(() => { if (hosting) this.begin(s); else this.end(); });
      });
      // A YouTube session that moves on to another video gets that video's picture
      $effect(() => {
        const id = watchTogether.mode === 1 ? watchTogether.currentVideo?.id : null;
        untrack(() => {
          if (!id || !this.hostingOn || id === this.lastVideo) return;
          this.lastVideo = id;
          const s = this.hostingOn;
          window.setTimeout(() => { if (this.hostingOn === s) void this.send(s); }, 300);
        });
      });
    });
  }

  closed(s: Session): void {
    if (this.hostingOn === s) this.end();
  }

  // Someone else's frame arrived
  receive(s: Session, sender: number, dataId: string, data: Uint8Array): void {
    if (dataId !== THUMB_DATA_ID || sender === s.self?.session) return;
    const bytes = this.assembler.push(sender, data);
    if (!bytes) return;
    const now = Date.now();
    if (now - (this.lastFrom.get(sender) ?? 0) < MIN_GAP_MS) return;
    this.lastFrom.set(sender, now);
    s.setFrame(sender, bytes);
  }

  // Someone came into our channel: while hosting they get a fresh frame (and so does everyone else)
  userMoved(s: Session, user: { session: number; channelId: number }): void {
    if (this.hostingOn !== s || user.session === s.self?.session || user.channelId !== s.self?.channelId) return;
    if (this.arrival !== null) return;
    this.arrival = window.setTimeout(() => { this.arrival = null; if (this.hostingOn === s) void this.send(s); }, ARRIVAL_DELAY_MS);
  }

  private begin(s: Session): void {
    if (this.hostingOn === s) return;
    this.end();
    this.hostingOn = s;
    // The first frame once the picture is there; when it is not yet (a YouTube video still loading), a few more tries
    const first = (n: number) => window.setTimeout(async () => {
      if (this.hostingOn !== s) return;
      if (!await this.send(s) && n < 6) first(n + 1);
    }, n === 0 ? 1200 : 2000);
    first(0);
    this.timer = window.setInterval(() => { if (this.hostingOn === s) void this.send(s); }, REFRESH_MS);
  }

  private end(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    if (this.arrival !== null) { clearTimeout(this.arrival); this.arrival = null; }
    const s = this.hostingOn;
    this.hostingOn = null;
    // Our own tile goes back to the avatar
    if (s?.self) s.dropFrame(s.self.session);
  }

  // Take a frame and send it to everybody in the channel
  // false when there was no picture to take yet
  private async send(s: Session): Promise<boolean> {
    const bytes = await this.capture();
    if (!bytes) return false;
    if (this.hostingOn !== s) return true;
    const self = s.self;
    const client = s.client;
    if (!self || !client) return true;
    s.setFrame(self.session, bytes);
    const to = s.usersIn(self.channelId).map(u => u.session).filter(x => x !== self.session);
    if (!to.length) return true;
    try {
      for (const chunk of encodeThumb(bytes)) client.sendPluginData(to, THUMB_DATA_ID, chunk);
    } catch { /* too large: nothing sent */ }
    return true;
  }

  // ─── Taking the frame ───────────────────────────────────────────────────────

  private async capture(): Promise<Uint8Array | null> {
    let src: Source | null = null;
    try {
      src = await this.source();
      return src ? await this.encode(src) : null;
    } catch {
      return null;
    } finally {
      src?.close?.();
    }
  }

  private async source(): Promise<Source | null> {
    // A screen share: a frame of the stream we send
    if (share.stream && share.kind === 'screen') {
      const track = share.stream.getVideoTracks()[0];
      if (track) {
        const IC = (globalThis as any).ImageCapture;
        if (IC) {
          try {
            const bmp: ImageBitmap = await new IC(track).grabFrame();
            return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
          } catch { /* the other way below */ }
        }
        const v = document.createElement('video');
        v.muted = true;
        v.srcObject = new MediaStream([track]);
        try {
          await v.play();
          await new Promise(r => setTimeout(r, 150));
          if (v.videoWidth) return { source: v, width: v.videoWidth, height: v.videoHeight, close: () => { v.pause(); v.srcObject = null; } };
        } catch { /* nothing */ }
        v.srcObject = null;
      }
    }
    // Watch together, a file played from here
    if (watchTogether.mode === 2) {
      const v = watchTogether.hostVideo;
      if (v && v.videoWidth > 0) return { source: v, width: v.videoWidth, height: v.videoHeight };
      return null;
    }
    // Watch together, YouTube: the video's own preview picture (not a frame of the player), so
    // everyone sees the same clean cover. The host loads it; the others get it from the host.
    if (watchTogether.mode === 1) {
      const id = watchTogether.currentVideo?.id ?? watchTogether.party?.meta.videoId;
      if (!id) return null;
      let url: string | null = null;
      if (typeof desktop?.youtubeThumbnail === 'function') url = await desktop.youtubeThumbnail(id);
      else {
        // Web build: only works where YouTube's picture server allows it
        const blob = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`).then(r => r.ok ? r.blob() : null).catch(() => null);
        if (blob) url = URL.createObjectURL(blob);
      }
      if (!url) return null;
      const img = new Image();
      img.src = url;
      try { await img.decode(); } finally { if (url.startsWith('blob:')) URL.revokeObjectURL(url); }
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    }
    return null;
  }

  // A JPEG small enough for the chunks
  private async encode(src: Source): Promise<Uint8Array | null> {
    if (!src.width || !src.height) return null;
    let width = WIDTH;
    for (let round = 0; round < 4; round++) {
      const height = Math.max(1, Math.round(width * src.height / src.width));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      if (!g) return null;
      g.drawImage(src.source, 0, 0, width, height);
      for (const quality of [0.6, 0.45, 0.3]) {
        const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', quality));
        if (blob && blob.size <= MAX_THUMB_BYTES) return new Uint8Array(await blob.arrayBuffer());
      }
      width = Math.round(width * 0.75);
    }
    return null;
  }
}

export const thumbs = new Thumbs();
