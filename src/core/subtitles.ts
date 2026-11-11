// Subtitles for Torrent Together: the OpenSubtitles file hash, reading release names, decoding and
// parsing subtitle files. Pure functions; the network part lives in electron/subtitles.ts.

export interface SubtitleOption {
  id: string;
  url: string;
  lang: string;   // ISO 639-2 (three letters), as the OpenSubtitles addon gives it
  source?: string; // where it was found, shown under its name
}

export interface Cue { start: number; end: number; text: string } // milliseconds

// ─── OpenSubtitles hash ───────────────────────────────────────────────────────
// The file size plus the sum of the first and the last 64 KiB read as little-endian 64-bit
// numbers, modulo 2^64. Lets OpenSubtitles find the subtitles made for exactly this file.

export const HASH_CHUNK = 65536;
const MASK64 = (1n << 64n) - 1n;

export function openSubtitlesHash(head: Uint8Array, tail: Uint8Array, size: number): string | null {
  if (!Number.isSafeInteger(size) || size < HASH_CHUNK) return null;
  let h = BigInt(size);
  for (const part of [head, tail]) {
    const dv = new DataView(part.buffer, part.byteOffset, part.byteLength);
    for (let i = 0; i + 8 <= part.byteLength; i += 8) h = (h + dv.getBigUint64(i, true)) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

// ─── Release names ────────────────────────────────────────────────────────────

export interface ReleaseName { title: string; year?: number; season?: number; episode?: number }

const STOP = [
  /\bS(\d{1,2})E(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{2,3})\b/i,
  /[([]?\b((?:19|20)\d{2})\b[)\]]?/,
  /\b(?:480|576|720|1080|2160)[pi]\b/i,
  /\b(?:4k|uhd|web-?dl|web-?rip|blu-?ray|bdrip|brrip|hdrip|dvdrip|hdtv|hdcam|remux|x26[45]|h\.?26[45]|hevc|xvid)\b/i
];

// "The.Matrix.1999.1080p.BluRay.x264-GRP.mkv" -> { title: "The Matrix", year: 1999 }
export function parseReleaseName(file: string): ReleaseName {
  let s = file.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,4}$/i, '');
  s = s.replace(/^\s*[[(][^\])]*[\])]\s*/, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const out: ReleaseName = { title: s };
  const se = STOP[0].exec(s) ?? STOP[1].exec(s);
  if (se) { out.season = Number(se[1]); out.episode = Number(se[2]); }
  else {
    // Fansub style: "Show Name - 03 (1080p)": the number after the dash is the episode
    const anime = /^(.+?)\s+-\s+(\d{1,3})(?:v\d)?(?=\s|$|\[|\()/.exec(s);
    if (anime) { out.season = 1; out.episode = Number(anime[2]); s = anime[1]; }
  }
  // A year at the very start is part of the title ("2012")
  const ym = new RegExp(STOP[2].source, 'g');
  let year: RegExpExecArray | null;
  while ((year = ym.exec(s))) {
    if (year.index > 0) { out.year = Number(year[1]); break; }
  }
  let cut = s.length;
  for (const re of STOP) {
    const g = new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(s))) {
      if (m.index > 0) { cut = Math.min(cut, m.index); break; }
    }
  }
  out.title = s.slice(0, cut).replace(/[-–\s([]+$/, '').trim() || s;
  return out;
}

// What was typed in the search box: an id ("tt1234567", "kitsu:123"), or a title; either may be followed by
// an episode ("S01E06", "1x06", "- 06", "ep 6", a bare "6"). An episode left out is the file's own.
export function readQuery(typed: string, file: ReleaseName): { rel: ReleaseName; imdb: string | null; kitsu: string | null } {
  const idm = /^(tt\d{5,10}|kitsu:\d+)(?::(\d+))?\b(.*)$/i.exec(typed);
  let rel: ReleaseName, rest = typed;
  let imdb: string | null = null, kitsu: string | null = null;
  if (idm) {
    const id = idm[1].toLowerCase();
    if (id.startsWith('tt')) imdb = id; else kitsu = id.slice(6);
    rest = idm[3];
    rel = { title: '' };
    if (idm[2]) rel.episode = Number(idm[2]); // "kitsu:123:6"
  } else {
    rel = parseReleaseName(typed);
    rest = '';
  }
  if (rel.episode == null) {
    const se = /S(\d{1,2})E(\d{1,3})|\b(\d{1,2})x(\d{2,3})\b/i.exec(idm ? rest : typed);
    const trailing = !idm ? /(?:^|\s)(?:e|ep|episode)?\.?\s*(\d{1,3})\s*$/i.exec(typed) : /(?:^|\s)(?:e|ep)?\.?\s*(\d{1,3})\s*$/i.exec(rest);
    if (se) { rel.season = Number(se[1] ?? se[3]); rel.episode = Number(se[2] ?? se[4]); }
    else if (trailing && !/\b(?:19|20)\d{2}$/.test(typed.trim())) {
      rel.season = 1; rel.episode = Number(trailing[1]);
      if (!idm) rel.title = rel.title.replace(/[\s-]+(?:e|ep|episode)?\.?\s*\d{1,3}$/i, '').trim() || rel.title;
    }
  }
  // Nothing typed about the episode: it is the file's
  if (rel.episode == null && file.episode != null) { rel.season = file.season; rel.episode = file.episode; }
  return { rel, imdb, kitsu };
}

// The query the OpenSubtitles addon is asked: /subtitles/<type>/<id>/<extra>.json
export function subtitlesPath(type: 'movie' | 'series', id: string, extra: { hash?: string | null; size?: number; filename?: string }): string {
  const parts: string[] = [];
  if (extra.hash) parts.push(`videoHash=${encodeURIComponent(extra.hash)}`);
  if (extra.size) parts.push(`videoSize=${extra.size}`);
  if (extra.filename) parts.push(`filename=${encodeURIComponent(extra.filename)}`);
  const tail = parts.length ? `/${parts.join('&')}` : '';
  return `/subtitles/${type}/${encodeURIComponent(id)}${tail}.json`;
}

// ─── Languages ────────────────────────────────────────────────────────────────

const LANGS: [iso3: string, iso2: string][] = [
  ['eng', 'en'], ['ara', 'ar'], ['spa', 'es'], ['fre', 'fr'], ['ger', 'de'], ['ita', 'it'], ['por', 'pt'],
  ['rus', 'ru'], ['tur', 'tr'], ['pol', 'pl'], ['dut', 'nl'], ['swe', 'sv'], ['nor', 'no'], ['dan', 'da'],
  ['fin', 'fi'], ['gre', 'el'], ['heb', 'he'], ['hin', 'hi'], ['jpn', 'ja'], ['kor', 'ko'], ['chi', 'zh'],
  ['per', 'fa'], ['rum', 'ro'], ['hun', 'hu'], ['cze', 'cs'], ['slo', 'sk'], ['bul', 'bg'], ['ukr', 'uk'],
  ['srp', 'sr'], ['hrv', 'hr'], ['slv', 'sl'], ['ind', 'id'], ['may', 'ms'], ['vie', 'vi'], ['tha', 'th'],
  ['ben', 'bn'], ['urd', 'ur'], ['lit', 'lt'], ['lav', 'lv'], ['est', 'et'], ['cat', 'ca'], ['alb', 'sq'],
  ['mac', 'mk'], ['bos', 'bs'], ['ice', 'is'], ['geo', 'ka'], ['arm', 'hy'], ['tam', 'ta'], ['tel', 'te']
];
// Other spellings of the same three-letter codes
const ALIASES: Record<string, string> = {
  fra: 'fre', deu: 'ger', nld: 'dut', ell: 'gre', zho: 'chi', fas: 'per', ron: 'rum', ces: 'cze', slk: 'slo',
  msa: 'may', sqi: 'alb', mkd: 'mac', isl: 'ice', kat: 'geo', hye: 'arm', nob: 'nor', pob: 'por', pt: 'por'
};
const TO3 = new Map(LANGS.map(([a, b]) => [b, a]));
const TO2 = new Map(LANGS);

// A language code of any of its forms ("en", "eng", "EN-us") as the three-letter code of this table
export function normLang(code: string): string {
  const c = code.toLowerCase().split(/[-_]/)[0];
  return TO3.get(c) ?? ALIASES[c] ?? c;
}

export function langLabel(code: string): string {
  const iso3 = normLang(code);
  const iso2 = TO2.get(iso3) ?? iso3;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(iso2) ?? iso3.toUpperCase();
  } catch {
    return iso3.toUpperCase();
  }
}

