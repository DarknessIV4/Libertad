import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { openChannel } from './channel.ts';
import { Connections, fromB64, toB64 } from './connections.ts';
import { AndroidIdentityStore } from './identities.ts';
import { describeCert } from '../../../electron/certs.ts';
import { pingServer, fetchPublicListWith } from '../../../electron/publist.ts';
import { parseYoutubeResults, parseYoutubeData, youtubeSearchUrl, YOUTUBE_JSON_SEARCH, youtubeJsonBody } from '../../../src/core/youtube-search.ts';
import { CH, type CallMethod, type CastMethod, type CallMsg, type CastMsg, type ReplyMsg, type P12Backup } from '../../shared/protocol.ts';

// Entry point of the Mumble backend for the Android app.
//
// Runs inside Node.js for Mobile Apps (nodejs-mobile), started by the capacitor-nodejs plugin: scripts/build-node.mjs
// bundles this into dist-android/nodejs/index.js, and Capacitor copies that folder into the APK next to the web
// files. The page (Capacitor WebView, src/lib/native-android.ts) talks to it over the plugin's channel.
//
// Only Mumble server support lives here: connections (TLS + encrypted UDP voice), client certificates, server
// pings and the public server list. Friends, calls, file sharing and torrents are not part of it yet.

// nodejs-mobile cannot restart its runtime without restarting the app, so a stray error must not end the process
process.on('uncaughtException', e => console.error('[mobile] uncaught exception:', e));
process.on('unhandledRejection', e => console.error('[mobile] unhandled rejection:', e));

const channel = openChannel();

let store: Promise<AndroidIdentityStore> | null = null;
const identities = () => (store ??= (async () => {
  const dir = path.join(channel.dataPath(), 'libertad');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return new AndroidIdentityStore(dir);
})().catch(e => { store = null; throw e; }));

const connections = new Connections(e => channel.send(CH.event, e), identities);

const DESKTOP_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

// ─── Calls the page waits for an answer to ───────────────────────────────────

