import type { Transport, ServerCertInfo, CertDetails, UdpChannel } from '../core/transport.ts';
import { webApi, openWebTransport } from './web.svelte.ts';
import type { TorrentInfo, TorrentPlay, TorrentStats } from '../core/torrent-meta.ts';
import type { FoundEpisodes } from '../core/episodes.ts';
import type { FoundTorrent, TitleResult } from '../core/search.ts';
import type { YoutubeResult } from '../core/youtube-search.ts';
import type { EmbeddedBatch, EmbeddedTrack } from '../core/mkv.ts';
import type { Cue, SubtitleOption } from '../core/subtitles.ts';

// What an IPC call to the desktop app's main process rejects with: "Error invoking remote method 'x': Error: the sentence"
export const torrentError = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') || 'Something went wrong';

// What both the desktop app and the browser build (through the web proxy) provide
export type YoutubeAccountState = { signedIn: boolean; noHistory: boolean };

export interface PlatformApi {
  platformInfo(): Promise<{ os: string; osVersion: string }>;
  describeCerts(ders: Uint8Array[]): Promise<CertDetails[]>;
  // People on a server without connecting (UDP ping; in the browser the proxy sends it, for its own servers)
  pingServer(host: string, port: number): Promise<PingResult | null>;
  identities: {
    list(): Promise<{ identities: IdentitySummary[]; setupDone: boolean }>;
    create(name: string, email: string): Promise<IdentitySummary>;
    importP12(bytes: Uint8Array, password: string, name: string): Promise<IdentitySummary>;
    findMumble(): Promise<{ name: string } | null>;
    importMumble(name: string): Promise<IdentitySummary>;
    // Where the backup was saved, or null when cancelled
    exportP12(id: string, password: string): Promise<string | null>;
    setDefault(id: string): Promise<void>;
    rename(id: string, name: string): Promise<void>;
    remove(id: string): Promise<void>;
    finishSetup(): Promise<void>;
  };
}

export type FileBegin = { ok: true } | { ok: false; reason: 'canceled' | 'space' | 'toolarge' | 'error'; free?: number };
export type FileExport = { ok: true; path: string } | { ok: false; reason: 'canceled' | 'space' | 'toolarge' | 'error'; free?: number };

