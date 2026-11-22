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

// The JSON object after "ytInitialData =" in the page; null when the page has none. The desktop page writes it as
// an object, the mobile page as a quoted string with \x escapes that has to be read as a string first.
export function extractInitialData(html: string): unknown {
  const at = html.indexOf('ytInitialData');
  if (at < 0) return null;
  const eq = html.indexOf('=', at);
  const open = eq < 0 ? -1 : html.slice(eq + 1, eq + 40).search(/\S/);
  const first = open < 0 ? '' : html[eq + 1 + open];
  if (first === "'" || first === '"') {
    const start = eq + 1 + open;
    let i = start + 1;
    while (i < html.length && html[i] !== first) i += html[i] === '\\' ? 2 : 1;
    if (i >= html.length) return null;
    try {
      const raw = html.slice(start + 1, i);
      const text = raw.replace(/\\(x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|(.))/g, (_m, _a, x, u, c) =>
        x ? String.fromCharCode(parseInt(x, 16)) : u ? String.fromCharCode(parseInt(u, 16)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c);
      return JSON.parse(text);
    } catch { return null; }
  }
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  // The object ends where the script does; scanning the braces (in strings too) is the other way, and a longer one
  const end = html.indexOf(';</script>', start);
  if (end < 0) return null;
  try { return JSON.parse(html.slice(start, end)); } catch { return null; }
}

// The videos in a results page, in the order shown. Shorts, playlists, channels and ads are not videos here.
export function parseYoutubeResults(html: string): YoutubeResult[] {
  return parseYoutubeData(extractInitialData(html));
}

// The same, from the data object itself (the page's, or the answer of YouTube's JSON search)
export function parseYoutubeData(data: unknown): YoutubeResult[] {
  const out: YoutubeResult[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (out.length >= MAX_YOUTUBE_RESULTS || depth > 40 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
    const o = node as Record<string, unknown>;
    // The mobile page calls its videos videoWithContextRenderer, with other names for some of the fields
    // The newer layout: a lockupViewModel, its text under metadata and its length in a badge on the thumbnail
    const lk = o.lockupViewModel as Record<string, any> | undefined;
    if (lk && typeof lk === 'object') {
      const id = typeof lk.contentId === 'string' ? lk.contentId : '';
      if (lk.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && /^[A-Za-z0-9_-]{11}$/.test(id) && !seen.has(id)) {
        const meta = lk.metadata?.lockupMetadataViewModel;
        const title = clip(meta?.title?.content, 200);
        const rows: string[][] = (meta?.metadata?.contentMetadataViewModel?.metadataRows ?? [])
          .map((r: any) => (Array.isArray(r?.metadataParts) ? r.metadataParts.map((p: any) => clip(p?.text?.content, 80)).filter(Boolean) : []));
        const badges = JSON.stringify(lk.contentImage ?? '');
        const length = /"text":"(\d{1,2}(?::\d{2}){1,2})"/.exec(badges)?.[1] ?? '';
        if (title) {
          seen.add(id);
          const flat = rows.flat();
          out.push({
            id, title,
            channel: rows[0]?.[0] ?? '',
            duration: !length && /"text":"LIVE"|BADGE_STYLE_LIVE/.test(badges) ? 'LIVE' : length,
            views: flat.find(t => /views?$|watching$/i.test(t)) ?? '',
            published: flat.find(t => /ago$|^Streamed|^Premiered/i.test(t)) ?? ''
          });
        }
      }
      return;
    }
    const v = (o.videoRenderer ?? o.videoWithContextRenderer) as Record<string, unknown> | undefined;
    if (v && typeof v === 'object') {
      const id = typeof v.videoId === 'string' ? v.videoId : '';
      const title = textOf(v.title ?? v.headline, 200);
      if (/^[A-Za-z0-9_-]{11}$/.test(id) && title && !seen.has(id)) {
        seen.add(id);
        const live = JSON.stringify(v.badges ?? '').includes('LIVE') && !v.lengthText;
        out.push({
          id, title,
          channel: textOf(v.ownerText ?? v.longBylineText ?? v.shortBylineText, 80),
          duration: live ? 'LIVE' : textOf(v.lengthText, 12),
          views: textOf(v.viewCountText ?? v.shortViewCountText, 40),
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

// YouTube's own JSON search, the page's fallback: the same data without the page around it
export const YOUTUBE_JSON_SEARCH = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';
export const youtubeJsonBody = (query: string): string => JSON.stringify({
  context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } },
  query: query.trim()
});
