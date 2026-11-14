import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream';
import {
  buildMagnet, isVideoName, normalizeMagnet, parseMagnet, pickDefaultFile,
  type TorrentInfo, type TorrentPlay, type TorrentStats
} from '../src/core/torrent-meta.ts';
import { HASH_CHUNK, openSubtitlesHash } from '../src/core/subtitles.ts';
import type { Transcoder } from './transcode.ts';
import type { MediaInfo } from '../src/core/transcode.ts';
import { SubScanner, parseCuesAt, parseHead, parseTracksAt, textTracks, type EmbeddedCue, type EmbeddedTrack, type MkvHead } from '../src/core/mkv.ts';

// The torrent engine of Torrent Together, without anything of Electron in it (so it can be tested
// on its own). WebTorrent downloads; a small web server on this computer hands the video to the
// page's <video> element with range requests, so seeking works while the file is still arriving.

// The parts of WebTorrent that are used (it ships no types)
export interface WtFile {
  name: string; path: string; length: number; progress: number;
  select(): void;
  createReadStream(o?: { start?: number; end?: number }): AsyncIterable<Uint8Array> & { destroy(e?: Error): void };
}
export interface WtTorrent {
  infoHash: string; name: string; ready: boolean; torrentFile?: Uint8Array; private?: boolean; files: WtFile[]; announce: string[];
  numPeers: number; downloadSpeed: number; uploadSpeed: number; downloaded: number;
  once(ev: string, fn: (...a: any[]) => void): void;
  destroy(opts?: { destroyStore?: boolean }, cb?: () => void): void;
}
export interface WtClient {
  add(id: string | Uint8Array, opts: object): WtTorrent;
  on(ev: string, fn: (...a: any[]) => void): void;
  destroy(cb?: () => void): void;
}
export type WtConstructor = new (opts?: object) => WtClient;

export interface EngineOptions {
  root: string;                                  // where downloads live; wiped when the engine starts and stops
  loadClient?: () => Promise<WtConstructor>;
  metadataTimeoutMs?: number;
  // Converts what the page can not play; null/absent when there is no ffmpeg
  transcoder?: Transcoder | null;
}

// Public trackers added to every torrent here. A magnet link carries only a few trackers, and a joiner that
// is given none that work finds nobody (0 peers, loading forever) even though the swarm is there.
const FALLBACK_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
];

// HTTP(S) trackers: they get through on networks that block UDP, which is what a "0 peers" joiner is often stuck behind
const HTTP_TRACKERS = [
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.gbitt.info:443/announce',
  'https://tracker1.520.jp:443/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'http://tracker.files.fm:6969/announce'
];
const EXTRA_UDP_TRACKERS = [
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.0x7c0.com:6969/announce'
];
// Tried one after the other while nobody has answered: the first is the normal one, the rest are what a stalled torrent is re-added with
const TRACKER_SETS: string[][] = [
  FALLBACK_TRACKERS,
  [...HTTP_TRACKERS, ...FALLBACK_TRACKERS.slice(0, 3)],
  [...EXTRA_UDP_TRACKERS, ...HTTP_TRACKERS, ...FALLBACK_TRACKERS]
];
const ALL_FALLBACKS = new Set(TRACKER_SETS.flat());
// How long a torrent with no peers (and no file list yet) waits before it is re-added with other trackers
// Public caches that keep the .torrent files of popular torrents: asked in parallel with the peers, whichever answers first gives
// the file list (an address that does not have the file is skipped by WebTorrent). Only used here, never put in a shared link.
const TORRENT_CACHES: ((hash: string) => string)[] = [
  h => `https://itorrents.org/torrent/${h.toUpperCase()}.torrent`,
  h => `https://torrage.info/torrent.php?h=${h.toUpperCase()}`,
  h => `https://btcache.me/torrent/${h.toUpperCase()}`
];
const withCaches = (magnet: string): string => {
  const hash = parseMagnet(magnet)?.infoHash;
  return hash ? magnet + TORRENT_CACHES.map(c => `&xs=${encodeURIComponent(c(hash))}`).join('') : magnet;
};
const STALL_MS = 5000;
// The same for a torrent whose file list is known but that has not sent a single byte (checked every 5 s, refreshed after 3 quiet checks)
const START_CHECK_MS = 5000;
const START_QUIET_CHECKS = 3;
// Peers that are there but never send the file list are given this long before the torrent is re-added
const NO_METADATA_MS = 20000;

