import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTorrentEngine, type WtConstructor, type WtFile } from '../electron/torrent-core.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SubScanner, assText, parseCuesAt, parseHead, parseTracksAt, textTracks, type EmbeddedCue } from '../src/core/mkv.ts';

// A small Matroska file, built by hand
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const idBytes = (id: number) => { const o: number[] = []; for (let v = id; v > 0; v = Math.floor(v / 256)) o.unshift(v % 256); return Uint8Array.from(o); };
const size = (n: number) => { for (let len = 1; len <= 8; len++) if (n < 2 ** (7 * len) - 1) { const o = new Uint8Array(len); let v = n; for (let i = len - 1; i >= 0; i--) { o[i] = v % 256; v = Math.floor(v / 256); } o[0] |= 0x80 >> (len - 1); return o; } throw new Error('too big'); };
const el = (id: number, ...p: Uint8Array[]) => { const body = cat(...p); return cat(idBytes(id), size(body.length), body); };
const num = (id: number, v: number) => el(id, Uint8Array.from(v > 255 ? [v >> 8, v & 255] : [v]));
const str = (id: number, s: string) => el(id, new TextEncoder().encode(s));
const block = (track: number, rel: number, data: Uint8Array) => cat(size(track), Uint8Array.from([(rel >> 8) & 255, rel & 255, 0]), data);
const enc = (s: string) => new TextEncoder().encode(s);

const track = (n: number, type: number, codec: string, lang: string, name = '', extra: Uint8Array[] = []) =>
  el(0xae, num(0xd7, n), num(0x83, type), str(0x86, codec), str(0x22b59c, lang), ...(name ? [str(0x536e, name)] : []), ...extra);

const tracks = el(0x1654ae6b,
  track(1, 1, 'V_MPEG4/ISO/AVC', 'und'),
  track(2, 2, 'A_AAC', 'jpn'),
  track(3, 17, 'S_TEXT/UTF8', 'eng', 'Full'),
  track(4, 17, 'S_TEXT/ASS', 'jpn'),
  track(5, 17, 'S_HDMV/PGS', 'ger'),
  track(6, 17, 'S_TEXT/UTF8', 'fre', 'Zipped', [el(0x6d80, new Uint8Array(1))]));
const info = el(0x1549a966, el(0x2ad7b1, Uint8Array.from([0x0f, 0x42, 0x40])));  // 1,000,000: a tick is a millisecond

const cluster = (time: number, ...inner: Uint8Array[]) => el(0x1f43b675, num(0xe7, time), ...inner);
const group = (blk: Uint8Array, duration?: number) => el(0xa0, el(0xa1, blk), ...(duration ? [num(0x9b, duration)] : []));
const video = el(0xa3, block(1, 0, new Uint8Array(3000)));

const c1 = cluster(1000, video, group(block(3, 500, enc('Hello <i>there</i>')), 2000), group(block(4, 600, enc('0,0,Default,,0,0,0,,{\\i1}Konnichiwa{\\i0}\\Nworld')), 1500), group(block(5, 700, new Uint8Array(20))));
const c2 = cluster(5000, video, el(0xa3, block(3, -100, enc('Later'))));
const c3 = cluster(9000, group(block(3, 0, enc('Last')), 1000));

const seekEntry = (target: number, at: number) => el(0x4dbb, el(0x53ab, idBytes(target)), el(0x53ac, Uint8Array.from([at >> 8, at & 255])));
const cuePoint = (time: number, cluster: number) => el(0xbb, num(0xb3, time), el(0xb7, num(0xf7, 1), num(0xf1, cluster)));

