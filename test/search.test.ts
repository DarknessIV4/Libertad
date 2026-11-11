import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PROVIDERS_CONFIG, TORRENTIO_PROVIDERS, mergeTitles, parseCinemeta, parseKitsu, readStats, streamRequest, streamsToFound } from '../src/core/search.ts';

const H1 = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const H2 = 'd0072a83c810c0e18f157ad067948f3f03fc8307';

test('every Torrentio provider is asked for by name', () => {
  assert.equal(TORRENTIO_PROVIDERS.length, 28);
  assert.ok(ALL_PROVIDERS_CONFIG.startsWith('providers=yts,eztv,'));
  assert.ok(ALL_PROVIDERS_CONFIG.includes(',nyaasi,') && ALL_PROVIDERS_CONFIG.endsWith(',besttorrents'));
});

test('Cinemeta results: only real IMDb ids, https posters', () => {
  const r = parseCinemeta({ metas: [
    { id: 'tt0903747', imdb_id: 'tt0903747', name: 'Breaking Bad', releaseInfo: '2008–2013', poster: 'https://img.example/p.jpg', description: 'A  teacher\nturns bad' },
    { id: 'kitsu:1', name: 'Not imdb' },
    { id: 'tt1', name: '', poster: 'http://x' },
    { id: 'tt0111161', name: 'The Shawshank Redemption', poster: 'javascript:alert(1)' }
  ] }, 'series');
  assert.deepEqual(r.map(x => x.id), ['tt0903747', 'tt0111161']);
  assert.equal(r[0].poster, 'https://img.example/p.jpg');
  assert.equal(r[0].blurb, 'A teacher turns bad');
  assert.equal(r[1].poster, null);
  assert.deepEqual(parseCinemeta(null, 'movie'), []);
  assert.deepEqual(parseCinemeta({ metas: 'x' }, 'movie'), []);
});

test('Kitsu results: the English name, a film is a movie', () => {
  const r = parseKitsu({ data: [
    { id: '1', attributes: { canonicalTitle: 'Cowboy Bebop', titles: { en: 'Cowboy Bebop' }, startDate: '1998-04-03', subtype: 'TV', posterImage: { small: 'https://k.example/a.jpg' } } },
    { id: '2', attributes: { canonicalTitle: 'Sen to Chihiro', titles: { en: 'Spirited Away' }, startDate: '2001-07-20', subtype: 'movie' } },
    { id: 'abc', attributes: { canonicalTitle: 'bad id' } }
  ] });
  assert.deepEqual(r.map(x => [x.id, x.type, x.name, x.year]), [['1', 'series', 'Cowboy Bebop', '1998'], ['2', 'movie', 'Spirited Away', '2001']]);
});

test('the same title from two sources is listed once', () => {
  const a = parseCinemeta({ metas: [{ id: 'tt1', name: 'Cowboy Bebop', releaseInfo: '1998' }] }, 'series');
  const b = parseKitsu({ data: [{ id: '1', attributes: { titles: { en: 'Cowboy Bebop' }, startDate: '1998-04-03' } }] });
  assert.equal(mergeTitles(a, b).length, 1);
  assert.equal(mergeTitles(a, b)[0].source, 'imdb');
});

test('what Torrentio is asked for', () => {
  assert.deepEqual(streamRequest({ source: 'imdb', id: 'tt1', type: 'movie' }, 1, 1), { type: 'movie', id: 'tt1' });
  assert.deepEqual(streamRequest({ source: 'imdb', id: 'tt1', type: 'series' }, 2, 7), { type: 'series', id: 'tt1:2:7' });
  assert.deepEqual(streamRequest({ source: 'kitsu', id: '42', type: 'series' }, 1, 8), { type: 'series', id: 'kitsu:42:8' });
  assert.deepEqual(streamRequest({ source: 'kitsu', id: '42', type: 'movie' }, 1, 1), { type: 'movie', id: 'kitsu:42' });
  assert.deepEqual(streamRequest({ source: 'imdb', id: 'tt1', type: 'series' }, -3, 0), { type: 'series', id: 'tt1:1:1' });
});

test('Torrentio stats line', () => {
  assert.deepEqual(readStats('Some.Movie.2020\n👤 12 💾 1.5 GB ⚙️ ThePirateBay\n🇬🇧'), { seeders: 12, size: Math.floor(1.5 * 1073741824), provider: 'ThePirateBay' });
  assert.deepEqual(readStats('nothing here'), { seeders: 0, size: 0, provider: '' });
});

test('streams become a seeded list of torrents, each once', () => {
  const found = streamsToFound([
    { name: 'Torrentio\n720p', title: 'Movie.720p\n👤 3 💾 900 MB ⚙️ YTS', infoHash: H1 },
    { name: 'Torrentio\n1080p', title: 'Movie.1080p\n👤 50 💾 2.1 GB ⚙️ 1337x\n🇬🇧 / 🇫🇷', infoHash: H2, fileIdx: 4, sources: ['tracker:udp://t.example:1'] },
    { name: 'Torrentio\n1080p', title: 'Movie.1080p again\n👤 9 💾 2.1 GB ⚙️ EZTV', infoHash: H2.toUpperCase() },
    { name: 'RD+ 1080p', title: 'a debrid link' },  // no info hash: a debrid link
    { name: 'bad', title: 'x', infoHash: 'nothex' }
  ]);
  assert.deepEqual(found.map(f => f.provider), ['1337x', 'YTS']);
  assert.equal(found[0].quality, '1080p');
  assert.equal(found[0].torrent.fileIdx, 4);
  assert.equal(found[0].languages, '🇬🇧 / 🇫🇷');
  assert.ok(found[0].torrent.magnet.startsWith(`magnet:?xt=urn:btih:${H2}`));
});
