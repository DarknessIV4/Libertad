// Files between mumh5 clients, with no file host. The pieces go straight from computer to
// computer over WebRTC data channels (core/file-p2p.ts); only the small requests and the
// connection setup travel through Mumble. When no direct connection can be made, the pieces
// are carried by the Mumble server itself, as described below.
//
// A file is announced in an ordinary chat message: a marker other clients do not show, then
// its name, size and a preview picture, which is all regular Mumble clients get. mumh5 clients
// that want the file ask the sender, or anyone else who has it, over plugin data; the pieces
// then come as chat messages addressed only to those clients.
//
// Murmur lets a client send about one chat message a second, but one message may be as long
// as the image limit (131072 characters by default) when the bulk sits in <img src="data:...">.
// It counts characters, not bytes, so every character carries 15 bits (code points U+4000 to
// U+BFFF, all plain XML text): about 240 KB per message. A message addressed to several
// people costs the sender one message; the server copies it to each of them.
import { encodeSignal, SignalAssembler } from './share-signal.ts';
import type { MumbleClient } from './client.ts';

export const FILE_DATA_ID = 'mumh5.file';

export const FILE = {
  who: 1,    // who has file i? { i }
  have: 2,   // I have file i: { i }
  want: 3,   // send me these pieces of i: { i, r: ranges }; replaces what was asked before, none stops
  done: 4,   // everything you asked for is sent: { i }
  gone: 5,   // I cannot send file i: { i }
  offer: 6,  // direct connection, from the one who wants pieces: { i, sdp }
  answer: 7  // direct connection, from the one who has them: { i, sdp }
} as const;
export type FileType = typeof FILE[keyof typeof FILE];

export const MAX_FILE = 100 * 1024 ** 3;
// Keeps the bookkeeping small even when a server's limits make pieces small
export const MAX_PIECES = 1048576;

// i: id, n: name, s: size in bytes, m: type, c: bytes per piece, h: hash of the piece hashes
export interface FileMeta { i: string; n: string; s: number; m: string; c: number; h: string }

export const encodeFileSignal = (type: FileType, body: unknown) => encodeSignal(type, JSON.stringify(body));

export class FileAssembler extends SignalAssembler<FileType> {
  constructor() {
    super(Object.values(FILE));
  }
}

export function parseBody(text: string | undefined): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text ?? '');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export const okId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-z]{1,40}$/.test(v);

// ─── 15 bits per character ────────────────────────────────────────────────────

const BASE = 0x4000;

export const encodedLength = (bytes: number) => Math.ceil(bytes * 8 / 15);

export function encode15(bytes: Uint8Array): string {
  const codes = new Uint16Array(encodedLength(bytes.length));
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    if (bits >= 15) {
      bits -= 15;
      codes[o++] = BASE + (acc >>> bits);
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) codes[o++] = BASE + (acc << (15 - bits));
  let out = '';
  for (let i = 0; i < codes.length; i += 8192) out += String.fromCharCode(...codes.subarray(i, i + 8192));
  return out;
}