const calls: Record<CallMethod, (...a: any[]) => unknown> = {
  platformInfo: () => ({ os: 'android', osVersion: os.release() }),

  // This phone's own IPv4 addresses on its networks. The WebView hides them behind random ".local" names that no other
  // device can resolve, which breaks screen and camera streams on the same network (see src/lib/ice.ts).
  localAddresses: () => Object.values(os.networkInterfaces()).flatMap(list => list ?? [])
    .filter(i => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map(i => i.address),

  // Parses DER certificates (e.g. a user's chain from UserStats) for the viewer
  describeCerts: (ders: unknown) =>
    (Array.isArray(ders) ? ders.slice(0, 8) : []).flatMap(d => { try { return [describeCert(Buffer.from(fromB64(d)))]; } catch { return []; } }),

  // Mumble's UDP ping: people on a server without connecting
  pingServer: (host: unknown, port: unknown) => pingServer(String(host), Number(port)),
  // Mumble's list sits behind a CDN that refuses non-browser TLS clients (HTTP 501 for Node), which is why the desktop
  // app fetches it with Chromium's network stack. Here Node's fetch is tried with a browser's headers; if the list
  // server still answers 501, fetch it in the page instead (see mobile/README.md).
  publicServers: (url: unknown) => {
    if (!/^https?:\/\//i.test(String(url))) throw new Error('Invalid list address');
    return fetchPublicListWith(u => fetch(u, { headers: BROWSER_HEADERS }), String(url));
  },

  // YouTube together: videos matching what was typed, read from YouTube's own results page. The page cannot fetch it
  // itself (YouTube sends no CORS headers), so Node does, as the desktop app's main process does.
  youtubeSearch: async (query: unknown) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Type something to search for');
    const cookie = 'CONSENT=YES+1; SOCS=CAI';
    // A desktop agent on purpose: with the phone's, YouTube answers with its mobile page, laid out differently from
    // the one the parser (and the desktop app) reads
    const headers = { ...BROWSER_HEADERS, 'user-agent': DESKTOP_AGENT, 'accept-language': 'en-US,en;q=0.9', cookie };
    const notes: string[] = [];
    // 1. The results page
    try {
      const res = await fetch(youtubeSearchUrl(query), { headers, signal: AbortSignal.timeout(15000) });
      const html = (await res.text()).slice(0, 4 * 1024 * 1024);
      const found = parseYoutubeResults(html);
      if (found.length) return found;
      notes.push(`page ${res.status}, ${html.length} bytes, data ${html.includes('ytInitialData') ? 'present' : 'missing'}${res.url && !res.url.includes('/results') ? `, sent to ${new URL(res.url).host}` : ''}`);
    } catch (e) { notes.push(`page failed: ${(e as Error).message}`); }
    // 2. YouTube's JSON search, which has no consent page or layout variants to get past
    try {
      const res = await fetch(YOUTUBE_JSON_SEARCH, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', origin: 'https://www.youtube.com' },
        body: youtubeJsonBody(query),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) { notes.push(`json ${res.status}`); }
      else {
        const found = parseYoutubeData(await res.json());
        if (found.length) return found;
        notes.push('json had no videos');
      }
    } catch (e) { notes.push(`json failed: ${(e as Error).message}`); }
    // Neither found a video: say what happened rather than "nothing found", which would hide a problem
    throw new Error(`YouTube gave no results (${notes.join('; ')}). Try again, or paste a link.`);
  },

  'identities.list': async () => (await identities()).list(),
  'identities.create': async (name: unknown, email: unknown) => (await identities()).create(String(name), String(email ?? '')),
  'identities.importP12': async (bytes: unknown, password: unknown, name: unknown) =>
    (await identities()).importP12(fromB64(bytes), String(password ?? ''), String(name ?? '')),
  // There is no desktop Mumble client on a phone to take a certificate from
  'identities.findMumble': () => null,
  'identities.importMumble': () => { throw new Error('There is no desktop Mumble client on this phone.'); },
  // Android has no save dialog in Node: the bytes go to the page, which saves the file
  'identities.exportP12': async (id: unknown, password: unknown): Promise<P12Backup> => {
    const { bytes, name } = await (await identities()).exportP12(String(id), String(password ?? ''));
    return { name, bytes: toB64(bytes) };
  },
  'identities.setDefault': async (id: unknown) => (await identities()).setDefault(String(id)),
  'identities.rename': async (id: unknown, name: unknown) => (await identities()).rename(String(id), String(name)),
  'identities.remove': async (id: unknown) => (await identities()).remove(String(id)),
  'identities.finishSetup': async () => (await identities()).finishSetup(),

  open: (connId: unknown, host: unknown, port: unknown, identityId?: unknown) => connections.open(connId, host, port, identityId),
  udpClientNonce: (connId: unknown) => connections.udpClientNonce(connId)
};

// ─── Messages with no answer (bytes to send, UDP keys) ───────────────────────

const casts: Record<CastMethod, (...a: any[]) => void> = {
  send: (connId, data) => connections.send(connId, data),
  close: connId => connections.close(connId),
  udpSetup: (connId, key, cn, sn, protobuf) => connections.udpSetup(connId, key, cn, sn, protobuf),
  udpNonce: (connId, sn) => connections.udpNonce(connId, sn),
  udpSend: (connId, data) => connections.udpSend(connId, data)
};

channel.on(CH.call, async (msg: CallMsg) => {
  if (!msg || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
  const reply = (r: ReplyMsg) => channel.send(CH.reply, r);
  const fn = Object.hasOwn(calls, msg.method) ? calls[msg.method] : null;
  if (!fn) return reply({ id: msg.id, ok: false, error: `Unknown call: ${msg.method}` });
  try {
    reply({ id: msg.id, ok: true, value: (await fn(...(Array.isArray(msg.args) ? msg.args : []))) ?? null });
  } catch (e) {
    reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

channel.on(CH.cast, (msg: CastMsg) => {
  if (!msg || typeof msg.method !== 'string' || !Object.hasOwn(casts, msg.method)) return;
  try { casts[msg.method](...(Array.isArray(msg.args) ? msg.args : [])); } catch (e) { console.error(`[mobile] ${msg.method}:`, e); }
});

// The page says hello until it hears `ready` (this process may have started before the page was listening).
// A new token means a new page: whatever the old one had open is closed. The same token again changes nothing.
let pageToken: string | null = null;
channel.on(CH.hello, (token: unknown) => {
  if (typeof token !== 'string' || !token) return;
  if (token !== pageToken) {
    pageToken = token;
    connections.closeAll();
  }
  channel.send(CH.ready, token);
});

// Connections stay open in the background only while Android lets this process run: it needs the foreground
// service the app adds on the Android side (see mobile/README.md). Nothing to do here but log it.
channel.onLifecycle(state => console.log(`[mobile] app ${state}`));

console.log(`[mobile] Mumble backend started (node ${process.version}, ${process.platform})`);
