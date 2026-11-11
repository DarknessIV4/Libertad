// Torrent Together: searching for something to watch instead of pasting a link. A title is looked up in
// Cinemeta (films and series, by IMDb id) and Kitsu (anime, by Kitsu id); Torrentio then answers for that id
// with the torrents of every provider it scrapes. Pure functions; the network part lives in electron/search.ts.
import { streamToMeta, type AddonStream } from './episodes.ts';
import type { TorrentMeta } from './torrent-meta.ts';

// The providers Torrentio scrapes (the list its own addon filters by). Asking for all of them by name means
// the answer does not depend on what the server's default happens to be.
export interface Provider { key: string; label: string; group: 'general' | 'anime' | 'foreign' }
export const TORRENTIO_PROVIDERS: readonly Provider[] = [
  ...['yts:YTS', 'eztv:EZTV', 'rarbg:RARBG', '1337x:1337x', 'ext:EXT', 'thepiratebay:ThePirateBay', 'kickasstorrents:KickassTorrents',
    'torrentgalaxy:TorrentGalaxy', 'uindex:UIndex', 'knaben:Knaben', 'magnetdl:MagnetDL'].map(x => ({ key: x.split(':')[0], label: x.split(':')[1], group: 'general' as const })),
  ...['horriblesubs:HorribleSubs', 'nyaasi:NyaaSi', 'animetosho:AnimeTosho', 'tokyotosho:TokyoTosho', 'anidex:AniDex', 'nekobt:nekoBT']
    .map(x => ({ key: x.split(':')[0], label: x.split(':')[1], group: 'anime' as const })),
  ...['rutor:Rutor', 'rutracker:Rutracker', 'comando:Comando', 'bludv:BluDV', 'micoleaodublado:MicoLeaoDublado', 'torrent9:Torrent9',
    'ilcorsaronero:ilCorSaRoNeRo', 'mejortorrent:MejorTorrent', 'wolfmax4k:Wolfmax4k', 'cinecalidad:Cinecalidad', 'besttorrents:BestTorrents']
    .map(x => ({ key: x.split(':')[0], label: x.split(':')[1], group: 'foreign' as const }))
];

// The path segment that configures Torrentio: every provider
export const ALL_PROVIDERS_CONFIG = `providers=${TORRENTIO_PROVIDERS.map(p => p.key).join(',')}`;

export type TitleSource = 'imdb' | 'kitsu';
export interface TitleResult {
  source: TitleSource;
  id: string;                  // "tt0903747" or the number of a Kitsu anime
  type: 'movie' | 'series';
  name: string;
  year: string;
  poster: string | null;       // https only
  blurb: string;
}

export const MAX_TITLES = 12;
export const MAX_RESULTS = 60;

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 600) return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
};

interface CinemetaMeta { id?: unknown; imdb_id?: unknown; name?: unknown; year?: unknown; releaseInfo?: unknown; poster?: unknown; description?: unknown }

// What Cinemeta answers for "catalog/<type>/top/search=<text>.json"
export function parseCinemeta(json: unknown, type: 'movie' | 'series'): TitleResult[] {
  const metas = (json as { metas?: unknown } | null)?.metas;
  if (!Array.isArray(metas)) return [];
  const out: TitleResult[] = [];
  for (const m of metas as CinemetaMeta[]) {
    const id = typeof m?.imdb_id === 'string' ? m.imdb_id : typeof m?.id === 'string' ? m.id : '';
    const name = clip(m?.name, 120);
    if (!/^tt\d{1,10}$/.test(id) || !name) continue;
    out.push({ source: 'imdb', id, type, name, year: clip(m.releaseInfo ?? m.year, 12), poster: httpsUrl(m.poster), blurb: clip(m.description, 160) });
  }
  return out;
}

interface KitsuAnime { id?: unknown; attributes?: { canonicalTitle?: unknown; titles?: Record<string, unknown>; startDate?: unknown; subtype?: unknown; synopsis?: unknown; posterImage?: { small?: unknown; tiny?: unknown } } }

