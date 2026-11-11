import { net } from 'electron';
import {
  decodeSubtitle, normLang, parseReleaseName, parseSubtitles, readQuery, subtitlesPath,
  type Cue, type ReleaseName, type SubtitleOption
} from '../src/core/subtitles.ts';

// The same two services Stremio's player asks: the OpenSubtitles addon (which answers a file hash
// or an IMDb id with subtitle files) and Cinemeta (which turns a title into an IMDb id).
const ADDON = 'https://opensubtitles-v3.strem.io';
const CINEMETA = 'https://v3-cinemeta.strem.io';

const MAX_SUBTITLE_BYTES = 3 * 1024 * 1024;
const PER_LANGUAGE = 5;

// Only public web addresses: an address in a list from the network never reaches this computer's own services
export function isPublicUrl(raw: string, allowHttp = false): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(h);
}

// A fetch that follows redirects only to public addresses, with a time limit and a size limit
export async function fetchLimited(url: string, maxBytes: number, ms: number, allowHttp = false, headers?: Record<string, string>, init?: { method: string; body: string }): Promise<Uint8Array> {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!isPublicUrl(target, allowHttp)) throw new Error('This address is not allowed');
    const res = await net.fetch(target, { redirect: 'manual', headers, ...init, signal: AbortSignal.timeout(ms) });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error('Bad redirect');
      target = new URL(next, target).toString();
      continue;
    }
    if (!res.ok) throw new Error(`The server answered ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error('The file is too large');
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error('The file is too large');
    return buf;
  }
  throw new Error('Too many redirects');
}

export async function getJson<T>(url: string, headers?: Record<string, string>, init?: { method: string; body: string }, ms = 8000): Promise<T | null> {
  try {
    const bytes = await fetchLimited(url, 2 * 1024 * 1024, ms, false, headers, init);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (e) {
    console.log('[subtitles] request failed:', url.replace(/^https:\/\//, ''), '-', (e as Error).message);
    return null;
  }
}

interface CinemetaMeta { id?: string; imdb_id?: string; releaseInfo?: string; year?: string }

// The IMDb id of what the file name says, so the addon can be asked by title as well as by hash
async function imdbIdOf(title: string, year: number | undefined, type: 'movie' | 'series', strictYear = false): Promise<string | null> {
  if (!title) return null;
  const r = await getJson<{ metas?: CinemetaMeta[] }>(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`);
  const metas = (r?.metas ?? []).filter(m => /^tt\d+$/.test(m.imdb_id ?? m.id ?? ''));
  if (!metas.length) return null;
  const byYear = year ? metas.find(m => `${m.releaseInfo ?? m.year ?? ''}`.startsWith(String(year))) : undefined;
  const pick = byYear ?? (strictYear ? undefined : metas[0]);
  return pick ? (pick.imdb_id ?? pick.id ?? null) : null;
}

// Stremio asks for subtitles by the id of what was picked in its catalog ("tt0903747:1:6" for a series
// episode). A magnet link has no such id, so it is worked out here. Fansub files carry the Japanese
// romanised title ("Toukutsu Ou") that Cinemeta doesn't know, so Kitsu is asked first: it knows every
// name a show has, including the English one ("Tomb Raider King") that Cinemeta does know.
interface Show { kitsu?: string; names: string[]; english: string[]; year?: number }
interface KitsuAnime { id?: string; attributes?: { canonicalTitle?: string; titles?: Record<string, string>; abbreviatedTitles?: string[]; startDate?: string } }
interface JikanAnime { title?: string; title_english?: string; title_japanese?: string; title_synonyms?: string[]; titles?: { title?: string }[]; year?: number; aired?: { prop?: { from?: { year?: number } } } }

// Spellings that are the same sound: "Toukutsu Ou" and "Tōkutsu-ō" and "Tokutsu O"
const squash = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '').replace(/ou|oo/g, 'o').replace(/uu/g, 'u');
const strings = (xs: unknown[]) => xs.filter((n): n is string => typeof n === 'string' && !!n.trim());

