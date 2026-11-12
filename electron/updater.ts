// Updates from the latest GitHub release of DarknessIV4/Libertad.
//  - AppImage: the new AppImage is downloaded next to the running one and replaces it, in the same
//    place, then Libertad starts again from it.
//  - Windows: the release's installer (.exe) is downloaded and opened, so the user can reinstall.
//  - Anything else (deb, tar.gz, macOS, a development run): only reports the new version and opens the release page.
// No electron-updater: it needs latest.yml files that a hand-made release does not have.
import { app, dialog, shell, type BrowserWindow } from 'electron';
import { promises as fs, createWriteStream, createReadStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const REPO = 'DarknessIV4/Libertad';

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string;
  // 'appimage' and 'windows' can be installed from here; 'manual' means the release page
  kind: 'appimage' | 'windows' | 'manual';
  page: string;
  size: number;
}
interface Asset { name: string; size: number; browser_download_url: string; digest?: string }
// The SHA-256 GitHub shows for every release file is what decides: an update is offered when the
// release's file differs from the one in use, even if the version number is the same.
//  - AppImage: the running file is hashed.
//  - Windows: the installer's hash is remembered in system.json when it is fetched (the installed
//    program is not that file, so it cannot be hashed).
const systemFile = () => path.join(app.getPath('userData'), 'system.json');
const readSystem = (): Record<string, unknown> => { try { return JSON.parse(readFileSync(systemFile(), 'utf8')); } catch { return {}; } };
const rememberDigest = (hex: string) => fs.writeFile(systemFile(), JSON.stringify({ ...readSystem(), updateDigest: hex }));
function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', c => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}
async function localDigest(): Promise<string> {
  try {
    if (process.platform === 'linux' && process.env.APPIMAGE) return await hashFile(process.env.APPIMAGE);
    if (process.platform === 'win32') return String(readSystem().updateDigest ?? '');
  } catch { /* unreadable: fall back to the version */ }
  return '';
}

let found: (UpdateInfo & { asset: Asset | null }) | null = null;
let busy = false;

const parts = (v: string) => v.replace(/^v/i, '').split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
export function isNewer(latest: string, current: string): boolean {
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export function pickAsset(assets: Asset[], platform: string, appImage: boolean): Asset | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const rank = (a: Asset) => (a.name.toLowerCase().includes(arch) ? 0 : 1);
  const list = assets.filter(a => !/\.blockmap$|\.yml$|\.sha/i.test(a.name));
  if (platform === 'linux' && appImage) return list.filter(a => /\.AppImage$/i.test(a.name)).sort((a, b) => rank(a) - rank(b))[0] ?? null;
  if (platform === 'win32') return list.filter(a => /\.exe$/i.test(a.name) && !/uninstall/i.test(a.name)).sort((a, b) => rank(a) - rank(b))[0] ?? null;
  return null;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'Libertad-updater', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(res.status === 404 ? 'no release found on GitHub yet' : `GitHub answered ${res.status}`);
  const rel = await res.json() as { tag_name: string; html_url: string; assets: Asset[] };
  const current = app.getVersion();
  const latest = String(rel.tag_name).replace(/^v/i, '');
  const asset = pickAsset(rel.assets ?? [], process.platform, !!process.env.APPIMAGE);
  const kind = asset ? (process.platform === 'win32' ? 'windows' : 'appimage') : 'manual';
  const remote = asset?.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : '';
  const local = remote ? await localDigest() : '';
  const differs = !!remote && !!local && remote !== local;
  found = { available: isNewer(latest, current) || (differs && !isNewer(current, latest)), current, latest, kind, page: rel.html_url, size: asset?.size ?? 0, asset };
  const { asset: _a, ...info } = found;
  return info;
}

async function download(asset: Asset, to: string, progress: (done: number, total: number) => void): Promise<void> {
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'Libertad-updater' } });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = asset.size || Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  const out = createWriteStream(to);
  let done = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>(r => out.once('drain', () => r()));
      done += chunk.length;
      progress(done, total);
    }
    await new Promise<void>((resolve, reject) => { out.once('error', reject); out.end(resolve); });
  } catch (e) { out.destroy(); await fs.rm(to, { force: true }); throw e; }
  if (total && done !== total) { await fs.rm(to, { force: true }); throw new Error('the download was cut off'); }
  const want = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : '';
  if (want && hash.digest('hex') !== want) { await fs.rm(to, { force: true }); throw new Error('the download does not match its checksum'); }
}

// Downloads the update found by checkForUpdate and installs it. Resolves when the app is about to exit.
export async function installUpdate(progress: (done: number, total: number) => void): Promise<void> {
  if (busy) throw new Error('an update is already running');
  if (!found?.available) throw new Error('no update to install');
  if (!app.isPackaged) throw new Error('updates install only in the packaged app');
  const { asset, page } = found;
  if (!asset) { await shell.openExternal(page); return; }
  busy = true;
  try {
    if (process.platform === 'linux' && process.env.APPIMAGE) {
      const target = process.env.APPIMAGE;
      const tmp = `${target}.update`;
      try { await fs.access(path.dirname(target), (await import('node:fs')).constants.W_OK); }
      catch { throw new Error(`no permission to write in ${path.dirname(target)}`); }
      await download(asset, tmp, progress);
      await fs.chmod(tmp, 0o755);
      // Renaming over the running file is fine on Linux: the old copy stays mounted until it exits
      await fs.rename(tmp, target);
      if (asset.digest?.startsWith('sha256:')) await rememberDigest(asset.digest.slice(7).toLowerCase()).catch(() => {});
      spawn('sh', ['-c', 'sleep 1; exec "$0"', target], { detached: true, stdio: 'ignore' }).unref();
      app.exit(0);
    } else if (process.platform === 'win32') {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'libertad-update-'));
      const file = path.join(dir, asset.name);
      await download(asset, file, progress);
      if (asset.digest?.startsWith('sha256:')) await rememberDigest(asset.digest.slice(7).toLowerCase()).catch(() => {});
      // Opened normally, so the installer's own wizard asks and reinstalls
      spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.exit(0), 800);
    } else {
      await shell.openExternal(page);
    }
  } finally { busy = false; }
}

// At start-up: check, and ask before fetching anything
export async function checkOnStartup(win: () => BrowserWindow | null, progress: (done: number, total: number) => void): Promise<void> {
  if (!app.isPackaged) return;
  let info: UpdateInfo;
  try { info = await checkForUpdate(); } catch { return; }
  if (!info.available) return;
  const w = win();
  const opts = {
    type: 'question' as const, buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1, title: 'Update available',
    message: `Libertad ${info.latest} is available (you have ${info.current}).`,
    detail: info.kind === 'manual' ? 'Open the download page?' : 'Download and update now?'
  };
  const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
  if (r.response !== 0) return;
  try { await installUpdate(progress); }
  catch (e) { await dialog.showErrorBox('Update failed', (e as Error).message); }
}
