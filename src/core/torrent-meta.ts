// Torrent Together: what the host tells everybody about the torrent, and the checks every
// receiver runs on it. Pure functions, shared by the page and the desktop app's main process.
//
// Only the info hash, the name and a few trackers travel through the Mumble server. Each person
// downloads the video themselves from the swarm and plays it in their own player.

export interface TorrentMeta {
  infoHash: string;   // 40 lowercase hex characters
  magnet: string;     // canonical magnet link: hash, name, a few trackers
  fileIdx: number;    // which file of the torrent everybody plays
  name: string;       // the torrent's name
  fileName: string;   // the file that is played
  size: number;       // size of that file in bytes
}

export interface TorrentFileInfo { index: number; name: string; length: number }

// What looking a torrent up returns (the torrent's file list is known once its metadata arrived)
export interface TorrentInfo {
  infoHash: string;
  name: string;
  magnet: string;
  files: TorrentFileInfo[];
  // The file most likely meant: the largest video
  defaultIndex: number;
}

export interface TorrentPlay { url: string; fileName: string; length: number }

export interface TorrentStats {
  ready: boolean;       // the torrent's metadata is here
  peers: number;
  down: number;         // bytes per second
  up: number;
  progress: number;     // 0..1 of the file that is played
  downloaded: number;   // bytes of the whole torrent
}

const HEX40 = /^[0-9a-f]{40}$/;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TRACKER_PROTOCOLS = new Set(['udp:', 'http:', 'https:', 'ws:', 'wss:']);

export const MAX_TRACKERS = 8;
export const MAX_MAGNET = 2048;

// The info hash as 40 lowercase hex characters, from hex or from the base32 form magnet links also use
export function btihToHex(btih: string): string | null {
  const s = btih.trim();
  if (/^[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  if (/^[A-Za-z2-7]{32}$/.test(s)) {
    let bits = 0, value = 0, out = '';
    for (const ch of s.toUpperCase()) {
      value = (value << 5) | B32.indexOf(ch);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out += ((value >>> bits) & 0xff).toString(16).padStart(2, '0');
      }
    }
    return HEX40.test(out) ? out : null;
  }
  return null;
}

export interface ParsedMagnet { infoHash: string; name: string; trackers: string[] }

export function parseMagnet(input: string): ParsedMagnet | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== 'magnet:') return null;
  let infoHash: string | null = null;
  for (const xt of url.searchParams.getAll('xt')) {
    const m = /^urn:btih:(.+)$/i.exec(xt);
    if (m) { infoHash = btihToHex(m[1]); if (infoHash) break; }
  }
  if (!infoHash) return null;
  const trackers: string[] = [];
  for (const raw of url.searchParams.getAll('tr')) {
    if (trackers.length >= MAX_TRACKERS) break;
    // Torrentio writes its trackers as "tracker:udp://host:port/announce"
    const tr = raw.replace(/^tracker:/i, '');
    if (tr.length > 300) continue;
    try {
      if (TRACKER_PROTOCOLS.has(new URL(tr).protocol) && !trackers.includes(tr)) trackers.push(tr);
    } catch { /* not an address */ }
  }
  const name = (url.searchParams.get('dn') ?? '').slice(0, 200);
  return { infoHash, name, trackers };
}

export function buildMagnet(infoHash: string, name: string, trackers: readonly string[]): string {
  let m = `magnet:?xt=urn:btih:${infoHash}`;
  if (name) m += `&dn=${encodeURIComponent(name.slice(0, 200))}`;
  for (const t of trackers.slice(0, MAX_TRACKERS)) m += `&tr=${encodeURIComponent(t)}`;
  return m;
}

// Whatever a person pastes (a magnet link, or just the hash) as a canonical magnet link; null when it is neither
export function normalizeMagnet(input: string): string | null {
  const s = input.trim();
  if (s.length > 8192) return null;
  const parsed = parseMagnet(s);
  if (parsed) return buildMagnet(parsed.infoHash, parsed.name, parsed.trackers);
  const hash = btihToHex(s);
  return hash ? buildMagnet(hash, '', []) : null;
}

const str = (v: unknown, max: number): string | null => typeof v === 'string' && v.length <= max ? v : null;

