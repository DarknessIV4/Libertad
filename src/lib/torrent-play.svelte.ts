// Torrent Together: one person's side of it. Starts the torrent in the desktop app, plays it in the
// page's own <video> from the local address the app serves, shows how the download is going, and
// finds and shows subtitles like Stremio's player does.
import { desktop, torrentError } from './native.ts';
import { store } from './settings.svelte.ts';
import type { TorrentMeta, TorrentStats } from '../core/torrent-meta.ts';
import { decodeSubtitle, langLabel, normLang, parseSubtitles, preferredLangs, type Cue, type SubtitleOption } from '../core/subtitles.ts';
import { pickAudio, planPlayback, type MediaInfo } from '../core/transcode.ts';
import type { EmbeddedBatch, EmbeddedTrack } from '../core/mkv.ts';

const MAX_DELAY_MS = 60000;
const MAX_SUBTITLE_FILE = 3 * 1024 * 1024;

export type TorrentStatus = 'idle' | 'connecting' | 'ready' | 'failed';

// One voice (audio track) of the video, as the menu shows it
export interface AudioOption { index: number; label: string; detail: string; on: boolean }
// The part of a video's audio track list this uses (browsers ship no types for it)
interface AudioTrackLike { enabled: boolean; label: string; language: string }
interface AudioTrackListLike {
  length: number;
  [i: number]: AudioTrackLike;
  addEventListener(ev: string, fn: () => void): void;
  removeEventListener(ev: string, fn: () => void): void;
}

// The <video> gave up on the file itself
class MediaFailure extends Error {}

export class TorrentPlay {
  status = $state<TorrentStatus>('idle');
  error = $state('');
  stats = $state<TorrentStats | null>(null);
  // The picture has stopped for want of data
  buffering = $state(false);

  subs = $state<SubtitleOption[]>([]);
  subsState = $state<'idle' | 'searching' | 'done'>('idle');
  // 'off', the id of a found subtitle, or 'file' (one from this computer)
  chosen = $state('off');
  subError = $state('');
  delayMs = $state(0);
  // What is being said right now, as safe HTML (only bold, italic, underline and line breaks)
  shown = $state('');
  // Subtitles inside the video file, and how the reading of the file for their lines is going
  embedded = $state<EmbeddedTrack[]>([]);
  scan = $state<{ state: 'idle' | 'running' | 'done' | 'failed'; progress: number }>({ state: 'idle', progress: 0 });
  // The voices of the video: always at least one (the file's own sound), the chosen one marked
  audio = $state<AudioOption[]>([]);

  // Why the video is being converted ("HEVC video", "DTS audio"), or '' when it plays as it is
  converting = $state('');

