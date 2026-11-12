// Torrent Together's sibling, YouTube together: searching YouTube instead of pasting a link. The results page
// carries its data as a JSON object ("ytInitialData") in a script; this finds the videos in it. YouTube has no
// key-free search API, so this reads what the page itself shows. Pure functions; the request is in electron/youtube-account.ts.

export interface YoutubeResult {
  id: string;
  title: string;
  channel: string;
  duration: string;    // "12:34", "LIVE" for a live stream, "" when not said
  views: string;       // "1.2M views", "" when not said
  published: string;   // "3 years ago", "" when not said
}

export const MAX_YOUTUBE_RESULTS = 20;

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
// YouTube writes text as { simpleText } or as { runs: [{ text }] }
const textOf = (v: unknown, n: number): string => {
  const t = v as { simpleText?: unknown; runs?: { text?: unknown }[] } | undefined;
  return clip(t?.simpleText ?? (Array.isArray(t?.runs) ? t.runs.map(r => (typeof r?.text === 'string' ? r.text : '')).join('') : ''), n);
};

// The JSON object after "ytInitialData =" in the page; null when the page has none
export function extractInitialData(html: string): unknown {
  const at = html.indexOf('ytInitialData');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  // The object ends where the script does; scanning the braces (in strings too) is the other way, and a longer one
  const end = html.indexOf(';</script>', start);
  if (end < 0) return null;
  try { return JSON.parse(html.slice(start, end)); } catch { return null; }
}

// The videos in a results page, in the order shown. Shorts, playlists, channels and ads are not videos here.
export function parseYoutubeResults(html: string): YoutubeResult[] {
  const data = extractInitialData(html);
  const out: YoutubeResult[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (out.length >= MAX_YOUTUBE_RESULTS || depth > 40 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
    const o = node as Record<string, unknown>;
    const v = o.videoRenderer as Record<string, unknown> | undefined;
    if (v && typeof v === 'object') {
      const id = typeof v.videoId === 'string' ? v.videoId : '';
      const title = textOf(v.title, 200);
      if (/^[A-Za-z0-9_-]{11}$/.test(id) && title && !seen.has(id)) {
        seen.add(id);
        const live = JSON.stringify(v.badges ?? '').includes('LIVE') && !v.lengthText;
        out.push({
          id, title,
          channel: textOf(v.ownerText ?? v.longBylineText, 80),
          duration: live ? 'LIVE' : textOf(v.lengthText, 12),
          views: textOf(v.viewCountText, 40),
          published: textOf(v.publishedTimeText, 30)
        });
      }
      return;
    }
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  };
  walk(data, 0);
  return out;
}

// The address of a results page
export const youtubeSearchUrl = (query: string): string => `https://www.youtube.com/results?search_query=${encodeURIComponent(query.trim())}`;
