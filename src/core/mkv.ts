// Torrent Together: subtitles that are inside the video file. Chromium plays a Matroska (.mkv, .webm) file but
// shows none of its subtitle tracks, so the file is read here: the track list from its start, and the subtitle
// blocks from its clusters while it is scanned. Pure functions over bytes; the reading of the file lives in
// electron/torrent-core.ts.

export interface EmbeddedTrack {
  number: number;     // the track number blocks refer to
  codec: string;      // "S_TEXT/UTF8", "S_TEXT/ASS", ...
  lang: string;       // ISO 639-2, "eng" when the file does not say
  name: string;       // the title the muxer gave it ("Signs & Songs"), often empty
  forced: boolean;
  isDefault: boolean;
}

// What the scan sends to the page, a little at a time
export interface EmbeddedCue { track: number; start: number; end: number; text: string }
export interface EmbeddedBatch { infoHash: string; fileIdx: number; cues: EmbeddedCue[]; progress: number; done: boolean; error?: string }

// Text subtitles only. Picture subtitles (PGS, VobSub) can not be shown as text.
const TEXT_CODECS = new Set(['S_TEXT/UTF8', 'S_TEXT/ASS', 'S_TEXT/SSA', 'S_TEXT/WEBVTT']);

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimestampScale: 0x2ad7b1, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83,
  CodecID: 0x86, Language: 0x22b59c, LanguageBCP47: 0x22b59d, Name: 0x536e, FlagDefault: 0x88, FlagForced: 0x55aa,
  ContentEncodings: 0x6d80, Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b
};
const TYPE_SUBTITLE = 17;
const DEFAULT_SCALE = 1_000_000; // nanoseconds per tick: a tick is a millisecond
const MAX_BLOCK = 256 * 1024;    // a subtitle block is small; anything bigger is a picture
const DEFAULT_CUE_MS = 4000;

// ─── Reading elements ────────────────────────────────────────────────────────

interface Header { id: number; size: number | null; hlen: number }

// The header (id and size) of the element at `o`. null: not enough bytes yet. 'bad': not a Matroska element.
export function readHeader(b: Uint8Array, o: number): Header | null | 'bad' {
  if (o >= b.length) return null;
  const first = b[o];
  let idLen = 1;
  while (idLen <= 4 && !(first & (0x80 >> (idLen - 1)))) idLen++;
  if (idLen > 4) return 'bad';
  if (o + idLen >= b.length) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + b[o + i];
  const s0 = b[o + idLen];
  let sLen = 1;
  while (sLen <= 8 && !(s0 & (0x80 >> (sLen - 1)))) sLen++;
  if (sLen > 8) return 'bad';
  if (o + idLen + sLen > b.length) return null;
  let value = s0 & (0xff >> sLen);
  let allOnes = value === (0xff >> sLen);
  for (let i = 1; i < sLen; i++) {
    const byte = b[o + idLen + i];
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { id, size: allOnes ? null : value, hlen: idLen + sLen };
}

// A variable-length number as the track number of a block (marker bit removed)
function readVint(b: Uint8Array, o: number): { value: number; len: number } | null {
  if (o >= b.length) return null;
  const first = b[o];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || o + len > b.length) return null;
  let value = first & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + b[o + i];
  return { value, len };
}

const uint = (b: Uint8Array, o: number, n: number): number => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
  return v;
};
const text = (b: Uint8Array, o: number, n: number): string => new TextDecoder().decode(b.subarray(o, o + n)).replace(/\0+$/, '');

// Calls `fn` for every complete child between `start` and `end`; stops at one that is cut off or has no size
function children(b: Uint8Array, start: number, end: number, fn: (id: number, at: number, size: number) => void): void {
  let o = start;
  while (o < end) {
    const h = readHeader(b, o);
    if (!h || h === 'bad' || h.size === null) return;
    const at = o + h.hlen;
    if (at + h.size > end) return;
    fn(h.id, at, h.size);
    o = at + h.size;
  }
}

// ─── The start of the file ───────────────────────────────────────────────────

export interface MkvTrack extends EmbeddedTrack { type: number; encoded: boolean }

function trackEntry(b: Uint8Array, at: number, size: number): MkvTrack {
  const t: MkvTrack = { number: 0, type: 0, codec: '', lang: 'eng', name: '', forced: false, isDefault: false, encoded: false };
  let bcp47 = '';
  children(b, at, at + size, (id, o, n) => {
    if (id === ID.TrackNumber) t.number = uint(b, o, n);
    else if (id === ID.TrackType) t.type = uint(b, o, n);
    else if (id === ID.CodecID) t.codec = text(b, o, n);
    else if (id === ID.Language) t.lang = text(b, o, n) || 'eng';
    else if (id === ID.LanguageBCP47) bcp47 = text(b, o, n);
    else if (id === ID.Name) t.name = text(b, o, n).slice(0, 120);
    else if (id === ID.FlagForced) t.forced = uint(b, o, n) === 1;
    else if (id === ID.FlagDefault) t.isDefault = uint(b, o, n) === 1;
    else if (id === ID.ContentEncodings) t.encoded = true;
  });
  // The newer language element is the more exact one ("pt-BR"), when there is one
  if (bcp47) t.lang = bcp47;
  return t;
}