// The languages to look for, best first: the person's own, then English
export function preferredLangs(languages: readonly string[], saved = ''): string[] {
  const out: string[] = [];
  for (const l of [saved, ...languages, 'en']) {
    if (!l || l === 'off') continue;
    const n = normLang(l);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// The first subtitle in the best language there is
export function pickSubtitle(options: readonly SubtitleOption[], preferred: readonly string[]): SubtitleOption | null {
  for (const lang of preferred) {
    const hit = options.find(o => normLang(o.lang) === lang);
    if (hit) return hit;
  }
  return null;
}

// ─── Decoding ─────────────────────────────────────────────────────────────────

const LEGACY: Record<string, string> = {
  ara: 'windows-1256', per: 'windows-1256', urd: 'windows-1256',
  heb: 'windows-1255',
  rus: 'windows-1251', ukr: 'windows-1251', bul: 'windows-1251', srp: 'windows-1251', mac: 'windows-1251',
  gre: 'windows-1253', tur: 'windows-1254',
  pol: 'windows-1250', cze: 'windows-1250', slo: 'windows-1250', hun: 'windows-1250', rum: 'windows-1250',
  hrv: 'windows-1250', slv: 'windows-1250', alb: 'windows-1250', bos: 'windows-1250',
  lit: 'windows-1257', lav: 'windows-1257', est: 'windows-1257',
  vie: 'windows-1258', tha: 'windows-874', jpn: 'shift_jis', kor: 'euc-kr', chi: 'gbk'
};

// Subtitle files are UTF-8 or UTF-16 when somebody cared, and otherwise whatever their language's
// old code page was: the language says which
export function decodeSubtitle(bytes: Uint8Array, lang = ''): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { /* not UTF-8 */ }
  try {
    return new TextDecoder(LEGACY[normLang(lang)] ?? 'windows-1252').decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// ─── Parsing (SubRip and WebVTT) ──────────────────────────────────────────────

const TIME = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;
const ARROW = new RegExp(`(${TIME.source})\\s*-->\\s*(${TIME.source})`);
const MAX_CUES = 20000;

function toMs(h: string | undefined, m: string, s: string, frac: string): number {
  return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(frac.padEnd(3, '0'));
}

// Markup a video's cue text may keep is bold, italic and underline; positioning codes, fonts and
// every other tag go
function cleanText(raw: string): string {
  return raw
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<(?!\/?(?:i|b|u)\s*>)[^>]*>/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function parseSubtitles(text: string): Cue[] {
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex(l => l.includes('-->'));
    if (at < 0) continue;
    if (/^(WEBVTT|NOTE|STYLE|REGION)/.test(lines[0])) continue;
    const m = ARROW.exec(lines[at]);
    if (!m) continue;
    // Groups: 1 = whole start, 2-5 = its parts; 6 = whole end, 7-10 = its parts
    const start = toMs(m[2], m[3], m[4], m[5]);
    const end = toMs(m[7], m[8], m[9], m[10]);
    const body = cleanText(lines.slice(at + 1).join('\n'));
    if (!body || end <= start) continue;
    cues.push({ start, end, text: body });
    if (cues.length >= MAX_CUES) break;
  }
  return cues.sort((a, b) => a.start - b.start);
}
