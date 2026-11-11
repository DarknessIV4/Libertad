import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractInitialData, parseYoutubeResults, youtubeSearchUrl } from '../src/core/youtube-search.ts';

const video = (id: string, title: string, extra: object = {}) => ({
  videoRenderer: {
    videoId: id, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: 'Some Channel' }] },
    lengthText: { simpleText: '12:34' }, viewCountText: { simpleText: '1.2M views' }, publishedTimeText: { simpleText: '3 years ago' }, ...extra
  }
});
const page = (data: unknown) => `<html><script nonce="x">var ytInitialData = ${JSON.stringify(data)};</script><script>other()</script></html>`;

test('videos are found in the results page, wherever the sections put them', () => {
  const html = page({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [video('dQw4w9WgXcQ', 'Never Gonna Give You Up'), { adSlotRenderer: {} }, { reelShelfRenderer: { items: [{ reelItemRenderer: { videoId: 'aaaaaaaaaaa' } }] } }] } },
    { itemSectionRenderer: { contents: [video('9bZkp7q19f0', 'Gangnam {Style}; </b>'), video('dQw4w9WgXcQ', 'a repeat')] } }
  ] } } } } });
  const r = parseYoutubeResults(html);
  assert.deepEqual(r.map(x => x.id), ['dQw4w9WgXcQ', '9bZkp7q19f0']);
  assert.deepEqual(r[0], { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', channel: 'Some Channel', duration: '12:34', views: '1.2M views', published: '3 years ago' });
  assert.equal(r[1].title, 'Gangnam {Style}; </b>');
});

test('a live stream has no length and a LIVE badge; a bad id is not a video', () => {
  const live = video('liveliveliv', 'Radio', { lengthText: undefined, badges: [{ metadataBadgeRenderer: { label: 'LIVE' } }] });
  const r = parseYoutubeResults(page({ a: [live, video('short', 'bad id'), video('abcdefghijk', '')] }));
  assert.deepEqual(r.map(x => [x.id, x.duration]), [['liveliveliv', 'LIVE']]);
});

test('a page without its data gives nothing, and no more than 20 are kept', () => {
  assert.equal(extractInitialData('<html>consent</html>'), null);
  assert.deepEqual(parseYoutubeResults('<html>consent</html>'), []);
  const many = Array.from({ length: 30 }, (_, i) => video(`abcdefghi${String(i).padStart(2, '0')}`, `v${i}`));
  assert.equal(parseYoutubeResults(page({ many })).length, 20);
});

test('the search address', () => {
  assert.equal(youtubeSearchUrl(' lofi & chill '), 'https://www.youtube.com/results?search_query=lofi%20%26%20chill');
});