// What Kitsu answers for "anime?filter[text]=<text>"
export function parseKitsu(json: unknown): TitleResult[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: TitleResult[] = [];
  for (const a of data as KitsuAnime[]) {
    const id = typeof a?.id === 'string' ? a.id : '';
    const at = a?.attributes ?? {};
    const name = clip(at.titles?.en ?? at.titles?.en_us ?? at.canonicalTitle ?? at.titles?.en_jp, 120);
    if (!/^\d{1,9}$/.test(id) || !name) continue;
    out.push({
      source: 'kitsu', id, type: at.subtype === 'movie' ? 'movie' : 'series', name,
      year: clip(at.startDate, 4), poster: httpsUrl(at.posterImage?.small ?? at.posterImage?.tiny), blurb: clip(at.synopsis, 160)
    });
  }
  return out;
}

// The same film or show listed twice (a title in both Cinemeta and Kitsu is kept once, the IMDb one)
export function mergeTitles(...lists: TitleResult[][]): TitleResult[] {
  const seen = new Set<string>();
  const out: TitleResult[] = [];
  const norm = (t: TitleResult) => `${t.type}|${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}|${t.year.slice(0, 4)}`;
  for (const t of lists.flat()) {
    const keys = [`${t.source}:${t.id}`, norm(t)];
    if (keys.some(k => seen.has(k))) continue;
    keys.forEach(k => seen.add(k));
    out.push(t);
  }
  return out.slice(0, MAX_TITLES);
}

// The id Torrentio is asked for: a film by its id, an episode as "id:season:episode" (Kitsu: "kitsu:id:episode")
export function streamRequest(t: Pick<TitleResult, 'source' | 'id' | 'type'>, season: number, episode: number): { type: 'movie' | 'series'; id: string } {
  if (t.type === 'movie') return { type: 'movie', id: t.source === 'kitsu' ? `kitsu:${t.id}` : t.id };
  const ep = Math.max(1, Math.floor(episode) || 1);
  if (t.source === 'kitsu') return { type: 'series', id: `kitsu:${t.id}:${ep}` };
  // Season 0 is the specials; anything that is not a season number is the first season
  const s = Math.floor(season);
  return { type: 'series', id: `${t.id}:${s >= 0 ? s : 1}:${ep}` };
}

export interface FoundTorrent {
  torrent: TorrentMeta;
  provider: string;
  seeders: number;
  quality: string;      // "1080p", "4k HDR", "" when not said
  size: number;         // bytes, 0 when not said
  languages: string;    // flags, "" when not said
  title: string;        // the release name
}

const SIZE_UNITS: Record<string, number> = { kB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };

// Torrentio puts the numbers in a line of its own: "👤 12 💾 1.5 GB ⚙️ ThePirateBay"
export function readStats(title: string): { seeders: number; size: number; provider: string } {
  const seeders = /👤\s*(\d+)/.exec(title);
  const size = /💾\s*([\d.,]+)\s*([kMGT]B)/.exec(title);
  const provider = /⚙️?\s*([^\s\n]+)/.exec(title);
  const bytes = size ? Math.floor(parseFloat(size[1].replace(/,/g, '')) * (SIZE_UNITS[size[2]] ?? 1)) : 0;
  return { seeders: seeders ? Number(seeders[1]) : 0, size: Number.isFinite(bytes) ? bytes : 0, provider: provider?.[1] ?? '' };
}

// Torrentio's answer as a list for a person to choose from: only torrents (debrid links have no info hash), each torrent
// once, the best seeded first
export function streamsToFound(streams: readonly AddonStream[]): FoundTorrent[] {
  const seen = new Set<string>();
  const out: FoundTorrent[] = [];
  for (const s of streams) {
    const torrent = streamToMeta(s);
    if (!torrent || seen.has(torrent.infoHash)) continue;
    seen.add(torrent.infoHash);
    const stats = readStats(s.title ?? '');
    const lines = (s.title ?? '').split('\n');
    const flags = lines.find(l => /\p{Regional_Indicator}/u.test(l) && !/[👤💾⚙]/u.test(l)) ?? '';
    out.push({
      torrent, provider: stats.provider, seeders: stats.seeders, size: stats.size || torrent.size,
      quality: clip((s.name ?? '').split('\n').slice(1).join(' '), 30), languages: clip(flags, 40), title: clip(lines[0], 200) || torrent.name
    });
  }
  return out.sort((a, b) => b.seeders - a.seeders).slice(0, MAX_RESULTS);
}
