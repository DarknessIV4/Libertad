import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs, constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

// Large received files live here as plain files, not as Blobs in IndexedDB.
// Names are a hash of the file id, so a hostile id can never become a path.
const dir = () => path.join(app.getPath('userData'), 'files');
const key = (id: string) => createHash('sha256').update(String(id)).digest('hex');
const partPath = (id: string) => path.join(dir(), key(id) + '.part');
const donePath = (id: string) => path.join(dir(), key(id) + '.bin');
const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const okNum = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const MAX_IO = 4 * 1024 * 1024;

// One open handle per file, cached as a promise so concurrent first writes share it
const handles = new Map<string, Promise<FileHandle>>();

function open(id: string, size?: number): Promise<FileHandle> {
  let p = handles.get(id);
  if (!p) {
    p = (async () => {
      await fs.mkdir(dir(), { recursive: true });
      if (await exists(donePath(id))) return fs.open(donePath(id), 'r');
      const fresh = !(await exists(partPath(id)));
      // 'r+' / 'w+' and not 'a': append mode ignores write offsets on Linux
      const h = await fs.open(partPath(id), fresh ? 'w+' : 'r+');
      if (fresh && process.platform === 'win32') {
        // NTFS zero-fills the gap when a write lands past the end, unless the file is sparse
        await new Promise<void>(r => execFile('fsutil', ['sparse', 'setflag', partPath(id)], () => r()));
      }
      if (okNum(size) && size > 0) await h.truncate(size).catch(() => {});
      return h;
    })();
    handles.set(id, p);
    p.catch(() => handles.delete(id));
  }
  return p;
}

async function close(id: string): Promise<void> {
  const p = handles.get(id);
  if (!p) return;
  handles.delete(id);
  const h = await p.catch(() => null);
  await h?.close().catch(() => {});
}

export function registerFileStore(): void {
  // Downloads do not survive a restart, so leftover partial files are garbage
  fs.readdir(dir())
    .then(names => Promise.all(names.filter(n => n.endsWith('.part')).map(n => fs.rm(path.join(dir(), n), { force: true }))))
    .catch(() => {});

  ipcMain.handle('files:write', async (_e, id: string, offset: number, bytes: Uint8Array, size: number) => {
    if (!okNum(offset) || !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IO) throw new Error('bad write');
    const h = await open(id, size);
    const { bytesWritten } = await h.write(bytes, 0, bytes.byteLength, offset);
    if (bytesWritten !== bytes.byteLength) throw new Error('short write');
    return true;
  });
  ipcMain.handle('files:read', async (_e, id: string, offset: number, length: number) => {
    if (!okNum(offset) || !okNum(length) || length > MAX_IO) throw new Error('bad range');
    const h = await open(id);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await h.read(buf, 0, length, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  });
  ipcMain.handle('files:finish', async (_e, id: string) => {
    await close(id);
    await fs.rename(partPath(id), donePath(id));
    return true;
  });
  ipcMain.handle('files:remove', async (_e, id: string) => {
    await close(id);
    await fs.rm(partPath(id), { force: true });
    await fs.rm(donePath(id), { force: true });
    return true;
  });
  ipcMain.handle('files:has', (_e, id: string) => exists(donePath(id)));
  ipcMain.handle('files:free', async () => {
    await fs.mkdir(dir(), { recursive: true });
    const s = await fs.statfs(dir());
    return s.bavail * s.bsize;
  });
  ipcMain.handle('files:export', async (e, id: string, name: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { defaultPath: String(name ?? 'file').slice(0, 255) };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return false;
    // Instant on filesystems with reflinks (btrfs, XFS), a normal copy elsewhere
    await fs.copyFile(donePath(id), r.filePath, constants.COPYFILE_FICLONE);
    return true;
  });
}
