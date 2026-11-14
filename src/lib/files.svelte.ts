// Files between Libertad clients (see core/file-transfer.ts): what this computer keeps,
// downloads in progress, and the pieces it sends to others. A download asks the sender and
// everyone else on the server who has the file, and splits the pieces between them. The pieces
// go straight from computer to computer over WebRTC; only requests and connection setup use
// Mumble. Where no direct connection can be made, the Mumble server carries the pieces as chat
// messages, limited by the server to about one a second. The file's hash comes with the
// announcement, so what arrives is checked either way.
import {
  FILE, FILE_DATA_ID, MAX_FILE, MAX_PIECES, FileAssembler, Sender, pumpRouted, RateLimiter, uploadRate, encodeFileSignal, parseBody, okId, validMeta,
  pieceBytes, pieceCount, pieceSize, pieceForm, pieceMessage, parsePiece, encode15, decode15,
  toRanges, fromRanges, split, sha256, rootHash, type FileMeta, type FileType
} from '../core/file-transfer.ts';
import { newId } from '../core/text-signal.ts';
import { FileP2P } from '../core/file-p2p.ts';
import { rtcConfig } from './ice.ts';
import type { Session } from './session.svelte.ts';
import { getBlob, putBlob, getData, putData, deleteBlob } from './blobstore.ts';
import { desktop, type FileBegin } from './native.ts';
import { formatBytes } from './html.ts';
import { setRateLimits } from '../core/client.ts';
import { store } from './settings.svelte.ts';
import { sounds } from './audio/sounds.svelte.ts';

export interface Transfer {
  state: 'idle' | 'finding' | 'loading' | 'ready' | 'failed';
  got: number;     // bytes so far
  rate: number;    // bytes per second, recently
  sources: number; // people sending it to us
  disk?: boolean;
  saved?: string;  // where a large file went: a path on the desktop, a file name in the browser
  error: string;
  url: string;     // once ready
  sending: number; // people we are sending it to
}

const BLANK: Transfer = { state: 'idle', got: 0, rate: 0, sources: 0, error: '', url: '', sending: 0 };

// What this computer keeps of files it sent and received; the oldest go first
const KEEP_BYTES = 100 * 1024 ** 3;
const INDEX = 'files:index';
const MAX_SOURCES = 12;

// Files this big are not held as Blobs: they are written as they arrive straight into the file the
// person picked, so nothing is kept twice. The desktop app does that through its main process, a
// browser with the file picker through that. To test with a small file:
// localStorage.setItem('libertad.diskMin', '1000000') and restart.
function diskMin(): number {
  try { return Number(localStorage.getItem('libertad.diskMin')) || 256 * 1024 ** 2; } catch { return 256 * 1024 ** 2; }
}

// Where a large download goes as it arrives
interface Sink {
  write(offset: number, bytes: Uint8Array): Promise<unknown>;
  // Puts the finished file in place; returns where it is
  finish(): Promise<string>;
  // Drops what was written; safe to call more than once
  abort(): Promise<unknown>;
}

