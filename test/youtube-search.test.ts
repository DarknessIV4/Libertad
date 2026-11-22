import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractInitialData, parseYoutubeData, parseYoutubeResults, youtubeSearchUrl } from '../src/core/youtube-search.ts';

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

test('the mobile page: videoWithContextRenderer, and the data as an escaped string', () => {
  const data = { a: [{ videoWithContextRenderer: { videoId: 'dQw4w9WgXcQ', headline: { runs: [{ text: 'Mobile "title"' }] },
    shortBylineText: { runs: [{ text: 'Chan' }] }, lengthText: { runs: [{ text: '3:32' }] }, shortViewCountText: { simpleText: '1B views' }, publishedTimeText: { simpleText: '14 years ago' } } }] };
  const esc = JSON.stringify(data).replace(/[\\"{}:,\[\]']/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  const html = `<script>var ytInitialData = '${esc}';</script>`;
  assert.deepEqual(parseYoutubeResults(html), [{ id: 'dQw4w9WgXcQ', title: 'Mobile "title"', channel: 'Chan', duration: '3:32', views: '1B views', published: '14 years ago' }]);
});

test('the newer lockupViewModel layout', () => {
  const lock = { lockupViewModel: { contentId: 'dQw4w9WgXcQ', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '3:32' } }] } }] } },
    metadata: { lockupMetadataViewModel: { title: { content: 'Never Gonna' }, metadata: { contentMetadataViewModel: { metadataRows: [
      { metadataParts: [{ text: { content: 'Rick' } }] }, { metadataParts: [{ text: { content: '1B views' } }, { text: { content: '14 years ago' } }] }] } } } } } };
  const other = { lockupViewModel: { contentId: 'PLxxxxxxxxx', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' } };
  assert.deepEqual(parseYoutubeData({ a: [lock, other] }), [{ id: 'dQw4w9WgXcQ', title: 'Never Gonna', channel: 'Rick', duration: '3:32', views: '1B views', published: '14 years ago' }]);
});

test('the search address', () => {
  assert.equal(youtubeSearchUrl(' lofi & chill '), 'https://www.youtube.com/results?search_query=lofi%20%26%20chill');
});
