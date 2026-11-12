// Torrent Together memo: the last show this person started watching, kept on this computer only.
import { load, save } from './storage.ts';

export interface Memo { show: string; season: number | null; episode: number | null }

const KEY = 'libertad.watchMemo';

// "Show.Name.S01E07.1080p.mkv", "[Group] Show - 07 (1080p).mkv", "Show 1x07" -> show, season, episode
export function parseMemo(file: string): Memo | null {
  let s = file.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  s = s.replace(/[._]+/g, ' ');
  let season: number | null = null, episode: number | null = null, show = s;
  const se = /\bS(\d{1,2})\s*E(\d{1,3})\b/i.exec(s) ?? /\b(\d{1,2})x(\d{2,3})\b/i.exec(s);
  const anime = /\s-\s*(\d{1,3})(?:v\d)?\b/.exec(s);
  if (se) { season = Number(se[1]); episode = Number(se[2]); show = s.slice(0, se.index); }
  else if (anime) { episode = Number(anime[1]); show = s.slice(0, anime.index); }
  else show = s.replace(/\b(19|20)\d{2}\b.*$/, '').replace(/\b(2160|1080|720|480)p\b.*$/i, '');
  show = show.replace(/[-\s]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return show ? { show, season, episode } : null;
}

export function memoText(m: Memo): string {
  const parts = [m.show];
  if (m.season !== null) parts.push(`Season ${m.season}`);
  if (m.episode !== null) parts.push(`Episode ${m.episode}`);
  return parts.join(' - ');
}

class WatchMemo {
  last = $state<Memo | null>(load<{ memo: Memo | null }>(KEY, { memo: null }).memo);

  // Called when this person starts watching a torrent, whether they host or joined
  record(fileName: string) {
    const m = parseMemo(fileName);
    if (!m) return;
    this.last = m;
    save(KEY, { memo: m });
  }

  clear() {
    this.last = null;
    save(KEY, { memo: null });
  }
}

export const watchMemo = new WatchMemo();
