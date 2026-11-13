import { registerFileStore } from './filestore.ts';
import { registerTorrent } from './torrent.ts';
import { registerProfiles } from './profiles.ts';
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, net, shell, session, systemPreferences, type WebContents } from 'electron';
import { promises as fs, readFileSync, existsSync, readdirSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { IdentityStore } from './identity-store.ts';
import { describeCert } from './certs.ts';
import * as tray from './tray.ts';
import { fetchLinkPreview } from './link-preview.ts';
import { searchGiphy, fetchGif } from './giphy-search.ts';
import { fetchPublicListWith, pingServer } from './publist.ts';
import { openTls } from './tls-transport.ts';
import { udpChannel } from './udp-voice.ts';
import { registerYoutubeAccount } from './youtube-account.ts';
import { setYoutubeQuality, setYoutubeRate, getYoutubeVideoSize, getYoutubeFrame, hideYoutubeIndicator } from './yt-quality.ts';
import { checkForUpdate, installUpdate, checkOnStartup } from './updater.ts';
import { ShareAudio, pipewireAvailable, descendsFrom, VIRTUAL_MIC_LABEL, type AudioTarget } from './pipewire.ts';
import { WindowsShareAudio, windowsExcludeSupported } from './win-audio.ts';

const devUrl = process.env.VITE_DEV_SERVER_URL;

// The built app is served from a small local web server instead of file://. YouTube's embeds look at the
// page that embeds them: from file:// there is no referrer and no origin, which looks nothing like a browser.
// The port is fixed so cookies and localStorage belong to the same origin on every start.
const APP_PORT = 47931;
let appOrigin = '';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
  '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};
function serveDist(): Promise<string> {
  const root = path.resolve(__dirname, '../dist');
  const server = http.createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      const file = path.resolve(root, '.' + (rel === '/' ? '/index.html' : rel));
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  const listen = (port: number) => new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/`));
  });
  // If the fixed port is taken, any free one still works (only the saved localStorage starts over)
  return listen(APP_PORT).catch(() => listen(0));
}

// Screen sharing connects Libertad users directly. Chromium would hide this computer's addresses
// behind names that only resolve on the local network, so two people on IPv6 could not reach
// each other without a helper server. Only this app's own page runs here.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Lets the page list and switch the audio tracks of a video (the voice-over menu of Torrent Together)
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');

// Libertad used to be called mumh5, and its data folder was named after it. On the first start with the new
// name, copy what is in the old folder (identities, kept files, settings) into the new one. Each top-level
// entry is copied only if the new folder does not have it yet, so nothing is overwritten and the browser
// databases (which must not be mixed) stay whole. The old folder is left as it was. Caches and lock files are skipped.
(() => {
  try {
    const oldDir = path.join(app.getPath('appData'), 'mumh5');
    const newDir = app.getPath('userData');
    const done = path.join(newDir, '.migrated-from-mumh5');
    if (!existsSync(oldDir) || existsSync(done)) return;
    mkdirSync(newDir, { recursive: true });
    const skip = /^(Cache|Code Cache|GPUCache|DawnCache|ShaderCache|GrShaderCache|Singleton\w*|lockfile|\.org\.chromium.*)$/;
    for (const name of readdirSync(oldDir)) {
      if (skip.test(name) || existsSync(path.join(newDir, name))) continue;
      cpSync(path.join(oldDir, name), path.join(newDir, name), { recursive: true, filter: src => !skip.test(path.basename(src)) });
    }
    writeFileSync(done, new Date().toISOString());
  } catch { /* nothing to migrate, or no permission: start fresh */ }
})();

// System settings live in a file of their own: Chromium decides about the graphics card before
// the window exists, long before the page (and its localStorage) can be asked.
const systemFile = path.join(app.getPath('userData'), 'system.json');
const readSystem = (): { hardwareAcceleration?: boolean; autoUpdate?: boolean } => {
  try { return JSON.parse(readFileSync(systemFile, 'utf8')); } catch { return {}; }
};
const hardwareAcceleration = readSystem().hardwareAcceleration !== false;
if (!hardwareAcceleration) {
  app.disableHardwareAcceleration();
} else if (process.platform === 'linux') {
  // Chromium keeps video encoding and decoding on the processor on Linux unless asked; streams
  // then cost a lot of CPU. Names a Chromium version does not know are ignored.
  app.commandLine.appendSwitch('enable-features', 'AcceleratedVideoEncoder,AcceleratedVideoDecodeLinuxGL,VaapiVideoEncoder,VaapiVideoDecodeLinuxGL');
}
// Run on system startup. Windows and macOS have login items; Electron has none on Linux, where the
// desktop environments start what is listed in ~/.config/autostart.
const autostartFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'Libertad.desktop');
// An AppImage runs from a mounted copy of itself; the file it came from is what to start
const startCommand = () => process.env.APPIMAGE || process.execPath;
const launchOnStartup = (): boolean =>
  process.platform === 'linux' ? existsSync(autostartFile) : app.getLoginItemSettings().openAtLogin;
async function setLaunchOnStartup(on: boolean): Promise<void> {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: on });
    return;
  }
  if (!on) { await fs.rm(autostartFile, { force: true }); return; }
  // Desktop Entry Exec values: quote the path and escape the characters the spec reserves
  const exec = '"' + startCommand().replace(/(["`$\\])/g, '\\$1') + '"';
  await fs.mkdir(path.dirname(autostartFile), { recursive: true });
  await fs.writeFile(autostartFile, [
    '[Desktop Entry]', 'Type=Application', 'Name=Libertad', 'Comment=Modern Mumble client',
    `Exec=${exec}`, 'Icon=Libertad', 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''
  ].join('\n'));
}
ipcMain.handle('system:get', () => ({ hardwareAcceleration, autoUpdate: readSystem().autoUpdate !== false, launchOnStartup: launchOnStartup(), platform: process.platform }));
ipcMain.handle('system:setLaunchOnStartup', async (_e, on: boolean) => {
  // A development run would register Electron itself, not the app
  if (!app.isPackaged) throw new Error('only the installed app can do this');
  await setLaunchOnStartup(!!on);
});
ipcMain.handle('system:setHardwareAcceleration', async (_e, on: boolean) => {
  await fs.writeFile(systemFile, JSON.stringify({ ...readSystem(), hardwareAcceleration: !!on }));
});
ipcMain.handle('system:setAutoUpdate', async (_e, on: boolean) => {
  await fs.writeFile(systemFile, JSON.stringify({ ...readSystem(), autoUpdate: !!on }));
});
const updateProgress = (done: number, total: number) => mainWindow?.webContents.send('update:progress', done, total);
ipcMain.handle('update:check', () => checkForUpdate());
ipcMain.handle('update:install', () => installUpdate(updateProgress));
ipcMain.handle('system:relaunch', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('system:quit', () => { tray.quitApp(); });
// Chromium writes localStorage to disk a few seconds after a change, or on a clean quit; killing the app
// (pkill, a crash, the system closing it) loses what was still waiting. The page asks for a flush after saving.
ipcMain.handle('storage:flush', () => { session.defaultSession.flushStorageData(); });

// Keyboard shortcuts that also work while Libertad is in the background. The renderer sends the whole
// list each time it changes; each press goes back as a 'tray:action' of the form "shortcut:<id>".
// Resolves to the ones the system would not give us (another program has them), and whether this is
// Wayland, where the desktop decides about such shortcuts and may not offer them at all.
let globalActive = false;
ipcMain.handle('shortcuts:setGlobal', (_e, list: { id: string; accelerator: string }[]) => {
  const failed: string[] = [];
  const wayland = onWayland();
  const items = Array.isArray(list) ? list.slice(0, 20) : [];
  // Nothing registered and nothing wanted: leave the system alone (on Wayland even that makes noise in the desktop portal)
  if (!items.length && !globalActive) return { failed, wayland };
  globalShortcut.unregisterAll();
  globalActive = false;
  for (const item of items) {
    const id = String(item?.id ?? ''), accelerator = String(item?.accelerator ?? '');
    if (!/^[a-z-]{1,20}$/.test(id) || !accelerator) continue;
    let ok = false;
    try { ok = globalShortcut.register(accelerator, () => mainWindow?.webContents.send('tray:action', `shortcut:${id}`)); } catch { /* not a key combination the system knows */ }
    if (ok) globalActive = true; else failed.push(id);
  }
  return { failed, wayland };
});
app.on('will-quit', () => { if (globalActive) globalShortcut.unregisterAll(); });

let identityStore: IdentityStore | null = null;
const identities = () => (identityStore ??= new IdentityStore(app.getPath('userData')));

// ─── Mumble TLS connections, one per renderer request ─────────────────────────

type Conn = ReturnType<typeof openTls> & { owner: WebContents; udp?: ReturnType<typeof udpChannel> };
const conns = new Map<string, Conn>();

// ─── Identities (client certificates) ─────────────────────────────────────────

registerFileStore();
registerProfiles();
registerTorrent();
ipcMain.handle('identities:list', () => identities().list());
ipcMain.handle('identities:create', (_e, name: string, email: string) => identities().create(String(name), String(email ?? '')));
ipcMain.handle('identities:import', (_e, bytes: Uint8Array, password: string, name: string) =>
  identities().importP12(new Uint8Array(bytes), String(password ?? ''), String(name ?? '')));
ipcMain.handle('identities:findMumble', () => identities().findMumbleCertificate().then(f => f && { name: f.name }));
ipcMain.handle('identities:importMumble', (_e, name: string) => identities().importFromMumble(String(name ?? '')));
ipcMain.handle('identities:setDefault', (_e, id: string) => identities().setDefault(String(id)));
ipcMain.handle('identities:rename', (_e, id: string, name: string) => identities().rename(String(id), String(name)));
ipcMain.handle('identities:remove', (_e, id: string) => identities().remove(String(id)));
ipcMain.handle('identities:finishSetup', () => identities().finishSetup());

// Saves a password-protected .p12 backup where the user chooses; returns the path or null
ipcMain.handle('identities:export', async (e, id: string, password: string) => {
  const { bytes, name } = await identities().exportP12(String(id), String(password ?? ''));
  const win = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    title: 'Save identity backup',
    defaultPath: path.join(app.getPath('documents'), `${name.replace(/[^\w.-]+/g, '_') || 'identity'}.p12`),
    filters: [{ name: 'PKCS#12 certificate', extensions: ['p12', 'pfx'] }]
  };
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, bytes, { mode: 0o600 });
  return res.filePath;
});