// The desktop app's preload API
interface NativeApi extends PlatformApi {
  // Other people's profile backgrounds in the app's data folder (user-profiles/<name>/<file>); bytes null deletes
  profiles: {
    read(name: string, file: 'meta.json' | 'banner' | 'card'): Promise<Uint8Array | null>;
    write(name: string, file: 'meta.json' | 'banner' | 'card', bytes: Uint8Array | null): Promise<boolean>;
  };
  files: {
    // Asks where to save (a Save dialog) and creates the file there; nothing is fetched before this says ok
    begin(id: string, name: string, size: number, hash: string): Promise<FileBegin>;
    write(id: string, offset: number, bytes: Uint8Array): Promise<boolean>;
    // Puts the finished file in place and returns its path
    finish(id: string): Promise<string>;
    // Drops an unfinished download and any cached copy; never a file the person saved
    remove(id: string): Promise<boolean>;
    where(id: string, hash: string): Promise<{ kind: 'saved'; path: string } | { kind: 'cache' } | null>;
    reveal(id: string): Promise<boolean>;
    // Moves a file an older version cached out to a place the person picks
    export(id: string, name: string, hash: string): Promise<FileExport>;
  };
  // Torrent Together (desktop only). Errors come back as rejections with a sentence a person can read, see torrentError.
  torrent: {
    // A magnet link, a bare info hash or the address of a .torrent file; resolves once the file list is known
    inspect(input: string): Promise<TorrentInfo>;
    // Asks for a .torrent file on this computer; null when cancelled
    openFile(): Promise<TorrentInfo | null>;
    // Starts downloading the file and returns the local address to play it from
    play(meta: { magnet: string; fileIdx: number }): Promise<TorrentPlay>;
    stats(infoHash: string, fileIdx: number): Promise<TorrentStats>;
    // Stops downloading and forgets the files
    stop(infoHash: string): Promise<void>;
    // `query`: a title or an IMDb id typed by the person, when the file's own name finds nothing
    subtitles(infoHash: string, fileIdx: number, query?: string): Promise<SubtitleOption[]>;
    subtitleFile(url: string, lang: string): Promise<Cue[]>;
    // The `count` episodes after the one the file is, looked up online in the same release (group and resolution) when possible
    findEpisodes(filename: string, count: number): Promise<FoundEpisodes>;
    // Films, series and anime matching a title typed by the person
    searchTitles(query: string): Promise<TitleResult[]>;
    // The torrents of every Torrentio provider for a film, or for one episode of a series (season and episode are ignored for a film)
    searchTorrents(title: Pick<TitleResult, 'source' | 'id' | 'type'>, season: number, episode: number): Promise<FoundTorrent[]>;
    // The text subtitle tracks inside the video file (a Matroska file; none for any other kind)
    embeddedTracks(infoHash: string, fileIdx: number): Promise<EmbeddedTrack[]>;
    // Reads the file for the cues of those tracks, starting at `startMs`; they arrive through onEmbeddedCues
    embeddedScan(infoHash: string, fileIdx: number, startMs: number): Promise<void>;
    embeddedStop(infoHash: string, fileIdx: number): Promise<void>;
    onEmbeddedCues(fn: (batch: EmbeddedBatch) => void): () => void;
  };
  updateTray(state: { icon: string; tooltip: string; connected: boolean; server: string; muted: boolean; deafened: boolean; mode: string }): void;
  onTrayAction(fn: (action: string) => void): void;
  // Settings Chromium reads at start-up; changes apply after a restart
  system: {
    get(): Promise<{ hardwareAcceleration: boolean; launchOnStartup: boolean; platform: string }>;
    setHardwareAcceleration(on: boolean): Promise<void>;
    // Starts mumh5 when you sign in to the computer (takes effect at once, no restart)
    setLaunchOnStartup(on: boolean): Promise<void>;
    relaunch(): Promise<void>;
    // Closes the app for good (not just to the tray)
    quit(): Promise<void>;
  };
  // Keyboard shortcuts that work while the app is in the background; resolves to the ids the system refused
  shortcuts: {
    setGlobal(list: { id: string; accelerator: string }[]): Promise<{ failed: string[]; wayland: boolean }>;
  };
  setFullScreen(fullscreen: boolean): Promise<void>;
  isFullScreen(): Promise<boolean>;
  // Full screen of one pop-out window (by the name it was opened with); omit `fullscreen` to toggle. Resolves to the state asked for.
  // The YouTube account of the embedded player (see electron/youtube-account.ts)
  youtube: {
    // Videos matching a title typed by the person
    search(query: string): Promise<YoutubeResult[]>;
    account(): Promise<YoutubeAccountState>;
    // The app's own sign-in window (asks like Firefox; Google may still refuse); resolves when it closes
    signIn(): Promise<YoutubeAccountState>;
    // Opens the default browser; resolves when the companion extension has delivered the sign-in, or it was cancelled
    browserSignIn(): Promise<YoutubeAccountState & { error?: string }>;
    browserCancel(): Promise<void>;
    // The folder holding the browser extension (written on demand); the second also opens it in the file manager
    companionFolder(): Promise<string>;
    openCompanionFolder(): Promise<string>;
    // Cookie text copied from the browser: a "Cookie:" header, a Cookie-Editor JSON export, cookies.txt or table rows
    importCookies(text: string): Promise<YoutubeAccountState & { imported?: number; error?: string }>;
    signOut(): Promise<YoutubeAccountState>;
    setNoHistory(on: boolean): Promise<YoutubeAccountState>;
  };
  setPopoutFullScreen(name: string, fullscreen?: boolean): Promise<boolean>;
  isPopoutFullScreen(name: string): Promise<boolean>;
  linkPreview(url: string): Promise<LinkPreviewData | null>;
  // Sets the quality inside the YouTube player's frame (see electron/yt-quality.ts)
  youtubeQuality(level: string): Promise<{ method: 'api' | 'menu' | 'none'; quality?: string; error?: string }>;
  // Sets the playback speed inside the YouTube player's frame
  youtubeRate(rate: number): Promise<{ method: 'api' | 'menu' | 'none'; rate?: number; error?: string }>;
  // The size of the picture the YouTube player plays (null while unknown)
  youtubeVideoSize(): Promise<{ width: number; height: number } | null>;
  // One frame of the YouTube picture as a small JPEG data address (null when there is none)
  youtubeFrame(): Promise<string | null>;
  // The video's preview picture from YouTube, as a small JPEG data address (null when there is none)
  youtubeThumbnail(id: string): Promise<string | null>;
  publicServers(url: string): Promise<PublicServer[]>;
  onContextMenu(fn: (params: ContextParams) => void): void;
  editAction(action: string, arg?: unknown): void;
  // Screens and windows that can be shared; pick one before calling getDisplayMedia
  // chosen: the system's own picker already asked (Wayland), so `sources` is the one answer
  // Thumbnails are slower to get and can fail; ask for the names first
  screenSources(thumbnails: boolean): Promise<{ sources: ScreenSource[]; chosen: boolean }>;
  pickScreenSource(id: string): void;
  // portal: the system shows its own source picker (Wayland). audio: how other programs' sound can be captured.
  shareInfo(): Promise<{ portal: boolean; audio: 'pipewire' | 'loopback' | 'none'; micLabel: string }>;
  shareAudioApps(): Promise<string[]>;
  // Linux: route one program, or everything but this app, into a virtual microphone named micLabel
  shareAudioStart(target: { kind: 'all' } | { kind: 'app'; name: string }): Promise<void>;
  shareAudioStop(): Promise<void>;
  open(connId: string, host: string, port: number, identityId?: string): Promise<void>;
  send(connId: string, bytes: Uint8Array): void;
  close(connId: string): void;
  on(event: 'secure' | 'data' | 'close' | 'udpVoice' | 'udpState' | 'udpResync', fn: (connId: string, ...args: any[]) => void): () => void;
  udpSetup(connId: string, key: Uint8Array, cn: Uint8Array, sn: Uint8Array, protobuf: boolean): void;
  udpNonce(connId: string, sn: Uint8Array): void;
  udpSend(connId: string, bytes: Uint8Array): void;
  udpClientNonce(connId: string): Promise<Uint8Array | null>;
}