const PRIVATE = 'This is a private torrent. Its tracker would give your personal key to everybody in the channel, so it can not be shared here.';
const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  ogv: 'video/ogg', avi: 'video/x-msvideo', ts: 'video/mp2t', m2ts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg'
};
const mimeOf = (name: string) => MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

// A single "Range: bytes=a-b" header. null: no range was asked. 'bad': one that can not be met.
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'bad' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '') || size < 1) return 'bad';
  let start: number, end: number;
  if (m[1] === '') {
    const last = Number(m[2]);
    if (last === 0) return 'bad';
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? 'bad' : { start, end };
}

interface Entry {
  t: WtTorrent; owners: Set<object>; ready: Promise<void>;
  readd?: (attempt: number, source?: Uint8Array) => WtTorrent;
  swap?: Promise<void>;     // the torrent is being re-added: requests for its file wait for it
  watching?: boolean;
  snap?: TorrentStats;         // the last numbers shown, kept while the torrent is being re-added
  remap?: Map<number, number>; // the file number a link names -> where that file really is in the torrent
}

export function createTorrentEngine(opts: EngineOptions) {
  const timeoutMs = opts.metadataTimeoutMs ?? 90000;
  const torrents = new Map<string, Entry>();
  let clientP: Promise<WtClient> | null = null;
  let serverP: Promise<{ port: number; token: string; srv: http.Server }> | null = null;
  const scans = new Map<string, { cancel(): void }>();
  const heads = new Map<string, Promise<{ head: MkvHead; tracks: EmbeddedTrack[]; codecs: Map<number, string> } | null>>();

  async function getClient(): Promise<WtClient> {
    clientP ??= (async () => {
      // The name is not a literal, so a bundler leaves it alone and Node loads the package at run time
      const spec = 'webtorrent';
      const Ctor = opts.loadClient ? await opts.loadClient() : ((await import(spec)).default as WtConstructor);
      await fs.rm(opts.root, { recursive: true, force: true });
      await fs.mkdir(opts.root, { recursive: true });
      const client = new Ctor({ maxConns: 150 });
      client.on('error', () => {}); // a failed torrent reports itself to whoever waits for it
      return client;
    })();
    return clientP;
  }

  // The file a link's number stands for. Torrentio numbers a torrent's files its own way, so the number can name another file
  // (or none) here: the file of the same size or name is the one meant, and a link whose number names nothing plays the largest video.
  const fileOf = (entry: Entry | undefined, idx: number): WtFile | undefined => entry?.t.files[entry.remap?.get(idx) ?? idx];
  function resolveIdx(files: readonly WtFile[], idx: number, hint?: { fileName?: string; size?: number }): number {
    const at0 = files[idx];
    // Without a name or size to go by, a number that names no file stays an error
    if (!at0 && !hint?.fileName && !hint?.size) return idx;
    const base = (n: string) => n.slice(Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\')) + 1).toLowerCase();
    const size = hint?.size && hint.size > 0 ? hint.size : 0, name = hint?.fileName ? base(hint.fileName) : '';
    const at = files[idx];
    if (at && (!size || at.length === size)) return idx;
    const found = files.findIndex(f => (!size || f.length === size) && (size || name) && (!name || base(f.path || f.name) === name));
    if (found >= 0) return found;
    const bySize = size ? files.findIndex(f => f.length === size && isVideoName(f.name)) : -1;
    if (bySize >= 0) return bySize;
    if (at) return idx; // nothing fits better: the number is trusted
    return pickDefaultFile(files.map((f, index) => ({ index, name: f.path || f.name, length: f.length })));
  }

  function drop(entry: Entry, keepFiles = false) {
    for (const [k, scan] of scans) if (k.startsWith(`${entry.t.infoHash}:`)) { scan.cancel(); scans.delete(k); }
    for (const k of heads.keys()) if (k.startsWith(`${entry.t.infoHash}:`)) heads.delete(k);
    for (const [k, v] of torrents) if (v === entry) torrents.delete(k);
    opts.transcoder?.release(`${entry.t.infoHash}:`);
    try { entry.t.destroy({ destroyStore: !keepFiles }); } catch { /* already gone */ }
  }

  // Waits for the torrent's metadata. Fails, and forgets the torrent, when nobody answers in time
  // or when it is a private torrent.
  // `readd(attempt, source)` adds the same torrent again with another set of trackers (from its file list when `source` is given):
  // it is used when nobody has answered for a while, or when the peers that did answer never send the file list.
  function track(t: WtTorrent, known: string | null, owner: object, readd?: (attempt: number, source?: Uint8Array) => WtTorrent): Entry {
    const entry: Entry = { t, owners: new Set([owner]), ready: Promise.resolve(), readd };
    entry.ready = new Promise<void>((resolve, reject) => {
      let stalled: ReturnType<typeof setInterval> | null = null, over = false;
      const done = () => { over = true; clearTimeout(timer); if (stalled) clearInterval(stalled); };
      const fail = (e: Error) => {
        done();
        // A duplicate is a torrent that is already here: its files are the ones in use
        drop(entry, /duplicate torrent/i.test(e.message));
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error('Nobody sharing this torrent could be found. It may be dead, or the link is wrong.')), timeoutMs);
      const watch = (cur: WtTorrent) => {
        cur.once('ready', () => {
          if (entry.t !== cur) return;
          done();
          if (cur.private) fail(new Error(PRIVATE)); else resolve();
        });
        cur.once('error', (e: Error) => { if (entry.t === cur) fail(e); });
      };
      watch(t);
      if (readd) {
        let attempt = 0, busy = false, since = Date.now();
        stalled = setInterval(() => {
          const cur = entry.t;
          // 0 peers: try other trackers soon. Peers that give no file list (a link with thousands of dead ones): after a longer while
          if (busy || cur.ready || (cur.numPeers > 0 && Date.now() - since < NO_METADATA_MS)) return;
          if (attempt >= TRACKER_SETS.length - 1) { clearInterval(stalled!); return; }
          busy = true;
          attempt++;
          let went = false;
          const go = () => {
            if (went) return;
            went = true;
            busy = false;
            since = Date.now();
            if (over) return;
            try { const next = readd(attempt); entry.t = next; watch(next); } catch (e) { fail(e as Error); }
          };
          // Let go of the old one first (its files are closed when the callback runs), then add it again
          setTimeout(go, 3000);
          try { cur.destroy({ destroyStore: false }, go); } catch { go(); }
        }, STALL_MS);
      }
    });
    entry.ready.catch(() => {});
    if (known) torrents.set(known, entry);
    else entry.ready.then(() => { torrents.set(entry.t.infoHash, entry); }, () => {});
    return entry;
  }

  const addOpts = (attempt = 0) => ({ path: opts.root, deselect: true, announce: TRACKER_SETS[Math.min(attempt, TRACKER_SETS.length - 1)] });

  function describe(entry: Entry): TorrentInfo {
    const t = entry.t;
    const files = t.files.map((f, index) => ({ index, name: f.path || f.name, length: f.length }));
    return {
      infoHash: t.infoHash,
      name: t.name,
      // Only the torrent's own trackers are shared on, not the ones added here (the joiner adds those itself)
      magnet: buildMagnet(t.infoHash, t.name, t.announce.filter(a => !ALL_FALLBACKS.has(a))),
      files,
      defaultIndex: pickDefaultFile(files)
    };
  }

  // A torrent whose file list is known but that sends nothing: the same torrent is added again (from its own file list, so no
  // second wait for it) with other trackers, which brings other peers. Requests for the file wait until that is done.
  function refresh(entry: Entry, fileIdx: number, attempt: number) {
    const old = entry.t, source = old.torrentFile;
    entry.swap = new Promise<void>(resolve => {
      let went = false;
      const finish = () => { entry.swap = undefined; resolve(); };
      const go = () => {
        if (went) return;
        went = true;
        try {
          const next = entry.readd!(attempt, source);
          entry.t = next;
          next.once('ready', () => { next.files[entry.remap?.get(fileIdx) ?? fileIdx]?.select(); finish(); });
          next.once('error', finish);
          setTimeout(finish, 20000);
        } catch { finish(); }
      };
      setTimeout(go, 3000);
      try { old.destroy({ destroyStore: false }, go); } catch { go(); }
    });
  }

  // Once the file is chosen: if not a single byte has arrived after 15 seconds (peers that are there but stuck, trackers that
  // answered with dead addresses) the torrent is refreshed, up to twice with other trackers. Stops by itself at the first byte.
  function watchStart(entry: Entry, hash: string, fileIdx: number) {
    if (entry.watching || !entry.readd) return;
    entry.watching = true;
    let quiet = 0, tries = 0;
    const iv = setInterval(() => {
      const t = entry.t;
      if (torrents.get(hash) !== entry || t.downloaded > 0 || tries >= TRACKER_SETS.length - 1) { clearInterval(iv); entry.watching = false; return; }
      if (entry.swap) return;
      quiet = t.downloadSpeed > 0 ? 0 : quiet + 1;
      if (quiet < START_QUIET_CHECKS) return;
      quiet = 0;
      refresh(entry, fileIdx, ++tries);
    }, START_CHECK_MS);
    iv.unref?.();
  }

  // Looks a torrent up (magnet link, bare hash, or the bytes of a .torrent file) and waits for its file list
  async function inspect(source: string | Uint8Array, owner: object): Promise<TorrentInfo> {
    const client = await getClient();
    let entry: Entry | undefined;
    if (typeof source === 'string') {
      const magnet = normalizeMagnet(source);
      const hash = magnet ? parseMagnet(magnet)?.infoHash : null;
      if (!magnet || !hash) throw new Error('That is not a magnet link, an info hash or a .torrent file');
      entry = torrents.get(hash);
      if (entry) entry.owners.add(owner);
      else entry = track(client.add(withCaches(magnet), addOpts()), hash, owner, (n, src) => client.add(src ?? withCaches(magnet), addOpts(n)));
    } else {
      entry = track(client.add(source, addOpts()), null, owner);
    }
    try {
      await entry.ready;
    } catch (e) {
      const dup = /duplicate torrent ([0-9a-f]{40})/i.exec((e as Error).message);
      const existing = dup ? torrents.get(dup[1].toLowerCase()) : undefined;
      if (!existing) throw e;
      existing.owners.add(owner);
      return describe(existing);
    }
    return describe(entry);
  }

  async function ensureServer() {
    serverP ??= new Promise((resolve, reject) => {
      const token = randomBytes(18).toString('hex');
      const srv = http.createServer((req, res) => serve(req, res, token, (srv.address() as AddressInfo).port));
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as AddressInfo).port, token, srv }));
    });
    return serverP;
  }

  // GET /<token>/<info hash>/<file index>, with or without a Range header. Nothing else is answered.
  function serve(req: http.IncomingMessage, res: http.ServerResponse, token: string, port: number) {
    const fail = (code: number, headers: Record<string, string> = {}) => { res.writeHead(code, headers); res.end(); };
    // A web page that was lured to another name for this computer (DNS rebinding) is not served
    if (req.headers.host !== `127.0.0.1:${port}`) return fail(403);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, { Allow: 'GET, HEAD' });
    const m = /^\/([0-9a-f]{36})\/([0-9a-f]{40})\/(\d{1,5})(?:\/hls\/(\d{1,2})\/(index\.m3u8|seg\d{1,6}\.ts))?$/.exec((req.url ?? '').split('?')[0]);
    if (!m || m[1] !== token) return fail(404);
    const entry = torrents.get(m[2]);
    if (entry?.swap) { void entry.swap.then(() => serve(req, res, token, port)); return; }
    const file = fileOf(entry, Number(m[3]));
    if (!file) return fail(404);
    if (m[5]) {
      // The converted video: the transcoder reads the file from this same server, so it is fetched like any player does
      if (!opts.transcoder || req.method !== 'GET') return fail(404);
      const input = `http://127.0.0.1:${port}/${token}/${m[2]}/${m[3]}`;
      void opts.transcoder.serve(res, `${m[2]}:${m[3]}`, input, Number(m[4]), m[5]).catch(() => { if (!res.headersSent) fail(500); else res.destroy(); });
      return;
    }

    const range = parseRange(req.headers.range, file.length);
    if (range === 'bad') return fail(416, { 'Content-Range': `bytes */${file.length}` });
    const { start, end } = range ?? { start: 0, end: file.length - 1 };
    const headers: Record<string, string | number> = {
      'Content-Type': mimeOf(file.name),
      'Accept-Ranges': 'bytes',
      'Content-Length': file.length === 0 ? 0 : end - start + 1,
      'Cache-Control': 'no-store',
      // The page reads frames of the picture for the small preview; the address is unguessable
      'Access-Control-Allow-Origin': '*'
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${file.length}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || file.length === 0) return void res.end();
    const stream = file.createReadStream({ start, end });
    // The player moved on or went away: stop asking the swarm for what it will not read
    res.once('close', () => stream.destroy());
    pipeline(stream as any, res, () => {});
  }

  // The torrent is added when it is not here yet (a viewer joining), then the file is chosen and its address returned
  async function play(meta: { magnet: string; fileIdx: number; fileName?: string; size?: number }, owner: object): Promise<TorrentPlay> {
    const client = await getClient();
    const parsed = parseMagnet(meta.magnet);
    if (!parsed) throw new Error('That is not a magnet link');
    let entry = torrents.get(parsed.infoHash);
    if (entry) entry.owners.add(owner);
    else {
      const magnet = buildMagnet(parsed.infoHash, parsed.name, parsed.trackers);
      entry = track(client.add(withCaches(magnet), addOpts()), parsed.infoHash, owner, (n, src) => client.add(src ?? withCaches(magnet), addOpts(n)));
    }
    await entry.ready;
    const real = resolveIdx(entry.t.files, meta.fileIdx, meta);
    if (real !== meta.fileIdx) (entry.remap ??= new Map()).set(meta.fileIdx, real); else entry.remap?.delete(meta.fileIdx);
    const file = entry.t.files[real];
    if (!file) throw new Error('That file is not in this torrent');
    file.select();
    watchStart(entry, parsed.infoHash, meta.fileIdx);
    const srv = await ensureServer();
    return { url: `http://127.0.0.1:${srv.port}/${srv.token}/${parsed.infoHash}/${meta.fileIdx}`, fileName: file.name, length: file.length };
  }

  // What is in the played file, and where its converted form is served from (null: nothing can convert it here)
  async function probe(infoHash: string, fileIdx: number): Promise<{ info: MediaInfo | null; hls: string | null }> {
    const tc = opts.transcoder;
    if (!tc || !fileOf(torrents.get(infoHash), fileIdx)) return { info: null, hls: null };
    const srv = await ensureServer();
    const base = `http://127.0.0.1:${srv.port}/${srv.token}/${infoHash}/${fileIdx}`;
    const info = await tc.probe(`${infoHash}:${fileIdx}`, base);
    return { info, hls: info && info.duration > 0 ? `${base}/hls/` : null };
  }

  function stats(infoHash: string, fileIdx: number): TorrentStats {
    const entry = torrents.get(infoHash);
    if (!entry) return { ready: false, peers: 0, down: 0, up: 0, progress: 0, downloaded: 0 };
    if (entry.swap && entry.snap) return entry.snap;
    const t = entry.t, file = fileOf(entry, fileIdx);
    return (entry.snap = { ready: t.ready, peers: t.numPeers, down: t.downloadSpeed, up: t.uploadSpeed, progress: file?.progress ?? 0, downloaded: t.downloaded });
  }

  async function readRange(f: WtFile, start: number, end: number, ms: number): Promise<Uint8Array> {
    const stream = f.createReadStream({ start, end });
    const timer = setTimeout(() => stream.destroy(new Error('timeout')), ms);
    try {
      const parts: Uint8Array[] = [];
      for await (const c of stream) parts.push(c);
      return Buffer.concat(parts);
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }
  }

  // What the subtitle search needs to know about the played file; the hash is null when the ends
  // of the file did not arrive in time
  async function fileFacts(infoHash: string, fileIdx: number, ms = 20000): Promise<{ name: string; size: number; hash: string | null } | null> {
    const file = fileOf(torrents.get(infoHash), fileIdx);
    if (!file) return null;
    let hash: string | null = null;
    if (file.length >= HASH_CHUNK) {
      try {
        const [head, tail] = await Promise.all([
          readRange(file, 0, HASH_CHUNK - 1, ms),
          readRange(file, file.length - HASH_CHUNK, file.length - 1, ms)
        ]);
        hash = openSubtitlesHash(head, tail, file.length);
      } catch { /* the name has to do */ }
    }
    return { name: file.name, size: file.length, hash };
  }

  // ─── Subtitles inside the file ─────────────────────────────────────────────

  const HEAD_BYTES = 2 * 1024 * 1024;
  const MATROSKA = /\.(mkv|mka|webm)$/i;

  // The text subtitle tracks a Matroska file holds, read from its start (and from where its seek head says the tracks
  // are, when something big sits in front of them). Empty for any other kind of file.
  function embeddedInfo(infoHash: string, fileIdx: number, ms: number) {
    const key = `${infoHash}:${fileIdx}`;
    let p = heads.get(key);
    if (!p) {
      p = (async () => {
        const file = fileOf(torrents.get(infoHash), fileIdx);
        if (!file || !MATROSKA.test(file.name) || file.length < 1024) return null;
        const head = parseHead(await readRange(file, 0, Math.min(file.length, HEAD_BYTES) - 1, ms));
        if (!head) return null;
        let all = head.tracks;
        if (!all && head.tracksPos !== null && head.tracksPos < file.length) {
          const at = head.tracksPos;
          all = parseTracksAt(await readRange(file, at, Math.min(file.length, at + 512 * 1024) - 1, ms));
        }
        const tracks = textTracks(all ?? []);
        return { head, tracks, codecs: new Map(tracks.map(t => [t.number, t.codec] as [number, string])) };
      })().catch(() => { heads.delete(key); return null; });
      heads.set(key, p);
    }
    return p;
  }

  async function embeddedTracks(infoHash: string, fileIdx: number, ms = 15000): Promise<EmbeddedTrack[]> {
    return (await embeddedInfo(infoHash, fileIdx, ms))?.tracks ?? [];
  }

  // Reads the whole file for the blocks of its subtitle tracks and hands them over in batches. It starts at the
  // cluster of `startMs` (so what is about to be watched comes first) and then goes back for what is before it.
  // The file is read like the player reads it: pieces nobody has are asked for.
  function embeddedScan(infoHash: string, fileIdx: number, startMs: number, onBatch: (b: { cues: EmbeddedCue[]; progress: number; done: boolean; error?: string }) => void): void {
    const key = `${infoHash}:${fileIdx}`;
    scans.get(key)?.cancel();
    let cancelled = false;
    const handle = { cancel: () => { cancelled = true; } };
    scans.set(key, handle);
    void (async () => {
      try {
        const info = await embeddedInfo(infoHash, fileIdx, 20000);
        const file = fileOf(torrents.get(infoHash), fileIdx);
        if (!info || !file || !info.tracks.length) return onBatch({ cues: [], progress: 1, done: true });
        const { head, codecs } = info;
        const first = head.firstCluster ?? head.segStart;
        let from = first;
        if (startMs > 0 && head.cuesPos !== null && head.cuesPos < file.length) {
          const at = head.cuesPos;
          const points = parseCuesAt(await readRange(file, at, Math.min(file.length, at + 1024 * 1024) - 1, 20000), head.scale);
          const hit = points.filter(c => c.timeMs <= startMs).pop();
          if (hit) from = Math.max(first, head.segStart + hit.cluster);
        }
        // From the cluster at the start position to the end; then from the beginning up to it
        const passes = from > first ? [{ start: from, end: file.length - 1, stopAt: undefined as number | undefined }, { start: first, end: from - 1, stopAt: from }]
          : [{ start: first, end: file.length - 1, stopAt: undefined as number | undefined }];
        const total = passes.reduce((n, x) => n + (x.end - x.start + 1), 0);
        let read = 0, pending: EmbeddedCue[] = [], last = Date.now();
        const flush = (done: boolean) => { onBatch({ cues: pending, progress: done ? 1 : Math.min(0.999, read / total), done }); pending = []; last = Date.now(); };
        for (const pass of passes) {
          const scanner = new SubScanner(codecs, head.scale, pass.start, pass.stopAt);
          const stream = file.createReadStream({ start: pass.start, end: pass.end });
          try {
            for await (const chunk of stream) {
              if (cancelled) return;
              read += chunk.length;
              pending.push(...scanner.push(chunk));
              if (scanner.finished) break;
              if (Date.now() - last > 500) flush(false);
            }
          } finally {
            stream.destroy();
          }
        }
        if (!cancelled) flush(true);
      } catch (e) {
        if (!cancelled) onBatch({ cues: [], progress: 0, done: true, error: (e as Error).message });
      } finally {
        if (scans.get(key) === handle) scans.delete(key);
      }
    })();
  }

  function embeddedStop(infoHash: string, fileIdx: number) {
    const key = `${infoHash}:${fileIdx}`;
    scans.get(key)?.cancel();
    scans.delete(key);
  }

  function stop(infoHash: string, owner: object) {
    const entry = torrents.get(infoHash);
    if (!entry) return;
    entry.owners.delete(owner);
    if (!entry.owners.size) drop(entry);
  }

  // Whoever asked for these torrents is gone
  function release(owner: object) {
    for (const entry of new Set(torrents.values())) {
      entry.owners.delete(owner);
      if (!entry.owners.size) drop(entry);
    }
  }

  async function shutdown() {
    const client = clientP ? await clientP.catch(() => null) : null;
    const server = serverP ? await serverP.catch(() => null) : null;
    await opts.transcoder?.shutdown().catch(() => {});
    server?.srv.close();
    server?.srv.closeAllConnections();
    torrents.clear();
    await new Promise<void>(res => (client ? client.destroy(res) : res()));
    await fs.rm(opts.root, { recursive: true, force: true });
  }

  return { inspect, play, probe, stats, fileFacts, embeddedTracks, embeddedScan, embeddedStop, stop, release, shutdown, isVideoName };
}

export type TorrentEngine = ReturnType<typeof createTorrentEngine>;
