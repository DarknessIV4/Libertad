import { getJson } from './subtitles.ts';
import type { AddonStream } from '../src/core/episodes.ts';
import { ALL_PROVIDERS_CONFIG, mergeTitles, parseCinemeta, parseKitsu, streamRequest, streamsToFound, type FoundTorrent, type TitleResult } from '../src/core/search.ts';

const CINEMETA = 'https://v3-cinemeta.strem.io';
const KITSU = 'https://kitsu.io/api/edge';
const TORRENTIO = 'https://torrentio.strem.fun';

// Films, series and anime matching what was typed. A service that does not answer only leaves its part out.
export async function searchTitles(query: string): Promise<TitleResult[]> {
  const q = encodeURIComponent(query.trim());
  const [movies, series, anime] = await Promise.all([
    getJson<unknown>(`${CINEMETA}/catalog/movie/top/search=${q}.json`),
    getJson<unknown>(`${CINEMETA}/catalog/series/top/search=${q}.json`),
    getJson<unknown>(`${KITSU}/anime?filter%5Btext%5D=${q}&page%5Blimit%5D=8`, { Accept: 'application/vnd.api+json' })
  ]);
  if (movies === null && series === null && anime === null) throw new Error('The search services did not answer. Check your connection and try again.');
  // Interleaved, so a film and a series with the same name both show near the top
  const a = parseCinemeta(movies, 'movie'), b = parseCinemeta(series, 'series');
  const mixed = Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [a[i], b[i]]).flat().filter((x): x is TitleResult => !!x);
  return mergeTitles(mixed, parseKitsu(anime));
}

// The torrents of every Torrentio provider for a film or an episode
export async function searchTorrents(title: Pick<TitleResult, 'source' | 'id' | 'type'>, season: number, episode: number): Promise<FoundTorrent[]> {
  const req = streamRequest(title, season, episode);
  const id = encodeURIComponent(req.id).replace(/%3A/gi, ':');
  const r = await getJson<{ streams?: AddonStream[] }>(`${TORRENTIO}/${ALL_PROVIDERS_CONFIG}/stream/${req.type}/${id}.json`, undefined, undefined, 25000);
  console.log('[search] asked', req.type, req.id, '->', r ? `${r.streams?.length ?? 0} streams` : 'no answer');
  if (r === null) throw new Error('Torrentio did not answer. Try again in a moment.');
  return streamsToFound(Array.isArray(r.streams) ? r.streams : []);
}
