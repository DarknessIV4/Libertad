import { getJson, resolveShowIds } from './subtitles.ts';
import { parseReleaseName } from '../src/core/subtitles.ts';
import { pickStream, releaseTraits, streamToMeta, type AddonStream, type FoundEpisodes } from '../src/core/episodes.ts';

// The addon Stremio's own catalog of torrents is served by. Its answer for "tt1234567:1:8" or "kitsu:42:8" is
// a list of torrents for that episode.
const TORRENTIO = 'https://torrentio.strem.fun';

async function streamsFor(id: string): Promise<AddonStream[]> {
  const r = await getJson<{ streams?: AddonStream[] }>(`${TORRENTIO}/stream/series/${encodeURIComponent(id).replace(/%3A/gi, ':')}.json`, undefined, undefined, 15000);
  console.log('[episodes] asked', id, '->', r ? `${r.streams?.length ?? 0} streams` : 'no answer');
  return Array.isArray(r?.streams) ? r.streams : [];
}

// The `count` episodes after the one `filename` is, in the release the person chose (same group and
// resolution when there is one)
export async function findEpisodes(filename: string, count: number): Promise<FoundEpisodes> {
  const rel = parseReleaseName(filename);
  if (rel.episode == null) throw new Error('This file name does not say which episode it is');
  const season = rel.season ?? 1;
  const ids = await resolveShowIds(rel, true);
  if (!ids.imdb && !ids.kitsu) throw new Error(`Could not tell which show "${rel.title}" is`);
  const want = releaseTraits(filename);
  const episodes: FoundEpisodes['episodes'] = [];
  const missing: number[] = [];

  const one = async (episode: number) => {
    // An anime is filed by its Kitsu id with an absolute episode number; everything else by its IMDb id
    const tries = [ids.kitsu ? `kitsu:${ids.kitsu}:${episode}` : null, ids.imdb ? `${ids.imdb}:${season}:${episode}` : null].filter((x): x is string => !!x);
    for (const id of tries) {
      const pick = pickStream(await streamsFor(id), want);
      const torrent = pick ? streamToMeta(pick) : null;
      if (torrent) return torrent;
    }
    return null;
  };

  const numbers = Array.from({ length: count }, (_, i) => rel.episode! + 1 + i);
  // A few at a time: the addon is a public service
  for (let i = 0; i < numbers.length; i += 4) {
    const chunk = numbers.slice(i, i + 4);
    const found = await Promise.all(chunk.map(one));
    chunk.forEach((episode, k) => { const torrent = found[k]; if (torrent) episodes.push({ episode, torrent }); else missing.push(episode); });
  }
  // The queue plays in order and a gap would play the wrong episode next: it stops at the first one not found
  const firstGap = missing.length ? Math.min(...missing) : Infinity;
  return { show: ids.show, episodes: episodes.filter(e => e.episode < firstGap), missing };
}
