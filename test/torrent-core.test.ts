import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTorrentEngine, parseRange, type WtConstructor } from '../electron/torrent-core.ts';
import { openSubtitlesHash } from '../src/core/subtitles.ts';

test('a range header: one range, from the start, from the end, or refused', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 }, 'the end is cut to the file');
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 }, 'the last 100 bytes');
  assert.equal(parseRange('bytes=1000-', 1000), 'bad');
  assert.equal(parseRange('bytes=5-2', 1000), 'bad');
  assert.equal(parseRange('bytes=0-1,5-9', 1000), 'bad', 'several ranges are not served');
  assert.equal(parseRange('items=0-1', 1000), 'bad');
  assert.equal(parseRange('bytes=-0', 1000), 'bad');
  assert.equal(parseRange('bytes=0-', 0), 'bad');
});

// WebTorrent ships no types
const spec = 'webtorrent';
const WebTorrent: any = (await import(spec)).default;

// Two real clients on this computer: one seeds a file, the engine downloads it from there
const flags = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false };

function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers }, res => {
      const parts: Buffer[] = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function swarm(privateTorrent = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'libertad-tt-'));
  const data = Buffer.from(Uint8Array.from({ length: 700_000 }, (_, i) => (i * 31 + (i >> 8)) & 255));
  const file = path.join(dir, 'Some.Movie.2020.1080p.mp4');
  writeFileSync(file, data);
  const seeder = new WebTorrent(flags);
  const seeded: any = await new Promise(res => seeder.seed(file, { private: privateTorrent, announce: [] }, res));
  class TestClient extends WebTorrent {
    constructor(o: object) { super({ ...o, ...flags }); }
    add(id: any, o: any) {
      const t = super.add(id, o);
      t.once('infoHash', () => t.addPeer(`127.0.0.1:${seeder.torrentPort}`));
      return t;
    }
  }
  const engine = createTorrentEngine({
    root: path.join(dir, 'dl'),
    loadClient: async () => TestClient as unknown as WtConstructor,
    metadataTimeoutMs: 15000
  });
  const owner = {};
  const done = async () => {
    await engine.shutdown();
    await new Promise<void>(res => seeder.destroy(() => res()));
    rmSync(dir, { recursive: true, force: true });
  };
  return { engine, owner, data, magnet: seeded.magnetURI as string, infoHash: seeded.infoHash as string, done };
}

test('a magnet link is looked up, played over local range requests, and cleaned up', { timeout: 60000 }, async () => {
  const s = await swarm();
  try {
    const info = await s.engine.inspect(s.magnet, s.owner);
    assert.equal(info.infoHash, s.infoHash);
    assert.equal(info.files.length, 1);
    assert.equal(info.files[0].length, s.data.length);
    assert.equal(info.defaultIndex, 0);
    assert.ok(info.magnet.startsWith(`magnet:?xt=urn:btih:${s.infoHash}`));

    const play = await s.engine.play({ magnet: info.magnet, fileIdx: 0 }, s.owner);
    assert.match(play.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{36}\/[0-9a-f]{40}\/0$/);
    assert.equal(play.length, s.data.length);

    // The whole file, then the middle of it, then the end: the bytes are the file's own
    const whole = await fetch(play.url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'video/mp4');
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), s.data);

    const mid = await fetch(play.url, { headers: { Range: 'bytes=1000-1999' } });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers.get('content-range'), `bytes 1000-1999/${s.data.length}`);
    assert.deepEqual(Buffer.from(await mid.arrayBuffer()), s.data.subarray(1000, 2000));

    const tail = await fetch(play.url, { headers: { Range: 'bytes=-500' } });
    assert.equal(tail.status, 206);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), s.data.subarray(s.data.length - 500));

    assert.equal((await fetch(play.url, { headers: { Range: `bytes=${s.data.length}-` } })).status, 416);
    assert.equal((await fetch(play.url, { method: 'HEAD' })).status, 200);

    // Not a valid token, not a file, not a name this computer answers to
    const base = new URL(play.url);
    assert.equal((await fetch(`${base.origin}/${'0'.repeat(36)}/${s.infoHash}/0`)).status, 404);
    assert.equal((await fetch(play.url.replace(/\/0$/, '/7'))).status, 404);
    assert.equal((await rawGet(play.url, { Host: 'evil.example' })).status, 403);

    const st = s.engine.stats(s.infoHash, 0);
    assert.equal(st.ready, true);
    assert.equal(st.progress, 1);

    // What the subtitle search is given: the file's name and its OpenSubtitles hash
    const facts = await s.engine.fileFacts(s.infoHash, 0);
    assert.equal(facts?.name, 'Some.Movie.2020.1080p.mp4');
    assert.equal(facts?.size, s.data.length);
    assert.equal(facts?.hash, openSubtitlesHash(s.data.subarray(0, 65536), s.data.subarray(s.data.length - 65536), s.data.length));

    // The last person to stop takes the torrent away: its address answers no more
    s.engine.stop(s.infoHash, s.owner);
    assert.equal((await fetch(play.url)).status, 404);
    assert.equal(s.engine.stats(s.infoHash, 0).ready, false);
  } finally {
    await s.done();
  }
});

test('a viewer joining plays from the magnet alone, and the torrent stays while somebody needs it', { timeout: 60000 }, async () => {
  const s = await swarm();
  try {
    const other = {};
    const a = await s.engine.play({ magnet: s.magnet, fileIdx: 0 }, s.owner);
    const b = await s.engine.play({ magnet: s.magnet, fileIdx: 0 }, other);
    assert.equal(a.url, b.url, 'one download for both');
    s.engine.stop(s.infoHash, s.owner);
    assert.equal((await fetch(b.url, { headers: { Range: 'bytes=0-9' } })).status, 206, 'the other still needs it');
    s.engine.release(other);
    assert.equal((await fetch(b.url)).status, 404);
  } finally {
    await s.done();
  }
});

test('a private torrent is refused, and a wrong file index too', { timeout: 60000 }, async () => {
  const priv = await swarm(true);
  try {
    await assert.rejects(priv.engine.inspect(priv.magnet, priv.owner), /private torrent/);
  } finally {
    await priv.done();
  }
  const s = await swarm();
  try {
    await assert.rejects(s.engine.play({ magnet: s.magnet, fileIdx: 3 }, s.owner), /not in this torrent/);
    await assert.rejects(s.engine.inspect('not a link', s.owner), /not a magnet link/);
  } finally {
    await s.done();
  }
});