type Picker = (o: { suggestedName: string }) => Promise<FileSystemFileHandle>;
const picker = (): Picker | null => {
  const f = (globalThis as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  return typeof f === 'function' ? f.bind(globalThis) : null;
};
const useDisk = (meta: FileMeta): boolean => (!!desktop || !!picker()) && meta.s >= diskMin();
const fileName = (n: string) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'file';

const diskInit = (meta: FileMeta, sink: Sink | null) => {
  const n = sink ? pieceCount(meta) : 0;
  return { disk: !!sink, sink, have: new Uint8Array(n), flat: new Uint8Array(n * 32), tail: Promise.resolve() as Promise<unknown>, wfail: false };
};
const hasPiece = (d: Download, k: number): boolean => (d.disk ? d.have[k] === 1 : !!d.parts[k]);
// An older version also cached large files in the app's folder
type KeptDisk = Kept & { disk?: boolean };

// Opt-in faster sending for servers where you raised messagelimit / messageburst.
setRateLimits(500, 200);
// How long answers to "who has it" may take
const FIND_MS = 3000;
// A source that sent nothing for this long is asked again, twice, then the download stops
const STALL_MS = 45000;
// Murmur allows 15 plugin messages at once and 4 a second; text channels use some of that
const BURST = 4;
const PER_SECOND = 1.5;

interface Kept extends FileMeta { at: number }

interface Source { pieces: Set<number>; retries: number }

interface Download {
  s: Session;
  meta: FileMeta;
  count: number;
  parts: (Blob | undefined)[];
  digests: Promise<Uint8Array>[];
  disk: boolean;
  sink: Sink | null;
  have: Uint8Array;
  flat: Uint8Array;
  tail: Promise<unknown>;
  wfail: boolean;
  got: number;
  bytes: number;
  sources: Map<number, Source>;
  findUntil: number;
  lastAt: number;
  stalls: number;
  timer: ReturnType<typeof setInterval>;
  rebalance: ReturnType<typeof setTimeout> | undefined;
  rateFrom: { at: number; bytes: number };
}

// The upload speed limit from the settings, shared by everything this computer sends
const limiter = new RateLimiter(() => uploadRate(Number(store.settings.uploadLimit) || 0));
// How long a request waits for the direct connection before the server carries the pieces
const DIRECT_MS = 6000;

// STUN and relay servers for direct connections: the ones in Settings, like everything else that connects directly
const p2pConfig = rtcConfig;

interface Runtime {
  assembler: FileAssembler;
  sender: Sender;
  p2p: FileP2P;
  // Newest request per person and file, so a late answer to an old one does not replace it
  wantSeq: Map<string, number>;
  pumping: boolean;
  queue: { to: number[]; packet: Uint8Array; boot: boolean; only: boolean }[];
  level: number;
  levelAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

// Only types the app can show are kept as such; anything else (HTML, SVG) stays inert data
// even if someone opens it, because object URLs carry the app's own origin
export function safeType(type: string): string {
  return /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+)$/.test(type) ? type : 'application/octet-stream';
}

export function fileKind(meta: FileMeta): 'image' | 'video' | 'audio' | null {
  const t = safeType(meta.m);
  return t.startsWith('image/') ? 'image' : t.startsWith('video/') ? 'video' : t.startsWith('audio/') ? 'audio' : null;
}

class Files {
  transfers = $state<Record<string, Transfer>>({});
  // Bytes kept on this computer, once looked at
  usage = $state<number | null>(null);

  private runtimes = new WeakMap<Session, Runtime>();
  private downloads = new Map<string, Download>();
  // Files at hand this run: sent from here, received, or read back from storage
  private local = new Map<string, { meta: FileMeta; blob: Blob }>();
  private index: Kept[] | null = null;
  private checked = new Set<string>();
  // Files whose Save dialog is open
  private choosing = new Set<string>();

  // Plugin data needs a 1.4 server; older ones would not pass the requests on
  supported(s: Session): boolean {
    return !!s.client && s.client.serverVersionNum >= 0x010400;
  }

  private set(id: string, patch: Partial<Transfer>): void {
    this.transfers[id] = { ...(this.transfers[id] ?? BLANK), ...patch };
  }

  // Files that travel only over direct connections between clients (profile pictures, banners, cards): never
  // sent through the server, and not asked about there
  p2pOnly = new Set<string>();

  // The direct channel to this person: made when missing, and used for their profile
  profileLink(s: Session, peer: number): void {
    void this.runtime(s).p2p.connect(peer, 'bprofile');
  }
  sendProfile(s: Session, peer: number, text: string): void {
    this.runtime(s).p2p.sendProfile(peer, text);
  }
  openPeers(s: Session): number[] {
    return this.runtime(s).p2p.openPeers();
  }

  // ─── Kept files ─────────────────────────────────────────────────────────────

  private async loadIndex(): Promise<Kept[]> {
    if (this.index) return this.index;
    let list: Kept[] = [];
    try {
      const v = await getData<Kept[]>(INDEX);
      if (Array.isArray(v)) list = v.filter(k => validMeta(k) && typeof k.at === 'number');
    } catch { /* storage unavailable */ }
    // Another call may have finished first
    this.index ??= list;
    this.usage = this.index.reduce((n, k) => n + k.s, 0);
    return this.index;
  }

  private async keep(meta: FileMeta, blob: Blob): Promise<void> {
    try {
      const index = await this.loadIndex();
      await putBlob('file:' + meta.i, blob);
      const list = [...index.filter(k => k.i !== meta.i), { ...meta, at: Date.now() }];
      let total = list.reduce((n, k) => n + k.s, 0);
      // Files used this run stay; the rest goes oldest first
      for (const k of [...list]) {
        if (total <= KEEP_BYTES) break;
        if (this.local.has(k.i)) continue;
        if ((k as KeptDisk).disk) await desktop?.files.remove(k.i).catch(() => {});
        else await deleteBlob('file:' + k.i).catch(() => {});
        list.splice(list.indexOf(k), 1);
        total -= k.s;
      }
      this.index = list;
      this.usage = total;
      await putData(INDEX, list);
    } catch { /* storage unavailable: the file is still here until the app closes */ }
  }

  private async find(id: string): Promise<{ meta: FileMeta; blob: Blob } | null> {
    const at = this.local.get(id);
    if (at) return at;
    const kept = (await this.loadIndex()).find(k => k.i === id);
    if (!kept) return null;
    try {
      const blob = await getBlob('file:' + id);
      if (!blob) return null;
      const { at: _, ...meta } = kept;
      const found = { meta, blob };
      this.local.set(id, found);
      return found;
    } catch {
      return null;
    }
  }

  // The bytes of a file this computer has (sent or received), or null
  async blobOf(id: string): Promise<Blob | null> {
    return (await this.find(id))?.blob ?? null;
  }

  private ready(meta: FileMeta, blob: Blob): void {
    this.local.set(meta.i, { meta, blob });
    const url = this.transfers[meta.i]?.url || URL.createObjectURL(new Blob([blob], { type: safeType(meta.m) }));
    this.set(meta.i, { state: 'ready', got: meta.s, url, error: '', rate: 0, sources: 0 });
  }

  // Shows a file as ready when this computer has it
  async check(meta: FileMeta): Promise<void> {
    if (this.checked.has(meta.i)) return;
    this.checked.add(meta.i);
    const kept = (await this.loadIndex()).find(k => k.i === meta.i) as KeptDisk | undefined;
    if (desktop && (useDisk(meta) || kept?.disk) && !this.downloads.has(meta.i)) {
      const at = await desktop.files.where(meta.i, meta.h).catch(() => null);
      if (!this.downloads.has(meta.i)) {
        if (at?.kind === 'saved') return this.readyDisk(meta, at.path);
        if (at?.kind === 'cache' && kept?.disk && kept.h === meta.h) return this.readyDisk(meta);
      }
    }
    const found = await this.find(meta.i);
    if (found && found.meta.h === meta.h && !this.downloads.has(meta.i)) this.ready(found.meta, found.blob);
  }

  async measure(): Promise<void> {
    await this.loadIndex();
  }

  async clear(): Promise<void> {
    const index = await this.loadIndex();
    for (const k of index) {
      if ((k as KeptDisk).disk) await desktop?.files.remove(k.i).catch(() => {});
      else await deleteBlob('file:' + k.i).catch(() => {});
    }
    this.index = [];
    this.usage = 0;
    await putData(INDEX, []).catch(() => {});
    // What is on screen stays usable until the app closes
  }

  // ─── Sending a file ─────────────────────────────────────────────────────────

  // Hashes the file and keeps it at hand for whoever asks. Returns the announcement details
  // or why it cannot be sent.
  // stable: the id comes from the content, so sharing the same file again (a banner, on every
  // connect) gives the same id and people who have it already do not fetch it again
  async share(s: Session, file: File, progress: (fraction: number) => void, stable = false): Promise<FileMeta | string> {
    const client = s.client;
    if (!client) return 'Not connected.';
    if (!this.supported(s)) return `${file.name}: sending files needs a server running Mumble 1.4 or newer`;
    if (!file.size) return `${file.name}: the file is empty`;
    if (file.size > MAX_FILE) return `${file.name}: too large (at most 100 GB)`;
    const c = pieceBytes(client.config);
    if (c < 1500) return `${file.name}: this server's message limit is too small for files`;
    const count = pieceCount({ s: file.size, c });
    if (count > MAX_PIECES) return `${file.name}: too large for this server's message limits`;
    const digests: Uint8Array[] = [];
    try {
      for (let k = 0; k < count; k++) {
        digests.push(await sha256(new Uint8Array(await file.slice(k * c, (k + 1) * c).arrayBuffer())));
        if (k % 16 === 0) progress(k / count);
      }
    } catch {
      return `${file.name}: could not be read`;
    }
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.type) && file.type.length <= 100 ? file.type : '';
    const h = await rootHash(digests);
    const meta = validMeta({ i: stable ? 'b' + h.slice(0, 24) : newId(), n: file.name.slice(0, 255) || 'file', s: file.size, m: type, c, h });
    if (!meta) return `${file.name}: cannot be sent`;
    this.checked.add(meta.i);
    if (stable) this.p2pOnly.add(meta.i);
    this.ready(meta, file);
    // A copy of a big file would take the same space again; it is sent from the original while this run lasts
    if (meta.s < diskMin()) this.keep(meta, file);
    return meta;
  }

  // ─── Downloading ────────────────────────────────────────────────────────────

  // A file was announced live: fetch it right away when it is small enough
  offered(s: Session, meta: FileMeta, author: number | null): void {
    const limit = store.settings.autoDownload * 1024 * 1024;
    this.check(meta).then(() => {
      const t = this.transfers[meta.i];
      // Large files ask where to save, which needs a click
      if (limit && meta.s <= limit && !useDisk(meta) && (!t || t.state === 'idle')) this.download(s, meta, author);
    });
  }

  // ask: always let the person pick where it goes (when this device can), whatever the size
  download(s: Session, meta: FileMeta, author: number | null, ask = false): void {
    const client = s.client;
    const t = this.transfers[meta.i];
    if (this.downloads.has(meta.i) || this.choosing.has(meta.i) || t?.state === 'ready') return;
    if (!client || !this.supported(s)) {
      this.set(meta.i, { state: 'failed', error: 'Downloading needs a server running Mumble 1.4 or newer' });
      return;
    }
    if (!(ask ? !!desktop || !!picker() : useDisk(meta))) return this.start(s, meta, author, null);
    // Where to save comes first, from this very click; nothing is fetched if it is refused
    this.choosing.add(meta.i);
    this.openSink(meta).then(opened => {
      if (!opened) return;
      if ('error' in opened) return this.set(meta.i, { state: 'failed', error: opened.error });
      this.start(s, meta, author, opened.sink);
    }).catch(() => {
      this.set(meta.i, { state: 'failed', error: 'Could not create the file there' });
    }).finally(() => this.choosing.delete(meta.i));
  }

  // The file to write into, or null when the person closed the dialog
  private async openSink(meta: FileMeta): Promise<{ sink: Sink } | { error: string } | null> {
    const id = meta.i;
    if (desktop) {
      const r: FileBegin = await desktop.files.begin(id, fileName(meta.n), meta.s, meta.h).catch(() => ({ ok: false, reason: 'error' }) as FileBegin);
      if (r.ok) {
        return { sink: { write: (o, b) => desktop!.files.write(id, o, b), finish: () => desktop!.files.finish(id), abort: () => desktop!.files.remove(id) } };
      }
      if (r.reason === 'canceled') return null;
      const room = r.free != null ? ` (${formatBytes(r.free)} free, ${formatBytes(meta.s)} needed)` : '';
      return { error: r.reason === 'space' ? `Not enough free space there${room}` : r.reason === 'toolarge' ? 'That drive cannot hold a file this large' : 'Could not create the file there' };
    }
    // The browser: must be called from the click itself, before anything is awaited
    let handle: FileSystemFileHandle;
    try {
      handle = await picker()!({ suggestedName: fileName(meta.n) });
    } catch (e) {
      return (e as { name?: string } | null)?.name === 'AbortError' ? null : { error: 'Could not create the file there' };
    }
    let w: FileSystemWritableFileStream;
    try {
      w = await handle.createWritable();
    } catch {
      return { error: 'Could not write to that file' };
    }
    return {
      sink: {
        write: (o, b) => w.write({ type: 'write', position: o, data: b as Uint8Array<ArrayBuffer> }),
        finish: async () => { await w.close(); return handle.name; },
        abort: () => w.abort().catch(() => {})
      }
    };
  }

  private start(s: Session, meta: FileMeta, author: number | null, sink: Sink | null): void {
    const client = s.client;
    // The connection may have gone while the dialog was open
    if (!client) {
      void sink?.abort().catch(() => {});
      this.set(meta.i, { state: 'failed', error: 'Disconnected' });
      return;
    }
    const now = Date.now();
    const d: Download = {
      s, meta, count: pieceCount(meta), parts: [], digests: [], ...diskInit(meta, sink), got: 0, bytes: 0, sources: new Map(),
      findUntil: now + FIND_MS, lastAt: now, stalls: 0, timer: setInterval(() => this.watch(d), 2000),
      rebalance: undefined, rateFrom: { at: now, bytes: 0 }
    };
    this.downloads.set(meta.i, d);
    this.set(meta.i, { state: 'finding', got: 0, rate: 0, sources: 0, error: '', saved: undefined });
    if (author != null && author !== client.session && client.users.has(author)) {
      d.sources.set(author, { pieces: new Set(), retries: 0 });
      this.runtime(s).p2p.connect(author, meta.i);
      this.assign(d);
    }
    if (this.p2pOnly.has(meta.i)) return;
    const others = [...client.users.keys()].filter(id => id !== client.session && id !== author);
    this.signal(s, others, FILE.who, { i: meta.i });
  }

  cancel(id: string): void {
    const d = this.downloads.get(id);
    if (!d) return;
    this.stop(d);
    this.discard(d);
    this.set(id, { state: 'idle', got: 0, rate: 0, sources: 0 });
  }

  private stop(d: Download): void {
    clearInterval(d.timer);
    clearTimeout(d.rebalance);
    if (this.downloads.get(d.meta.i) === d) this.downloads.delete(d.meta.i);
    const busy = [...d.sources].filter(([, src]) => src.pieces.size).map(([id]) => id);
    if (d.s.client) this.signal(d.s, busy, FILE.want, { i: d.meta.i, r: [] });
  }

  // What a download that did not finish wrote is deleted now, not at the next start
  private discard(d: Download): void {
    if (!d.sink) return;
    const sink = d.sink;
    // Writes still on their way are no longer an error to report
    d.wfail = true;
    d.tail.then(() => sink.abort()).catch(() => {});
  }

  // The sound of a file arriving or failing. Profile pictures, banners and cards travel as files too
  // (direct between clients only): somebody changing their profile is not a file for you, so those are silent.
  private fileSound(id: string, ev: 'uploadDone' | 'uploadFailed'): void {
    if (!this.p2pOnly.has(id)) sounds.play(ev);
  }

  private fail(d: Download, error: string): void {
    this.stop(d);
    this.discard(d);
    this.set(d.meta.i, { state: 'failed', error, rate: 0, sources: 0 });
    this.fileSound(d.meta.i, 'uploadFailed');
  }

  private missing(d: Download): number[] {
    const out: number[] = [];
    for (let k = 0; k < d.count; k++) if (!hasPiece(d, k)) out.push(k);
    return out;
  }

  // Shares out what is still missing between the sources, one stretch each
  private assign(d: Download): void {
    clearTimeout(d.rebalance);
    d.rebalance = undefined;
    const parts = split(this.missing(d), [...d.sources.keys()]);
    for (const [id, src] of d.sources) {
      const pieces = parts.get(id) ?? [];
      // Nothing new for a source that has nothing to do
      if (!pieces.length && !src.pieces.size) continue;
      src.pieces = new Set(pieces);
      this.signal(d.s, [id], FILE.want, { i: d.meta.i, r: toRanges(pieces) });
    }
    this.set(d.meta.i, { sources: d.sources.size });
  }

  private dropSource(d: Download, id: number): void {
    if (!d.sources.delete(id)) return;
    if (d.sources.size) this.assign(d);
    else if (Date.now() > d.findUntil) this.fail(d, 'Nobody online has this file right now');
  }

  private watch(d: Download): void {
    if (this.downloads.get(d.meta.i) !== d) return clearInterval(d.timer);
    const now = Date.now();
    if (!d.s.client) return this.fail(d, 'Disconnected');
    if (!d.sources.size) {
      if (now > d.findUntil) this.fail(d, 'Nobody online has this file right now');
      return;
    }
    if (now - d.lastAt > STALL_MS) {
      if (++d.stalls > 2) return this.fail(d, 'The transfer stopped');
      d.lastAt = now;
      this.assign(d);
    }
    // Speed over the last few seconds
    if (now - d.rateFrom.at >= 4000) {
      this.set(d.meta.i, { rate: (d.bytes - d.rateFrom.bytes) / ((now - d.rateFrom.at) / 1000) });
      d.rateFrom = { at: now, bytes: d.bytes };
    }
  }

  // A chat message carrying a piece; only from people we asked
  piece(s: Session, from: number, html: string): void {
    const p = parsePiece(html);
    const d = p && this.downloads.get(p.id);
    if (!p || !d || d.s !== s || !d.sources.has(from) || p.index >= d.count || hasPiece(d, p.index)) return;
    const bytes = decode15(p.payload, pieceSize(d.meta, p.index));
    if (!bytes) return;
    this.ingest(d, from, p.index, bytes);
  }

  // A piece from a source, however it came
  private ingest(d: Download, from: number, index: number, bytes: Uint8Array): void {
    const p = { id: d.meta.i, index };
    if (!d.sources.has(from) || index >= d.count || hasPiece(d, index)) return;
    if (d.disk) {
      const k = p.index;
      d.have[k] = 1;
      const task = Promise.all([
        d.sink!.write(k * d.meta.c, bytes),
        sha256(bytes).then(h => { d.flat.set(h, k * 32); }),
      ]).catch(() => {
        if (!d.wfail) { d.wfail = true; this.fail(d, 'Could not write the file'); }
      });
      d.tail = d.tail.then(() => task);
    } else {
      d.parts[p.index] = new Blob([bytes as Uint8Array<ArrayBuffer>]);
      d.digests[p.index] = sha256(bytes);
    }
    d.got++;
    d.bytes += bytes.length;
    d.lastAt = Date.now();
    d.stalls = 0;
    d.sources.get(from)!.pieces.delete(p.index);
    if (this.transfers[d.meta.i]?.state === 'finding' && d.rateFrom.bytes === 0) d.rateFrom = { at: Date.now(), bytes: 0 };
    this.set(d.meta.i, { state: 'loading', got: d.bytes });
    if (d.got === d.count) this.finish(d);
  }

  private async finish(d: Download): Promise<void> {
    this.stop(d);
    if (d.disk) return this.finishDisk(d);
    const hash = await rootHash(await Promise.all(d.digests));
    if (hash !== d.meta.h) return this.fail(d, 'The file did not arrive intact');
    const blob = new Blob(d.parts as Blob[], { type: safeType(d.meta.m) });
    this.ready(d.meta, blob);
    this.keep(d.meta, blob);
    this.fileSound(d.meta.i, 'uploadDone');
  }

  // ─── Requests between clients ───────────────────────────────────────────────

  private async finishDisk(d: Download): Promise<void> {
    const sink = d.sink!;
    try {
      await d.tail;
      if (d.wfail) { await sink.abort().catch(() => {}); return; }
      const digests: Uint8Array[] = [];
      for (let k = 0; k < d.count; k++) digests.push(d.flat.subarray(k * 32, (k + 1) * 32));
      if (await rootHash(digests) !== d.meta.h) {
        await sink.abort().catch(() => {});
        return this.fail(d, 'The file did not arrive intact');
      }
      // Only a file that checked out is put in place; it is the only copy
      const where = await sink.finish();
      this.readyDisk(d.meta, where);
      this.fileSound(d.meta.i, 'uploadDone');
    } catch {
      await sink.abort().catch(() => {});
      this.fail(d, 'Could not write the file');
    }
  }

  private readyDisk(meta: FileMeta, saved?: string): void {
    this.set(meta.i, { state: 'ready', got: meta.s, url: '', disk: true, saved, error: '', rate: 0, sources: 0 });
  }

  // Opens the folder holding a file that was saved (desktop app)
  reveal(id: string): void {
    void desktop?.files.reveal(id).catch(() => {});
  }

  // A large file an older version cached: ask where, then move it out of the cache, not copy it
  async saveKept(meta: FileMeta): Promise<void> {
    if (!desktop) return;
    const r = await desktop.files.export(meta.i, fileName(meta.n), meta.h).catch(() => null);
    if (r?.ok) {
      await this.forget(meta.i);
      this.set(meta.i, { saved: r.path, error: '' });
    } else if (r?.reason !== 'canceled') {
      const room = r?.reason === 'space' && r.free != null ? ` (${formatBytes(r.free)} free)` : '';
      this.set(meta.i, { error: r?.reason === 'space' ? `Not enough free space there${room}` : 'Could not save the file there' });
    }
  }

  // Takes a file out of the kept list once it lives somewhere else
  private async forget(id: string): Promise<void> {
    const index = await this.loadIndex();
    const list = index.filter(k => k.i !== id);
    this.index = list;
    this.usage = list.reduce((n, k) => n + k.s, 0);
    await putData(INDEX, list).catch(() => {});
  }

  private runtime(s: Session): Runtime {
    let rt = this.runtimes.get(s);
    if (!rt) {
      rt = {
        assembler: new FileAssembler(), sender: new Sender(), wantSeq: new Map(), pumping: false, queue: [], level: 0, levelAt: Date.now(), timer: undefined,
        p2p: new FileP2P({
          config: p2pConfig,
          signal: (to, type, file, sdp) => this.signal(s, [to], type === 'offer' ? FILE.offer : FILE.answer, { i: file, sdp }),
          expect: (from, file, index) => {
            const d = this.downloads.get(file);
            return d && d.s === s && d.sources.has(from) && index < d.count ? pieceSize(d.meta, index) : null;
          },
          piece: (from, file, index, bytes) => {
            const d = this.downloads.get(file);
            if (d && d.s === s) this.ingest(d, from, index, bytes);
          },
          done: (from, file) => { void this.sourceDone(s, from, file); },
          known: id => !!s.client?.users.has(id),
          profile: (from, text) => s.onManifest(from, text),
          control: (from, packet) => { void this.receive(s, from, FILE_DATA_ID, packet); },
          opened: peer => s.onLinkOpen(peer)
        })
      };
      this.runtimes.set(s, rt);
    }
    return rt;
  }

  async receive(s: Session, from: number, dataId: string, data: Uint8Array): Promise<void> {
    if (dataId !== FILE_DATA_ID || !this.supported(s)) return;
    const rt = this.runtime(s);
    const signal = await rt.assembler.push(from, data);
    const body = parseBody(signal?.text);
    const client = s.client;
    if (!signal || !body || !okId(body.i) || !client || this.runtimes.get(s) !== rt) return;
    const id = body.i;
    const d = this.downloads.get(id);
    const mine = d && d.s === s ? d : null;
    switch (signal.type) {
      case FILE.who:
        // Profile files come from their owner over the direct channel only
        if (!this.p2pOnly.has(id) && await this.find(id)) this.signal(s, [from], FILE.have, { i: id });
        break;
      case FILE.have:
        if (!mine || mine.sources.has(from) || mine.sources.size >= MAX_SOURCES) return;
        mine.sources.set(from, { pieces: new Set(), retries: 0 });
        mine.lastAt = Date.now();
        rt.p2p.connect(from, id);
        // Answers come in together; share out once they are in
        clearTimeout(mine.rebalance);
        mine.rebalance = setTimeout(() => { if (this.downloads.get(id) === mine) this.assign(mine); }, 400);
        break;
      case FILE.want: {
        const found = await this.find(id);
        const pieces = found && fromRanges(body.r, pieceCount(found.meta));
        if (!found) return this.signal(s, [from], FILE.gone, { i: id });
        if (!pieces) return;
        const key = `${from}:${id}`;
        const seq = (rt.wantSeq.get(key) ?? 0) + 1;
        rt.wantSeq.set(key, seq);
        // The asker is setting up a direct connection; give it a moment so the pieces do not take the server's road
        if (pieces.length && !await rt.p2p.waitOpen(from, DIRECT_MS) && (this.p2pOnly.has(id) || found.meta.c > pieceBytes(client.config))) {
          return this.signal(s, [from], FILE.gone, { i: id });
        }
        // A newer request arrived while we waited, or the person left
        if (rt.wantSeq.get(key) !== seq || this.runtimes.get(s) !== rt) return;
        if (!pieces.length) rt.wantSeq.delete(key);
        rt.sender.want(id, from, pieces);
        this.set(id, { sending: rt.sender.receivers(id) });
        this.pump(s, rt);
        break;
      }
      case FILE.done:
        await this.sourceDone(s, from, id);
        break;
      case FILE.offer:
        if (typeof body.sdp === 'string') await rt.p2p.onOffer(from, id, body.sdp);
        break;
      case FILE.answer:
        if (typeof body.sdp === 'string') await rt.p2p.onAnswer(from, body.sdp);
        break;
      case FILE.gone:
        if (mine) this.dropSource(mine, from);
        break;
    }
  }

  // A source says it sent everything we asked for (by message or on the direct channel)
  private async sourceDone(s: Session, from: number, id: string): Promise<void> {
    const mine = this.downloads.get(id);
    const src = mine && mine.s === s ? mine.sources.get(from) : undefined;
    if (!mine || !src) return;
    mine.lastAt = Date.now();
    const left = [...src.pieces].filter(k => !hasPiece(mine, k));
    if (!left.length) return;
    // Something got lost on the way: ask again, or leave it to the others
    if (++src.retries > 2) return this.dropSource(mine, from);
    src.pieces = new Set(left);
    this.signal(s, [from], FILE.want, { i: id, r: toRanges(left) });
  }

  private pump(s: Session, rt: Runtime): void {
    const client = s.client;
    if (rt.pumping || !client) return;
    rt.pumping = true;
    const alive = () => this.runtimes.get(s) === rt && s.client === client;
    // Pieces sent through the server before it confirmed it has read them
    let unconfirmed = 0;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const viaServer = async (file: string, k: number, bytes: Uint8Array, to: number[]): Promise<number[]> => {
      if (bytes.length > pieceBytes(client.config)) return to; // this server's limits are too small for the file's pieces
      const html = pieceMessage(pieceForm(client.config), file, k, encode15(bytes));
      await limiter.take(bytes.length, alive);
      // A slow upload slows the transfer down instead of piling up in front of chat and voice
      if (unconfirmed >= 3) {
        await client.flushed();
        unconfirmed = 0;
      }
      for (let w = client.bulkWait(); w > 0; w = client.bulkWait()) {
        await sleep(w);
        if (!alive()) return [];
      }
      const there = to.filter(r => client.users.has(r));
      if (there.length && client.sendBulk({ users: there }, html)) unconfirmed++;
      if (there.length) console.info(`[Files] piece ${k} of ${file} sent through the server (no direct connection to ${there.join(', ')})`);
      return [];
    };
    pumpRouted({
      sender: rt.sender, alive,
      read: async (file, k) => {
        const found = await this.find(file);
        if (!found) return null;
        const { meta, blob } = found;
        return new Uint8Array(await blob.slice(k * meta.c, k * meta.c + pieceSize(meta, k)).arrayBuffer());
      },
      deliver: async (file, k, bytes, to) => {
        const direct = to.filter(r => rt.p2p.isOpen(r));
        const rest = to.filter(r => !direct.includes(r));
        const failed: number[] = [];
        await Promise.all([
          ...direct.map(async r => { if (!await rt.p2p.send(r, file, k, bytes, limiter, alive)) rest.push(r); }),
        ]);
        if (rest.length && alive()) failed.push(...(this.p2pOnly.has(file) ? rest : await viaServer(file, k, bytes, rest)));
        return failed;
      },
      done: (rs, file) => {
        for (const r of rs) {
          if (!client.users.has(r)) continue;
          if (!rt.p2p.sendDone(r, file)) this.signal(s, [r], FILE.done, { i: file });
        }
      },
      gone: (rs, file) => { this.signal(s, rs, FILE.gone, { i: file }); this.set(file, { sending: 0 }); },
      sent: file => this.set(file, { sending: rt.sender.receivers(file) })
    }).finally(() => {
      rt.pumping = false;
      // Asked again while the last piece went out
      if (alive() && rt.sender.busy) this.pump(s, rt);
    });
  }

  private async signal(s: Session, to: number[], type: FileType, body: unknown): Promise<void> {
    const rt = this.runtime(s);
    // Someone flooding us with questions does not get a growing pile of answers
    if (!to.length || rt.queue.length > 200) return;
    // Offers and answers set up the direct connection, so they must go through the server; the rest goes direct when it can
    const boot = type === FILE.offer || type === FILE.answer;
    const only = this.p2pOnly.has((body as { i?: string } | null)?.i ?? '');
    for (const packet of await encodeFileSignal(type, body)) rt.queue.push({ to, packet, boot, only });
    this.flush(s, rt);
  }

  private flush(s: Session, rt: Runtime): void {
    if (rt.timer) return;
    const client = s.client;
    while (rt.queue.length && client && this.runtimes.get(s) === rt) {
      const item = rt.queue[0];
      const direct = item.boot ? [] : item.to.filter(id => rt.p2p.isOpen(id));
      const rest = item.to.filter(id => !direct.includes(id) && client.users.has(id));
      const useServer = rest.length > 0 && (item.boot || !item.only);
      if (useServer) {
        const now = Date.now();
        rt.level = Math.max(0, rt.level - (now - rt.levelAt) / 1000 * PER_SECOND);
        rt.levelAt = now;
        if (rt.level > BURST - 1) {
          rt.timer = setTimeout(() => { rt.timer = undefined; this.flush(s, rt); }, 1000 / PER_SECOND);
          return;
        }
        rt.level++;
      }
      rt.queue.shift();
      for (const id of direct) rt.p2p.sendControl(id, item.packet);
      if (useServer) client.sendPluginData(rest, FILE_DATA_ID, item.packet);
    }
  }

  // ─── Called by the session ──────────────────────────────────────────────────

  userLeft(s: Session, session: number): void {
    const rt = this.runtimes.get(s);
    if (rt) {
      rt.sender.drop(session);
      rt.p2p.drop(session);
      for (const id of Object.keys(this.transfers)) if (this.transfers[id].sending) this.set(id, { sending: rt.sender.receivers(id) });
    }
    for (const d of [...this.downloads.values()]) if (d.s === s) this.dropSource(d, session);
  }

  closed(s: Session): void {
    const rt = this.runtimes.get(s);
    if (rt) { clearTimeout(rt.timer); rt.p2p.close(); }
    this.runtimes.delete(s);
    for (const d of [...this.downloads.values()]) if (d.s === s) this.fail(d, 'Disconnected');
    for (const id of Object.keys(this.transfers)) if (this.transfers[id].sending) this.set(id, { sending: 0 });
  }
}

export const files = new Files();