function trackList(b: Uint8Array, at: number, size: number): MkvTrack[] {
  const out: MkvTrack[] = [];
  children(b, at, at + size, (id, o, n) => { if (id === ID.TrackEntry) out.push(trackEntry(b, o, n)); });
  return out;
}

export interface MkvHead {
  segStart: number;              // where the segment's contents begin: every position in the file is counted from here
  scale: number;                 // nanoseconds per tick
  tracks: MkvTrack[] | null;     // null when they are not within the bytes read: see tracksPos
  tracksPos: number | null;      // where the seek head says they are
  cuesPos: number | null;
  firstCluster: number | null;
}

// What the first bytes of the file say. null: this is not a Matroska file.
export function parseHead(b: Uint8Array): MkvHead | null {
  const first = readHeader(b, 0);
  if (!first || first === 'bad' || first.id !== ID.EBML || first.size === null) return null;
  const head: MkvHead = { segStart: -1, scale: DEFAULT_SCALE, tracks: null, tracksPos: null, cuesPos: null, firstCluster: null };
  let o = first.hlen + first.size;
  for (;;) {
    const h = readHeader(b, o);
    if (!h || h === 'bad') break;
    if (h.id === ID.Segment) { head.segStart = o + h.hlen; o = head.segStart; continue; }
    if (head.segStart < 0) break; // something other than a segment follows the header
    if (h.id === ID.Cluster) { head.firstCluster = o; break; }
    if (h.size === null) break;
    const at = o + h.hlen;
    const whole = at + h.size <= b.length;
    if (whole && h.id === ID.SeekHead) {
      children(b, at, at + h.size, (id, so, sn) => {
        if (id !== ID.Seek) return;
        let target = -1, pos = -1;
        children(b, so, so + sn, (cid, co, cn) => {
          if (cid === ID.SeekID) target = uint(b, co, cn);
          else if (cid === ID.SeekPosition) pos = uint(b, co, cn);
        });
        if (pos < 0) return;
        if (target === ID.Tracks) head.tracksPos = head.segStart + pos;
        else if (target === ID.Cues) head.cuesPos = head.segStart + pos;
      });
    } else if (whole && h.id === ID.Info) {
      children(b, at, at + h.size, (id, io, n) => { if (id === ID.TimestampScale) head.scale = uint(b, io, n) || DEFAULT_SCALE; });
    } else if (whole && h.id === ID.Tracks) {
      head.tracks = trackList(b, at, h.size);
      head.tracksPos = o;
    } else if (h.id === ID.Tracks) {
      head.tracksPos = o;
    } else if (h.id === ID.Cues) {
      head.cuesPos = o;
    }
    o = at + h.size;
  }
  return head.segStart < 0 ? null : head;
}

// The tracks, from bytes that begin with the Tracks element. null when it is not all there.
export function parseTracksAt(b: Uint8Array): MkvTrack[] | null {
  const h = readHeader(b, 0);
  if (!h || h === 'bad' || h.id !== ID.Tracks || h.size === null || h.hlen + h.size > b.length) return null;
  return trackList(b, h.hlen, h.size);
}

// The subtitle tracks that can be shown as text
export const textTracks = (tracks: readonly MkvTrack[]): EmbeddedTrack[] =>
  tracks.filter(t => t.type === TYPE_SUBTITLE && !t.encoded && TEXT_CODECS.has(t.codec))
    .map(({ number, codec, lang, name, forced, isDefault }) => ({ number, codec, lang, name, forced, isDefault }));

export interface CuePoint { timeMs: number; cluster: number } // cluster: counted from the segment's start

// The index of the file (which cluster holds which time), from bytes that begin with the Cues element. What was
// read before the bytes ran out is returned.
export function parseCuesAt(b: Uint8Array, scale: number): CuePoint[] {
  const h = readHeader(b, 0);
  const out: CuePoint[] = [];
  if (!h || h === 'bad' || h.id !== ID.Cues || h.size === null) return out;
  children(b, h.hlen, Math.min(b.length, h.hlen + h.size), (id, at, size) => {
    if (id !== ID.CuePoint) return;
    let time = -1, cluster = -1;
    children(b, at, at + size, (cid, co, cn) => {
      if (cid === ID.CueTime) time = uint(b, co, cn);
      else if (cid === ID.CueTrackPositions && cluster < 0) {
        children(b, co, co + cn, (pid, po, pn) => { if (pid === ID.CueClusterPosition) cluster = uint(b, po, pn); });
      }
    });
    if (time >= 0 && cluster >= 0) out.push({ timeMs: Math.round(time * scale / 1e6), cluster });
  });
  return out;
}

// ─── Text of a block ─────────────────────────────────────────────────────────

