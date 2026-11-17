import { registerFileStore } from './filestore.ts';
import { registerTorrent } from './torrent.ts';
import { registerProfiles } from './profiles.ts';
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, net, screen, shell, session, systemPreferences, type WebContents } from 'electron';
import { promises as fs, createReadStream, readFileSync, existsSync, readdirSync, cpSync, mkdirSync, writeFileSync, appendFileSync, statSync, renameSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import v8 from 'node:v8';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { IdentityStore } from './identity-store.ts';
import { describeCert } from './certs.ts';
import * as tray from './tray.ts';
import { fetchLinkPreview } from './link-preview.ts';
import { searchGiphy, fetchGif } from './giphy-search.ts';
import { fetchPublicListWith, pingServer } from './publist.ts';
import { openTls } from './tls-transport.ts';
import { registerP2p } from './p2p.ts';
import { listGpus, planGpu } from './gpu.ts';
import { udpChannel } from './udp-voice.ts';
import { registerYoutubeAccount } from './youtube-account.ts';
import { setYoutubeQuality, setYoutubeRate, getYoutubeVideoSize, getYoutubeFrame, hideYoutubeIndicator } from './yt-quality.ts';
import { checkForUpdate, installUpdate, checkOnStartup } from './updater.ts';
import { ShareAudio, pipewireAvailable, descendsFrom, VIRTUAL_MIC_LABEL, type AudioTarget } from './pipewire.ts';
import { WindowsShareAudio, windowsExcludeSupported } from './win-audio.ts';

// Linux on a Wayland desktop: the app runs on X11 (through XWayland) unless Settings > System says Wayland. As a native Wayland window
// the call bar that is dragged out of the app (an always-on-top window that follows the cursor and goes back in when it is dropped on
// the app) does not work: Wayland gives a program no say over where its windows are or what is over what. Chromium decides about this
// before any script runs, so a switch set from here is too late: the app starts itself once more with the switch on the command line.
// X11 sessions are X11 already. `npm run dev` passes the switch itself (scripts/dev.mjs). LIBERTAD_WAYLAND=1 forces Wayland, and a
// --ozone-platform given on the command line by the person starting the app is respected.
//
// IMPORTANT: on a Wayland session Electron itself adds `--ozone-platform=wayland` to its command line before any script runs, so
// app.commandLine.hasSwitch('ozone-platform') is ALWAYS true there and says nothing about what the person asked for. (That made the
// packaged app skip this relaunch and run as a native Wayland window, while `npm run dev` worked because dev.mjs passes the flag.)
// What the person asked for can only be read from the real process arguments (process.argv).
const AUTO_X11_FLAG = '--libertad-auto-x11';
// An AppImage that was started with --appimage-extract-and-run (a computer where FUSE does not work) must start itself again the
// same way: the plain start needs FUSE and shows "Cannot mount AppImage". The runtime unpacks into /tmp/appimage_extracted_*.
const keepExtractMode = (): void => {
  if (process.env.APPIMAGE && /appimage_extracted_/.test(process.env.APPDIR ?? '')) process.env.APPIMAGE_EXTRACT_AND_RUN = '1';
};
// Starts the app again as a program of its own, and the caller quits. This is not app.relaunch(): from an AppImage that starts the
// file again with this copy's environment and its folder as the working directory. The folder is the mounted AppImage, which goes
// away the moment this copy quits, and the variables of the running copy (APPDIR, ARGV0, OWD) belong to it, not to the next one.
// The new AppImage then finds no folder to stand in or a mount that is being torn down, and shows "Cannot mount AppImage".
const startAgain = (args: string[]): void => {
  keepExtractMode();
  const env: NodeJS.ProcessEnv = { ...process.env };
  const cwd = (process.env.OWD && existsSync(process.env.OWD) ? process.env.OWD : os.homedir());
  if (process.env.APPIMAGE) for (const k of ['APPDIR', 'ARGV0', 'OWD']) delete env[k];
  try {
    const child = spawn(process.env.APPIMAGE || process.execPath, args, { detached: true, stdio: 'ignore', cwd, env });
    child.on('error', () => { /* nothing more to do: the app is closing */ });
    child.unref();
  } catch { /* fall back to Electron's own */
    app.relaunch({ execPath: process.env.APPIMAGE || process.execPath, args });
  }
  app.exit(0);
};
const ozoneArg = (a: string) => /^--ozone-platform(-hint)?(=|$)/.test(a);
const savedDisplayServer = (): 'x11' | 'wayland' => {
  if (process.env.LIBERTAD_WAYLAND) return 'wayland';
  try {
    const d = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'system.json'), 'utf8')).displayServer;
    if (d === 'wayland') return 'wayland';
  } catch { /* nothing saved yet */ }
  return 'x11';
};
const waylandSession = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
// The arguments the app was really started with, without the ones this app added to itself for X11
const userArgs = (): string[] => process.argv.slice(1).filter(a => a !== AUTO_X11_FLAG && !(process.argv.includes(AUTO_X11_FLAG) && ozoneArg(a)));
const startedByUsAsX11 = process.argv.includes(AUTO_X11_FLAG);
// An --ozone-platform / --ozone-platform-hint that somebody typed (not the one added by this app for X11)
const userChoseOzone = process.argv.slice(1).some(a => ozoneArg(a)) && !startedByUsAsX11;
if (waylandSession && !startedByUsAsX11 && !userChoseOzone && !process.env.LIBERTAD_X11_RELAUNCHED && savedDisplayServer() === 'x11') {
  // Taken along into the new process: it can not start itself a third time if the switch were ever not seen
  process.env.LIBERTAD_X11_RELAUNCHED = '1';
  // From an AppImage the file it came from is what starts again (the folder it runs from goes away with this process)
  startAgain([...userArgs(), '--ozone-platform=x11', AUTO_X11_FLAG]);
  process.exit(0);
}
// The loop guard has done its work; programs started from here (an update, the tray) decide for themselves
delete process.env.LIBERTAD_X11_RELAUNCHED;
// Starts the app again (settings that apply after a restart). The X11 flags this app added to itself are left out, so the saved choice
// in Settings > System is decided anew: otherwise a person who went back to Wayland would be put on X11 again by the old arguments.
// From an AppImage the file it came from is what starts again, not the folder it was mounted in.
const relaunchApp = (): void => {
  // The new copy starts while this one is still closing: it is told so, and the lock is handed over now
  process.env.LIBERTAD_RESTARTING = '1';
  try { app.releaseSingleInstanceLock(); } catch { /* none held */ }
  startAgain(userArgs());
};

