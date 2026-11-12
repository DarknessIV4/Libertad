// The YouTube account: signing in (in a window of its own, with the cookies kept in the same session
// the embedded player uses), signing out, and not telling YouTube what was watched.
//
// Signed in, YouTube is far less likely to answer an embed with "Sign in to confirm you're not a bot".
// The player then loads from youtube.com instead of youtube-nocookie.com (which ignores the login).
// A player that is signed in also writes to the account's watch history, and the only way to stop that
// from outside is to not send the pings that do it: those requests are cancelled while "don't sync
// history" is on. It is best effort, YouTube can rename those addresses.
//
// Google refuses to sign anyone in inside an app window, so there are three ways in (the settings dialog offers them):
//   1. the default browser, with a small companion extension handing the cookies over (youtube-companion.ts)
//   2. pasting the cookies (youtube-cookies.ts reads the formats people can copy)
//   3. a sign-in window of the app itself that asks like Firefox does, which Google sometimes accepts
// Whatever the way, the cookies end up in the default session, with an end date, so they last across restarts.
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOGIN_COOKIES, parseCookies } from './youtube-cookies.ts';
import { fetchLimited } from './subtitles.ts';
import { parseYoutubeResults, youtubeSearchUrl } from '../src/core/youtube-search.ts';
import { startPairing, writeCompanion, type Pairing } from './youtube-companion.ts';

const prefsFile = () => path.join(app.getPath('userData'), 'youtube.json');
const prefs = { noHistory: false };
function loadPrefs() {
  try { prefs.noHistory = !!JSON.parse(readFileSync(prefsFile(), 'utf8')).noHistory; } catch { /* first run */ }
}
function savePrefs() {
  try { writeFileSync(prefsFile(), JSON.stringify(prefs)); } catch { /* the choice then lasts until the app closes */ }
}

async function isSignedIn(): Promise<boolean> {
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: 'youtube.com' });
    const now = Date.now() / 1000;
    return cookies.some(c => LOGIN_COOKIES.has(c.name) && (!c.expirationDate || c.expirationDate > now));
  } catch { return false; }
}
const account = async () => ({ signedIn: await isSignedIn(), noHistory: prefs.noHistory });

// Option 3: the sign-in window asks like Firefox. Google's "this browser may not be secure" check looks at
// the user agent and at the Chromium client hints (Sec-CH-UA...), which a Firefox never sends; both are
// changed for this one window only. Best effort: Google can start refusing this at any time.
const FIREFOX_VERSION = '140.0';
const firefoxAgent = () => {
  const os = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}; rv:${FIREFOX_VERSION}) Gecko/20100101 Firefox/${FIREFOX_VERSION}`;
};
const spoofed = new Set<number>(); // web contents asking as Firefox

let signInWindow: BrowserWindow | null = null;
function openSignIn(parent: BrowserWindow | null): Promise<void> {
  if (signInWindow && !signInWindow.isDestroyed()) {
    const open = signInWindow;
    open.focus();
    return new Promise(resolve => open.once('closed', () => resolve()));
  }
  return new Promise(resolve => {
    const win = new BrowserWindow({
      width: 520, height: 720, parent: parent ?? undefined, autoHideMenuBar: true, title: 'Sign in to YouTube', backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    signInWindow = win;
    const id = win.webContents.id;
    spoofed.add(id);
    win.webContents.setUserAgent(firefoxAgent());
    // Nothing but the sign-in pages in here: other links open in the system browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    // Once the sign-in has taken us to YouTube and the login is there, the window has done its job
    const check = async () => {
      if (win.isDestroyed()) return;
      let host = '';
      try { host = new URL(win.webContents.getURL()).hostname; } catch { return; }
      if (/(^|\.)youtube\.com$/.test(host) && await isSignedIn() && !win.isDestroyed()) win.close();
    };
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-navigate-in-page', check);
    win.on('closed', () => { signInWindow = null; spoofed.delete(id); resolve(); });
    win.loadURL(`https://accounts.google.com/ServiceLogin?service=youtube&continue=${encodeURIComponent('https://www.youtube.com/')}`).catch(() => {});
  });
}

async function signOut() {
  const ses = session.defaultSession;
  for (const domain of ['youtube.com', 'google.com']) {
    for (const c of await ses.cookies.get({ domain }).catch(() => [])) {
      const host = (c.domain ?? '').replace(/^\./, '');
      await ses.cookies.remove(`http${c.secure ? 's' : ''}://${host}${c.path ?? '/'}`, c.name).catch(() => {});
    }
  }
}