// An ASS line as it is stored in Matroska: "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
export function assText(line: string): string {
  let i = -1;
  for (let k = 0; k < 8; k++) {
    i = line.indexOf(',', i + 1);
    if (i < 0) return '';
  }
  const body = line.slice(i + 1);
  // Drawings (the shapes of a sign or a logo) are not text
  if (/\{[^}]*\\p[1-9]/.test(body)) return '';
  return body
    .replace(/\{[^}]*\}/g, tags => {
      let out = '';
      for (const m of tags.matchAll(/\\([ibu])([01])(?![0-9])/g)) out += m[2] === '1' ? `<${m[1]}>` : `</${m[1]}>`;
      return out;
    })
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function blockText(codec: string, data: Uint8Array): string {
  const raw = new TextDecoder().decode(data);
  if (codec === 'S_TEXT/ASS' || codec === 'S_TEXT/SSA') return assText(raw);
  return raw.replace(/\r/g, '').trim();
}

// ─── Scanning the clusters ───────────────────────────────────────────────────

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

// Reads the clusters of a file as its bytes arrive, in pieces of any size, and returns the subtitle blocks of the
// tracks it is asked for. Everything else (the picture, the sound) is skipped without being held.
export class SubScanner {
  finished = false;
  private buf: Uint8Array = new Uint8Array(0);
  private skip = 0;
  private clusterTime = 0;

  // `codecs`: track number -> codec. `pos`: the file offset of the first byte pushed, the start of a cluster (or of
  // the segment). `stopAt`: the scan ends when a cluster begins at or after this offset.
  private codecs: ReadonlyMap<number, string>;
  private scale: number;
  private pos: number;
  private stopAt: number | undefined;
  constructor(codecs: ReadonlyMap<number, string>, scale: number, pos: number, stopAt?: number) {
    this.codecs = codecs;
    this.scale = scale;
    this.pos = pos;
    this.stopAt = stopAt;
  }

  push(chunk: Uint8Array): EmbeddedCue[] {
    const out: EmbeddedCue[] = [];
    if (this.finished) return out;
    this.buf = concat(this.buf, chunk);
    let o = 0; // consumed so far in buf
    const eat = (n: number) => { o += n; this.pos += n; };
    for (;;) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, this.buf.length - o);
        eat(n);
        this.skip -= n;
        if (this.skip > 0) break;
      }
      const h = readHeader(this.buf, o);
      if (h === 'bad') { this.finished = true; break; }
      if (!h) break;
      const total = h.size === null ? null : h.hlen + h.size;
      if (h.id === ID.Cluster) {
        if (this.stopAt !== undefined && this.pos >= this.stopAt) { this.finished = true; break; }
        eat(h.hlen); // the clusters' children are read in place
        continue;
      }
      if (total === null) { this.finished = true; break; }
      if (h.id === ID.Timestamp) {
        if (this.buf.length - o < total) break;
        this.clusterTime = uint(this.buf, o + h.hlen, h.size!);
        eat(total);
      } else if (h.id === ID.SimpleBlock || h.id === ID.BlockGroup) {
        const group = h.id === ID.BlockGroup;
        let wanted = h.size! <= MAX_BLOCK;
        if (wanted && !group) {
          // The track number is at the start of the block: a block of the picture or the sound is skipped unread
          if (this.buf.length - o < h.hlen + Math.min(h.size!, 8)) break;
          const t = readVint(this.buf, o + h.hlen);
          wanted = !!t && this.codecs.has(t.value);
        }
        if (!wanted) { this.skip = total; continue; }
        if (this.buf.length - o < total) break;
        const payload = this.buf.subarray(o + h.hlen, o + total);
        if (group) this.group(payload, out); else this.block(payload, undefined, out);
        eat(total);
      } else {
        this.skip = total;
      }
    }
    this.buf = this.buf.subarray(o);
    return out;
  }

  private group(p: Uint8Array, out: EmbeddedCue[]) {
    let block: Uint8Array | null = null, duration: number | undefined;
    children(p, 0, p.length, (id, at, size) => {
      if (id === ID.Block) block = p.subarray(at, at + size);
      else if (id === ID.BlockDuration) duration = uint(p, at, size);
    });
    if (block) this.block(block, duration, out);
  }

  // A block: the track number, the time since the cluster's start (16 bits), flags, then the data
  private block(b: Uint8Array, duration: number | undefined, out: EmbeddedCue[]) {
    const t = readVint(b, 0);
    if (!t || b.length < t.len + 3) return;
    const codec = this.codecs.get(t.value);
    if (!codec) return;
    const rel = (b[t.len] << 8) | b[t.len + 1];
    const ticks = this.clusterTime + (rel > 0x7fff ? rel - 0x10000 : rel);
    const ms = (n: number) => Math.round(n * this.scale / 1e6);
    const textOf = blockText(codec, b.subarray(t.len + 3));
    if (!textOf) return;
    const start = Math.max(0, ms(ticks));
    out.push({ track: t.value, start, end: duration !== undefined && duration > 0 ? start + ms(duration) : start + DEFAULT_CUE_MS, text: textOf });
  }
}