// The renderer picks the connection id and subscribes before calling open, so no event can be missed
ipcMain.handle('mumble:open', async (e, connId: string, host: string, port: number, identityId?: string) => {
  if (typeof connId !== 'string' || conns.has(connId)) throw new Error('Invalid connection id');
  const id = await identities().get(identityId);
  const owner = e.sender;
  const emit = (channel: string, ...args: unknown[]) => { if (!owner.isDestroyed()) owner.send(channel, connId, ...args); };
  const conn = openTls(String(host), Number(port) || 64738, id.certPem, id.keyPem, {
    onSecure: info => {
      // Encrypted UDP voice to the address the TLS connection actually reached
      const udp = udpChannel(info.address, info.port);
      udp.onVoice = p => emit('mumble:udpVoice', p);
      udp.onState = (ok, rtt) => emit('mumble:udpState', ok, rtt);
      udp.onResync = () => emit('mumble:udpResync');
      const c = conns.get(connId);
      if (c) c.udp = udp;
      else udp.close();
      emit('mumble:secure', info);
    },
    onData: chunk => emit('mumble:data', chunk),
    onClose: reason => { conns.get(connId)?.udp?.close(); conns.delete(connId); emit('mumble:close', reason); }
  });
  conns.set(connId, Object.assign(conn, { owner }));
  owner.once('destroyed', () => conn.close());
});