// The byte length comes from the file's size: the last character does not say how many bits it holds
export function decode15(text: string, length: number): Uint8Array | null {
  if (text.length !== encodedLength(length)) return null;
  const out = new Uint8Array(length);
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < text.length; i++) {
    const v = text.charCodeAt(i) - BASE;
    if (v < 0 || v > 0x7fff) return null;
    acc = (acc << 15) | v;
    bits += 15;
    while (bits >= 8 && o < length) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 255;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

// ─── Pieces as chat messages ─────────────────────────────────────────────────

export interface Limits { allowHtml: boolean; messageLength: number; imageMessageLength: number }

// 0 means no limit; stay well inside what a server reads in one go anyway
const UNLIMITED = 1 << 20;
const OVERHEAD = 128;

// Pieces travel inside <img src="data:..."> where that allows more than plain text
export function pieceForm(l: Limits): 'img' | 'text' {
  const text = l.messageLength || UNLIMITED;
  const image = l.allowHtml ? l.imageMessageLength || UNLIMITED : 0;
  return image > text ? 'img' : 'text';
}

// Bytes of a file per chat message on a server with these limits: a multiple of 15, so a
// full piece fills its characters exactly
export function pieceBytes(l: Limits): number {
  const text = l.messageLength || UNLIMITED;
  const image = l.allowHtml ? l.imageMessageLength || UNLIMITED : 0;
  // Use image limit if it allows more than text limit; cap at what Murmur reads in one go
  const maxChars = l.allowHtml ? (l.imageMessageLength || UNLIMITED) : (l.messageLength || UNLIMITED);
  const chars = Math.min(UNLIMITED, maxChars) - OVERHEAD;
  return Math.max(0, Math.floor(chars / 8) * 15);
}

export const pieceCount = (m: { s: number; c: number }) => Math.ceil(m.s / m.c);
export const pieceSize = (m: { s: number; c: number }, k: number) => Math.min(m.c, m.s - k * m.c);

export function pieceMessage(form: 'img' | 'text', id: string, index: number, payload: string): string {
  return form === 'img' ? `<img alt="mumh5:f:${id}:${index}" src="data:,${payload}"/>` : `mumh5:f:${id}:${index}:${payload}`;
}

const IMG_HEAD = '<img alt="mumh5:f:';
const TEXT_HEAD = 'mumh5:f:';
const IMG_RE = /^<img alt="mumh5:f:([0-9a-z]{1,40}):(\d{1,7})" src="data:,/;
const TEXT_RE = /^mumh5:f:([0-9a-z]{1,40}):(\d{1,7}):/;

// Cheap enough to run on every chat message before anything else looks at it
export const isPiece = (html: string) => html.startsWith(IMG_HEAD) || html.startsWith(TEXT_HEAD);

export function parsePiece(html: string): { id: string; index: number; payload: string } | null {
  const img = html.startsWith(IMG_HEAD);
  const m = (img ? IMG_RE : TEXT_RE).exec(html.slice(0, 80));
  if (!m || (img && !html.endsWith('"/>'))) return null;
  return { id: m[1], index: Number(m[2]), payload: html.slice(m[0].length, img ? -3 : undefined) };
}

// ─── The announcement ────────────────────────────────────────────────────────

const OPEN = '<!--mumh5:file:';
const CLOSE = '<!--/mumh5:file-->';
// No "-" in the encoded part, so the comment cannot end early or contain "--"
const BLOCK = /<!--mumh5:file:([^>\-]{1,2000})-->([\s\S]*?)<!--\/mumh5:file-->/g;
const POSTER = /<img src="(data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+)"\s*\/?>/;

// What other clients show stays between the markers, so mumh5 can put its own card there
export function announce(meta: FileMeta, visible: string): string {
  return `${OPEN}${encodeURIComponent(JSON.stringify(meta)).replace(/-/g, '%2D')}-->${visible}${CLOSE}`;
}

export function validMeta(v: unknown): FileMeta | null {
  const m = v as Record<string, unknown> | null;
  if (!m || typeof m !== 'object' || !okId(m.i)) return null;
  if (typeof m.n !== 'string' || !m.n.length || m.n.length > 255) return null;
  if (!Number.isInteger(m.s) || (m.s as number) < 1 || (m.s as number) > MAX_FILE) return null;
  if (typeof m.m !== 'string' || m.m.length > 100 || (m.m && !/^[\w.+-]+\/[\w.+-]+$/.test(m.m))) return null;
  if (!Number.isInteger(m.c) || (m.c as number) < 1500 || (m.c as number) > 2 * UNLIMITED || (m.c as number) % 15) return null;
  if (Math.ceil((m.s as number) / (m.c as number)) > MAX_PIECES) return null;
  if (typeof m.h !== 'string' || !/^[0-9a-f]{64}$/.test(m.h)) return null;
  // Names come from other people: no folders, no control characters
  const n = m.n.replace(/[\u0000-\u001f\u007f/\\]/g, '_');
  return { i: m.i, n, s: m.s as number, m: m.m, c: m.c as number, h: m.h };
}

// Finds announced files and takes them out of the message, together with their preview picture
export function takeFiles(html: string): { html: string; files: { meta: FileMeta; poster: string }[] } {
  if (!html.includes(OPEN)) return { html, files: [] };
  const files: { meta: FileMeta; poster: string }[] = [];
  const rest = html.replace(BLOCK, (all, encoded: string, inner: string) => {
    let meta: FileMeta | null = null;
    try { meta = validMeta(JSON.parse(decodeURIComponent(encoded))); } catch { /* not ours */ }
    if (!meta) return all;
    if (!files.some(f => f.meta.i === meta.i)) files.push({ meta, poster: POSTER.exec(inner)?.[1] ?? '' });
    return '';
  });
  return { html: rest, files };
}

// ─── Ranges of pieces ────────────────────────────────────────────────────────

// Sorted piece numbers as [first, last + 1] pairs
export function toRanges(pieces: Iterable<number>): [number, number][] {
  const sorted = [...pieces].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && last[1] === p) last[1]++;
    else if (!last || last[1] < p) out.push([p, p + 1]);
  }
  return out;
}