// The ways a title may be spelled by the site that knows the show: a search for one spelling misses the others
function spellings(title: string): string[] {
  const t = title.trim();
  const words = t.split(/\s+/);
  const set = new Set<string>([t, t.replace(/\s+/g, ''), t.replace(/\s+/g, '-')]);
  set.add(t.replace(/ou/gi, 'o').replace(/uu/gi, 'u'));
  set.add(t.replace(/ou/gi, 'ō').replace(/uu/gi, 'ū'));
  if (words.length > 1) { set.add(words.slice(0, -1).join(' ')); set.add(words[0]); }
  return [...set].filter(x => x.length >= 3).slice(0, 7);
}

// 0..1: how alike two names are, by shared letter pairs
function alike(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const x = grams(a), y = grams(b);
  let hit = 0;
  for (const [g, n] of x) hit += Math.min(n, y.get(g) ?? 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

interface AniMedia { title?: { romaji?: string; english?: string; native?: string }; synonyms?: string[]; seasonYear?: number; startDate?: { year?: number } }
const ANILIST_QUERY = 'query($s:String){Page(perPage:8){media(search:$s,type:ANIME){title{romaji english native} synonyms seasonYear startDate{year}}}}';

// Every name a show goes by (Japanese, English, Chinese, abbreviations), from Kitsu, AniList and MyAnimeList,
// searched under each likely spelling of the file's title
async function showsNamed(title: string): Promise<Show[]> {
  const out: Show[] = [];
  const forms = spellings(title);
  await Promise.all(forms.flatMap(form => {
    const q = encodeURIComponent(form);
    return [
      getJson<{ data?: KitsuAnime[] }>(`https://kitsu.io/api/edge/anime?filter%5Btext%5D=${q}&page%5Blimit%5D=8`, { Accept: 'application/vnd.api+json' }).then(r => {
        for (const a of r?.data ?? []) {
          if (!a.id || !/^\d+$/.test(a.id)) continue;
          const at = a.attributes ?? {};
          const t = at.titles ?? {};
          out.push({
            kitsu: a.id,
            names: strings([at.canonicalTitle, ...Object.values(t), ...(at.abbreviatedTitles ?? [])]),
            english: strings([t.en, t.en_us, at.canonicalTitle, t.en_jp]),
            year: Number((at.startDate ?? '').slice(0, 4)) || undefined
          });
        }
      }),
      getJson<{ data?: { Page?: { media?: AniMedia[] } } }>('https://graphql.anilist.co', { 'Content-Type': 'application/json', Accept: 'application/json' },
        { method: 'POST', body: JSON.stringify({ query: ANILIST_QUERY, variables: { s: form } }) }).then(r => {
        for (const a of r?.data?.Page?.media ?? []) {
          out.push({
            names: strings([a.title?.romaji, a.title?.english, a.title?.native, ...(a.synonyms ?? [])]),
            english: strings([a.title?.english, a.title?.romaji]),
            year: a.seasonYear ?? a.startDate?.year ?? undefined
          });
        }
      })
    ];
  }));
  // MyAnimeList last and only for the plain title: its service is slow
  const jikan = await getJson<{ data?: JikanAnime[] }>(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=10`, undefined, undefined, 5000);
  for (const a of jikan?.data ?? []) {
    out.push({
      names: strings([a.title, a.title_english, a.title_japanese, ...(a.title_synonyms ?? []), ...(a.titles ?? []).map(t => t.title)]),
      english: strings([a.title_english, a.title]),
      year: a.year ?? a.aired?.prop?.from?.year ?? undefined
    });
  }
  return out;
}

// The show a file's title most likely means, with the Kitsu id when Kitsu is where it was found
async function findShow(title: string): Promise<Show | null> {
  const want = squash(title);
  if (!want) return null;
  const scored = (await showsNamed(title))
    .map(show => ({ show, score: Math.max(0, ...show.names.map(n => alike(want, squash(n)))) }))
    .sort((x, y) => y.score - x.score);
  console.log('[subtitles] shows named like', JSON.stringify(title), ':', JSON.stringify(scored.slice(0, 4).map(x => [x.score.toFixed(2), x.show.names[0], x.show.year])));
  // A show not named like the file is not the show: its subtitles would be someone else's
  const best = scored[0];
  if (!best || best.score < 0.6) return null;
  // The same show listed by both sources: keep the Kitsu id of whichever one matched
  const kitsu = scored.find(x => x.show.kitsu && x.score >= best.score - 0.05)?.show.kitsu;
  return { ...best.show, kitsu };
}

// The IMDb and Kitsu ids of what a release name is about (an episode is a series, and most often an anime when
// IMDb does not know the title)
export async function resolveShowIds(rel: ReleaseName, episode: boolean): Promise<{ imdb: string | null; kitsu: string | null; show: string }> {
  const type = episode ? 'series' : 'movie';
  let imdb = await imdbIdOf(rel.title, rel.year, type);
  let kitsu: string | null = null;
  let name = rel.title;
  // An episode with no IMDb listing is most often an anime
  if (!imdb && episode) {
    const show = await findShow(rel.title);
    if (show) {
      kitsu = show.kitsu ?? null;
      name = show.english[0] ?? show.names[0] ?? rel.title;
      // Its English names find the IMDb listing, which is what the subtitle sites are filed under
      const tries = [...new Set([...show.english, ...show.names])].slice(0, 6);
      for (const n of tries) {
        imdb = await imdbIdOf(n, show.year, 'series', true);
        if (imdb) break;
      }
      console.log('[subtitles] show: kitsu', kitsu, '| names tried:', JSON.stringify(tries), '| year:', show.year, '-> imdb', imdb);
    }
  }
  return { imdb, kitsu, show: name };
}

// `query` is what the person typed when the file's own name found nothing
export async function findSubtitles(q: { filename: string; size: number; hash: string | null; query?: string }): Promise<SubtitleOption[]> {
  const fileRel = parseReleaseName(q.filename);
  const typed = q.query?.trim();
  let rel: ReleaseName = fileRel;
  let imdb: string | null = null, kitsu: string | null = null;
  if (typed) ({ rel, imdb, kitsu } = readQuery(typed, fileRel));
  const episode = rel.season != null && rel.episode != null || (kitsu !== null && rel.episode != null);
  const type = episode ? 'series' : 'movie';
  if (!imdb && !kitsu) ({ imdb, kitsu } = await resolveShowIds(rel, episode));
  const extra = { hash: q.hash, size: q.size, filename: q.filename };

  const asked: string[] = [];
  if (imdb) asked.push(subtitlesPath(type, type === 'series' ? `${imdb}:${rel.season ?? 1}:${rel.episode}` : imdb, extra));
  if (kitsu) asked.push(subtitlesPath('series', rel.episode != null ? `kitsu:${kitsu}:${rel.episode}` : `kitsu:${kitsu}`, extra));
  // The file's own hash, too: a wrong title match must not hide the subtitles made for exactly this file
  if (q.hash) asked.push(subtitlesPath('movie', 'tt0', extra));
  console.log('[subtitles] file:', q.filename, '| typed:', typed ?? '-', '| read as:', JSON.stringify(rel), '| imdb:', imdb, '| kitsu:', kitsu, '| hash:', q.hash);
  if (!asked.length) return [];

  const seen = new Set<string>();
  const perLang = new Map<string, number>();
  const out: SubtitleOption[] = [];
  for (const path of asked) {
    const r = await getJson<{ subtitles?: { id?: unknown; url?: unknown; lang?: unknown }[] }>(ADDON + path);
    console.log('[subtitles] asked', path.slice(0, 120), '->', r ? `${r.subtitles?.length ?? 0} found` : 'no answer');
    for (const s of r?.subtitles ?? []) {
      if (typeof s.url !== 'string' || typeof s.lang !== 'string' || !isPublicUrl(s.url) || seen.has(s.url)) continue;
      const lang = normLang(s.lang);
      const n = perLang.get(lang) ?? 0;
      if (n >= PER_LANGUAGE) continue;
      perLang.set(lang, n + 1);
      seen.add(s.url);
      out.push({ id: String(s.id ?? s.url).slice(0, 80), url: s.url, lang, source: 'OpenSubtitles' });
    }
  }
  return out;
}

export async function fetchSubtitle(url: string, lang: string): Promise<Cue[]> {
  const bytes = await fetchLimited(url, MAX_SUBTITLE_BYTES, 15000);
  return parseSubtitles(decodeSubtitle(bytes, lang));
}