ipcMain.on('mumble:send', (e, connId: string, bytes: Uint8Array) => {
  const conn = conns.get(connId);
  if (conn && conn.owner === e.sender) conn.send(bytes);
});

// UDP voice: keys from the server's CryptSetup, voice packets, nonce resync
const ownUdp = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, connId: string) => {
  const conn = conns.get(connId);
  return conn && conn.owner === e.sender ? conn.udp : undefined;
};
ipcMain.on('mumble:udpSetup', (e, connId: string, key: Uint8Array, cn: Uint8Array, sn: Uint8Array, protobuf: boolean) =>
  ownUdp(e, connId)?.setup(new Uint8Array(key), new Uint8Array(cn), new Uint8Array(sn), !!protobuf));
ipcMain.on('mumble:udpNonce', (e, connId: string, sn: Uint8Array) => ownUdp(e, connId)?.setServerNonce(new Uint8Array(sn)));
ipcMain.on('mumble:udpSend', (e, connId: string, bytes: Uint8Array) => ownUdp(e, connId)?.send(new Uint8Array(bytes)));
ipcMain.handle('mumble:udpClientNonce', (e, connId: string) => ownUdp(e, connId)?.clientNonce() ?? null);

ipcMain.on('mumble:close', (e, connId: string) => {
  const conn = conns.get(connId);
  if (conn && conn.owner === e.sender) conn.close();
});