function file() {
  const ebml = el(0x1a45dfa3, str(0x4282, 'matroska'));
  // the seek head has a fixed size, so the positions it holds can be worked out before it is built
  const seekLen = el(0x114d9b74, seekEntry(0x1654ae6b, 0), seekEntry(0x1c53bb6b, 0)).length;
  const tracksAt = seekLen + info.length;
  const c1At = tracksAt + tracks.length, c2At = c1At + c1.length, c3At = c2At + c2.length, cuesAt = c3At + c3.length;
  const seek = el(0x114d9b74, seekEntry(0x1654ae6b, tracksAt), seekEntry(0x1c53bb6b, cuesAt));
  const cues = el(0x1c53bb6b, cuePoint(0, c1At), cuePoint(5000, c2At), cuePoint(9000, c3At));
  const body = cat(seek, info, tracks, c1, c2, c3, cues);
  const segHeader = cat(idBytes(0x18538067), size(body.length));
  const all = cat(ebml, segHeader, body);
  const segStart = ebml.length + segHeader.length;
  return { all, segStart, firstCluster: segStart + c1At, tracksAt, cuesAt };
}

test('the head: segment, scale, tracks, first cluster', () => {
  const f = file();
  const head = parseHead(f.all)!;
  assert.equal(head.segStart, f.segStart);
  assert.equal(head.scale, 1_000_000);
  assert.equal(head.firstCluster, f.firstCluster);
  assert.equal(head.tracksPos, f.segStart + f.tracksAt);
  assert.equal(head.cuesPos, f.segStart + f.cuesAt);
  assert.deepEqual(head.tracks!.map(t => t.number), [1, 2, 3, 4, 5, 6]);
  assert.equal(parseHead(enc('not a matroska file at all')), null);
});

test('only text subtitle tracks are offered, with their language and name', () => {
  const list = textTracks(parseHead(file().all)!.tracks!);
  assert.deepEqual(list.map(t => [t.number, t.codec, t.lang, t.name]), [[3, 'S_TEXT/UTF8', 'eng', 'Full'], [4, 'S_TEXT/ASS', 'jpn', '']]);
});

test('the tracks are read from where the seek head points when the head is cut short', () => {
  const f = file();
  const cut = f.all.subarray(0, f.segStart + f.tracksAt - 3); // ends inside the info, after the seek head
  const head = parseHead(cut)!;
  assert.equal(head.tracks, null);
  assert.equal(head.tracksPos, f.segStart + f.tracksAt);
  assert.equal(parseTracksAt(f.all.subarray(head.tracksPos!))!.length, 6);
  assert.equal(parseTracksAt(f.all.subarray(head.tracksPos!, head.tracksPos! + 10)), null);
});

test('the scan finds the blocks of the wanted tracks, however the bytes arrive', () => {
  const f = file();
  const codecs = new Map([[3, 'S_TEXT/UTF8'], [4, 'S_TEXT/ASS']]);
  for (const step of [f.all.length, 1000, 7, 1]) {
    const scanner = new SubScanner(codecs, 1_000_000, f.firstCluster);
    const got: EmbeddedCue[] = [];
    for (let i = f.firstCluster; i < f.all.length; i += step) got.push(...scanner.push(f.all.subarray(i, Math.min(f.all.length, i + step))));
    assert.deepEqual(got.map(c => [c.track, c.start, c.end, c.text]), [
      [3, 1500, 3500, 'Hello <i>there</i>'],
      [4, 1600, 3100, '<i>Konnichiwa</i>\nworld'],
      [3, 4900, 8900, 'Later'],  // a block without a duration lasts a few seconds; its time is before the cluster's by 100 ms
      [3, 9000, 10000, 'Last']
    ], `in pieces of ${step}`);
  }
});

test('the scan stops where it is told to, and can start in the middle', () => {
  const f = file();
  const codecs = new Map([[3, 'S_TEXT/UTF8'], [4, 'S_TEXT/ASS']]);
  const second = f.firstCluster + c1.length;
  const third = second + c2.length;
  const run = (from: number, stopAt?: number) => {
    const s = new SubScanner(codecs, 1_000_000, from, stopAt);
    return s.push(f.all.subarray(from)).map(c => c.text);
  };
  assert.deepEqual(run(second), ['Later', 'Last']);
  assert.deepEqual(run(f.firstCluster, second), ['Hello <i>there</i>', '<i>Konnichiwa</i>\nworld']);
  assert.deepEqual(run(f.firstCluster, third), ['Hello <i>there</i>', '<i>Konnichiwa</i>\nworld', 'Later']);
});

