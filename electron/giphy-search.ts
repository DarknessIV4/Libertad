// GIF search through GIPHY's own website, the way a browser reads it, no API key needed.
// 1. A hidden browser window (the app's own Chromium, with its own cookies kept apart) opens the site's
//    search page, so it shows what the site shows, and is scrolled to make the site load more.
// 2. If that gives nothing, the plain HTML of the explore page is read instead (about 24 GIFs, then the
//    related searches it lists, one after another).
// If the site puts up a human check (a captcha, "verify you are human"), the window is shown so the person
// can solve it; it is hidden again once the results are there, and the cookie it earns is kept.
// The window asks as the Chromium it really is: a made-up Firefox would not match the rest of what the
// engine sends (client hints, the way it connects), and a mismatch is what gets noticed.
// Unofficial, so it follows whatever the site looks like today.

import { BrowserWindow, app, net, session } from 'electron';

export interface GiphyGif { id: string; preview: string; url: string }

// The picture that is sent lives at a fixed address; the one shown is what the page itself shows
const MEDIA = /^https:\/\/media\d*\.giphy\.com\/media\/(?:v1\.[^/]+\/)?([A-Za-z0-9]+)\//;
const toGif = (src: string): GiphyGif | null => {
  const m = MEDIA.exec(src);
  return m ? { id: m[1], preview: src, url: `https://media.giphy.com/media/${m[1]}/giphy.gif` } : null;
};


const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");

export function parseGiphy(html: string): GiphyGif[] {
  const out: GiphyGif[] = [];
  const seen = new Set<string>();
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = decode(/\ssrc\s*=\s*"([^"]+)"/i.exec(tag)?.[1] ?? '');
    const g = toGif(src);
    if (!g || seen.has(g.id)) continue;
    seen.add(g.id);
    out.push(g);
  }
  return out;
}

