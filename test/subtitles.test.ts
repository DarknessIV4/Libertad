import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readQuery, decodeSubtitle, normLang, openSubtitlesHash, parseReleaseName, parseSubtitles, pickSubtitle, preferredLangs, subtitlesPath } from '../src/core/subtitles.ts';

test('the OpenSubtitles hash: size plus the 64-bit words of both ends', () => {
  assert.equal(openSubtitlesHash(new Uint8Array(65536), new Uint8Array(65536), 200000), '0000000000030d40');
  const file = Uint8Array.from({ length: 300000 }, (_, i) => (i * 7 + (i >> 5)) & 255);
  let h = BigInt(file.length);
  const dv = new DataView(file.buffer);
  for (const from of [0, file.length - 65536]) for (let i = 0; i < 65536; i += 8) h = (h + dv.getBigUint64(from + i, true)) & 0xffffffffffffffffn;
  assert.equal(openSubtitlesHash(file.subarray(0, 65536), file.subarray(-65536), file.length), h.toString(16).padStart(16, '0'));
  assert.equal(openSubtitlesHash(new Uint8Array(10), new Uint8Array(10), 10), null, 'too small to have one');
});

test('release names give a title, a year, and an episode', () => {
  assert.deepEqual(parseReleaseName('The.Matrix.1999.1080p.BluRay.x264-GRP.mkv'), { title: 'The Matrix', year: 1999 });
  assert.deepEqual(parseReleaseName('Breaking.Bad.S02E05.720p.HDTV.x264.mkv'), { title: 'Breaking Bad', season: 2, episode: 5 });
  assert.deepEqual(parseReleaseName('2012.2009.1080p.BluRay.mkv'), { title: '2012', year: 2009 });
  assert.deepEqual(parseReleaseName('Show.1x07.avi'), { title: 'Show', season: 1, episode: 7 });
  assert.equal(parseReleaseName('Movie Name (2010) 720p.mp4').title, 'Movie Name');
  assert.deepEqual(parseReleaseName('[Group] Show Name - 03 [1080p].mkv'), { title: 'Show Name', season: 1, episode: 3 });
  assert.deepEqual(parseReleaseName('[SubsPlease] Sousou no Frieren - 12v2 (1080p) [ABCD1234].mkv'), { title: 'Sousou no Frieren', season: 1, episode: 12 });
  assert.equal(parseReleaseName('Blade Runner - 2049 1080p.mkv').episode, undefined, 'a year is not an episode');
  assert.equal(parseReleaseName('Some Film.mkv').title, 'Some Film');
});

test('the addon is asked with the hash, the size and the name', () => {
  assert.equal(subtitlesPath('movie', 'tt0133093', { hash: 'abc', size: 5, filename: 'a b.mkv' }), '/subtitles/movie/tt0133093/videoHash=abc&videoSize=5&filename=a%20b.mkv.json');
  assert.equal(subtitlesPath('series', 'tt1:2:5', {}), '/subtitles/series/tt1%3A2%3A5.json');
});

test('languages: any spelling, the person\'s first', () => {
  assert.equal(normLang('en'), 'eng');
  assert.equal(normLang('EN-us'), 'eng');
  assert.equal(normLang('fra'), 'fre');
  assert.equal(normLang('ar'), 'ara');
  assert.deepEqual(preferredLangs(['ar-EG', 'en-US'], ''), ['ara', 'eng']);
  assert.deepEqual(preferredLangs(['en-US'], 'fr'), ['fre', 'eng']);
  assert.deepEqual(preferredLangs(['en-US'], 'off'), ['eng']);
  const subs = [{ id: '1', url: 'u1', lang: 'fre' }, { id: '2', url: 'u2', lang: 'ara' }];
  assert.equal(pickSubtitle(subs, ['eng', 'ara'])?.id, '2');
  assert.equal(pickSubtitle(subs, ['jpn']), null);
});

test('subtitle files: byte order marks, UTF-8, and the old code page of the language', () => {
  assert.equal(decodeSubtitle(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi');
  assert.equal(decodeSubtitle(Uint8Array.from([0xff, 0xfe, 0x68, 0x00])), 'h');
  assert.equal(decodeSubtitle(new TextEncoder().encode('مرحبا')), 'مرحبا');
  assert.equal(decodeSubtitle(Uint8Array.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]), 'ara'), 'مرحبا');
  assert.equal(decodeSubtitle(Uint8Array.from([0xe9]), 'fr'), 'é');
  assert.equal(decodeSubtitle(Uint8Array.from([0xcf, 0xf0, 0xe8]), 'rus'), 'При');
});

test('SubRip and WebVTT are read; markup other than bold, italic and underline is dropped', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> {\\an8}there\r\n\r\n2\r\n00:01:02.000 --> 00:01:03.000\r\n<font color="red">Hi</font>\r\nsecond line\r\n\r\n3\r\n00:00:09,000 --> 00:00:08,000\r\nbackwards\r\n';
  assert.deepEqual(parseSubtitles(srt), [
    { start: 1000, end: 2500, text: '<i>Hello</i> there' },
    { start: 62000, end: 63000, text: 'Hi\nsecond line' }
  ]);
  const vtt = 'WEBVTT\n\nNOTE a comment\n\ncue1\n00:01.500 --> 00:03.000 align:start\nText\n\n01:00:00.000 --> 01:00:01.000\nLate';
  assert.deepEqual(parseSubtitles(vtt), [{ start: 1500, end: 3000, text: 'Text' }, { start: 3600000, end: 3601000, text: 'Late' }]);
  assert.deepEqual(parseSubtitles('garbage'), []);
});

test('the search box: ids, titles, and an episode typed or taken from the file', () => {
  const file = parseReleaseName('[SubsPlease] Toukutsu Ou - 06 (1080p) [A29A8F89].mkv');
  const movie = parseReleaseName('Some.Movie.2010.1080p.mkv');
  // A title alone: the episode is the file's
  assert.deepEqual(readQuery('Cave King', file), { rel: { title: 'Cave King', season: 1, episode: 6 }, imdb: null, kitsu: null });
  // An episode typed wins over the file's
  assert.equal(readQuery('Frieren S01E12', file).rel.episode, 12);
  assert.equal(readQuery('Frieren S01E12', file).rel.title, 'Frieren');
  assert.deepEqual(readQuery('Show Name - 07', file).rel, { title: 'Show Name', season: 1, episode: 7 });
  assert.deepEqual(readQuery('Show Name 7', file).rel, { title: 'Show Name', season: 1, episode: 7 });
  assert.deepEqual(readQuery('Show Name ep 8', file).rel, { title: 'Show Name', season: 1, episode: 8 });
  assert.deepEqual(readQuery('Show 1x09', file).rel.episode, 9);
  // Ids
  assert.deepEqual(readQuery('tt1234567 S02E03', file), { rel: { title: '', season: 2, episode: 3 }, imdb: 'tt1234567', kitsu: null });
  assert.deepEqual(readQuery('tt1234567', file).rel, { title: '', season: 1, episode: 6 });
  assert.deepEqual(readQuery('kitsu:46474 6', movie), { rel: { title: '', season: 1, episode: 6 }, imdb: null, kitsu: '46474' });
  assert.deepEqual(readQuery('kitsu:46474:6', movie).rel.episode, 6);
  assert.equal(readQuery('KITSU:46474:6', movie).kitsu, '46474');
  // A year is not an episode, and a movie file has no episode to hand over
  assert.deepEqual(readQuery('Some Movie 2010', movie).rel, { title: 'Some Movie', year: 2010 });
  assert.equal(readQuery('Some Movie', movie).rel.episode, undefined);
});