test('the index of the file: which cluster holds which time', () => {
  const cue = (time: number, cluster: number) => el(0xbb, num(0xb3, time), el(0xb7, num(0xf7, 1), num(0xf1, cluster)));
  const cues = el(0x1c53bb6b, cue(0, 100), cue(5000, 20000));
  assert.deepEqual(parseCuesAt(cues, 1_000_000), [{ timeMs: 0, cluster: 100 }, { timeMs: 5000, cluster: 20000 }]);
  assert.deepEqual(parseCuesAt(cues.subarray(0, cues.length - 3), 1_000_000), [{ timeMs: 0, cluster: 100 }], 'what arrived is used');
});

test('ASS lines: text only, no drawings, line breaks', () => {
  assert.equal(assText('12,0,Default,,0,0,0,,Hello\\Nthere'), 'Hello\nthere');
  assert.equal(assText('1,0,Sign,,0,0,0,,{\\pos(1,2)\\b1}Bold{\\b0} text'), '<b>Bold</b> text');
  assert.equal(assText('1,0,Sign,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}'), '');
  assert.equal(assText('not an ass line'), '');
  assert.equal(assText('1,0,Default,,0,0,0,,a, b, c'), 'a, b, c', 'commas in the text stay');
});

// The engine, with a torrent that is only a file in memory
async function withEngine<T>(name: string, bytes: Uint8Array, run: (engine: ReturnType<typeof createTorrentEngine>, hash: string) => Promise<T>): Promise<T> {
  const H = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
  const root = mkdtempSync(path.join(tmpdir(), 'mkv-test-'));
  const readFrom: WtFile['createReadStream'] = (o = {}) => {
    const start = o.start ?? 0, end = Math.min(o.end ?? bytes.length - 1, bytes.length - 1);
    return { destroy() {}, async *[Symbol.asyncIterator]() { for (let i = start; i <= end; i += 97) yield bytes.subarray(i, Math.min(end + 1, i + 97)); } } as ReturnType<WtFile['createReadStream']>;
  };
  const Fake = class {
    on() {}
    add() {
      const t = { infoHash: H, name, ready: true, files: [{ name, path: name, length: bytes.length, progress: 1, select() {}, createReadStream: readFrom }], announce: [], numPeers: 0, downloadSpeed: 0, uploadSpeed: 0, downloaded: 0,
        once(ev: string, fn: () => void) { if (ev === 'ready') setTimeout(fn, 0); }, destroy() {} };
      return t;
    }
    destroy(cb?: () => void) { cb?.(); }
  } as unknown as WtConstructor;
  const engine = createTorrentEngine({ root, loadClient: async () => Fake });
  try {
    await engine.play({ magnet: `magnet:?xt=urn:btih:${H}`, fileIdx: 0 }, {});
    return await run(engine, H);
  } finally {
    await engine.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}

const scanAll = (engine: ReturnType<typeof createTorrentEngine>, hash: string, startMs: number) => new Promise<EmbeddedCue[]>((resolve, reject) => {
  const got: EmbeddedCue[] = [];
  engine.embeddedScan(hash, 0, startMs, b => { got.push(...b.cues); if (b.error) reject(new Error(b.error)); else if (b.done) resolve(got); });
});

test('the engine lists the embedded tracks of a Matroska file, and none for another kind', async () => {
  await withEngine('movie.mkv', file().all, async (engine, hash) => {
    assert.deepEqual((await engine.embeddedTracks(hash, 0)).map(t => t.lang), ['eng', 'jpn']);
  });
  await withEngine('movie.mp4', file().all, async (engine, hash) => {
    assert.deepEqual(await engine.embeddedTracks(hash, 0), []);
  });
});

test('the engine scan reads the file from the start position, then goes back for the beginning', async () => {
  await withEngine('movie.mkv', file().all, async (engine, hash) => {
    assert.deepEqual((await scanAll(engine, hash, 0)).map(c => c.text), ['Hello <i>there</i>', '<i>Konnichiwa</i>\nworld', 'Later', 'Last']);
    assert.deepEqual((await scanAll(engine, hash, 6000)).map(c => c.text), ['Later', 'Last', 'Hello <i>there</i>', '<i>Konnichiwa</i>\nworld']);
  });
});
