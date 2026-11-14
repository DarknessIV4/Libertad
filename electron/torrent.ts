import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTorrentEngine } from './torrent-core.ts';
import { createTranscoder, findBinaries, type Transcoder } from './transcode.ts';
import { fetchLimited, fetchSubtitle, findSubtitles } from './subtitles.ts';
import { normalizeMagnet, MAX_MAGNET, MAX_QUEUE } from '../src/core/torrent-meta.ts';
import { findEpisodes } from './episodes.ts';
import { searchTitles, searchTorrents } from './search.ts';

const MAX_TORRENT_FILE = 5 * 1024 * 1024;
const okStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const okIdx = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;
const okHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);

// Torrent Together: the desktop app downloads the torrent itself and plays it from a local address
export function registerTorrent(hardware = true): void {
  // ffmpeg is looked for once, at start-up; without it only what the page plays by itself works
  const engineOpts = { root: path.join(app.getPath('userData'), 'torrents'), transcoder: null as Transcoder | null };
  const transcoderReady = findBinaries().then(
    bin => { if (bin) engineOpts.transcoder = createTranscoder({ bin, root: path.join(app.getPath('userData'), 'transcode'), hardware }); },
    () => {});
  const engine = createTorrentEngine(engineOpts);

  // Everything a window asked for goes when the window does
  const watched = new WeakSet<object>();
  const owner = (e: IpcMainInvokeEvent) => {
    if (!watched.has(e.sender)) {
      watched.add(e.sender);
      e.sender.once('destroyed', () => engine.release(e.sender));
    }
    return e.sender;
  };

  // A magnet link, a bare info hash, or the address of a .torrent file
  ipcMain.handle('torrent:inspect', async (e, input: unknown) => {
    if (!okStr(input, 8192)) throw new Error('Paste a magnet link');
    const text = input.trim();
    if (/^https?:\/\//i.test(text)) {
      const bytes = await fetchLimited(text, MAX_TORRENT_FILE, 20000, true);
      return engine.inspect(bytes, owner(e));
    }
    if (!normalizeMagnet(text)) throw new Error('That is not a magnet link, an info hash or the address of a .torrent file');
    return engine.inspect(text, owner(e));
  });

  // A .torrent file from this computer; the person picks it, the page never names a path
  ipcMain.handle('torrent:openFile', async e => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Choose a .torrent file',
      properties: ['openFile' as const],
      filters: [{ name: 'Torrent', extensions: ['torrent'] }]
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    const stat = await fs.stat(r.filePaths[0]);
    if (stat.size > MAX_TORRENT_FILE) throw new Error('That file is too large for a .torrent');
    return engine.inspect(new Uint8Array(await fs.readFile(r.filePaths[0])), owner(e));
  });

  ipcMain.handle('torrent:play', (e, meta: unknown) => {
    const m = meta as { magnet?: unknown; fileIdx?: unknown; fileName?: unknown; size?: unknown } | null;
    if (!m || !okStr(m.magnet, MAX_MAGNET) || !okIdx(m.fileIdx)) throw new Error('bad request');
    return engine.play({
      magnet: m.magnet, fileIdx: m.fileIdx,
      fileName: typeof m.fileName === 'string' ? m.fileName.slice(0, 400) : undefined,
      size: typeof m.size === 'number' && Number.isSafeInteger(m.size) && m.size >= 0 ? m.size : undefined
    }, owner(e));
  });

  // What the played file holds, and the address of its converted form (info is null when ffmpeg is missing or can not read it)
  ipcMain.handle('torrent:probe', async (_e, infoHash: unknown, fileIdx: unknown) => {
    if (!okHash(infoHash) || !okIdx(fileIdx)) throw new Error('bad request');
    await transcoderReady;
    return engine.probe(infoHash, fileIdx);
  });

  ipcMain.handle('torrent:stats', (_e, infoHash: unknown, fileIdx: unknown) => {
    if (!okHash(infoHash) || !okIdx(fileIdx)) throw new Error('bad request');
    return engine.stats(infoHash, fileIdx);
  });

  ipcMain.handle('torrent:stop', (e, infoHash: unknown) => {
    if (okHash(infoHash)) engine.stop(infoHash, e.sender);
  });

  // The subtitles that fit the played file: by its OpenSubtitles hash and by its name
  ipcMain.handle('torrent:subtitles', async (_e, infoHash: unknown, fileIdx: unknown, query: unknown) => {
    if (!okHash(infoHash) || !okIdx(fileIdx)) throw new Error('bad request');
    const facts = await engine.fileFacts(infoHash, fileIdx);
    if (!facts) return [];
    return findSubtitles({ filename: facts.name, size: facts.size, hash: facts.hash, query: typeof query === 'string' ? query.slice(0, 200) : undefined });
  });

  // The next episodes of a show, found in the addon, for the file that was chosen
  ipcMain.handle('torrent:findEpisodes', (_e, filename: unknown, count: unknown) => {
    if (!okStr(filename, 400) || typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count >= MAX_QUEUE) throw new Error('bad request');
    return findEpisodes(filename, count);
  });

  // Search instead of a pasted link: first the title, then the torrents of every Torrentio provider for it
  ipcMain.handle('torrent:searchTitles', (_e, query: unknown) => {
    if (!okStr(query, 200) || !query.trim()) throw new Error('Type a title to search for');
    return searchTitles(query);
  });
  ipcMain.handle('torrent:searchTorrents', (_e, t: unknown, season: unknown, episode: unknown) => {
    const x = t as { source?: unknown; id?: unknown; type?: unknown } | null;
    const source = x?.source, type = x?.type;
    const idOk = typeof x?.id === 'string' && (source === 'imdb' ? /^tt\d{1,10}$/.test(x.id) : source === 'kitsu' && /^\d{1,9}$/.test(x.id));
    const num = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9999;
    if (!idOk || (type !== 'movie' && type !== 'series') || !num(season) || !num(episode)) throw new Error('bad request');
    return searchTorrents({ source: source as 'imdb' | 'kitsu', id: x!.id as string, type }, season as number, episode as number);
  });

  // Subtitles inside the video file: which there are, then a scan of the file that sends their cues as it goes
  ipcMain.handle('torrent:embeddedTracks', (_e, infoHash: unknown, fileIdx: unknown) => {
    if (!okHash(infoHash) || !okIdx(fileIdx)) throw new Error('bad request');
    return engine.embeddedTracks(infoHash, fileIdx);
  });
  ipcMain.handle('torrent:embeddedScan', (e, infoHash: unknown, fileIdx: unknown, startMs: unknown) => {
    if (!okHash(infoHash) || !okIdx(fileIdx) || typeof startMs !== 'number' || !Number.isFinite(startMs)) throw new Error('bad request');
    const sender = e.sender;
    engine.embeddedScan(infoHash, fileIdx, Math.max(0, Math.floor(startMs)), b => {
      if (!sender.isDestroyed()) sender.send('torrent:embeddedCues', { infoHash, fileIdx, ...b });
    });
  });
  ipcMain.handle('torrent:embeddedStop', (_e, infoHash: unknown, fileIdx: unknown) => {
    if (!okHash(infoHash) || !okIdx(fileIdx)) return;
    engine.embeddedStop(infoHash, fileIdx);
  });

  ipcMain.handle('torrent:subtitleFile', (_e, url: unknown, lang: unknown) => {
    if (!okStr(url, 2048)) throw new Error('bad request');
    return fetchSubtitle(url, typeof lang === 'string' ? lang.slice(0, 8) : '');
  });

  app.on('will-quit', () => { void engine.shutdown(); });
}