// Puts cookies (pasted text, or the companion's JSON) in the session. They are given an end date, so they stay.
async function importCookies(text: string): Promise<number> {
  const cookies = parseCookies(text);
  const ses = session.defaultSession;
  let n = 0;
  for (const c of cookies) {
    try {
      await ses.cookies.set({
        url: `https://${c.domain}${c.path}`, name: c.name, value: c.value,
        // A cookie for the whole site (".youtube.com") has a domain; a host-only one must not
        ...(c.hostOnly ? {} : { domain: '.' + c.domain }),
        // The player is a cross-site frame in the app's page: a cookie with no SameSite counts as Lax and is
        // never sent to it, so the login would not reach YouTube. Everything is stored as SameSite=None.
        path: c.path, secure: true, httpOnly: c.httpOnly, sameSite: 'no_restriction', expirationDate: c.expires
      });
      n++;
    } catch { /* one the session refuses must not stop the others */ }
  }
  await ses.cookies.flushStore().catch(() => {});
  if (!(await isSignedIn())) throw new Error('The cookies were read but the session did not accept them. They may have expired: sign in again and copy fresh ones.');
  return n;
}

let pairing: Pairing | null = null;
const companionDir = () => path.join(app.getPath('userData'), 'browser-companion');

// Option 1: opens the pairing page in the default browser and waits for the companion to deliver the cookies
async function browserSignIn(): Promise<string | undefined> {
  pairing?.close();
  let mine: Pairing;
  try {
    mine = pairing = await startPairing(writeCompanion(companionDir()), async json => { await importCookies(json); });
  } catch (e) { return `Could not start the local link: ${(e as Error).message}`; }
  try { await shell.openExternal(mine.url); }
  catch (e) { mine.close(); return `Could not open your browser: ${(e as Error).message}`; }
  const r = await mine.result;
  if (pairing === mine) pairing = null;
  return r.ok || r.error === 'cancelled' ? undefined : r.error;
}

// The requests that put a video into the account's watch history
const HISTORY_PINGS = ['youtube.com', 'youtube-nocookie.com'].flatMap(h =>
  [`*://*.${h}/api/stats/playback*`, `*://*.${h}/api/stats/watchtime*`, `*://*.${h}/ptracking*`]);

// YouTube refuses embeds without a referrer (error 153); a file:// app sends none. And the Firefox-like
// sign-in window must not send Chromium's client hints. One listener does both: a session has only one.
const EMBEDS = /^https:\/\/(www\.youtube-nocookie\.com\/|www\.youtube\.com\/embed\/)/;

// Call once the app is ready
export function registerYoutubeAccount(mainWindow: () => BrowserWindow | null) {
  loadPrefs();
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest({ urls: HISTORY_PINGS }, (_details, cb) => cb({ cancel: prefs.noHistory }));
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, cb) => {
    const h = details.requestHeaders;
    if (details.webContentsId !== undefined && spoofed.has(details.webContentsId)) {
      for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k)) delete h[k];
      h['User-Agent'] = firefoxAgent();
    } else if (EMBEDS.test(details.url) && !h.Referer) h.Referer = 'https://libertad.app/';
    cb({ requestHeaders: h });
  });
  // Videos matching what was typed, read from YouTube's own results page (the consent cookie keeps it from asking about cookies)
  ipcMain.handle('youtube:search', async (_e, query: unknown) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Type something to search for');
    const bytes = await fetchLimited(youtubeSearchUrl(query), 4 * 1024 * 1024, 15000, false, { 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' });
    const html = new TextDecoder().decode(bytes);
    // A page without its data is not a results page (a consent or error page): that is not "nothing found"
    if (!html.includes('ytInitialData')) throw new Error('YouTube did not answer the search. Try again, or paste a link.');
    const found = parseYoutubeResults(html);
    return found;
  });
  ipcMain.handle('youtube:account', () => account());
  ipcMain.handle('youtube:signIn', async () => { await openSignIn(mainWindow()); return account(); });
  ipcMain.handle('youtube:browserSignIn', async () => { const error = await browserSignIn(); return { ...(await account()), error }; });
  ipcMain.handle('youtube:browserCancel', () => { pairing?.close(); });
  ipcMain.handle('youtube:companionFolder', () => writeCompanion(companionDir()));
  ipcMain.handle('youtube:openCompanionFolder', async () => { const dir = writeCompanion(companionDir()); await shell.openPath(dir); return dir; });
  ipcMain.handle('youtube:importCookies', async (_e, text: string) => {
    try { const imported = await importCookies(String(text).slice(0, 2_000_000)); return { ...(await account()), imported }; }
    catch (e) { return { ...(await account()), error: (e as Error).message }; }
  });
  ipcMain.handle('youtube:signOut', async () => { await signOut(); return account(); });
  ipcMain.handle('youtube:setNoHistory', (_e, on: boolean) => { prefs.noHistory = !!on; savePrefs(); return account(); });
}
