import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promises as fs, existsSync, createReadStream } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import {
  SEGMENT_SECONDS, buildPlaylist, ffmpegArgs, parseProbe, segmentCount, type MediaInfo
} from '../src/core/transcode.ts';

// Converts what the page can not play (see src/core/transcode.ts). One ffmpeg runs at a time for each film and voice:
// it makes segments from where the viewer is, a little ahead of them, and starts again where they seek to.

export interface Binaries { ffmpeg: string; ffprobe: string }

const run = (file: string, args: string[], timeout = 8000, maxBuffer = 8 * 1024 * 1024) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { timeout, maxBuffer, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out)))));

// ffmpeg and ffprobe: the ones named in LIBERTAD_FFMPEG / LIBERTAD_FFPROBE, the ones that ship with the app
// (the ffmpeg-static and ffprobe-static packages), or the ones on the PATH. null when there are none.
export async function findBinaries(): Promise<Binaries | null> {
  const unpacked = (p: string) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const works = (f: string) => run(f, ['-version'], 5000).then(() => true, () => false);
  const candidates: { ffmpeg: string; ffprobe: string }[] = [];
  if (process.env.LIBERTAD_FFMPEG && process.env.LIBERTAD_FFPROBE) candidates.push({ ffmpeg: process.env.LIBERTAD_FFMPEG, ffprobe: process.env.LIBERTAD_FFPROBE });
  try {
    // The names are not literals, so a bundler leaves the packages alone and Node loads them at run time
    const a = 'ffmpeg-static', b = 'ffprobe-static';
    const ff = (await import(a)).default as string | null;
    const fp = ((await import(b)).default as { path?: string } | undefined)?.path;
    if (ff && fp) candidates.push({ ffmpeg: unpacked(ff), ffprobe: unpacked(fp) });
  } catch { /* not installed */ }
  candidates.push({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  for (const c of candidates) if (await works(c.ffmpeg) && await works(c.ffprobe)) return c;
  return null;
}

export interface TranscoderOptions {
  bin: Binaries;
  root: string;                 // where segments are written; wiped when it starts and stops
  segSeconds?: number;
  // How many segments are made past the one the viewer asked for before ffmpeg is stopped
  lookahead?: number;
  maxHeight?: number;
}

interface Session {
  dir: string;
  start: number;
  proc: ChildProcess;
  exited: boolean;
  failed: string;
  last: number;                 // the newest segment the viewer asked for
  timer: ReturnType<typeof setInterval>;
}

export function createTranscoder(opts: TranscoderOptions) {
  const seg = opts.segSeconds ?? SEGMENT_SECONDS;
  const ahead = opts.lookahead ?? 20;
  const sessions = new Map<string, Session>();            // `${hash}:${idx}:${voice}`
  const infos = new Map<string, Promise<MediaInfo | null>>(); // `${hash}:${idx}`
  let tonemap: Promise<boolean> | null = null;

  // Only an ffmpeg with the zscale and tonemap filters can bring HDR down to SDR
  const canTonemap = () => (tonemap ??= run(opts.bin.ffmpeg, ['-hide_banner', '-filters']).then(
    out => /\bzscale\b/.test(out) && /\btonemap\b/.test(out), () => false));

  async function probe(key: string, url: string): Promise<MediaInfo | null> {
    let p = infos.get(key);
    if (!p) {
      p = run(opts.bin.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url], 45000)
        .then(out => parseProbe(JSON.parse(out)), () => null);
      infos.set(key, p);
      void p.then(v => { if (!v) infos.delete(key); });
    }
    return p;
  }

  const segPath = (dir: string, n: number) => path.join(dir, `seg${n}.ts`);

  // The newest segment that is finished (a segment is renamed to its name only once it is complete)
  async function newest(s: Session): Promise<number> {
    let top = s.start - 1;
    try {
      for (const f of await fs.readdir(s.dir)) {
        const m = /^seg(\d+)\.ts$/.exec(f);
        if (m && Number(m[1]) > top) top = Number(m[1]);
      }
    } catch { /* gone */ }
    return top;
  }

  function kill(s: Session) {
    clearInterval(s.timer);
    if (!s.exited) { try { s.proc.kill('SIGKILL'); } catch { /* already gone */ } }
  }

  async function begin(skey: string, input: string, info: MediaInfo, voice: number, start: number): Promise<Session> {
    const old = sessions.get(skey);
    if (old) kill(old);
    const dir = path.join(opts.root, skey.replace(/:/g, '-'));
    await fs.mkdir(dir, { recursive: true });
    const args = ffmpegArgs({ input, info, audio: voice, start, dir, tonemap: await canTonemap(), maxHeight: opts.maxHeight, segSeconds: seg });
    const proc = spawn(opts.bin.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    proc.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-1500); });
    const s: Session = { dir, start, proc, exited: false, failed: '', last: start, timer: setInterval(() => {}, 1 << 30) };
    clearInterval(s.timer);
    proc.once('error', e => { s.exited = true; s.failed = e.message; });
    proc.once('exit', code => { s.exited = true; if (code && !s.failed) s.failed = err.trim().split('\n').pop() || `ffmpeg stopped (${code})`; });
    // Nobody needs the film converted to its end: stop when it is well ahead of the viewer
    s.timer = setInterval(() => {
      void newest(s).then(top => { if (!s.exited && top - s.last > ahead) kill(s); });
    }, 1000);
    sessions.set(skey, s);
    return s;
  }

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // Waits for segment `n`, starting (or restarting) the conversion when it is not on its way
  async function segment(skey: string, input: string, info: MediaInfo, voice: number, n: number, timeoutMs = 120000): Promise<string> {
    const dir = path.join(opts.root, skey.replace(/:/g, '-'));
    const file = segPath(dir, n);
    let s = sessions.get(skey);
    if (s) s.last = n;
    if (existsSync(file)) return file;
    // Not coming soon enough: before where this run began, far past where it is, or the run has ended
    const top = s ? await newest(s) : -1;
    if (!s || s.exited || n < s.start || n > top + 4) s = await begin(skey, input, info, voice, n);
    s.last = n;
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (existsSync(file)) return file;
      if (s.exited) {
        await sleep(150); // a segment may have been renamed just as the process ended
        if (existsSync(file)) return file;
        throw new Error(s.failed || 'The video could not be converted');
      }
      await sleep(100);
    }
    throw new Error('Converting the video took too long');
  }

  // GET .../hls/<voice>/index.m3u8 or .../hls/<voice>/seg<N>.ts
  async function serve(res: http.ServerResponse, hashIdx: string, input: string, voice: number, name: string): Promise<void> {
    const info = await probe(hashIdx, input);
    if (!info || !info.duration) { res.writeHead(502); res.end(); return; }
    if (voice >= Math.max(1, info.audio.length)) { res.writeHead(404); res.end(); return; }
    if (name === 'index.m3u8') {
      const body = buildPlaylist(info.duration, seg);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      return;
    }
    const n = Number(/^seg(\d+)\.ts$/.exec(name)?.[1]);
    if (!Number.isInteger(n) || n >= segmentCount(info.duration, seg)) { res.writeHead(404); res.end(); return; }
    const aborted = new AbortController();
    res.once('close', () => aborted.abort());
    let file: string;
    try {
      file = await segment(`${hashIdx}:${voice}`, input, info, voice, n);
    } catch {
      if (!res.headersSent) { res.writeHead(500); res.end(); }
      return;
    }
    if (aborted.signal.aborted) return;
    const size = (await fs.stat(file)).size;
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': size, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    createReadStream(file).pipe(res);
  }

  // The film is not played any more
  function release(hashIdxPrefix: string) {
    for (const [k, s] of sessions) if (k.startsWith(hashIdxPrefix)) { kill(s); sessions.delete(k); void fs.rm(s.dir, { recursive: true, force: true }); }
    for (const k of infos.keys()) if (k.startsWith(hashIdxPrefix)) infos.delete(k);
  }

  async function shutdown() {
    for (const s of sessions.values()) kill(s);
    sessions.clear();
    await fs.rm(opts.root, { recursive: true, force: true });
  }

  return { probe, serve, release, shutdown, segSeconds: seg };
}

export type Transcoder = ReturnType<typeof createTranscoder>;
