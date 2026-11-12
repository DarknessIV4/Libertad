import { app, dialog, ipcMain, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createFileStore } from './filestore-core.ts';

const MAX_IO = 4 * 1024 * 1024;
const okNum = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const okStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const safeName = (n: unknown) => String(n ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'file';

// Paths only ever come from the Save dialog, never from the renderer
async function pickPlace(e: IpcMainInvokeEvent, name: unknown): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(e.sender);
  const opts = { defaultPath: path.join(app.getPath('downloads'), safeName(name)) };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  return r.canceled || !r.filePath ? null : r.filePath;
}

export function registerFileStore(): void {
  const store = createFileStore({
    cacheDir: () => path.join(app.getPath('userData'), 'files'),
    stateFile: () => path.join(app.getPath('userData'), 'files-state.json')
  });
  store.sweep().catch(() => {});

  // Asks where to save, then makes the file there; nothing is fetched if this says no
  ipcMain.handle('files:begin', async (e, id: unknown, name: unknown, size: unknown, hash: unknown) => {
    if (!okStr(id, 64) || !okNum(size) || size < 1 || !okStr(hash, 128)) throw new Error('bad request');
    const place = await pickPlace(e, name);
    if (!place) return { ok: false, reason: 'canceled' };
    return store.begin(id, place, size, hash);
  });
  ipcMain.handle('files:write', (_e, id: unknown, offset: unknown, bytes: unknown) => {
    if (!okStr(id, 64) || !okNum(offset) || !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IO) throw new Error('bad write');
    return store.write(id, offset, bytes);
  });
  ipcMain.handle('files:finish', (_e, id: unknown) => {
    if (!okStr(id, 64)) throw new Error('bad request');
    return store.finish(id);
  });
  ipcMain.handle('files:remove', (_e, id: unknown) => {
    if (!okStr(id, 64)) throw new Error('bad request');
    return store.remove(id);
  });
  ipcMain.handle('files:where', (_e, id: unknown, hash: unknown) => {
    if (!okStr(id, 64) || !okStr(hash, 128)) return null;
    return store.where(id, hash);
  });
  ipcMain.handle('files:reveal', async (_e, id: unknown) => {
    const p = okStr(id, 64) ? await store.savedPath(id) : null;
    if (p) shell.showItemInFolder(p);
    return !!p;
  });
  // A picture of the video's current frame: ask where to save it, then write it (only on this computer)
  ipcMain.handle('files:saveFrame', async (e, name: unknown, bytes: unknown) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 64 * 1024 * 1024) throw new Error('bad request');
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Save frame', defaultPath: path.join(app.getPath('pictures'), safeName(name)), filters: [{ name: 'PNG image', extensions: ['png'] }] };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    await fsp.writeFile(r.filePath, bytes);
    return r.filePath;
  });
  // A file an older version kept in the app's cache: ask where, then move it out of the cache
  ipcMain.handle('files:export', async (e, id: unknown, name: unknown, hash: unknown) => {
    if (!okStr(id, 64) || !okStr(hash, 128)) throw new Error('bad request');
    const place = await pickPlace(e, name);
    if (!place) return { ok: false, reason: 'canceled' };
    return store.moveOut(id, place, hash);
  });
}