// Parses DER certificates (e.g. a user's chain from UserStats) for the viewer
ipcMain.handle('certs:describe', (_e, ders: Uint8Array[]) =>
  (Array.isArray(ders) ? ders.slice(0, 8) : []).flatMap(d => { try { return [describeCert(Buffer.from(d))]; } catch { return []; } }));

// Edit commands for the renderer's context menu (clipboard access goes through the browser engine)
ipcMain.on('edit:action', (e, action: string, arg?: unknown) => {
  const wc = e.sender;
  switch (action) {
    case 'undo': return wc.undo();
    case 'redo': return wc.redo();
    case 'cut': return wc.cut();
    case 'copy': return wc.copy();
    case 'paste': return wc.paste();
    case 'selectAll': return wc.selectAll();
    case 'replaceMisspelling': return wc.replaceMisspelling(String(arg));
    case 'addWord': return wc.session.addWordToSpellCheckerDictionary(String(arg));
    case 'copyImageAt': { const p = arg as { x: number; y: number }; return wc.copyImageAt(p.x, p.y); }
    case 'saveImage': return wc.downloadURL(String(arg));
  }
});

ipcMain.handle('publist:fetch', (_e, url: string) => fetchPublicListWith(u => net.fetch(u), String(url)));
ipcMain.handle('publist:ping', (_e, host: string, port: number) => pingServer(String(host), Number(port)));

ipcMain.handle('yt:quality', (_e, level: string) => setYoutubeQuality(String(level)));
ipcMain.handle('yt:size', () => getYoutubeVideoSize());
ipcMain.handle('yt:frame', (_e, full?: boolean) => getYoutubeFrame(full === true));
// The video's own preview picture (320x180, no black bars), as a data address; null when it cannot be had
ipcMain.handle('yt:thumbnail', async (_e, id: string) => {
  if (!/^[\w-]{11}$/.test(String(id))) return null;
  // The picture link previews show (the large one), else the smaller one every video has
  for (const name of ['maxresdefault', 'mqdefault']) {
    try {
      const res = await net.fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`);
      if (res.ok) return `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    } catch { /* the next one */ }
  }
  return null;
});
ipcMain.handle('yt:rate', (_e, rate: number) => setYoutubeRate(Number(rate)));
ipcMain.handle('gif:search', (e, q: string, page: number) => searchGiphy(String(q), Number(page), BrowserWindow.fromWebContents(e.sender)));
ipcMain.handle('gif:fetch', (_e, url: string) => fetchGif(String(url).slice(0, 2048)));
ipcMain.handle('preview:fetch', (_e, url: string) => fetchLinkPreview(String(url).slice(0, 2048)));

