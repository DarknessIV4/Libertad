import { test } from 'node:test';
import assert from 'node:assert/strict';
import { btihToHex, buildMagnet, normalizeMagnet, parseMagnet, pickDefaultFile, validTorrentMeta, validTorrentQueue, MAX_QUEUE, parseEpisode, episodesFrom } from '../src/core/torrent-meta.ts';

const H = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';

test('info hashes: hex or base32, either case', () => {
  assert.equal(btihToHex(H.toUpperCase()), H);
  assert.equal(btihToHex('YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK'), H);
  assert.equal(btihToHex('nope'), null);
  assert.equal(btihToHex(H.slice(1)), null);
});

test('magnet links are read and rebuilt, keeping only a few safe trackers', () => {
  const trs = Array.from({ length: 12 }, (_, i) => `&tr=${encodeURIComponent(`udp://t${i}.example:80`)}`).join('');
  const p = parseMagnet(`magnet:?xt=urn:btih:${H}&dn=My%20Film${trs}&tr=${encodeURIComponent('file:///etc/passwd')}`)!;
  assert.equal(p.infoHash, H);
  assert.equal(p.name, 'My Film');
  assert.equal(p.trackers.length, 8);
  assert.ok(p.trackers.every(t => t.startsWith('udp://')));
  assert.equal(parseMagnet('https://example.com'), null);
  assert.equal(parseMagnet('magnet:?dn=x'), null);
  assert.equal(normalizeMagnet(H), `magnet:?xt=urn:btih:${H}`);
  assert.equal(normalizeMagnet('hello'), null);
  assert.equal(buildMagnet(H, 'a b', ['udp://x:1']), `magnet:?xt=urn:btih:${H}&dn=a%20b&tr=${encodeURIComponent('udp://x:1')}`);
});

test('a Torrentio magnet link: "tracker:" prefixes, a newline in the name, a bare hash as a tracker', () => {
  const link = 'magnet:?xt=urn:btih:d0072a83c810c0e18f157ad067948f3f03fc8307&dn=Torrentio%0A1080p&tr=tracker%3Audp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=tracker%3Ahttp%3A%2F%2Ftracker2.dler.org%3A80%2Fannounce&tr=d0072a83c810c0e18f157ad067948f3f03fc8307';
  const p = parseMagnet(link)!;
  assert.equal(p.infoHash, 'd0072a83c810c0e18f157ad067948f3f03fc8307');
  assert.deepEqual(p.trackers, ['udp://tracker.opentrackr.org:1337/announce', 'http://tracker2.dler.org:80/announce']);
  assert.ok(normalizeMagnet(link));
});

test('what another person sends is checked and rebuilt, never used as it came', () => {
  const good = { infoHash: H, magnet: `magnet:?xt=urn:btih:${H}&dn=Film&tr=${encodeURIComponent('udp://t:1')}&x.pe=1.2.3.4:5`, fileIdx: 2, name: 'Film', fileName: 'Film/film.mkv', size: 1234 };
  const ok = validTorrentMeta(good)!;
  assert.equal(ok.infoHash, H);
  assert.ok(!ok.magnet.includes('x.pe'), 'unknown parameters (a peer address) are dropped');
  assert.equal(validTorrentMeta({ ...good, infoHash: 'a'.repeat(40) }), null, 'hash and link must agree');
  assert.equal(validTorrentMeta({ ...good, fileIdx: -1 }), null);
  assert.equal(validTorrentMeta({ ...good, fileIdx: 1.5 }), null);
  assert.equal(validTorrentMeta({ ...good, size: -3 }), null);
  assert.equal(validTorrentMeta({ ...good, magnet: 'x'.repeat(3000) }), null);
  assert.equal(validTorrentMeta({ ...good, name: 5 }), null);
  assert.equal(validTorrentMeta(null), null);
  assert.equal(validTorrentMeta('magnet'), null);
});

test('the file played by default is the largest video', () => {
  assert.equal(pickDefaultFile([{ index: 0, name: 'a.nfo', length: 9e9 }, { index: 1, name: 'a.mkv', length: 100 }, { index: 2, name: 'b.mp4', length: 500 }]), 2);
  assert.equal(pickDefaultFile([{ index: 0, name: 'a.zip', length: 5 }, { index: 1, name: 'b.rar', length: 9 }]), 1);
});

test('a queue: a limited length, every one checked', () => {
  const item = (i: number) => ({ infoHash: H, magnet: buildMagnet(H, 'x', []), fileIdx: i, name: 'x', fileName: `f${i}.mkv`, size: 10 });
  assert.equal(validTorrentQueue(Array.from({ length: MAX_QUEUE }, (_, i) => item(i)))?.length, MAX_QUEUE);
  assert.equal(validTorrentQueue(Array.from({ length: MAX_QUEUE + 1 }, (_, i) => item(i))), null, 'one too many');
  assert.equal(validTorrentQueue([]), null);
  assert.equal(validTorrentQueue('nope'), null);
  assert.equal(validTorrentQueue([item(0), { ...item(1), infoHash: 'a'.repeat(40) }]), null, 'one bad link spoils the queue');
});

test('episode numbers are read from file names', () => {
  assert.deepEqual(parseEpisode('Show.S02E07.1080p.mkv') && [parseEpisode('Show.S02E07.1080p.mkv')!.season, parseEpisode('Show.S02E07.1080p.mkv')!.episode], [2, 7]);
  assert.equal(parseEpisode('Show 3x05 Title.mp4')?.episode, 5);
  assert.equal(parseEpisode('Show Episode 12.mkv')?.episode, 12);
  assert.equal(parseEpisode('[Grp] Show - 05 [1080p].mkv')?.episode, 5);
  assert.equal(parseEpisode('Some.Movie.2019.1080p.mkv'), null);
  assert.equal(parseEpisode('Show.S01E02.mkv')?.group, parseEpisode('Show.S01E09.Other.Title.mkv')?.group);
  assert.notEqual(parseEpisode('Show.S01E02.mkv')?.group, parseEpisode('Show.S02E02.mkv')?.group);
});

test('the episodes after the chosen one are found in the same torrent', () => {
  const names = ['Show.S01E03.mkv', 'Show.S01E01.mkv', 'Show.S01E02.mkv', 'Show.S01E04.mkv', 'Show.S02E01.mkv', 'Show.S01E04.sample.mkv', 'Other.S01E05.mkv', 'notes.txt'];
  const files = names.map((name, index) => ({ index, name, length: 1000 }));
  assert.deepEqual(episodesFrom(files, 1).map(f => f.name), ['Show.S01E01.mkv', 'Show.S01E02.mkv', 'Show.S01E03.mkv', 'Show.S01E04.mkv']);
  assert.deepEqual(episodesFrom(files, 2).map(f => f.name), ['Show.S01E02.mkv', 'Show.S01E03.mkv', 'Show.S01E04.mkv'], 'from E02 on, not E01');
  assert.deepEqual(episodesFrom(files, 3).map(f => f.name), ['Show.S01E04.mkv'], 'the last one has none after it');
  assert.deepEqual(episodesFrom(files, 7).map(f => f.name), ['notes.txt'], 'no episode number: only the file itself');
});

import { pickStream, releaseTraits, streamToMeta, scoreStream } from '../src/core/episodes.ts';

test('the release the person chose is what the next episodes are picked in', () => {
  assert.deepEqual(releaseTraits('[SubsPlease] Toukutsu Ou - 07 (1080p) [93C2C269].mkv'), { group: 'subsplease', resolution: 1080 });
  assert.deepEqual(releaseTraits('Show.S01E07.720p.WEB-DL.x264-GRP.mkv'), { group: 'grp', resolution: 720 });
  const mk = (title: string, hash: string) => ({ infoHash: hash.repeat(40).slice(0, 40), title, name: `Torrentio\n${/(\d{3,4}p)/.exec(title)![1]}` });
  const streams = [
    mk('[Other] Toukutsu Ou - 08 (1080p).mkv\n👤 900', 'a'),
    mk('[SubsPlease] Toukutsu Ou - 08 (720p).mkv\n👤 50', 'b'),
    mk('[SubsPlease] Toukutsu Ou - 08 (1080p).mkv\n👤 40', 'c'),
    { title: 'debrid only', name: 'x', url: 'https://x' } as any
  ];
  const want = releaseTraits('[SubsPlease] Toukutsu Ou - 07 (1080p) [93C2C269].mkv');
  assert.equal(pickStream(streams, want)?.infoHash, 'c'.repeat(40));
  assert.ok(scoreStream(streams[2], want) > scoreStream(streams[0], want));
  assert.equal(pickStream([{ title: 'no hash' }], want), null);
});

test('a stream becomes a checked torrent to share', () => {
  const m = streamToMeta({
    infoHash: H.toUpperCase(), fileIdx: 3, title: 'Show.S01E08.mkv\n👤 12',
    sources: ['tracker:udp://tracker.example.org:1337/announce', 'dht:' + H],
    behaviorHints: { filename: 'Show.S01E08.mkv', videoSize: 1234567 }
  })!;
  assert.equal(m.infoHash, H);
  assert.equal(m.fileIdx, 3);
  assert.equal(m.fileName, 'Show.S01E08.mkv');
  assert.equal(m.size, 1234567);
  assert.ok(m.magnet.includes('tr=udp%3A%2F%2Ftracker.example.org%3A1337%2Fannounce'));
  assert.equal(streamToMeta({ infoHash: 'nope' }), null);
  assert.equal(streamToMeta({ infoHash: H })?.fileIdx, 0, 'a single-file torrent has no file number');
});
