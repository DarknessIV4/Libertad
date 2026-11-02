// Large received files are written as they arrive straight into the file the person picked
// (<name>.mumh5part beside it, renamed once the hash has been checked), so nothing is kept
// twice. Plain Node, no Electron, so the tests can drive it.
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const PART_SUFFIX = '.mumh5part';

export type Failure = 'space' | 'toolarge' | 'error';
export type Begun = { ok: true } | { ok: false; reason: Failure; free?: number };
export type Moved = { ok: true; path: string } | { ok: false; reason: Failure; free?: number };
export type Where = { kind: 'saved'; path: string } | { kind: 'cache' } | null;

export interface FileStoreOptions {
  // Files received by older versions were kept here; they are only read, moved out and removed now
  cacheDir: () => string;
  // Which files were saved where, and which part files are still being written
  stateFile: () => string;
  platform?: string;
  // Free bytes on the volume holding a folder, or null when unknown (tests replace this)
  free?: (dir: string) => Promise<number | null>;
}

interface Target { final: string; part: string; size: number; hash: string; fh: FileHandle }
interface Saved { path: string; size: number; h: string }
interface State { saved: Record<string, Saved>; partial: string[] }

const MAX_SAVED = 1000;
const okNum = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

export function classify(e: unknown): Failure {
  const c = codeOf(e);
  return c === 'ENOSPC' || c === 'EDQUOT' ? 'space' : c === 'EFBIG' ? 'toolarge' : 'error';
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await fs.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export function createFileStore(opts: FileStoreOptions) {
  const platform = opts.platform ?? process.platform;
  const free = opts.free ?? freeBytes;
  const targets = new Map<string, Target>();
  let state: State | null = null;
  let writing: Promise<unknown> = Promise.resolve();

  // Names in the cache are a hash of the file id, so a hostile id can never become a path
  const key = (id: string) => createHash('sha256').update(String(id)).digest('hex');
  const cachedPath = (id: string) => path.join(opts.cacheDir(), key(id) + '.bin');
  const cachedPart = (id: string) => path.join(opts.cacheDir(), key(id) + '.part');
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);

  async function load(): Promise<State> {
    if (state) return state;
    const s: State = { saved: {}, partial: [] };
    try {
      const v = JSON.parse(await fs.readFile(opts.stateFile(), 'utf8'));
      if (v && typeof v === 'object') {
        for (const [id, e] of Object.entries(v.saved ?? {})) {
          const x = e as Partial<Saved>;
          if (typeof x?.path === 'string' && okNum(x.size) && typeof x.h === 'string') s.saved[id] = { path: x.path, size: x.size, h: x.h };
        }
        if (Array.isArray(v.partial)) s.partial = v.partial.filter((p: unknown) => typeof p === 'string');
      }
    } catch { /* first run, or unreadable: start empty */ }
    // Another call may have finished first
    state ??= s;
    return state;
  }

  // One write at a time, through a temporary file, so a crash never leaves half a state file
  function persist(): void {
    writing = writing.then(async () => {
      if (!state) return;
      const file = opts.stateFile();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(state));
      await fs.rename(tmp, file);
    }).catch(() => {});
  }

  function remember(s: State, id: string, entry: Saved): void {
    delete s.saved[id];
    s.saved[id] = entry;
    const ids = Object.keys(s.saved);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SAVED))) delete s.saved[old];
  }

  async function dropPartial(part: string): Promise<void> {
    const s = await load();
    if (s.partial.includes(part)) {
      s.partial = s.partial.filter(p => p !== part);
      persist();
    }
  }

  // Starts a download into finalPath: checks the drive there, creates the part file
  async function begin(id: string, finalPath: string, size: number, hash: string): Promise<Begun> {
    // A retry of the same file starts clean
    await remove(id);
    if (!okNum(size) || size < 1) return { ok: false, reason: 'error' };
    const part = finalPath + PART_SUFFIX;
    const room = await free(path.dirname(finalPath));
    if (room != null && room < size) return { ok: false, reason: 'space', free: room };
    let fh: FileHandle;
    try {
      fh = await fs.open(part, 'w+');
    } catch (e) {
      return { ok: false, reason: classify(e) };
    }
    try {
      // NTFS zero-fills the gap when a write lands past the end, unless the file is sparse
      if (platform === 'win32') await new Promise<void>(r => execFile('fsutil', ['sparse', 'setflag', part], () => r()));
      // Pieces arrive out of order, so the file gets its size first. This is also where a drive that
      // cannot hold a file this large (FAT32) or is out of room says so, before anything is fetched.
      await fh.truncate(size);
    } catch (e) {
      const why = classify(e);
      if (why !== 'error') {
        await fh.close().catch(() => {});
        await fs.rm(part, { force: true }).catch(() => {});
        return { ok: false, reason: why };
      }
      // Anything else only means no preallocation; writes still work
    }
    targets.set(id, { final: finalPath, part, size, hash, fh });
    const s = await load();
    if (!s.partial.includes(part)) s.partial.push(part);
    persist();
    return { ok: true };
  }

  async function write(id: string, offset: number, bytes: Uint8Array): Promise<boolean> {
    const t = targets.get(id);
    if (!t) throw new Error('no destination');
    // Never past the size that was announced
    if (!okNum(offset) || offset + bytes.byteLength > t.size) throw new Error('bad write');
    const { bytesWritten } = await t.fh.write(bytes, 0, bytes.byteLength, offset);
    if (bytesWritten !== bytes.byteLength) throw new Error('short write');
    return true;
  }

  // The file is complete and checked: put it in place and return where it is
  async function finish(id: string): Promise<string> {
    const t = targets.get(id);
    if (!t) throw new Error('no destination');
    await t.fh.close();
    const st = await fs.stat(t.part);
    if (st.size !== t.size) throw new Error('wrong size');
    await fs.rename(t.part, t.final);
    targets.delete(id);
    const s = await load();
    s.partial = s.partial.filter(p => p !== t.part);
    remember(s, id, { path: t.final, size: t.size, h: t.hash });
    persist();
    return t.final;
  }

  // Drops an unfinished download and anything cached under the id. A file that was saved is the
  // person's own and is never touched here.
  async function remove(id: string): Promise<boolean> {
    const t = targets.get(id);
    if (t) {
      targets.delete(id);
      await t.fh.close().catch(() => {});
      await fs.rm(t.part, { force: true }).catch(() => {});
      await dropPartial(t.part);
    }
    await fs.rm(cachedPart(id), { force: true }).catch(() => {});
    await fs.rm(cachedPath(id), { force: true }).catch(() => {});
    return true;
  }

  async function where(id: string, hash: string): Promise<Where> {
    const s = await load();
    const v = s.saved[id];
    if (v && v.h === hash) {
      const there = await fs.stat(v.path).then(st => st.isFile() && st.size === v.size, () => false);
      if (there) return { kind: 'saved', path: v.path };
      // Moved or deleted by the person: forget it
      delete s.saved[id];
      persist();
    }
    return (await exists(cachedPath(id))) ? { kind: 'cache' } : null;
  }

  async function savedPath(id: string): Promise<string | null> {
    return (await load()).saved[id]?.path ?? null;
  }

  // A file an older version cached goes to the chosen place and leaves the cache: moved, not copied
  async function moveOut(id: string, finalPath: string, hash: string): Promise<Moved> {
    const src = cachedPath(id);
    let size: number;
    try {
      size = (await fs.stat(src)).size;
    } catch {
      return { ok: false, reason: 'error' };
    }
    const tmp = finalPath + PART_SUFFIX;
    try {
      try {
        await fs.rename(src, finalPath);
      } catch (e) {
        if (codeOf(e) !== 'EXDEV') throw e;
        // Another drive: copy beside the target first, so a failure leaves the cached file intact
        const room = await free(path.dirname(finalPath));
        if (room != null && room < size) return { ok: false, reason: 'space', free: room };
        try {
          await fs.copyFile(src, tmp);
          await fs.rename(tmp, finalPath);
        } catch (e2) {
          await fs.rm(tmp, { force: true }).catch(() => {});
          throw e2;
        }
        await fs.rm(src, { force: true });
      }
    } catch (e) {
      return { ok: false, reason: classify(e) };
    }
    const s = await load();
    remember(s, id, { path: finalPath, size, h: hash });
    persist();
    return { ok: true, path: finalPath };
  }

  // At start: downloads do not survive a restart, so what they left behind is garbage
  async function sweep(): Promise<void> {
    const names = await fs.readdir(opts.cacheDir()).catch(() => [] as string[]);
    await Promise.all(names.filter(n => n.endsWith('.part')).map(n => fs.rm(path.join(opts.cacheDir(), n), { force: true }).catch(() => {})));
    const s = await load();
    // Only what this app made: the suffix is checked again here, whatever the state file says
    for (const p of s.partial) if (p.endsWith(PART_SUFFIX)) await fs.rm(p, { force: true }).catch(() => {});
    if (s.partial.length) {
      s.partial = [];
      persist();
    }
  }

  return { begin, write, finish, remove, where, savedPath, moveOut, sweep, cachedPath, flush: () => writing };
}

export type FileStore = ReturnType<typeof createFileStore>;