// ─── Screen sharing ───────────────────────────────────────────────────────────
// The renderer lists the sources, the user picks one, and the next getDisplayMedia call gets it.
// On Wayland, listing already opens the system's picker and returns the one chosen source;
// `chosen` tells the renderer not to ask a second time.
let screenSources: Electron.DesktopCapturerSource[] = [];
let pickedSource: string | null = null;
const onWayland = () => process.platform === 'linux' && app.commandLine.getSwitchValue('ozone-platform') !== 'x11' &&
  (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

// Sound: PipeWire on Linux (one program or everything but this app); on Windows everything but this app
// (older Windows versions cannot leave this app out and fall back to the plain system loopback)
const shareAudio = new ShareAudio(() => {
  const pids = [process.pid, ...app.getAppMetrics().map(m => m.pid)];
  const names = [app.getName(), path.basename(process.execPath)].map(n => n.toLowerCase()).filter(Boolean);
  return { pids, names, isOwnPid: pid => descendsFrom(pid, pids) };
});
ipcMain.handle('share:info', async () => ({
  portal: onWayland(),
  audio: process.platform === 'win32' ? ((await windowsExcludeSupported()) ? 'system' : 'loopback') : (await pipewireAvailable()) ? 'pipewire' : 'none',
  micLabel: VIRTUAL_MIC_LABEL
}));
// The system's own camera switch: Windows has a privacy setting for all desktop programs, macOS asks once per app
ipcMain.handle('share:cameraAccess', async () => {
  try {
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('camera') === 'not-determined') {
      return (await systemPreferences.askForMediaAccess('camera')) ? 'granted' : 'denied';
    }
    return systemPreferences.getMediaAccessStatus('camera');
  } catch { return 'granted'; }
});
ipcMain.handle('share:openCameraSettings', async () => {
  const url = process.platform === 'win32' ? 'ms-settings:privacy-webcam'
    : process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera' : '';
  if (url) await shell.openExternal(url).catch(() => {});
});
ipcMain.handle('share:audioApps', () => shareAudio.apps().catch(() => []));
const windowsAudio = new WindowsShareAudio();
ipcMain.handle('share:audioStart', (e, target: AudioTarget) => {
  if (process.platform === 'win32') return windowsAudio.start(chunk => { if (!e.sender.isDestroyed()) e.sender.send('share:pcm', chunk); });
  return shareAudio.start(target?.kind === 'app' ? { kind: 'app', name: String(target.name) } : { kind: 'all' });
});
ipcMain.handle('share:audioStop', () => { windowsAudio.stop(); return shareAudio.stop(); });
// Chromium fetches spellcheck dictionaries from Google (redirector.gvt1.com) as soon as a session
// exists, even with spellcheck off; only an empty language list stops it
app.on('session-created', s => {
  s.setSpellCheckerEnabled(false);
  s.setSpellCheckerLanguages([]);
});
// The virtual microphone outlives the process otherwise
app.on('will-quit', () => { shareAudio.stop(); windowsAudio.stop(); });

// Names first (fast and dependable), thumbnails in a second call: grabbing the pictures can be
// slow and, under X11, can come back with nothing.
ipcMain.handle('share:sources', async (_e, thumbnails: boolean) => {
  const wayland = onWayland();
  const size = thumbnails ? { width: 320, height: 180 } : { width: 0, height: 0 };
  const list = () => desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: size });
  let found = await list();
  // Not on Wayland, where empty means the user cancelled the system's picker and asking again would reopen it
  for (let i = 0; i < 3 && !found.length && !wayland; i++) {
    await new Promise(r => setTimeout(r, 250));
    found = await list();
  }
  if (found.length || !thumbnails) screenSources = found;
  return {
    chosen: wayland && found.length === 1,
    sources: found.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() }))
  };
});
ipcMain.on('share:pick', (_e, id: string) => { pickedSource = String(id); });

ipcMain.on('tray:update', (_e, state: tray.TrayState) => tray.update(state));

ipcMain.handle('platform:info', () => ({ os: process.platform, osVersion: os.release() }));

ipcMain.handle('window:setFullScreen', (_e, fullscreen: boolean) => {
  if (mainWindow) mainWindow.setFullScreen(fullscreen);
});
ipcMain.handle('window:isFullScreen', () => mainWindow?.isFullScreen() ?? false);