export function fromRanges(v: unknown, count: number): number[] | null {
  if (!Array.isArray(v) || v.length > 10000) return null;
  const out = new Set<number>();
  for (const r of v) {
    if (!Array.isArray(r) || r.length !== 2) return null;
    const [a, b] = r;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b > count || a >= b) return null;
    for (let p = a; p < b; p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

// Splits what is missing into one stretch per source, in the order given
export function split(missing: number[], sources: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const per = Math.ceil(missing.length / Math.max(1, sources.length));
  sources.forEach((s, i) => {
    const part = missing.slice(i * per, (i + 1) * per);
    if (part.length) out.set(s, part);
  });
  return out;
}

// ─── Hashes ──────────────────────────────────────────────────────────────────

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
}

// The file's hash: SHA-256 over the SHA-256 of every piece, so pieces can be hashed as they come
export async function rootHash(digests: Uint8Array[]): Promise<string> {
  const all = new Uint8Array(digests.length * 32);
  digests.forEach((d, i) => all.set(d, i * 32));
  return [...await sha256(all)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── What a source sends next ────────────────────────────────────────────────

// Takes turns between the people asking, so one large download does not hold up the others,
// and sends each piece to everyone who wants it at once
export class Sender {
  private wants = new Map<string, Map<number, Set<number>>>();
  private turns: [string, number][] = [];

  want(file: string, receiver: number, pieces: number[]): void {
    let byReceiver = this.wants.get(file);
    if (!pieces.length) {
      byReceiver?.delete(receiver);
      if (byReceiver && !byReceiver.size) this.wants.delete(file);
      this.turns = this.turns.filter(([f, r]) => f !== file || r !== receiver);
      return;
    }
    if (!byReceiver) this.wants.set(file, byReceiver = new Map());
    byReceiver.set(receiver, new Set(pieces));
    if (!this.turns.some(([f, r]) => f === file && r === receiver)) this.turns.push([file, receiver]);
  }

  // Someone left
  drop(receiver: number): void {
    for (const file of [...this.wants.keys()]) this.want(file, receiver, []);
  }

  // The file cannot be sent; returns who was waiting for it
  dropFile(file: string): number[] {
    const waiting = [...this.wants.get(file)?.keys() ?? []];
    this.wants.delete(file);
    this.turns = this.turns.filter(([f]) => f !== file);
    return waiting;
  }

  get busy(): boolean {
    return this.turns.length > 0;
  }

  // People waiting for pieces of a file
  receivers(file: string): number {
    return this.wants.get(file)?.size ?? 0;
  }

  // The next piece, who it goes to, and who has everything they asked for once it is sent
  next(): { file: string; piece: number; to: number[]; finished: number[] } | null {
    const turn = this.turns.shift();
    if (!turn) return null;
    const [file, receiver] = turn;
    const byReceiver = this.wants.get(file)!;
    let piece = Infinity;
    for (const p of byReceiver.get(receiver)!) if (p < piece) piece = p;
    const to: number[] = [], finished: number[] = [];
    for (const [r, set] of byReceiver) {
      if (!set.delete(piece)) continue;
      to.push(r);
      if (!set.size) finished.push(r);
    }
    for (const r of finished) {
      byReceiver.delete(r);
      if (r !== receiver) this.turns = this.turns.filter(([f, x]) => f !== file || x !== r);
    }
    if (!byReceiver.size) this.wants.delete(file);
    if (!finished.includes(receiver)) this.turns.push(turn);
    return { file, piece, to, finished };
  }
}

// ─── Sending ─────────────────────────────────────────────────────────────────

export interface PumpHost {
  client: Pick<MumbleClient, 'bulkWait' | 'sendBulk' | 'flushed' | 'users'>;
  sender: Sender;
  // The chat message carrying a piece, or null when the file cannot be read any more
  read(file: string, piece: number): Promise<string | null>;
  done(receiver: number, file: string): void;
  gone(receivers: number[], file: string): void;
  alive(): boolean;
  sent?(file: string, piece: number, to: number[]): void;
}

// Pieces sent before the server confirmed it has read them
const UNCONFIRMED = 3;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Sends pieces while anyone wants some, as fast as the server's message limit allows
export async function pump(h: PumpHost): Promise<void> {
  let unconfirmed = 0;
  while (h.alive() && h.sender.busy) {
    const job = h.sender.next();
    if (!job) break;
    const html = await h.read(job.file, job.piece).catch(() => null);
    if (html == null) {
      h.gone([...new Set([...job.to, ...h.sender.dropFile(job.file)])], job.file);
      continue;
    }
    // A slow upload slows the transfer down instead of piling up in front of chat and voice
    if (unconfirmed >= UNCONFIRMED) {
      await h.client.flushed();
      unconfirmed = 0;
    }
    for (let w = h.client.bulkWait(); w > 0; w = h.client.bulkWait()) {
      await sleep(w);
      if (!h.alive()) return;
    }
    const to = job.to.filter(r => h.client.users.has(r));
    if (to.length && h.client.sendBulk({ users: to }, html)) unconfirmed++;
    h.sent?.(job.file, job.piece, to);
    for (const r of job.finished) if (h.client.users.has(r)) h.done(r, job.file);
  }
}

// ─── Upload speed limit ──────────────────────────────────────────────────────

// The setting is in Mbit/s like the stream bitrates; 0 is unlimited
export const uploadRate = (mbit: number): number => mbit > 0 ? mbit * 1_000_000 / 8 : 0;

// A token bucket: take() waits until n bytes may go out. The rate is read each time, so a
// change in settings applies to what is being sent right now.
export class RateLimiter {
  private tokens = 0;
  private at = Date.now();
  private rate: () => number;
  constructor(rate: () => number) {
    this.rate = rate;
  }

  async take(n: number, alive: () => boolean = () => true): Promise<void> {
    for (;;) {
      const r = this.rate();
      if (!(r > 0)) { this.tokens = 0; this.at = Date.now(); return; }
      const now = Date.now();
      // At most a quarter second may be sent at once, so the limit holds from the first moment
      const cap = Math.max(n, r / 4);
      this.tokens = Math.min(cap, this.tokens + (now - this.at) / 1000 * r);
      this.at = now;
      if (this.tokens >= n) { this.tokens -= n; return; }
      await sleep(Math.max(5, Math.min(250, (n - this.tokens) / r * 1000)));
      if (!alive()) return;
    }
  }
}

// ─── Pieces over a direct connection ─────────────────────────────────────────

// A piece is cut into frames that fit a data channel message: [kind, id length, id, piece, offset, bytes]
export const FRAME_BYTES = 16 * 1024;
export const FRAME_PIECE = 1;
export const FRAME_DONE = 2;

export function encodeFrame(kind: number, file: string, piece = 0, offset = 0, bytes?: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(file);
  const head = 2 + id.length + (kind === FRAME_PIECE ? 8 : 0);
  const out = new Uint8Array(head + (bytes?.length ?? 0));
  out[0] = kind;
  out[1] = id.length;
  out.set(id, 2);
  if (kind === FRAME_PIECE) {
    const v = new DataView(out.buffer);
    v.setUint32(2 + id.length, piece, false);
    v.setUint32(6 + id.length, offset, false);
    out.set(bytes!, head);
  }
  return out;
}

export interface Frame { kind: number; file: string; piece: number; offset: number; bytes: Uint8Array }

export function decodeFrame(data: Uint8Array): Frame | null {
  if (data.length < 2) return null;
  const kind = data[0], idLen = data[1];
  if (!idLen || data.length < 2 + idLen) return null;
  const file = new TextDecoder().decode(data.subarray(2, 2 + idLen));
  if (!okId(file)) return null;
  if (kind === FRAME_DONE) return data.length === 2 + idLen ? { kind, file, piece: 0, offset: 0, bytes: new Uint8Array(0) } : null;
  if (kind !== FRAME_PIECE || data.length < 10 + idLen) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { kind, file, piece: v.getUint32(2 + idLen, false), offset: v.getUint32(6 + idLen, false), bytes: data.subarray(10 + idLen) };
}

// ─── Sending, routed ─────────────────────────────────────────────────────────

export interface RoutedHost {
  sender: Sender;
  // The bytes of a piece, or null when the file cannot be read any more
  read(file: string, piece: number): Promise<Uint8Array | null>;
  // Sends a piece to these people, however it can reach each of them; returns those it could not serve
  deliver(file: string, piece: number, bytes: Uint8Array, to: number[]): Promise<number[]>;
  done(receivers: number[], file: string): void;
  gone(receivers: number[], file: string): void;
  alive(): boolean;
  sent?(file: string, piece: number, to: number[]): void;
}

// Sends pieces while anyone wants some, at the speed the person allowed
export async function pumpRouted(h: RoutedHost): Promise<void> {
  while (h.alive() && h.sender.busy) {
    const job = h.sender.next();
    if (!job) break;
    const bytes = await h.read(job.file, job.piece).catch(() => null);
    if (bytes == null) {
      h.gone([...new Set([...job.to, ...h.sender.dropFile(job.file)])], job.file);
      continue;
    }
    const failed = await h.deliver(job.file, job.piece, bytes, job.to);
    if (!h.alive()) return;
    if (failed.length) h.gone(failed, job.file);
    h.sent?.(job.file, job.piece, job.to);
    const served = job.finished.filter(r => !failed.includes(r));
    if (served.length) h.done(served, job.file);
  }
}
