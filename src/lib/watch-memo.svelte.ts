// Torrent Together memo: the last show this person started watching, kept on this computer only.
import { untrack } from 'svelte';
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

const LIST_KEY = 'libertad.watchMemos';
const MAX_RECORDS = 200;
const sameShow = (a: Memo, b: Memo) => a.show.toLowerCase() === b.show.toLowerCase();

function loadRecords(): Memo[] {
  const stored = load<{ memos: Memo[] }>(LIST_KEY, { memos: [] }).memos;
  const list = Array.isArray(stored) ? stored.filter(m => m && typeof m.show === 'string') : [];
  if (list.length) return list;
  // The memo used to keep one record only: it becomes the first of the list
  const old = load<{ memo: Memo | null }>(KEY, { memo: null }).memo;
  return old ? [old] : [];
}

class WatchMemo {
  // Every show this person started watching, the latest first, each with where they got to
  records = $state<Memo[]>(loadRecords());

  get last(): Memo | null { return this.records[0] ?? null; }

  // Called when this person starts watching a torrent, whether they host or joined.
  // A show that is already there moves to the top with its new season and episode.
  record(fileName: string) {
    const m = parseMemo(fileName);
    if (!m) return;
    // untrack: callers may be inside an $effect; reading records here must never make them depend on it
    const next = [m, ...untrack(() => this.records).filter(r => !sameShow(r, m))].slice(0, MAX_RECORDS);
    this.records = next;
    save(LIST_KEY, { memos: next });
  }

  remove(m: Memo) {
    this.records = this.records.filter(r => r !== m);
    save(LIST_KEY, { memos: this.records });
  }

  clear() {
    this.records = [];
    save(LIST_KEY, { memos: [] });
    save(KEY, { memo: null });
  }
}

export const watchMemo = new WatchMemo();