// The pop-out windows (one per picture, named by the frame name the app opened them with): full screen
// of that window alone, and back to the window it was when it ends. Returns the state asked for.
const popups = new Map<string, BrowserWindow>();
ipcMain.handle('popout:setFullScreen', (_e, name: string, fullscreen?: boolean) => {
  const win = popups.get(String(name));
  if (!win || win.isDestroyed()) return false;
  const want = typeof fullscreen === 'boolean' ? fullscreen : !win.isFullScreen();
  win.setFullScreen(want);
  return want;
});
ipcMain.handle('popout:isFullScreen', (_e, name: string) => {
  const win = popups.get(String(name));
  return !!win && !win.isDestroyed() && win.isFullScreen();
});

// ─── Window ────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: '#111214',
    title: 'Libertad',
    // Window and taskbar icon on Linux (Windows and macOS take it from the package)
    icon: path.join(__dirname, '../dist/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      // Voice must play without a click first
      autoplayPolicy: 'no-user-gesture-required',
      // Keep audio and timers running at full speed when the window is in the background
      backgroundThrottling: false,
      // Off until it can work without fetching dictionaries (see session-created)
      spellcheck: false
    }
  });

  // Links from chat open in the system browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // The stream window: an empty page the app fills with the video itself
    if (frameName === 'libertad-stream' && (url === 'about:blank' || url === '')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 600, minWidth: 320, minHeight: 200, backgroundColor: '#000000', autoHideMenuBar: true, title: 'Libertad' } };
    }
    // The pop-out windows: YouTube, and one for each screen, camera or watch together picture
    if ((frameName === 'libertad-watch' || frameName.startsWith('libertad-pop-')) && (url === 'about:blank' || url === '')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 600, minWidth: 320, minHeight: 200, backgroundColor: '#000000', autoHideMenuBar: true, title: 'Libertad Watch Together' } };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child, { frameName }) => {
    if (!frameName) return;
    popups.set(frameName, child);
    child.on('closed', () => { if (popups.get(frameName) === child) popups.delete(frameName); });
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (devUrl && url.startsWith(devUrl)) return;
    if (appOrigin && url.startsWith(appOrigin)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow = win;
  win.on('close', e => {
    if (tray.shouldHideOnClose()) {
      e.preventDefault();
      win.hide();
    }
  });
  // No default menu in Electron: report what was right-clicked, the renderer shows its own menu
  // (custom menus call preventDefault, which suppresses this event)
  win.webContents.on('context-menu', (_e, p) => {
    win.webContents.send('context-menu', {
      x: p.x, y: p.y, isEditable: p.isEditable, selectionText: p.selectionText, linkURL: p.linkURL,
      mediaType: p.mediaType, srcURL: p.srcURL, misspelledWord: p.misspelledWord,
      suggestions: p.dictionarySuggestions.slice(0, 5), editFlags: p.editFlags
    });
  });
  win.on('show', () => tray.onWindowVisibility());
  win.on('hide', () => tray.onWindowVisibility());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  if (devUrl) win.loadURL(devUrl);
  else serveDist().then(url => { appOrigin = url; return win.loadURL(url); }).catch(err => console.error('could not start the app server:', err));
}

// YouTube's bot check ("Sign in to confirm you're not a bot") looks at who is asking: the default user
// agent names Electron and this app, which no browser does. Ask like the plain Chromium this is.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|Libertad)\/\S+/g, '');

app.whenReady().then(async () => {
  // macOS asks once per app for microphone access
  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone').catch(() => false);
  hideYoutubeIndicator();
  registerYoutubeAccount(() => mainWindow);
  // (the referrer YouTube's embeds need is added in youtube-account.ts, which owns the session's header listener)

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const source = screenSources.find(s => s.id === pickedSource);
    pickedSource = null;
    // Without a picked source the request is refused
    try {
      if (!source) callback({});
      else if (request.audioRequested && process.platform === 'win32') callback({ video: source, audio: 'loopback' });
      else callback({ video: source });
    } catch { /* refused */ }
  });

  // Microphone, camera and screen capture for voice and video; nothing else
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-sanitized-write', 'notifications'].includes(permission));
  });
  createWindow();
  if (readSystem().autoUpdate !== false) setTimeout(() => { void checkOnStartup(() => mainWindow, updateProgress); }, 4000);
  await tray.setupTray(() => mainWindow, action => mainWindow?.webContents.send('tray:action', action));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
