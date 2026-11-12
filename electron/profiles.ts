// Other people's profile backgrounds (banner and card), kept in the app's data folder so they do not
// have to be fetched again each time: userData/user-profiles/<name>/{meta.json, banner, card}.
// <name> is the name the person goes by in the app. The renderer decides what to keep and when it is
// out of date (see src/lib/profile-cache.ts); this only reads and writes the files.
import { app, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const FILES = new Set(['meta.json', 'banner', 'card', 'profile', 'avatar']);
const MAX_BYTES = 64 * 1024 * 1024;
const base = () => path.join(app.getPath('userData'), 'user-profiles');

// Names come from other people: nothing that leaves the folder, nothing a file system refuses
export function safeName(name: string): string {
  let n = String(name).normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 100);
  if (!n || /^\.+$/.test(n) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  return n;
}

function target(name: unknown, file: unknown): string | null {
  if (typeof name !== 'string' || typeof file !== 'string' || !FILES.has(file)) return null;
  const root = base();
  const p = path.join(root, safeName(name), file);
  return p.startsWith(root + path.sep) ? p : null;
}

export function registerProfiles(): void {
  ipcMain.handle('profiles:read', async (_e, name: unknown, file: unknown) => {
    const p = target(name, file);
    if (!p) return null;
    try { return new Uint8Array(await fs.readFile(p)); } catch { return null; }
  });
  // bytes null: delete the file
  ipcMain.handle('profiles:write', async (_e, name: unknown, file: unknown, bytes: unknown) => {
    const p = target(name, file);
    if (!p) return false;
    try {
      if (bytes == null) { await fs.rm(p, { force: true }); return true; }
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES) return false;
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, bytes);
      return true;
    } catch { return false; }
  });
}