// What Electron reports for a right-click without a custom menu
export interface ContextParams {
  x: number;
  y: number;
  isEditable: boolean;
  selectionText: string;
  linkURL: string;
  mediaType: string;
  srcURL: string;
  misspelledWord: string;
  suggestions: string[];
  editFlags: { canUndo: boolean; canRedo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

export interface ScreenSource { id: string; name: string; thumbnail: string }
export interface PublicServer { name: string; host: string; port: number; url: string; country: string; countryCode: string; continent: string; ca: boolean }
export interface PingResult { ping: number; users: number; maxUsers: number; bandwidth: number; version: string }

export interface LinkPreviewData {
  url: string;
  title: string;
  description: string;
  site: string;
  image: string;
  large: boolean;
  color: string;
}

export interface IdentitySummary {
  id: string;
  name: string;
  fingerprint: string;
  isDefault: boolean;
  cert: CertDetails;
}

declare global {
  interface Window { mumh5Native?: NativeApi }
}

// Desktop-only features (tray, UDP voice, public list, direct link previews) check `desktop`
export const desktop: NativeApi | null = typeof window !== 'undefined' ? window.mumh5Native ?? null : null;
// The browser build (vite --mode web) talks to the web proxy instead
export const isWeb = !desktop && import.meta.env?.MODE === 'web';
export const native: PlatformApi | null = desktop ?? (isWeb ? webApi : null);

// A connection to a Mumble server: TLS in the desktop app, the proxy's WebSocket in the browser
export async function openTransport(host: string, port: number, identityId?: string): Promise<(Transport & { secure: Promise<ServerCertInfo> }) | null> {
  if (desktop) return new ElectronTransport(desktop, host, port, identityId);
  if (isWeb) return openWebTransport(host, port, identityId);
  return null;
}

// Transport backed by a TLS socket in the Electron main process.
// `secure` resolves once the TLS handshake is done, before any Mumble data is sent,
// so the caller can check the server certificate before sending a password.
export class ElectronTransport implements Transport {
  onData: ((chunk: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  readonly secure: Promise<ServerCertInfo>;
  udp: UdpChannel;
  private id = crypto.randomUUID();
  private offs: (() => void)[] = [];
  private api: NativeApi;

  constructor(api: NativeApi, host: string, port: number, identityId?: string) {
    this.api = api;
    let resolveSecure!: (i: ServerCertInfo) => void;
    let rejectSecure!: (e: Error) => void;
    this.secure = new Promise((res, rej) => { resolveSecure = res; rejectSecure = rej; });
    const id = this.id;
    // UDP voice lives in the main process; this bridges it to the client's UdpChannel
    const udp: UdpChannel = {
      onVoice: null, onState: null, onResync: null,
      setup: (k, c, s, p) => api.udpSetup(id, k, c, s, p),
      setServerNonce: n => api.udpNonce(id, n),
      clientNonce: () => api.udpClientNonce(id),
      send: p => api.udpSend(id, p)
    };
    this.udp = udp;
    this.offs.push(
      api.on('udpVoice', (cid, p) => { if (cid === id) udp.onVoice?.(p); }),
      api.on('udpState', (cid, ok, rtt) => { if (cid === id) udp.onState?.(ok, rtt); }),
      api.on('udpResync', cid => { if (cid === id) udp.onResync?.(); }),
      api.on('secure', (cid, info) => { if (cid === id) resolveSecure(info); }),
      api.on('data', (cid, chunk) => { if (cid === id) this.onData?.(chunk); }),
      api.on('close', (cid, reason) => {
        if (cid !== id) return;
        this.offs.forEach(off => off());
        rejectSecure(new Error(reason));
        this.onClose?.(reason);
      })
    );
    api.open(id, host, port, identityId).catch(e => rejectSecure(e));
  }

  send(bytes: Uint8Array): void { this.api.send(this.id, bytes); }
  close(): void { this.api.close(this.id); }
}