// One copy of the app per data folder. Two copies share one identity, so both go online on the friend network with the same key:
// the friend's computer keeps only one of the two connections, the other one reconnects, and so on, over and over. A call on the
// connection that lost is cut every few seconds (both people go silent and have to call again). A second start brings the first
// one to the front instead. (Not in `npm run dev`, which restarts itself on every change; LIBERTAD_ALLOW_MULTIPLE=1 turns it off.)
const restarting = !!process.env.LIBERTAD_RESTARTING;
delete process.env.LIBERTAD_RESTARTING;
const takeLock = (): boolean => {
  // After a restart the old copy may still hold the lock for a moment: wait for it (up to 8 s) instead of quitting
  for (let i = 0; i < 80; i++) {
    if (app.requestSingleInstanceLock()) return true;
    if (!restarting) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return false;
};
if (!process.env.VITE_DEV_SERVER_URL && !process.env.LIBERTAD_ALLOW_MULTIPLE && !takeLock()) {
  app.exit(0);
  process.exit(0);
}
app.on('second-instance', () => {
  const w = reviveWindow();
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
});

// Friends and calls run over UTP/UDP, where a peer vanishing mid-handshake (UTP_ECONNRESET and its kin) raises an
// 'error' on a connection nobody owns yet. That is routine network noise, not a bug: it must not pop up a dialog
// or take the main process down. Everything else is reported as before.
const NETWORK_CODES = /^(UTP_|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EADDRNOTAVAIL|CHANNEL_CLOSED|STREAM_DESTROYED)/;
function isNetworkNoise(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; stack?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  const text = `${typeof e?.message === 'string' ? e.message : ''}\n${typeof e?.stack === 'string' ? e.stack : ''}`;
  return NETWORK_CODES.test(code) || /\b(UTP_[A-Z]+|ECONNRESET)\b/.test(text) || /node_modules\/(utp-native|udx-native|hyperdht|@hyperswarm)\b/.test(text) && /ECONN|EPIPE|ETIMEDOUT|reset|closed|destroyed/i.test(text);
}
process.on('uncaughtException', err => {
  if (isNetworkNoise(err)) { console.warn('Ignored network error:', (err as Error)?.message ?? err); return; }
  console.error(err);
  try { dialog.showErrorBox('A JavaScript error occurred in the main process', String((err as Error)?.stack ?? err)); } catch { /* app not ready */ }
});
process.on('unhandledRejection', reason => {
  if (isNetworkNoise(reason)) return;
  console.error(reason);
});

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
      const st = await fs.stat(file);
      if (!st.isFile()) { res.writeHead(404).end(); return; }
      // Streamed, so a big file (the speech models, the wasm) is not read into the main process whole; the hashed build files never change
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { if (!res.headersSent) res.writeHead(404).end(); else res.destroy(); }
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
const disabledFeatures = ['WebRtcHideLocalIpsWithMdns'];
// Lets the page list and switch the audio tracks of a video (the voice-over menu of Torrent Together)
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');
// Timers and process priority stay at full speed in the background through these switches, not through
// backgroundThrottling:false. That option also stops Chromium from ever marking the page hidden, so the compositor and
// the GPU process keep every tile and texture of a window nobody sees (the "Throttle when hidden" saving never happened).
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

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
const readSystem = (): { displayServer?: 'x11' | 'wayland'; hardwareAcceleration?: boolean; gpu?: string; gpuTrial?: boolean; gpuReverted?: string; autoUpdate?: boolean; throttleWhenHidden?: boolean; deepSleep?: boolean } => {
  try { return JSON.parse(readFileSync(systemFile, 'utf8')); } catch { return {}; }
};
let gpuTrial = false;
let extraFeatures: string[] = [];
let softwareVideo = false;
const hardwareAcceleration = readSystem().hardwareAcceleration !== false;
// In a development run, what Chromium made of the graphics (is video encoding and decoding on the card?) goes to the terminal
if (!app.isPackaged) app.whenReady().then(() => setTimeout(() => console.log('[gpu] features', JSON.stringify(app.getGPUFeatureStatus()), 'LIBVA_DRIVER_NAME=', process.env.LIBVA_DRIVER_NAME ?? '(unset)'), 6000));
if (!hardwareAcceleration) {
  app.disableHardwareAcceleration();
} else if (process.platform === 'linux') {
  // Chromium keeps video encoding and decoding on the processor on Linux unless asked; streams
  // then cost a lot of CPU. Names a Chromium version does not know are ignored.
  // With two graphics chips: the one chosen in the settings does the work ('auto' leaves it to Chromium)
  // A choice is a trial until the window has shown a picture (see below): one that never got that far (a black window, the
  // app closed or crashed) is taken back to automatic at the next start, so a bad choice can not lock anybody out.
  const sys = readSystem();
  if (sys.gpu === 'software') {
    // Video encoding and decoding stay on the processor (the window is still drawn by the graphics card). Nothing to trial: it only
    // takes the video engines out.
    disabledFeatures.push('VaapiVideoDecoder', 'VaapiVideoEncoder', 'VaapiVideoDecodeLinuxGL', 'AcceleratedVideoDecodeLinuxGL', 'AcceleratedVideoEncoder', 'VaapiOnNvidiaGPUs');
    softwareVideo = true;
    console.log('[gpu] video work on the processor (software)');
  } else if (sys.gpuTrial === true && sys.gpu && sys.gpu !== 'auto') {
    writeFileSync(systemFile, JSON.stringify({ ...sys, gpu: 'auto', gpuTrial: false, gpuReverted: sys.gpu }));
    console.log('[gpu] the last choice never showed a picture, back to automatic');
  } else {
    const plan = planGpu(sys.gpu);
    if (plan) {
      extraFeatures = plan.features;
      if (plan.renderNode) app.commandLine.appendSwitch('render-node-override', plan.renderNode);
      console.log('[gpu] using', plan.gpu.label, plan.gpu.node, plan.features.join(','));
      writeFileSync(systemFile, JSON.stringify({ ...sys, gpuTrial: true, gpuReverted: undefined }));
      gpuTrial = true;
    }
  }
  // One switch with all of them (a second one would replace the first)
  if (!softwareVideo) app.commandLine.appendSwitch('enable-features', ['AcceleratedVideoEncoder', 'AcceleratedVideoDecodeLinuxGL', 'VaapiVideoEncoder', 'VaapiVideoDecodeLinuxGL', ...extraFeatures].join(','));
}
app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));
// A log file for the installed app: an AppImage started from a menu has no terminal to read. It is kept small (the old half is
// moved aside at 1 MB). Settings > System in the app does not show it; it lives next to system.json as libertad.log.
const logFile = path.join(app.getPath('userData'), 'libertad.log');
try { if (statSync(logFile).size > 1024 * 1024) renameSync(logFile, `${logFile}.old`); } catch { /* none yet */ }
const log = (...parts: unknown[]): void => {
  try {
    const text = parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
    appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
  } catch { /* the folder is not writable: nothing to do */ }
};
// What this run is (the first things to ask when something works from npm run dev and not from the AppImage)
log('start', { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged, appimage: !!process.env.APPIMAGE,
  session: process.env.XDG_SESSION_TYPE ?? '', waylandDisplay: !!process.env.WAYLAND_DISPLAY, ozone: app.commandLine.getSwitchValue('ozone-platform'),
  startedAsX11ByApp: startedByUsAsX11, args: process.argv.slice(1) });