export function parseRelated(html: string, slug: string): string[] {
  const out: string[] = [];
  for (const [, raw] of html.matchAll(/href="(?:https:\/\/giphy\.com)?\/explore\/([^"/?#]+)"/gi)) {
    const rel = decodeURIComponent(decode(raw));
    if (rel === slug || /-(stickers|clips)$/.test(rel) || out.includes(rel)) continue;
    out.push(rel);
    if (out.length >= 12) break;
  }
  return out;
}

interface Loaded { gifs: GiphyGif[]; related: string[] }
const cache = new Map<string, { value: Loaded; expires: number }>();

async function load(slug: string): Promise<Loaded> {
  const hit = cache.get(slug);
  if (hit && hit.expires > Date.now()) return hit.value;
  const res = await net.fetch(`https://giphy.com/explore/${encodeURIComponent(slug)}`, {
    headers: { 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(8000)
  });
  if (res.status === 404) return { gifs: [], related: [] };
  if (!res.ok) throw new Error(`GIPHY answered ${res.status}`);
  const html = (await res.text()).slice(0, 2_000_000);
  const value = { gifs: parseGiphy(html), related: parseRelated(html, slug) };
  cache.set(slug, { value, expires: Date.now() + 10 * 60e3 });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return value;
}

// Page 0 is the search itself; page n is the n-th related search it lists
// ─── The hidden browser window ───

interface Live { win: BrowserWindow; slug: string; seen: Set<string>; status: number; idle?: ReturnType<typeof setTimeout> }

class Unverified extends Error {}
let live: Live | null = null;
let gen = 0;
let prepared = false;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function prepare() {
  if (prepared) return;
  prepared = true;
  session.fromPartition('persist:giphy').setPermissionRequestHandler((_w, _p, cb) => cb(false));
  app.on('before-quit', closeLive);
}

function closeLive() {
  if (!live) return;
  clearTimeout(live.idle);
  if (!live.win.isDestroyed()) live.win.destroy();
  live = null;
}

async function pictures(win: BrowserWindow): Promise<GiphyGif[]> {
  try {
    const srcs: string[] = await win.webContents.executeJavaScript('[...document.images].map(i => i.currentSrc || i.src)');
    const seen = new Set<string>();
    return srcs.map(toGif).filter((g): g is GiphyGif => !!g && !seen.has(g.id) && !!seen.add(g.id));
  } catch { return []; }
}

// Looks again and again until `enough` is true or the time is up
async function waitFor(win: BrowserWindow, enough: (all: GiphyGif[]) => boolean, ms: number): Promise<GiphyGif[]> {
  const end = Date.now() + ms;
  let all: GiphyGif[] = [];
  while (Date.now() < end && !win.isDestroyed()) {
    all = await pictures(win);
    if (enough(all)) break;
    await sleep(300);
  }
  return all;
}

// A page that asks for a human: by what it says or shows, or by the server refusing
const CHALLENGE_SCRIPT = `(() => {
  const title = document.title || '';
  const text = (document.body && document.body.innerText || '').slice(0, 3000);
  if (/just a moment|attention required|access denied/i.test(title)) return true;
  if (/verify (that )?you are (a )?human|are you a robot|checking (if the site connection is secure|your browser)|complete the (security )?check|captcha/i.test(text)) return true;
  return !!document.querySelector('iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenges.cloudflare" i], #challenge-form, .cf-turnstile, .g-recaptcha, .h-captcha');
})()`;

async function isChallenge(win: BrowserWindow): Promise<boolean> {
  try { return !!(await win.webContents.executeJavaScript(CHALLENGE_SCRIPT)); } catch { return false; }
}

// Shows the window until the person has got through (results are on the page and the check is gone),
// then hides it. Closing the window, or taking more than three minutes, gives up.
async function verifyByHand(cur: Live): Promise<GiphyGif[]> {
  const { win } = cur;
  win.setTitle('Verify you are human to search GIPHY');
  win.show();
  win.focus();
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    if (win.isDestroyed()) throw new Unverified('The GIPHY check was closed before it was done');
    const all = await pictures(win);
    if (all.length && !(await isChallenge(win))) { win.hide(); return all; }
    await sleep(500);
  }
  if (!win.isDestroyed()) win.hide();
  throw new Unverified('The GIPHY check was not completed in time');
}

async function browserSearch(slug: string, page: number, parent?: BrowserWindow | null): Promise<{ gifs: GiphyGif[]; more: boolean }> {
  prepare();
  const mine = ++gen;
  const none = { gifs: [], more: false };
  if (page === 0) {
    closeLive();
    const win = new BrowserWindow({
      show: false, width: 1100, height: 900, parent: parent ?? undefined, autoHideMenuBar: true, title: 'GIPHY',
      webPreferences: { partition: 'persist:giphy', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => { if (!/^https:\/\/([\w-]+\.)?giphy\.com\//.test(url)) e.preventDefault(); });
    const cur: Live = live = { win, slug, seen: new Set(), status: 200 };
    win.webContents.on('did-navigate', (_e, _url, code) => { cur.status = code; });
    win.on('closed', () => { if (live === cur) live = null; });
    await win.loadURL(`https://giphy.com/search/${encodeURIComponent(slug)}`);
    let all = await waitFor(win, a => a.length >= 12, 10000);
    if (!all.length && (cur.status >= 400 || await isChallenge(win))) all = await verifyByHand(cur);
    if (mine !== gen) return none;
    if (!all.length) throw new Error('The search page showed no GIFs');
    all.forEach(g => live!.seen.add(g.id));
    live.idle = setTimeout(closeLive, 90_000);
    return { gifs: all, more: true };
  }
  const cur = live;
  if (!cur || cur.slug !== slug || cur.win.isDestroyed()) return none;
  clearTimeout(cur.idle);
  // Scroll to the bottom; the site loads the next ones
  await cur.win.webContents.executeJavaScript('window.scrollTo(0, document.documentElement.scrollHeight)').catch(() => {});
  const fresh = (a: GiphyGif[]) => a.some(g => !cur.seen.has(g.id));
  let all = await waitFor(cur.win, fresh, 6000);
  if (!fresh(all) && await isChallenge(cur.win)) {
    await verifyByHand(cur);
    all = await waitFor(cur.win, fresh, 6000);
  }
  if (mine !== gen) return none;
  const gifs = all.filter(g => !cur.seen.has(g.id));
  gifs.forEach(g => cur.seen.add(g.id));
  cur.idle = setTimeout(closeLive, 90_000);
  return { gifs, more: gifs.length > 0 };
}

// ─── Entry ───

let staticSlug = ''; // a search the window could not do: it continues through the plain page

// Page 0 is the search itself; each next page is more GIFs, until `more` is false
export async function searchGiphy(query: string, page = 0, parent?: BrowserWindow | null): Promise<{ gifs: GiphyGif[]; more: boolean }> {
  const q = query.trim().toLowerCase().slice(0, 100);
  const slug = q.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  if (!slug) return { gifs: [], more: false };
  const n = Math.max(0, Math.min(50, Math.floor(Number(page)) || 0));
  if (staticSlug === slug && n > 0) return staticSearch(slug, n);
  try { return await browserSearch(slug, n, parent); }
  catch (e) {
    if (e instanceof Unverified) { closeLive(); throw e; }
    closeLive();
    if (n > 0) return { gifs: [], more: false };
    console.warn('[giphy] window search failed, using the plain page:', (e as Error).message);
    staticSlug = slug;
    return staticSearch(slug, 0);
  }
}

// Page 0 is the explore page; page n is the n-th related search it lists
async function staticSearch(slug: string, n: number): Promise<{ gifs: GiphyGif[]; more: boolean }> {
  const first = await load(slug);
  if (n === 0) return { gifs: first.gifs, more: first.related.length > 0 };
  const rel = first.related[n - 1];
  if (!rel) return { gifs: [], more: false };
  return { gifs: (await load(rel)).gifs, more: n < first.related.length };
}

// The bytes of a GIPHY picture, for use as a profile picture (the window cannot read other sites itself)
const MAX_GIF = 40 * 1024 * 1024;
export async function fetchGif(url: string): Promise<Uint8Array> {
  if (!/^https:\/\/media\d*\.giphy\.com\/media\//.test(url)) throw new Error('Not a GIPHY picture');
  const res = await net.fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GIPHY answered ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_GIF) throw new Error('This GIF is too large');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_GIF) throw new Error('This GIF is too large');
  return new Uint8Array(buf);
}
