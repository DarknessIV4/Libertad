// Torrent Together: finding the next episodes of a show in a Stremio addon (Torrentio). Pure functions;
// the network part lives in electron/episodes.ts.
import { buildMagnet, validTorrentMeta, MAX_TRACKERS, type TorrentMeta } from './torrent-meta.ts';

// What Torrentio answers for one episode: a list of streams, each a torrent (or a debrid link, which has no info hash)
export interface AddonStream {
  name?: string;
  title?: string;
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  behaviorHints?: { filename?: string; videoSize?: number; bingeGroup?: string };
}

export interface ReleaseTraits { group: string | null; resolution: number | null }

// The release group and picture height of a file name: "[SubsPlease] Show - 07 (1080p).mkv", "Show.S01E07.1080p.WEB-GRP.mkv"
export function releaseTraits(file: string): ReleaseTraits {
  const base = file.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,4}$/i, '');
  const bracket = /^\s*[[(]([^\])]{2,40})[\])]/.exec(base);
  const dashed = /-([A-Za-z0-9]{2,20})$/.exec(base);
  const res = /(?<!\d)(2160|1440|1080|720|576|480)[pi]/i.exec(base);
  return { group: (bracket?.[1] ?? dashed?.[1] ?? null)?.toLowerCase() ?? null, resolution: res ? Number(res[1]) : null };
}

const textOf = (s: AddonStream) => `${s.behaviorHints?.filename ?? ''}\n${s.title ?? ''}\n${s.name ?? ''}`;

// How well a stream matches the release the person already chose: the same group, the same resolution, then more seeders
export function scoreStream(s: AddonStream, want: ReleaseTraits): number {
  const text = textOf(s).toLowerCase();
  let score = 0;
  if (want.group && text.includes(want.group)) score += 4;
  if (want.resolution && new RegExp(`(?<!\\d)${want.resolution}[pi]`).test(text)) score += 3;
  const seeders = /👤\s*(\d+)/.exec(s.title ?? '');
  if (seeders) score += Math.min(Number(seeders[1]), 1000) / 1001;
  return score;
}

// The best torrent among the streams; null when none is a torrent
export function pickStream(streams: readonly AddonStream[], want: ReleaseTraits): AddonStream | null {
  let best: AddonStream | null = null, bestScore = -1;
  for (const s of streams) {
    if (typeof s.infoHash !== 'string' || !/^[0-9a-fA-F]{40}$/.test(s.infoHash)) continue;
    const sc = scoreStream(s, want);
    if (sc > bestScore) { best = s; bestScore = sc; }
  }
  return best;
}

// A stream as what the party shares; checked like anything that comes from the network. null when it is not usable.
export function streamToMeta(s: AddonStream): TorrentMeta | null {
  if (typeof s.infoHash !== 'string') return null;
  const first = (s.title ?? '').split('\n')[0].trim();
  const file = (s.behaviorHints?.filename ?? first).slice(0, 400);
  const trackers = (s.sources ?? [])
    .filter((x): x is string => typeof x === 'string' && /^tracker:/i.test(x))
    .map(x => x.replace(/^tracker:/i, ''))
    .slice(0, MAX_TRACKERS * 2);
  const hash = s.infoHash.toLowerCase();
  const name = (first || file).slice(0, 200);
  const size = s.behaviorHints?.videoSize;
  return validTorrentMeta({
    infoHash: hash,
    magnet: buildMagnet(hash, name, trackers),
    fileIdx: typeof s.fileIdx === 'number' ? s.fileIdx : 0,
    name,
    fileName: file,
    size: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : 0
  });
}

export interface FoundEpisodes {
  show: string;
  episodes: { episode: number; torrent: TorrentMeta }[];
  missing: number[];
}