// A helper process of Chromium that died (the audio service is the one that carries every microphone and speaker stream of the page)
app.on('child-process-gone', (_e, d) => {
  log('child-process-gone', { type: d.type, name: d.name ?? '', reason: d.reason, exitCode: d.exitCode });
  if (d.type === 'Utility' && /audio/i.test(d.name ?? '')) {
    // Every stream the page had on it is dead although the page does not know: it builds its audio again
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('audio:serviceGone');
  }
});
app.on('render-process-gone', (_e, _wc, d) => log('render-process-gone', { reason: d.reason, exitCode: d.exitCode }));

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
// While the window is hidden (to the tray, or minimized) the page stops drawing and fetching, and keeps only what the
// connection needs (voice, chat, profiles). Unlike the settings above this takes effect at once, no restart.
let throttleWhenHidden = readSystem().throttleWhenHidden !== false;
let pageHidden = false;
// Whether each window is out of sight, from the events themselves: asking isVisible() inside a 'hide' handler can still
// answer true on some Linux desktops, which would leave the page drawing.
const gone = new WeakMap<BrowserWindow, boolean>();
const trackVisibility = (w: BrowserWindow, onChange: (why: string) => void) => {
  const on = (why: string, away: boolean) => w.on(why as 'show', () => { gone.set(w, away); onChange(why); });
  on('show', false); on('restore', false); on('hide', true); on('minimize', true);
};
// Development only (npm run dev): what the throttle decides, and what each process holds
const dev = () => !app.isPackaged;
// A full garbage collection of this process on demand (the flag is switched on at run time, no launch option needed)
let collectMain: (() => void) | null = null;
try { v8.setFlagsFromString('--expose-gc'); collectMain = vm.runInNewContext('gc') as () => void; } catch { /* not available */ }
const mainHeap = () => { const m = process.memoryUsage(); const mb = (n: number) => Math.round(n / 1048576); return `main heap ${mb(m.heapUsed)}/${mb(m.heapTotal)}MB, external ${mb(m.external)}MB, buffers ${mb(m.arrayBuffers)}MB, rss ${mb(m.rss)}MB`; };
// On Linux the working set counts every shared library once per process; PSS splits shared pages between the processes
// that use them, which is what a task manager that adds things up would show
const pssMB = (pid: number): number | null => {
  try { const m = /Pss:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')); return m ? Number(m[1]) / 1024 : null; } catch { return null; }
};
const memory = () => app.getAppMetrics().map(m => `${m.type} ${Math.round((process.platform === 'linux' ? pssMB(m.pid) : null) ?? (m.memory.privateBytes ?? m.memory.workingSetSize) / 1024)}MB`).join(' | ') + (process.platform === 'linux' ? ' (PSS)' : '');
// The page is told when it is hidden. Chromium's own timer throttling stays off on purpose (see createWindow): the
// Mumble ping and the voice timers must keep their rhythm, so the saving comes from the page doing less, not from slower timers.
function applyHidden(why = 'check'): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const away = gone.get(win) ?? false;
  // A pop-out window (stream, camera, Watch Together) is drawn by the page: while one is on screen the page is in use
  const popupShown = [...popups.values()].some(p => !p.isDestroyed() && !(gone.get(p) ?? false));
  // A call with a friend: the page holds the microphone, the speakers and the codec. Its window being reported as hidden (a desktop
  // that does not report minimize and restore reliably, as Wayland does not) must not take any of that away.
  const hidden = throttleWhenHidden && away && !popupShown && !p2pCall.inCall();
  if (dev()) console.log(`[throttle] ${why}: window ${away ? 'out of sight' : 'shown'}, pop-out ${popupShown ? 'shown' : 'none'}, setting ${throttleWhenHidden ? 'on' : 'off'} -> ${hidden === pageHidden ? `no change (${hidden ? 'hidden' : 'shown'})` : hidden ? 'HIDDEN' : 'SHOWN'}`);
  if (hidden === pageHidden) return;
  pageHidden = hidden;
  // Let Chromium treat the page as hidden (frees compositor tiles and GPU textures, stops frames) only while we want that.
  // Timers are unaffected, see the switches near the top.
  win.webContents.setBackgroundThrottling(hidden);
  win.webContents.send('window:hidden', hidden);
  if (hidden) armSleep(); else { if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; } if (asleep) wake(win); }
}
// Hidden for 15 seconds with no server connected (and no pop-out): nothing needs the page, so let go of it altogether. Its
// renderer process, audio service and every cache go; showing the window loads the app again (a few moments, and it opens on
// the start screen). While connected the page stays, because voice is captured, mixed and played there.
const SLEEP_AFTER_MS = 15_000;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let asleep = false;
// Deep sleep: the window itself is destroyed. Remembered so the next one opens where this one was.
let deepSleeping = false;
let savedBounds: { bounds: Electron.Rectangle; maximized: boolean } | null = null;
// Off unless "deepSleep": true is in system.json: measured, destroying the window freed nothing more (the graphics process stays)
const deepSleepEnabled = () => readSystem().deepSleep === true;
function reviveWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return deepSleeping ? createWindow(true) : null;
}
const appUrl = () => devUrl || appOrigin;
function armSleep(): void {
  if (sleepTimer || asleep) return;
  sleepTimer = setTimeout(() => {
    sleepTimer = null;
    const win = mainWindow;
    if (!win || win.isDestroyed() || !pageHidden || asleep || conns.size || popups.size || p2pCall.inCall() || !appUrl()) return;
    if (dev()) console.log('[throttle] nothing connected: the page goes to sleep');
    asleep = true;
    torrentEngine.release(win.webContents);
    if (deepSleepEnabled()) {
      // Deep sleep: the window goes too, so the graphics process has nothing to serve either. The tray makes it again (same
      // size and place) when asked to show it. Without "deepSleep": true in system.json the window stays and only its page ends.
      savedBounds = { bounds: win.getBounds(), maximized: win.isMaximized() };
      deepSleeping = true;
      win.destroy();
      tray.onWindowVisibility();
    } else {
      // Loading about:blank alone keeps the same renderer process (measured: Tab stayed at ~105MB), so end the process itself.
      // Showing the window loads the app into a fresh one.
      try { win.webContents.forcefullyCrashRenderer(); } catch { /* already gone */ }
    }
    if (dev()) for (const sec of [4, 20, 45]) setTimeout(() => { if (asleep || deepSleeping) console.log(`[throttle] ${deepSleeping ? 'window gone' : 'asleep'} for ${sec}s | ${memory()} | ${mainHeap()}`); }, sec * 1000);
  }, SLEEP_AFTER_MS);
  sleepTimer.unref?.();
}
function wake(win: BrowserWindow): void {
  asleep = false;
  if (dev()) console.log('[throttle] window shown: the page wakes up');
  // #woke: the page knows this is not a launch, so it does not connect to the last server on its own
  void win.webContents.loadURL(`${appUrl()}#woke`).catch(() => {});
}
// The page says it has drawn (or taken down) the main view
ipcMain.on('window:hiddenApplied', (e, hidden: boolean, stats?: Record<string, number>) => {
  if (dev()) console.log(`[throttle] page ${hidden ? 'took the main view down' : 'drew the main view again'} | ${memory()}`);
  if (!hidden) return;
  if (dev() && stats) console.log(`[throttle] page holds: ${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  // The page has let go of its view: ask Chromium to hand back what it only keeps for speed. A memory-pressure signal makes
  // every process trim its caches (decoded images, glyphs, compositor and GPU resources); the page's JS engine and this
  // process then collect garbage. All of it refills by itself when the window is shown again.
  const wc = e.sender;
  void (async () => {
    const heap = async () => { const h = await wc.debugger.sendCommand('Runtime.getHeapUsage') as { usedSize: number; totalSize: number }; return `${Math.round(h.usedSize / 1048576)}/${Math.round(h.totalSize / 1048576)}MB used/total`; };
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      const before = await heap();
      await wc.debugger.sendCommand('HeapProfiler.collectGarbage');
      await wc.debugger.sendCommand('Memory.simulatePressureNotification', { level: 'critical' }).catch(() => {});
      if (dev()) console.log(`[throttle] page JS heap ${before} -> ${await heap()} after garbage collection and a memory-pressure signal`);
    } catch (err) { if (dev()) console.log('[throttle] could not trim the page:', (err as Error).message); }
    finally { try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* gone */ } }
    if (dev()) console.log(`[throttle] ${mainHeap()} (before collecting)`);
    collectMain?.();
    setTimeout(() => { if (pageHidden) { collectMain?.(); if (dev()) console.log(`[throttle] after trimming | ${memory()} | ${mainHeap()}`); } }, 3000);
  })();
});
ipcMain.handle('system:get', () => ({ hardwareAcceleration, gpu: readSystem().gpu ?? 'auto', gpuReverted: readSystem().gpuReverted ?? '', gpus: listGpus().map(({ id, label, kind }) => ({ id, label, kind })), autoUpdate: readSystem().autoUpdate !== false, throttleWhenHidden, launchOnStartup: launchOnStartup(), platform: process.platform,
  // Only on a Wayland desktop is there a choice: what was chosen, and what this run is
  displayServer: waylandSession ? { choice: savedDisplayServer(), running: app.commandLine.getSwitchValue('ozone-platform') === 'x11' ? 'x11' : 'wayland' } : null }));
ipcMain.handle('system:setThrottleWhenHidden', async (_e, on: boolean) => {
  await fs.writeFile(systemFile, JSON.stringify({ ...readSystem(), throttleWhenHidden: !!on }));
  throttleWhenHidden = !!on;
  applyHidden('setting changed');
});
ipcMain.handle('system:setDisplayServer', async (_e, which: string) => {
  await fs.writeFile(systemFile, JSON.stringify({ ...readSystem(), displayServer: which === 'wayland' ? 'wayland' : 'x11' }));
});
ipcMain.handle('system:setLaunchOnStartup', async (_e, on: boolean) => {
  // A development run would register Electron itself, not the app
  if (!app.isPackaged) throw new Error('only the installed app can do this');
  await setLaunchOnStartup(!!on);
});
ipcMain.handle('system:setHardwareAcceleration', async (_e, on: boolean) => {
  await fs.writeFile(systemFile, JSON.stringify({ ...readSystem(), hardwareAcceleration: !!on }));
});
ipcMain.handle('system:setGpu', async (_e, id: string) => {
  await fs.writeFile(systemFile, JSON.stringify({ ...readSystem(), gpu: String(id || 'auto'), gpuTrial: false, gpuReverted: undefined }));
});
ipcMain.handle('system:setAutoUpdate', async (_e, on: boolean) => {
  await fs.writeFile(systemFile, JSON.stringify({ ...readSystem(), autoUpdate: !!on }));
});
const updateProgress = (done: number, total: number) => mainWindow?.webContents.send('update:progress', done, total);
ipcMain.handle('update:check', () => checkForUpdate());
ipcMain.handle('update:install', () => installUpdate(updateProgress));
ipcMain.handle('system:relaunch', () => { relaunchApp(); });
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
const torrentEngine = registerTorrent(hardwareAcceleration);
// A call with a friend (no Mumble connection) still needs the page: see applyHidden and armSleep
const p2pCall = registerP2p(identities, () => { log('friend call', p2pCall.inCall() ? 'active' : 'ended'); applyHidden('friend call'); });
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
    onClose: reason => { owner.removeListener('destroyed', onGone); conns.get(connId)?.udp?.close(); conns.delete(connId); emit('mumble:close', reason); }
  });
  // A listener per connection must not pile up on the window over many reconnects: it is removed when the connection ends
  const onGone = () => conn.close();
  conns.set(connId, Object.assign(conn, { owner }));
  owner.once('destroyed', onGone);
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
// A Wayland desktop, whichever window system the app itself runs on (Settings > System): with the app on X11 (XWayland) Chromium still
// captures through the desktop's portal, so its picker opens and the app's own list would only show black pictures and ask again.
const onWayland = () => waylandSession;

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

// The title bar the page draws on Linux and Windows (see createWindow); its buttons act on the window that asked
const customFrame = process.platform !== 'darwin';
ipcMain.handle('window:minimize', e => { BrowserWindow.fromWebContents(e.sender)?.minimize(); });
ipcMain.handle('window:toggleMaximize', e => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); }
});
// Closing goes through the window's close handler, so closing to the tray still works
ipcMain.handle('window:close', e => { BrowserWindow.fromWebContents(e.sender)?.close(); });
ipcMain.handle('window:state', e => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return { maximized: !!w?.isMaximized(), fullscreen: !!w?.isFullScreen() };
});

ipcMain.handle('window:setFullScreen', (_e, fullscreen: boolean) => {
  if (mainWindow) mainWindow.setFullScreen(fullscreen);
});
ipcMain.handle('window:isFullScreen', () => mainWindow?.isFullScreen() ?? false);

// The pop-out windows (one per picture, named by the frame name the app opened them with): full screen
// of that window alone, and back to the window it was when it ends. Returns the state asked for.
const popups = new Map<string, BrowserWindow>();
// When the desktop last moved each pop-out window
const movedPopups = new Map<string, number>();
// Going full screen (and coming back) moves and resizes a pop-out window, over the app's own window when they share a screen. That is
// not a drop on the app: the moves of a full screen change, and the ones that trail after it, never send the window back in.
const fullScreenGrace = new Map<string, number>();
// Short: a window dragged inside the app right after it left full screen must still go back in (the first time)
const fullScreenBusy = (name: string, win?: BrowserWindow) => (!!win && !win.isDestroyed() && win.isFullScreen()) || Date.now() < (fullScreenGrace.get(name) ?? 0);
const fullScreenChanging = (name: string, ms: number) => {
  fullScreenGrace.set(name, Math.max(fullScreenGrace.get(name) ?? 0, Date.now() + ms));
  movedPopups.delete(name);
};
ipcMain.handle('popout:setFullScreen', (_e, name: string, fullscreen?: boolean) => {
  const win = popups.get(String(name));
  if (!win || win.isDestroyed()) return false;
  const want = typeof fullscreen === 'boolean' ? fullscreen : !win.isFullScreen();
  fullScreenChanging(String(name), 800);
  win.setFullScreen(want);
  return want;
});
// While a drag out of the app is held, the pop-out windows follow the real cursor of the system (not the screen position the page's
// pointer events report, which can be wrong or missing outside the page), by the place on the window that was picked up.
let followSet: { name: string; dx: number; dy: number }[] = [];
let followTimer: ReturnType<typeof setInterval> | null = null;
let followStop: ReturnType<typeof setTimeout> | null = null;
const stopFollow = () => {
  if (followTimer) clearInterval(followTimer);
  if (followStop) clearTimeout(followStop);
  followTimer = followStop = null;
  followSet = [];
};
const stepFollow = () => {
  const p = screen.getCursorScreenPoint();
  for (const f of followSet) {
    const win = popups.get(f.name);
    if (!win || win.isDestroyed() || win.isFullScreen()) continue;
    const x = Math.round(p.x - f.dx), y = Math.round(p.y - f.dy);
    const b = win.getBounds();
    // The size it has: setPosition alone can resize a window by a pixel or two between screens of different scale
    if (b.x !== x || b.y !== y) win.setBounds({ x, y, width: b.width, height: b.height });
  }
};
ipcMain.on('popout:follow', (_e, items: { name: string; dx: number; dy: number }[]) => {
  stopFollow();
  followSet = (Array.isArray(items) ? items : []).filter(i => i && typeof i.name === 'string' && Number.isFinite(i.dx) && Number.isFinite(i.dy)).map(i => ({ name: i.name, dx: i.dx, dy: i.dy }));
  if (!followSet.length) return;
  stepFollow();
  followTimer = setInterval(stepFollow, 8);
  // A drag that nobody ended (the page went away) does not keep moving windows for ever
  followStop = setTimeout(stopFollow, 120_000);
});
// The drag ended: answers whether the cursor is over the app's own window (the pop-out was let go on it, so it goes back in)
ipcMain.handle('popout:followEnd', () => {
  const p = screen.getCursorScreenPoint();
  // The windows it was moving, taken before the follow is cleared: they count too (the cursor can be on the edge of one that is mostly over the app)
  const centers = followSet.map(f => popups.get(f.name)).filter((w): w is BrowserWindow => !!w && !w.isDestroyed()).map(w => { const c = w.getBounds(); return { x: c.x + c.width / 2, y: c.y + c.height / 2 }; });
  // This drag decides about these windows (here and now): the moves it made must not count as one the desktop made
  for (const f of followSet) movedPopups.delete(f.name);
  const followSet0 = followSet;
  stopFollow();
  const b = appRect();
  if (!b) { console.log('[popout] follow end: the app window is not there to drop on'); return false; }
  const within = (x: number, y: number) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
  // A window that is full screen (or just was) is over the app because it is full screen, not because it was dropped there
  const full = followSet0.some(f => popups.get(f.name)?.isFullScreen());
  const inside = !full && (within(p.x, p.y) || centers.some(c => within(c.x, c.y)));
  console.log(`[popout] follow end: cursor ${p.x},${p.y} app ${b.x},${b.y} ${b.width}x${b.height} -> ${inside ? 'back in' : 'stays out'} (${appPageOrigin ? 'place from the pointer' : 'place the window reports, no pointer sample yet'}; window reports ${mainWindow?.getBounds().x},${mainWindow?.getBounds().y})`);
  return inside;
});
ipcMain.on('popout:moveTo', (_e, name: string, x: number, y: number) => {
  const win = popups.get(String(name));
  if (!win || win.isDestroyed() || win.isFullScreen() || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const { width, height } = win.getBounds();
  win.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
});
// A pop-out window changes its size and keeps one edge where it was: `side` is the edge that stays ('right' keeps the left edge, so the
// window grows toward the right; 'left' keeps the right edge). With 'auto' it grows toward the right unless the screen has no room there.
// Answers the side it used. The call bar's pop-out is just the picture and grows when the mouse is over it.
ipcMain.handle('popout:resize', (_e, name: string, width: number, height: number, side: string): 'right' | 'left' => {
  const win = popups.get(String(name));
  const w = Math.round(width), h = Math.round(height);
  if (!win || win.isDestroyed() || win.isFullScreen() || !Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return side === 'left' ? 'left' : 'right';
  const b = win.getBounds();
  let use: 'right' | 'left' = side === 'left' ? 'left' : 'right';
  if (side === 'auto') {
    const area = screen.getDisplayMatching(b).workArea;
    use = b.x + w > area.x + area.width ? 'left' : 'right';
  }
  const x = use === 'left' ? b.x + b.width - w : b.x;
  // A window that cannot be resized by the user can refuse to be resized by the program too (on Linux): it is let free for the change
  const fixed = !win.isResizable();
  // The change moves and resizes the window: that is not a drop on the app
  fullScreenChanging(String(name), 300);
  try {
    if (fixed) { win.setResizable(true); win.setMinimumSize(1, 1); win.setMaximumSize(10000, 10000); }
    win.setBounds({ x, y: b.y, width: w, height: h });
  } catch { /* not supported here */ }
  finally { if (fixed) { try { win.setResizable(false); } catch { /* not supported here */ } } }
  return use;
});
// A pop-out window moved by the desktop (its title bar, or the bar's own drag area) and left over the app's window goes back in.
// The page of the pop-out asks when the pointer is back in it with no button down (the move is over); this answers whether that window
// has moved since the last question, and the cursor is over the app's own window.
// Where the app's window is on the screen. The window's own reported place can be stale (under XWayland it is only refreshed when the
// window is moved), so it is worked out from the pointer: the page says where the pointer is in the page, the cursor says where it is on
// the screen, and the difference is where the page starts.
let appPageOrigin: { x: number; y: number } | null = null;
ipcMain.on('app:pointer', (e, cx: number, cy: number) => {
  const w = mainWindow;
  if (!w || w.isDestroyed() || e.sender !== w.webContents || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  const c = screen.getCursorScreenPoint(), z = w.webContents.getZoomFactor();
  appPageOrigin = { x: Math.round(c.x - cx * z), y: Math.round(c.y - cy * z) };
});
const appRect = (): { x: number; y: number; width: number; height: number } | null => {
  const w = mainWindow;
  if (!w || w.isDestroyed() || !w.isVisible() || w.isMinimized()) return null;
  if (!appPageOrigin) return w.getBounds();
  const [width, height] = w.getContentSize();
  return { x: appPageOrigin.x, y: appPageOrigin.y, width, height };
};
ipcMain.handle('popout:dropCheck', (_e, name: string) => {
  const key = String(name);
  // The window has not been moved by the desktop since it last went back in (or was never moved)
  if (!movedPopups.has(key)) return false;
  const win = popups.get(key), b = appRect();
  if (!win || win.isDestroyed()) { movedPopups.delete(key); return false; }
  // Full screen over the app is not a drop on it
  if (fullScreenBusy(key, win)) { movedPopups.delete(key); return false; }
  if (!b) return false;
  const within = (x: number, y: number) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
  const p = screen.getCursorScreenPoint(), c = win.getBounds();
  // The cursor, or the middle of the window itself: under XWayland the cursor's place is only up to date while it is over a window of
  // this app, and a window let go over the app is over it whatever the cursor says
  const inside = within(p.x, p.y) || within(c.x + c.width / 2, c.y + c.height / 2);
  if (!app.isPackaged) console.log(`[popout] drop check ${key}: cursor ${p.x},${p.y} window ${c.x},${c.y} ${c.width}x${c.height} app ${b.x},${b.y} ${b.width}x${b.height} -> ${inside ? 'back in' : 'stays out'}`);
  // Kept until it goes in: a check that came before the desktop had told us where the window is (or while it was still being moved)
  // must not use up the move, or the next one has nothing to go by
  if (inside) movedPopups.delete(key);
  return inside;
});
ipcMain.handle('popout:isFullScreen', (_e, name: string) => {
  const win = popups.get(String(name));
  return !!win && !win.isDestroyed() && win.isFullScreen();
});

// ─── Window ────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

function createWindow(woke = false): BrowserWindow {
  deepSleeping = false;
  const restored = savedBounds;
  savedBounds = null;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    ...(restored && !restored.maximized ? restored.bounds : {}),
    minWidth: 360,
    minHeight: 480,
    backgroundColor: '#111214',
    title: 'Libertad',
    // Window and taskbar icon on Linux (Windows and macOS take it from the package)
    icon: path.join(__dirname, '../dist/icon.png'),
    // Linux and Windows: no system title bar, the page draws its own (src/ui/TitleBar.svelte); macOS keeps its own
    frame: !customFrame,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      // Voice must play without a click first
      autoplayPolicy: 'no-user-gesture-required',
      // Shown: render normally. Hidden: applyHidden() turns this on so the page really goes to sleep. Timers and audio are
      // kept at full speed by the command line switches instead.
      backgroundThrottling: false,
      // Off until it can work without fetching dictionaries (see session-created)
      spellcheck: false
    }
  });

  // Links from chat open in the system browser, never inside the app
  // width, height, left and top from the features string the page opened a pop-out window with
  const featureBox = (features: string) => {
    const n: Record<string, number> = {};
    for (const kv of String(features || '').split(',')) {
      const [k, v] = kv.split('=');
      const x = Number(v);
      if (k && v !== undefined && Number.isFinite(x)) n[k.trim()] = x;
    }
    return { width: n.width ?? 960, height: n.height ?? 600, ...(n.left !== undefined && n.top !== undefined ? { x: Math.round(n.left), y: Math.round(n.top) } : {}) };
  };
  win.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    // The stream window: an empty page the app fills with the video itself
    if (frameName === 'libertad-stream' && (url === 'about:blank' || url === '')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 600, minWidth: 320, minHeight: 200, backgroundColor: '#000000', frame: true, autoHideMenuBar: true, title: 'Libertad' } };
    }
    // The call bar dragged out of the app: a small window without a frame, over every window on the desktop
    if (frameName === 'libertad-overlay' && (url === 'about:blank' || url === '')) {
      const b = featureBox(features);
      return { action: 'allow', overrideBrowserWindowOptions: { ...b, width: Math.round(b.width), height: Math.round(b.height), frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, alwaysOnTop: true, skipTaskbar: true,
        // Like a game overlay: it never takes the keyboard from the game or app below (its buttons still click), and on macOS it is a panel,
        // the kind of window that can sit over full screen apps
        ...(process.platform === 'win32' || process.platform === 'darwin' ? { focusable: false } : {}), ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false, autoHideMenuBar: true, title: 'Libertad call' } };
    }
    // The pop-out windows: YouTube, and one for each screen, camera or watch together picture
    if ((frameName === 'libertad-watch' || frameName.startsWith('libertad-pop-')) && (url === 'about:blank' || url === '')) {
      return { action: 'allow', overrideBrowserWindowOptions: { ...featureBox(features), minWidth: 320, minHeight: 200, backgroundColor: '#000000', frame: true, autoHideMenuBar: true, title: 'Libertad Watch Together' } };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // What the page says about voice, calls and pop-outs, and every warning or error, goes to the log file as well
  win.webContents.on('console-message', (e: unknown) => {
    const ev = e as { level?: string | number; message?: string };
    const msg = String(ev.message ?? '');
    const bad = ev.level === 'warning' || ev.level === 'error' || ev.level === 2 || ev.level === 3;
    if (bad || /^\[(voice|call|popout|p2p)\]/.test(msg)) log('page', msg.slice(0, 500));
  });
  win.webContents.on('did-create-window', (child, { frameName }) => {
    if (!frameName) return;
    popups.set(frameName, child);
    child.on('move', () => { if (!fullScreenBusy(frameName, child)) movedPopups.set(frameName, Date.now()); });
    // Full screen started or ended (by the page's button, a key, or the system): none of the moves around it count
    // (The system can tell late, after the user has already taken hold of the window: only the moves right before it, which are the
    // change's own, are taken back, and the pause after it is short)
    const settled = () => {
      const at = movedPopups.get(frameName);
      fullScreenGrace.set(frameName, Math.max(fullScreenGrace.get(frameName) ?? 0, Date.now() + 300));
      if (at !== undefined && Date.now() - at < 400) movedPopups.delete(frameName);
    };
    child.on('enter-full-screen', settled);
    child.on('leave-full-screen', settled);
    // Over everything, full screen windows and every workspace included
    if (frameName === 'libertad-overlay') {
      const top = () => {
        if (child.isDestroyed()) return;
        try {
          child.setAlwaysOnTop(true, 'screen-saver');
          child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
          child.moveTop();
        } catch { /* not supported here */ }
      };
      top();
      // Other windows (a game going full screen, another always-on-top window) can take the top: it takes it back
      const keep = setInterval(top, 1500);
      child.on('blur', top);
      child.on('hide', top);
      child.on('show', top);
      child.on('closed', () => clearInterval(keep));
      screen.on('display-metrics-changed', top);
      child.on('closed', () => screen.removeListener('display-metrics-changed', top));
    }
    child.on('closed', () => { movedPopups.delete(frameName); fullScreenGrace.delete(frameName); if (popups.get(frameName) === child) popups.delete(frameName); applyHidden('pop-out closed'); });
    trackVisibility(child, why => applyHidden(`pop-out ${why}`));
    applyHidden('pop-out opened');
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (devUrl && url.startsWith(devUrl)) return;
    if (appOrigin && url.startsWith(appOrigin)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow = win;
  // The page draws the title bar, so it is told when the window is maximized or full screen
  const sendState = () => { if (!win.isDestroyed()) win.webContents.send('window:state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen() }); };
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);
  win.on('enter-full-screen', sendState);
  win.on('leave-full-screen', sendState);
  win.on('close', e => {
    if (tray.shouldHideOnClose()) {
      e.preventDefault();
      win.hide();
    } else if (process.platform !== 'darwin') {
      // Close to tray is off: closing the window quits the whole app, pop-out windows included
      tray.quitApp();
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
  trackVisibility(win, why => applyHidden(`window ${why}`));
  // A reloaded page starts out shown; tell it if that is not so
  win.webContents.on('did-finish-load', () => { if (pageHidden) { win.webContents.setBackgroundThrottling(true); win.webContents.send('window:hidden', true); } });
  // The graphics choice is confirmed once the window really shows something: a window that is all black (the card could not
  // present to this display) is put right by itself, with automatic graphics
  if (gpuTrial) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        const { width, height } = img.getSize();
        const px = img.toBitmap();
        let lit = 0;
        for (let i = 0; i < px.length; i += 4 * 97) if (px[i] + px[i + 1] + px[i + 2] > 12) lit++;
        if (width > 0 && height > 0 && lit === 0) {
          console.log('[gpu] the window is black with this graphics card, back to automatic');
          writeFileSync(systemFile, JSON.stringify({ ...readSystem(), gpu: 'auto', gpuTrial: false, gpuReverted: readSystem().gpu }));
          relaunchApp();
          return;
        }
      } catch { /* could not look: leave it to the next start */ }
      writeFileSync(systemFile, JSON.stringify({ ...readSystem(), gpuTrial: false }));
      gpuTrial = false;
    }, 5000));
  }
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; pageHidden = false; asleep = false; if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; } });

  if (restored?.maximized) win.maximize();
  // #woke: the page knows this is not a launch, so it does not connect to the last server on its own
  const suffix = woke ? '#woke' : '';
  if (devUrl) void win.loadURL(devUrl + suffix);
  else if (appOrigin) void win.loadURL(appOrigin + suffix);
  else serveDist().then(url => { appOrigin = url; return win.loadURL(url + suffix); }).catch(err => console.error('could not start the app server:', err));
  return win;
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
  await tray.setupTray(() => mainWindow, action => mainWindow?.webContents.send('tray:action', action), reviveWindow);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(deepSleeping); });
});

app.on('window-all-closed', () => {
  // Deep sleep closes the window on purpose; the app keeps running in the tray
  if (deepSleeping) return;
  if (process.platform !== 'darwin') app.quit();
});
