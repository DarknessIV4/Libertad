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
  infoHash: string; name: string; ready: boolean; private?: boolean; files: WtFile[]; announce: string[];
  numPeers: number; downloadSpeed: number; uploadSpeed: number; downloaded: number;
  once(ev: string, fn: (...a: any[]) => void): void;
  destroy(opts?: { destroyStore?: boolean }): void;
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
}

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

interface Entry { t: WtTorrent; owners: Set<object>; ready: Promise<void> }

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
      const client = new Ctor({ maxConns: 80 });
      client.on('error', () => {}); // a failed torrent reports itself to whoever waits for it
      return client;
    })();
    return clientP;
  }

  function drop(entry: Entry, keepFiles = false) {
    for (const [k, scan] of scans) if (k.startsWith(`${entry.t.infoHash}:`)) { scan.cancel(); scans.delete(k); }
    for (const k of heads.keys()) if (k.startsWith(`${entry.t.infoHash}:`)) heads.delete(k);
    for (const [k, v] of torrents) if (v === entry) torrents.delete(k);
    try { entry.t.destroy({ destroyStore: !keepFiles }); } catch { /* already gone */ }
  }

  // Waits for the torrent's metadata. Fails, and forgets the torrent, when nobody answers in time
  // or when it is a private torrent.
  function track(t: WtTorrent, known: string | null, owner: object): Entry {
    const entry: Entry = { t, owners: new Set([owner]), ready: Promise.resolve() };
    entry.ready = new Promise<void>((resolve, reject) => {
      const fail = (e: Error) => {
        clearTimeout(timer);
        // A duplicate is a torrent that is already here: its files are the ones in use
        drop(entry, /duplicate torrent/i.test(e.message));
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error('Nobody sharing this torrent could be found. It may be dead, or the link is wrong.')), timeoutMs);
      t.once('ready', () => {
        clearTimeout(timer);
        if (t.private) fail(new Error(PRIVATE)); else resolve();
      });
      t.once('error', (e: Error) => fail(e));
    });
    entry.ready.catch(() => {});
    if (known) torrents.set(known, entry);
    else entry.ready.then(() => { torrents.set(t.infoHash, entry); }, () => {});
    return entry;
  }

  const addOpts = () => ({ path: opts.root, deselect: true });

  function describe(entry: Entry): TorrentInfo {
    const t = entry.t;
    const files = t.files.map((f, index) => ({ index, name: f.path || f.name, length: f.length }));
    return {
      infoHash: t.infoHash,
      name: t.name,
      magnet: buildMagnet(t.infoHash, t.name, t.announce),
      files,
      defaultIndex: pickDefaultFile(files)
    };
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
      else entry = track(client.add(magnet, addOpts()), hash, owner);
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
    const m = /^\/([0-9a-f]{36})\/([0-9a-f]{40})\/(\d{1,5})$/.exec((req.url ?? '').split('?')[0]);
    if (!m || m[1] !== token) return fail(404);
    const file = torrents.get(m[2])?.t.files[Number(m[3])];
    if (!file) return fail(404);

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
  async function play(meta: { magnet: string; fileIdx: number }, owner: object): Promise<TorrentPlay> {
    const client = await getClient();
    const parsed = parseMagnet(meta.magnet);
    if (!parsed) throw new Error('That is not a magnet link');
    let entry = torrents.get(parsed.infoHash);
    if (entry) entry.owners.add(owner);
    else entry = track(client.add(buildMagnet(parsed.infoHash, parsed.name, parsed.trackers), addOpts()), parsed.infoHash, owner);
    await entry.ready;
    const file = entry.t.files[meta.fileIdx];
    if (!file) throw new Error('That file is not in this torrent');
    file.select();
    const srv = await ensureServer();
    return { url: `http://127.0.0.1:${srv.port}/${srv.token}/${parsed.infoHash}/${meta.fileIdx}`, fileName: file.name, length: file.length };
  }

  function stats(infoHash: string, fileIdx: number): TorrentStats {
    const entry = torrents.get(infoHash);
    if (!entry) return { ready: false, peers: 0, down: 0, up: 0, progress: 0, downloaded: 0 };
    const t = entry.t, file = t.files[fileIdx];
    return { ready: t.ready, peers: t.numPeers, down: t.downloadSpeed, up: t.uploadSpeed, progress: file?.progress ?? 0, downloaded: t.downloaded };
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
    const file = torrents.get(infoHash)?.t.files[fileIdx];
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
        const file = torrents.get(infoHash)?.t.files[fileIdx];
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
        const file = torrents.get(infoHash)?.t.files[fileIdx];
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
    server?.srv.close();
    server?.srv.closeAllConnections();
    torrents.clear();
    await new Promise<void>(res => (client ? client.destroy(res) : res()));
    await fs.rm(opts.root, { recursive: true, force: true });
  }

  return { inspect, play, stats, fileFacts, embeddedTracks, embeddedScan, embeddedStop, stop, release, shutdown, isVideoName };
}

export type TorrentEngine = ReturnType<typeof createTorrentEngine>;