// What arrived from another person, checked and rebuilt: never used as it came. null when anything is off.
export function validTorrentMeta(x: unknown): TorrentMeta | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const magnet = str(o.magnet, MAX_MAGNET);
  const name = str(o.name, 300);
  const fileName = str(o.fileName, 400);
  if (magnet === null || name === null || fileName === null) return null;
  const parsed = parseMagnet(magnet);
  // The hash and the magnet link have to agree: the link is what gets downloaded
  if (!parsed || typeof o.infoHash !== 'string' || o.infoHash.toLowerCase() !== parsed.infoHash) return null;
  const idx = o.fileIdx, size = o.size;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx > 65535) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;
  return {
    infoHash: parsed.infoHash,
    magnet: buildMagnet(parsed.infoHash, parsed.name || name, parsed.trackers),
    fileIdx: idx,
    name,
    fileName,
    size
  };
}

// The most videos one Torrent Together party can queue (links and episodes together), and the most links
export const MAX_QUEUE = 30;
export const MAX_LINKS = 5;

// A queue of torrents that arrived from another person, every one checked; null when anything is off
export function validTorrentQueue(x: unknown): TorrentMeta[] | null {
  if (!Array.isArray(x) || x.length < 1 || x.length > MAX_QUEUE) return null;
  const out: TorrentMeta[] = [];
  for (const item of x) {
    const m = validTorrentMeta(item);
    if (!m) return null;
    out.push(m);
  }
  return out;
}

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|ogv|ts|m2ts|wmv|flv|mpg|mpeg)$/i;
export const isVideoName = (name: string): boolean => VIDEO_EXT.test(name);

// The largest video; the largest file when there is none
export function pickDefaultFile(files: readonly TorrentFileInfo[]): number {
  let best = -1;
  for (const f of files) if (isVideoName(f.name) && (best < 0 || f.length > files[best].length)) best = files.indexOf(f);
  if (best < 0) for (const f of files) if (best < 0 || f.length > files[best].length) best = files.indexOf(f);
  return best < 0 ? 0 : files[best].index;
}

// ─── Episodes ────────────────────────────────────────────────────────────────

export interface EpisodeTag { group: string; season: number; episode: number }

// Which episode a file name says it is, and a group key that is the same for the files of one series
// and season (their folder and the text before the episode number). null when no number is found.
export function parseEpisode(path: string): EpisodeTag | null {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1).toLowerCase();
  const base = path.slice(slash + 1).replace(/\.[a-z0-9]{2,4}$/i, '');
  const patterns: [RegExp, (m: RegExpExecArray) => [number, number]][] = [
    [/s(\d{1,2})[\s._-]*e(\d{1,3})(?!\d)/i, m => [Number(m[1]), Number(m[2])]],
    [/(?<![\dx])(\d{1,2})x(\d{2,3})(?!\d)/i, m => [Number(m[1]), Number(m[2])]],
    [/(?:episode|ep)[\s._-]*(\d{1,3})(?!\d)/i, m => [0, Number(m[1])]],
    // Anime releases: "[Group] Show - 05 [1080p]"
    [/\s-\s(\d{2,3})(?:v\d)?(?=[\s._\[(-]|$)/, m => [0, Number(m[1])]]
  ];
  for (const [re, pick] of patterns) {
    const m = re.exec(base);
    if (!m) continue;
    const [season, episode] = pick(m);
    const stem = base.slice(0, m.index).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return { group: `${dir}|${stem}|${season}`, season, episode };
  }
  return null;
}

// The episodes of the same series and season as `file`, from that one on, in order (the file itself first)
export function episodesFrom(files: readonly TorrentFileInfo[], file: number): TorrentFileInfo[] {
  const chosen = files.find(f => f.index === file);
  const tag = chosen ? parseEpisode(chosen.name) : null;
  if (!chosen || !tag) return chosen ? [chosen] : [];
  const seen = new Set<number>([tag.episode]);
  const later: { f: TorrentFileInfo; episode: number }[] = [];
  for (const f of files) {
    if (f === chosen || !isVideoName(f.name) || /sample/i.test(f.name)) continue;
    const t = parseEpisode(f.name);
    if (!t || t.group !== tag.group || t.episode <= tag.episode || seen.has(t.episode)) continue;
    seen.add(t.episode);
    later.push({ f, episode: t.episode });
  }
  later.sort((a, b) => a.episode - b.episode);
  return [chosen, ...later.map(x => x.f)];
}