  private hls: { destroy(): void } | null = null;
  private conv: { base: string; info: MediaInfo; voice: number } | null = null;
  private video: HTMLVideoElement | null = null;
  private meta: TorrentMeta | null = null;
  private track: TextTrack | null = null;
  private cues: Cue[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private off: (() => void) | null = null;
  private embCues = new Map<number, Cue[]>();
  private offCues: (() => void) | null = null;
  private offAudio: (() => void) | null = null;
  private run = 0; // a newer start (or a stop) makes an older one's answers worthless

  // Starts downloading and loads the video into `video`; `ready` is called once it knows its length
  async start(meta: TorrentMeta, video: HTMLVideoElement, ready: () => void): Promise<void> {
    this.stop();
    const run = ++this.run;
    this.meta = meta;
    this.video = video;
    this.status = 'connecting';
    this.error = '';
    const api = desktop?.torrent;
    if (!api) {
      this.status = 'failed';
      this.error = 'Torrent Together needs the Libertad desktop app.';
      return;
    }

    const poll = () => api.stats(meta.infoHash, meta.fileIdx).then(s => { if (run === this.run) this.stats = s; }, () => {});
    void poll();
    this.timer = setInterval(poll, 1000);

    const onWaiting = () => { this.buffering = true; };
    const onFlowing = () => { this.buffering = false; };
    const onError = () => { if (this.status === 'ready') this.fail(video); };
    video.addEventListener('waiting', onWaiting);
    for (const ev of ['playing', 'canplay', 'pause', 'seeked']) video.addEventListener(ev, onFlowing);
    video.addEventListener('error', onError);
    this.off = () => {
      video.removeEventListener('waiting', onWaiting);
      for (const ev of ['playing', 'canplay', 'pause', 'seeked']) video.removeEventListener(ev, onFlowing);
      video.removeEventListener('error', onError);
    };

    try {
      const play = await api.play({ magnet: meta.magnet, fileIdx: meta.fileIdx });
      if (run !== this.run) return;
      // What is in the file decides whether the page can play it itself or it has to be converted first (HEVC,
      // DTS, an AVI ...). Without ffmpeg there is no probe, and the file is simply tried.
      const probe = await api.probe?.(meta.infoHash, meta.fileIdx).catch(() => null) ?? null;
      if (run !== this.run) return;
      const info = probe?.info ?? null;
      const base = probe?.hls ?? null;
      const plan = info ? planPlayback(info, play.fileName, m => video.canPlayType(m) !== '') : { direct: true, reason: '' };
      if (!plan.direct && base && info) {
        this.converting = plan.reason;
        await this.loadConverted(video, base, info, pickAudio(info.audio, preferredLangs(navigator.languages, '')), 0, run);
      } else {
        try {
          await this.loadDirect(video, play.url);
        } catch (e) {
          // The page's guess was wrong (or there was no probe): convert it after all
          if (!(e instanceof MediaFailure) || !base || !info) throw new Error(this.mediaError(video, !!base));
          this.converting = 'this format';
          await this.loadConverted(video, base, info, pickAudio(info.audio, preferredLangs(navigator.languages, '')), 0, run);
        }
      }
      if (run !== this.run) return;
      this.status = 'ready';
      ready();
      if (!this.conv) this.watchAudio(video);
      void this.findSubtitles(meta, run, undefined, this.loadEmbedded(meta, run));
    } catch (e) {
      if (run !== this.run) return;
      this.status = 'failed';
      this.error = torrentError(e);
    }
  }

  private loadDirect(video: HTMLVideoElement, url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const loaded = () => { video.removeEventListener('error', failed); resolve(); };
      const failed = () => { video.removeEventListener('loadedmetadata', loaded); reject(new MediaFailure()); };
      video.addEventListener('loadedmetadata', loaded, { once: true });
      video.addEventListener('error', failed, { once: true });
      video.src = url;
      video.load();
    });
  }

  // Plays the converted video (H.264 + AAC, cut into HLS segments by ffmpeg) through hls.js; `at` is where to start, in seconds
  private async loadConverted(video: HTMLVideoElement, base: string, info: MediaInfo, voice: number, at: number, run: number): Promise<void> {
    const { default: Hls } = await import('hls.js');
    if (run !== this.run) return;
    if (!Hls.isSupported()) throw new Error('This video has to be converted, and this computer can not play converted video.');
    this.destroyHls();
    video.removeAttribute('src');
    const slow = { maxTimeToFirstByteMs: 180000, maxLoadTimeMs: 240000, timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 } };
    // The first piece of a 4K film takes a while to make: be patient with it. No worker: the page's policy allows none.
    const hls = new Hls({ enableWorker: false, startPosition: at, maxBufferLength: 40, backBufferLength: 30, manifestLoadPolicy: { default: slow }, fragLoadPolicy: { default: slow } });
    this.hls = hls;
    this.conv = { base, info, voice };
    this.audio = info.audio.length
      ? info.audio.map(a => ({
          index: a.ord, on: a.ord === voice,
          label: a.lang && a.lang !== 'und' ? langLabel(a.lang) : a.title || `Track ${a.ord + 1}`,
          detail: [a.title && a.lang ? a.title : '', a.codec.toUpperCase(), a.channels > 2 ? `${a.channels - 1}.1` : ''].filter(Boolean).join(' · ')
        }))
      : [{ index: 0, label: 'Default', detail: '', on: true }];
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      video.addEventListener('loadedmetadata', () => { settled = true; resolve(); }, { once: true });
      hls.on(Hls.Events.ERROR, (_ev: unknown, d: { fatal?: boolean; details?: string }) => {
        if (!d.fatal) return;
        const err = new Error('The video could not be converted for playing. Pick another file or another release.');
        if (settled) { if (run === this.run) { this.status = 'failed'; this.error = err.message; } } else reject(err);
      });
      hls.loadSource(`${base}${voice}/index.m3u8`);
      hls.attachMedia(video);
    });
  }

  private destroyHls() {
    this.hls?.destroy();
    this.hls = null;
  }

  private mediaError(video: HTMLVideoElement, canConvert = false): string {
    // 4: the container or the codec is not one the player knows (HEVC, for one)
    if (video.error?.code !== 4) return 'The video could not be played.';
    return canConvert
      ? 'This video\'s format can not be played in Libertad, and converting it failed. Pick another file or another release.'
      : 'This video\'s format can not be played in Libertad (a codec such as HEVC or DTS is not supported), and ffmpeg was not found to convert it. Install ffmpeg (or set LIBERTAD_FFMPEG and LIBERTAD_FFPROBE), or pick another file or release.';
  }

  private fail(video: HTMLVideoElement) {
    this.status = 'failed';
    this.error = this.mediaError(video);
  }

  // Stops everything and lets go of the video; the torrent itself is stopped by whoever ends the party
  stop(): void {
    this.run++;
    if (this.meta) void desktop?.torrent?.embeddedStop?.(this.meta.infoHash, this.meta.fileIdx)?.catch(() => {});
    this.offCues?.();
    this.offCues = null;
    this.offAudio?.();
    this.offAudio = null;
    this.destroyHls();
    this.conv = null;
    this.converting = '';
    this.embedded = [];
    this.embCues.clear();
    this.scan = { state: 'idle', progress: 0 };
    this.audio = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
    this.clearCues();
    this.track = null;
    const video = this.video;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    this.video = null;
    this.meta = null;
    this.status = 'idle';
    this.error = '';
    this.stats = null;
    this.buffering = false;
    this.subs = [];
    this.subsState = 'idle';
    this.chosen = 'off';
    this.subError = '';
    this.delayMs = 0;
    this.cues = [];
  }

  // ─── Subtitles ───────────────────────────────────────────────────────────────

  // The person's own search, for a file whose name the search could not make sense of
  async search(query: string): Promise<void> {
    if (this.meta && query.trim()) await this.findSubtitles(this.meta, this.run, query.trim());
  }

  private async findSubtitles(meta: TorrentMeta, run: number, query?: string, embedded: Promise<void> = Promise.resolve()): Promise<void> {
    const api = desktop?.torrent;
    if (!api) return;
    this.subsState = 'searching';
    this.subError = '';
    try {
      const [found] = await Promise.all([api.subtitles(meta.infoHash, meta.fileIdx, query), embedded]);
      if (run !== this.run) return;
      this.subs = found;
      this.subsState = 'done';
      // Like Stremio: the person's own language (or the one chosen last time) starts by itself; a search
      // made by hand is meant to show something
      const saved = store.settings.subtitleLang;
      if (query || saved !== 'off') {
        const pick = this.autoPick(found, preferredLangs(navigator.languages, saved === 'off' ? '' : saved), !!query);
        if (pick) await this.choose(pick, false);
      }
    } catch (e) {
      if (run !== this.run) return;
      this.subsState = 'done';
      this.subError = torrentError(e);
    }
  }

  // The subtitle to start with: in the best language there is. The file's own (it fits its timing exactly) before one
  // found online, except for a search made by hand, which is meant to show what it found.
  private autoPick(found: readonly SubtitleOption[], langs: readonly string[], searched: boolean): string | null {
    for (const lang of langs) {
      const online = found.find(o => normLang(o.lang) === lang);
      const own = this.embedded.find(t => normLang(t.lang) === lang && !t.forced);
      if (searched && online) return online.id;
      if (own) return `emb:${own.number}`;
      if (online) return online.id;
    }
    return null;
  }

  // ─── Inside the file ─────────────────────────────────────────────────────────

  private async loadEmbedded(meta: TorrentMeta, run: number): Promise<void> {
    const api = desktop?.torrent;
    if (!api?.embeddedTracks) return;
    try {
      const tracks = await api.embeddedTracks(meta.infoHash, meta.fileIdx);
      if (run === this.run) this.embedded = tracks;
    } catch { /* the subtitles found online are still there */ }
  }

  // The file is read once, for all its subtitle tracks, when the first of them is wanted
  private startScan() {
    const api = desktop?.torrent, meta = this.meta;
    if (!api?.embeddedScan || !meta || this.scan.state === 'running' || this.scan.state === 'done') return;
    this.offCues ??= api.onEmbeddedCues(this.onBatch);
    this.scan = { state: 'running', progress: 0 };
    const run = this.run;
    api.embeddedScan(meta.infoHash, meta.fileIdx, Math.floor((this.video?.currentTime ?? 0) * 1000)).catch(e => {
      if (run !== this.run) return;
      this.scan = { state: 'failed', progress: 0 };
      this.subError = torrentError(e);
    });
  }

  private onBatch = (b: EmbeddedBatch) => {
    const meta = this.meta;
    if (!meta || b.infoHash !== meta.infoHash || b.fileIdx !== meta.fileIdx) return;
    const fresh: Cue[] = [];
    const want = this.chosen.startsWith('emb:') ? Number(this.chosen.slice(4)) : -1;
    for (const c of b.cues) {
      let list = this.embCues.get(c.track);
      if (!list) this.embCues.set(c.track, (list = []));
      const cue = { start: c.start, end: c.end, text: c.text };
      list.push(cue);
      if (c.track === want) fresh.push(cue);
    }
    this.scan = { state: b.error ? 'failed' : b.done ? 'done' : 'running', progress: b.progress };
    if (b.error) this.subError = b.error;
    if (fresh.length) {
      if (this.track && this.track.mode !== 'disabled') this.addCues(fresh); else this.show();
    }
  };

  // ─── Voices ──────────────────────────────────────────────────────────────────

  private audioList(video: HTMLVideoElement): AudioTrackListLike | null {
    return ((video as unknown as { audioTracks?: AudioTrackListLike }).audioTracks) ?? null;
  }

  // The video's own audio tracks (the voice-overs of a release that has several). A video whose tracks can not be
  // listed has the one it plays.
  private watchAudio(video: HTMLVideoElement) {
    const list = this.audioList(video);
    const read = () => {
      const out: AudioOption[] = [];
      for (let i = 0; list && i < list.length; i++) {
        const t = list[i];
        const lang = t.language && t.language !== 'und' ? langLabel(t.language) : '';
        const label = (t.label ?? '').trim();
        out.push({
          index: i, on: t.enabled,
          label: lang || label || `Track ${i + 1}`,
          detail: lang && label && label.toLowerCase() !== lang.toLowerCase() ? label : ''
        });
      }
      // Exactly one is on; when the browser does not say which, it is the first
      if (out.length && !out.some(o => o.on)) out[0].on = true;
      this.audio = out.length ? out : [{ index: 0, label: 'Default', detail: '', on: true }];
    };
    read();
    if (!list) return;
    for (const ev of ['addtrack', 'removetrack', 'change']) list.addEventListener(ev, read);
    this.offAudio = () => { for (const ev of ['addtrack', 'removetrack', 'change']) list.removeEventListener(ev, read); };
  }

  setAudio(index: number): void {
    if (this.conv) { void this.switchVoice(index); return; }
    const list = this.video ? this.audioList(this.video) : null;
    if (!list || index < 0 || index >= list.length) return;
    for (let i = 0; i < list.length; i++) list[i].enabled = i === index;
    this.audio = this.audio.map(o => ({ ...o, on: o.index === index }));
  }

  // A converted video has one voice in it at a time: another one is made from where the person is
  private async switchVoice(index: number): Promise<void> {
    const video = this.video, conv = this.conv, run = this.run;
    if (!video || !conv || index === conv.voice || !conv.info.audio.some(a => a.ord === index)) return;
    const at = video.currentTime, paused = video.paused;
    try {
      await this.loadConverted(video, conv.base, conv.info, index, at, run);
      if (run === this.run && !paused) void video.play().catch(() => {});
    } catch (e) {
      if (run === this.run) { this.status = 'failed'; this.error = torrentError(e); }
    }
  }

  // `remember`: a choice made by hand is the language to start with next time
  async choose(id: string, remember = true): Promise<void> {
    const run = this.run;
    this.subError = '';
    if (id === 'off') {
      this.chosen = 'off';
      this.cues = [];
      this.clearCues();
      if (remember) { store.settings.subtitleLang = 'off'; store.saveSettings(); }
      return;
    }
    if (id.startsWith('emb:')) {
      const n = Number(id.slice(4));
      const t = this.embedded.find(x => x.number === n);
      if (!t) return;
      let list = this.embCues.get(n);
      if (!list) this.embCues.set(n, (list = []));
      this.cues = list;
      this.chosen = id;
      this.startScan();
      this.show();
      if (remember) { store.settings.subtitleLang = t.lang; store.saveSettings(); }
      return;
    }
    const option = this.subs.find(s => s.id === id);
    const api = desktop?.torrent;
    if (!option || !api) return;
    try {
      const cues = await api.subtitleFile(option.url, option.lang);
      if (run !== this.run) return;
      if (!cues.length) throw new Error('This subtitle file is empty');
      this.cues = cues;
      this.chosen = id;
      this.show();
      if (remember) { store.settings.subtitleLang = option.lang; store.saveSettings(); }
    } catch (e) {
      if (run === this.run) this.subError = torrentError(e);
    }
  }

  // A subtitle file from this computer
  async loadFile(file: File): Promise<void> {
    this.subError = '';
    try {
      if (file.size > MAX_SUBTITLE_FILE) throw new Error('That file is too large for a subtitle');
      const text = decodeSubtitle(new Uint8Array(await file.arrayBuffer()), preferredLangs(navigator.languages, store.settings.subtitleLang)[0]);
      const cues = parseSubtitles(text);
      if (!cues.length) throw new Error('No subtitles were found in that file (SubRip .srt and WebVTT .vtt are read)');
      this.cues = cues;
      this.chosen = 'file';
      this.show();
    } catch (e) {
      this.subError = torrentError(e);
    }
  }

  // Subtitles that come too early or too late are moved for this person only
  setDelay(ms: number): void {
    this.delayMs = Math.max(-MAX_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(ms)));
    if (this.cues.length) this.show();
  }

  private clearCues() {
    this.shown = '';
    const t = this.track;
    if (!t) return;
    for (const cue of Array.from(t.cues ?? [])) t.removeCue(cue);
    t.mode = 'disabled';
  }

  // The cues on screen now. The page draws them itself (so they can be sized and moved), the video's
  // own cue drawing stays off: the track is 'hidden', which still tells us when a cue starts and ends.
  private refresh = () => {
    const t = this.track;
    const active = t && t.mode !== 'disabled' ? Array.from(t.activeCues ?? []) : [];
    this.shown = active.map(c => cueHtml((c as VTTCue).text)).join('<br>');
  };

  // Lines that arrived after the track was made are added to it
  private addCues(fresh: readonly Cue[]) {
    const t = this.track;
    if (!t) return;
    const shift = this.delayMs;
    for (const c of fresh) {
      const start = Math.max(0, c.start + shift) / 1000, end = Math.max(0, c.end + shift) / 1000;
      if (end > start) t.addCue(new VTTCue(start, end, c.text));
    }
    this.refresh();
  }

  private show() {
    const video = this.video;
    if (!video) return;
    if (!this.track) {
      this.track = video.addTextTrack('subtitles', 'Libertad', 'und');
      this.track.addEventListener('cuechange', this.refresh);
    }
    const t = this.track;
    for (const cue of Array.from(t.cues ?? [])) t.removeCue(cue);
    const shift = this.delayMs;
    for (const c of this.cues) {
      const start = Math.max(0, c.start + shift) / 1000, end = Math.max(0, c.end + shift) / 1000;
      if (end > start) t.addCue(new VTTCue(start, end, c.text));
    }
    t.mode = 'hidden';
    this.refresh();
  }
}

// Cue text for the page: everything is shown as text, only <i>, <b> and <u> (the parser keeps no other tag) work
function cueHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/<(\/?)(i|b|u)\s*>/gi, '\u0001$1$2\u0002')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u0001(\/?)(i|b|u)\u0002/g, '<$1$2>')
    .replace(/\n/g, '<br>');
}
