// Watch Together - shared playback sync state and logic
import type { YtControls } from './yt-controls.ts';
import { sessions } from './session.svelte.ts';
import { ui } from './ui.svelte.ts';
import { WATCH, WATCH_DATA_ID, encodeWatchSignal, WatchAssembler, type WatchMode, type WatchPartyMeta, type FileMeta, type StatePayload, type NextPayload } from '../core/watch-together.ts';
import { watchFileStream } from '../core/watch-stream.ts';
import type { Session } from './session.svelte.ts';
import { getBlob } from './blobstore.ts';
import { files } from './files.svelte.ts';
import { validMeta, type FileMeta as SharedFile } from '../core/file-transfer.ts';
import { validTorrentMeta, validTorrentQueue, type TorrentMeta } from '../core/torrent-meta.ts';
import { desktop } from './native.ts';

export type { WatchMode };

export interface WatchParty {
  host: Session;
  hostSession: number;
  meta: WatchPartyMeta;
  positionMs: number;
  playing: boolean;
  participants: number[]; // session IDs
  playlist: { id: string; title: string }[];
  currentIndex: number;
  at: number; // server timestamp of last update
  durationMs?: number; // length of the host's video (mode 2); viewers only receive a live stream, so the host tells them
  fileShare?: SharedFile; // the host's file as the file transfer knows it, so viewers can download the whole video
  // For file streaming (mode 2) - WebRTC based
  // File state is now in watchFileStream.watchers
  // For YouTube popup (mode 1)
  popoutPositionMs?: number; // Stored playback position when popped out
  popoutPlaying?: boolean; // Stored playing state when popped out
}

// Shared sync state with revision for conflict resolution
interface SyncState {
  rev: number;            // monotonically increasing revision
  origin: number;         // session id that originated this state
  playing: boolean;
  positionMs: number;
  at: number;             // server time when positionMs was true
  rate?: number;          // playback speed everybody plays at (YouTube); 1 when absent
}

type WatchState = 'idle' | 'joining' | 'watching' | 'leaving';

// Sync constants
const SYNC_INTERVAL_MS = 1000;
const DRIFT_THRESHOLD_MS = 700;
const SEEK_THRESHOLD_MS = 2000;
// The embedded player reports its position coarsely: only a bigger difference is worth a seek
const YT_DRIFT_MS = 1500;
// A paused player holds still and says exactly where it is, so it is held to a tighter line:
// everyone who pauses should stop on the same frame, not up to YT_DRIFT_MS apart
const YT_PAUSED_DRIFT_MS = 500;
const SEEK_DEBOUNCE_MS = 150;
const SETTLE_MS = 250;
const SETTLE_MAX_WAIT_MS = 600;
const EXPECTED_ECHO_WINDOW_MS = 1500;
const ECHO_TOLERANCE_MS = 500;

// Player states (match YouTube API)
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_ENDED = 0;
const YT_BUFFERING = 3;

function getServerTime(): number {
  return Date.now();
}

function compareSyncState(a: SyncState | null, b: SyncState | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.rev !== b.rev) return a.rev - b.rev;
  return a.origin - b.origin; // higher origin wins ties
}

function isSyncStateNewer(incoming: SyncState, current: SyncState | null): boolean {
  return compareSyncState(incoming, current) > 0;
}

class WatchTogether {
  // Per-session state (like Share.watches array)
  private parties = $state<Map<Session, WatchParty>>(new Map());
  private states = $state<Map<Session, WatchState>>(new Map());
  private syncIntervals = new Map<Session, number>();
  private assemblers = new Map<Session, WatchAssembler>();
  // Shared across sessions (local playback elements)
  // Plain field for identity check and listener bookkeeping (non-reactive)
  private videoEl: HTMLVideoElement | null = null;
  // Reactive field only for UI/components that need to read it
  localVideo = $state<HTMLVideoElement | null>(null);
  // Stream from host (mode 2): the host's player belongs to the session, not to the screen that
  // shows it. What it plays is what the viewers receive, so it has to keep playing when the host
  // leaves (the screen closes) and only stop when the party ends.
  hostVideo = $state.raw<HTMLVideoElement | null>(null);
  private hostVideoUrl: string | null = null;
  private hostVideoOwner: Session | null = null;
  private hostPark: HTMLElement | null = null;
  // getCurrentTime is in seconds (like YouTube's own API), seekTo in milliseconds
  youtubePlayer: ({ play: () => void; pause: () => void; seekTo: (ms: number) => void; getCurrentTime: () => number; getPlayerState: () => number; ready?: () => boolean } & Partial<YtControls>) | null = null;
  pendingSeek = $state(false);
  lastSyncSent = 0;
  latencyEstimate = $state(0);
  // Echo-safe tracking
  private expectedSeekMs: number | null = null;
  private expectedSeekUntil = 0;
  private expectedPlaying: boolean | null = null;
  private expectedPlayingUntil = 0;
  // Debounce
  private seekDebounceTimer: number | null = null;
  private seekDebouncedPosition: number | null = null;
  // Settle: coalesces play/pause/seek into one publish
  private settleTimer: number | null = null;
  private settleStartTime: number | null = null;
  private pendingSettleEvents: string[] = [];
  private settlePending = false; // non-reactive flag: local gesture waiting to publish
  // Last applied seek for duplicate detection
  private lastAppliedSeekServerTime = 0;
  private lastAppliedSeekPositionMs = 0;
  // Shared sync state per session
  private syncState = new Map<Session, SyncState | null>();
  // Stored state for leave/rejoin (extrapolated)
  private storedState = new Map<Session, { positionMs: number; playing: boolean; at: number; rate?: number }>();
  // Focus request from UI (channel tree, members list) to show watch together in VoiceStage
  private _focusRequest = $state(0);

  // DEBUG flag - set to true for verbose sync logging
  private static DEBUG = true; // Temporarily enabled for debugging

  private logDebug(...args: unknown[]) {
    if (WatchTogether.DEBUG) console.log('[sync]', ...args);
  }

  // Compute expected position from sync state
  private getExpectedPosition(s: Session): number {
    const state = this.getSyncState(s);
    if (!state) return 0;
    const now = Date.now();
    return state.positionMs + (state.playing ? (now - state.at) * (state.rate ?? 1) : 0);
  }

  // Single declarative reconcile: drives video element from shared state S
  private reconcile(s: Session): void {
    // Skip reconcile if a local gesture is waiting to publish - let the settle decide
    if (this.settlePending) {
      this.logDebug('reconcile', 'skipped: local gesture pending');
      return;
    }

    const state = this.getSyncState(s);
    if (!state) return;

    const expectedPos = this.getExpectedPosition(s);
    const party = this.getParty(s);

    this.logDebug('reconcile', 's:', s.self?.session, 'expectedPos:', expectedPos, 'playing:', state.playing, 'rev:', state.rev, 'origin:', state.origin);

    // YouTube mode
    if (party?.meta.mode === 1) {
      const yt = this.youtubePlayer;
      if (!yt || (yt.ready && !yt.ready())) {
        this.logDebug('reconcile', 'youtube player not ready, deferred');
        return;
      }
      // Play or pause first: a pause freezes the position, which is then compared with where the
      // one who paused stopped
      const st = yt.getPlayerState();
      if (state.playing) {
        if (st !== YT_PLAYING && st !== YT_BUFFERING && st !== YT_ENDED) yt.play();
      } else if (st === YT_PLAYING || st === YT_BUFFERING) {
        yt.pause();
      }
      // Everybody plays at the shared speed
      const wantRate = state.rate ?? 1;
      if ((yt.getRate?.() ?? 1) !== wantRate) yt.setRate?.(wantRate);
      const ytPos = yt.getCurrentTime() * 1000;
      const limit = state.playing ? YT_DRIFT_MS : YT_PAUSED_DRIFT_MS;
      if (Math.abs(ytPos - expectedPos) > limit) {
        this.logDebug('reconcile', 'youtube drift', Math.round(ytPos - expectedPos), 'seeking to', Math.round(expectedPos));
        yt.seekTo(expectedPos);
      }
      return;
    }

    // Local video mode
    if (!this.videoEl) {
      this.logDebug('reconcile', 'no video element, deferred');
      return;
    }
    if (this.videoEl.readyState < 1) { // HAVE_METADATA = 1
      this.logDebug('reconcile', 'video not ready (readyState < 1), deferred');
      return;
    }

    // Everybody's own player runs at the shared speed first (a nudge for drift is 3%, which stays
    // inside this margin); a live picture from a host has no speed of its own
    const baseRate = state.rate ?? 1;
    if (!this.videoEl.srcObject && Math.abs(this.videoEl.playbackRate - baseRate) > baseRate * 0.04) {
      this.videoEl.playbackRate = baseRate;
    }

    const actualPos = this.videoEl.currentTime * 1000;
    const drift = actualPos - expectedPos;

    // Torrent together: a player that is behind because the download has not caught up is left to
    // buffer; seeking it ahead on every sync would only ask the swarm for something else each second
    const downloading = party?.meta.mode === 3 && this.videoEl.readyState < 3 && !this.videoEl.paused && drift < 0 && drift > -15000;

    // Seek if drift is large (> 700ms)
    if (downloading) {
      this.logDebug('reconcile', 'torrent still downloading, not seeking');
    } else if (Math.abs(drift) > 700) {
      this.logDebug('reconcile', 'large drift', drift, 'seeking to', expectedPos);
      this.expectedSeekMs = expectedPos;
      this.expectedSeekUntil = Date.now() + EXPECTED_ECHO_WINDOW_MS;
      this.videoEl.currentTime = expectedPos / 1000;
    } else if (Math.abs(drift) > 50 && !this.videoEl.srcObject) {
      // Small drift: nudge playbackRate around the shared speed
      const base = state.rate ?? 1;
      this.videoEl.playbackRate = base * (drift > 0 ? 0.97 : 1.03);
      setTimeout(() => { if (this.videoEl) this.videoEl.playbackRate = this.sharedRate(); }, 500);
    } else if (!this.videoEl.srcObject && this.videoEl.playbackRate !== (state.rate ?? 1) && Math.abs(this.videoEl.playbackRate - (state.rate ?? 1)) > 0.05) {
      // The player plays at the shared speed (a live picture from a host has no speed of its own: the host's player has it)
      this.videoEl.playbackRate = state.rate ?? 1;
    }

    // Sync play/pause state
    const shouldPlay = state.playing;
    const isPlaying = !this.videoEl.paused;
    if (shouldPlay !== isPlaying) {
      this.logDebug('reconcile', 'play state mismatch', 'shouldPlay:', shouldPlay, 'isPlaying:', isPlaying);
      this.expectedPlaying = shouldPlay;
      this.expectedPlayingUntil = Date.now() + EXPECTED_ECHO_WINDOW_MS;
      if (shouldPlay) {
        const promise = this.videoEl.play();
        if (promise) {
          promise.catch((err: Error) => {
            this.logDebug('reconcile', 'play rejected:', err.name);
            if (err.name === 'NotAllowedError') {
              // Retry once muted
              this.videoEl!.muted = true;
              this.videoEl!.play().then(() => {
                // Show "Click to play" overlay via UI
                // The UI will handle unmuting on user interaction
              }).catch(() => {
                console.warn('[sync] play rejected even muted:', err.name);
              });
            }
          });
        }
      } else {
        this.videoEl.pause();
      }
    }
  }

  // Plugin data needs a 1.4 server; older ones would not pass the signals on
  supported(s: Session): boolean {
    return !!s.client && s.client.serverVersionNum >= 0x010400;
  }

  // Add people to the session's list (only those here in the channel, and always ourselves)
  private addParticipants(s: Session, ids: unknown): void {
    const party = this.getParty(s);
    if (!party || !Array.isArray(ids)) return;
    const me = s.self?.session;
    const next = [...party.participants];
    for (const id of ids) {
      if (typeof id !== 'number' || next.includes(id)) continue;
      if (id === me || this.inMyChannel(s, id)) next.push(id);
    }
    if (next.length === party.participants.length) return;
    party.participants = next;
    this.setParty(s, party);
  }

  // When the host asks (they came back) and we are watching, say so to them alone
  private announceToHost(s: Session, party: WatchParty, fromSession: number): void {
    if (fromSession !== party.hostSession || this.getState(s) !== 'watching') return;
    void this.sendWatchSignal(WATCH.join, {}, s, [fromSession]);
  }

  // Our list to hand to a newcomer, only when we are in the session ourselves
  private participantsToShare(s: Session, party: WatchParty): number[] | undefined {
    return this.getState(s) === 'watching' ? [...party.participants] : undefined;
  }

  // Everybody else on the server. Who hosts is shown on their name in every room, so the start and
  // the end of a party (and the question who hosts) reach everyone; the party itself is the channel's.
  private everyone(s: Session): number[] {
    const me = s.self?.session;
    return s.client ? [...s.client.users.values()].filter(u => u.session !== me).map(u => u.session) : [];
  }

  private outsiders(s: Session): number[] {
    const me = s.self?.session;
    const ch = s.self?.channelId;
    return s.client ? [...s.client.users.values()].filter(u => u.session !== me && u.channelId !== ch).map(u => u.session) : [];
  }

  // The indicator on the host's name for those in other rooms: what it needs, and nothing of the party
  private announceOutside(s: Session, party: WatchParty, to: number[]): void {
    if (!to.length) return;
    void this.sendWatchSignal(WATCH.start, { mode: party.meta.mode, title: party.meta.title }, s, to, true);
  }

  private inMyChannel(s: Session, sender: number): boolean {
    const self = s.client?.self;
    const senderUser = s.client?.users.get(sender);
    const result = !!self && senderUser?.channelId === self.channelId;
    return result;
  }

  // Get per-session state
  private getState(s: Session): WatchState {
    return this.states.get(s) ?? 'idle';
  }

  private setState(s: Session, state: WatchState) {
    this.states = new Map(this.states).set(s, state);
  }

  private getParty(s: Session): WatchParty | null {
    return this.parties.get(s) ?? null;
  }

  private setParty(s: Session, party: WatchParty | null) {
    if (party) {
      this.parties = new Map(this.parties).set(s, party);
    } else {
      const newMap = new Map(this.parties);
      newMap.delete(s);
      this.parties = newMap;
    }
  }

  // Get state for active session (for UI reactivity)
  get isWatching(): boolean {
    return this.getState(sessions.active) === 'watching';
  }

  get hasActiveParty(): boolean {
    return this.getParty(sessions.active) !== null;
  }

  // Host has an active party (either watching or left but party exists for rejoin)
  // Use $derived to properly track session changes through the Proxy
  isHostWithParty = $derived.by(() => {
    void sessions.active.tick;
    const s = sessions.active;
    const party = this.getParty(s);
    return this.isHostFor(s) && party !== null;
  });

  // Use $derived to properly track session changes through the Proxy
  // Reading sessions.active.tick establishes reactivity on session switches
  isHost = $derived.by(() => {
    void sessions.active.tick;
    const s = sessions.active;
    return this.isHostFor(s);
  });

  isHostFor(s: Session): boolean {
    const party = this.getParty(s);
    return party?.hostSession === s.self?.session;
  }

  // Expose party for active session
  get party(): WatchParty | null {
    return this.getParty(sessions.active);
  }

  get meta() {
    return this.party?.meta;
  }

  get positionMs() {
    return this.party?.positionMs ?? 0;
  }

  get playing() {
    return this.party?.playing ?? false;
  }

  get durationMs() {
    return this.party?.durationMs ?? 0;
  }

  // Where the shared video is right now and whether it plays; read it on a timer, it is not reactive
  sharedPosition(): number {
    return Math.max(0, Math.round(this.getExpectedPosition(sessions.active)));
  }

  sharedPlaying(): boolean {
    const s = sessions.active;
    return this.getSyncState(s)?.playing ?? this.getParty(s)?.playing ?? false;
  }

  get participants() {
    return this.party?.participants ?? [];
  }

  get playlist() {
    return this.party?.playlist ?? [];
  }

  get currentIndex() {
    return this.party?.currentIndex ?? 0;
  }

  get currentVideo() {
    return this.party?.playlist[this.party?.currentIndex ?? 0];
  }

  get mode() {
    return this.party?.meta.mode;
  }

  // Torrent together: the torrent this party plays
  get torrent(): TorrentMeta | undefined {
    return this.party?.meta.torrent;
  }

  // Torrent together: every link of the party in order, and where the party is in them
  get torrentQueue(): TorrentMeta[] {
    return this.party?.meta.queue ?? [];
  }

  get hasNextTorrent(): boolean {
    const p = this.party;
    return !!p && p.meta.mode === 3 && !!p.meta.queue && p.currentIndex < p.meta.queue.length - 1;
  }

  get focusRequest() {
    return this._focusRequest;
  }

  // Call this to request focus on watch together in VoiceStage
  focus() {
    this._focusRequest = Date.now();
  }

  // Where the host's player waits while no screen shows it: in the page, out of sight and silent
  private park(video: HTMLVideoElement) {
    if (!this.hostPark) {
      const el = document.createElement('div');
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;opacity:0;pointer-events:none;overflow:hidden';
      document.body.appendChild(el);
      this.hostPark = el;
    }
    this.hostPark.appendChild(video);
  }

  private createHostVideo(s: Session, file: File) {
    this.disposeHostVideo();
    const video = document.createElement('video');
    video.playsInline = true;
    video.preload = 'auto';
    video.controls = false; // the player's own bar (WatchPlayer) is the same for everyone
    video.style.cssText = 'width:100%;height:100%;object-fit:contain';
    this.hostVideoOwner = s;
    this.setVideoElement(video);
    this.hostVideoUrl = URL.createObjectURL(file);
    video.src = this.hostVideoUrl;
    this.park(video);
    this.hostVideo = video;
    video.load();
  }

  private disposeHostVideo(s?: Session) {
    const video = this.hostVideo;
    if (!video || (s && this.hostVideoOwner !== s)) return;
    if (this.videoEl === video) this.setVideoElement(null);
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    if (this.hostVideoUrl) URL.revokeObjectURL(this.hostVideoUrl);
    this.hostVideoUrl = null;
    this.hostVideoOwner = null;
    this.hostVideo = null;
  }

  // The player's screen shows the host's player; when the screen goes away the player is parked,
  // still playing. Returns the function that takes it back.
  mountHostVideo(node: HTMLElement): () => void {
    const video = this.hostVideo;
    if (!video) return () => {};
    node.appendChild(video);
    return () => { if (video.parentNode === node && this.hostVideo === video) this.park(video); };
  }

  // Moving the player to another window (pop out, pop in) makes the browser pause it and may
  // restart it from the start. None of that is something the person watching did: it is not
  // published to the others, nobody is seeked by it, and afterwards the player is put back where
  // it was, playing if it played. `move` does the moving.
  private moving = false;
  moveVideo(video: HTMLVideoElement, move: () => void): void {
    const live = !!video.srcObject; // a viewer's live picture has no position of its own
    const at = video.currentTime;
    const wasPlaying = !video.paused && !video.ended;
    this.moving = true;
    const restore = () => {
      if (!live && video.readyState >= 1 && Math.abs(video.currentTime - at) > 0.5) video.currentTime = at;
      if (wasPlaying && video.paused) video.play().catch(() => {});
    };
    move();
    restore();
    // A reload reports back some time later: put it right again, then listen to the player again
    video.addEventListener('loadedmetadata', restore, { once: true });
    video.addEventListener('canplay', restore, { once: true });
    setTimeout(restore, 300);
    // A player that changed window can go on playing without showing any picture (black, with the
    // sound and the clock running). A seek to where it already is makes the browser present a frame
    // again. Done inside the window in which events are ignored, so nobody else is seeked by it.
    const repaint = () => {
      if (live || video.readyState < 2 || video.seeking) return;
      video.currentTime = video.currentTime;
    };
    setTimeout(() => { restore(); repaint(); }, 500);
    setTimeout(repaint, 900);
    setTimeout(() => {
      restore();
      video.removeEventListener('loadedmetadata', restore);
      video.removeEventListener('canplay', restore);
      this.moving = false;
    }, 1200);
  }

  // The host has left but the party goes on: their player keeps running for the viewers
  private streamingAway(s: Session): boolean {
    return !!this.hostVideo && this.hostVideoOwner === s && this.isHostFor(s) && this.getParty(s)?.meta.mode === 2;
  }

  setVideoElement(video: HTMLVideoElement | null) {
    // Idempotent: same element, nothing to do (check plain field)
    if (this.videoEl === video) return;
    // Remove listeners from old element
    if (this.videoEl) {
      this.videoEl.removeEventListener('play', this.boundOnLocalPlay);
      this.videoEl.removeEventListener('pause', this.boundOnLocalPause);
      this.videoEl.removeEventListener('seeking', this.boundOnLocalSeeking);
      this.videoEl.removeEventListener('seeked', this.boundOnLocalSeeked);
      this.videoEl.removeEventListener('ended', this.boundOnLocalEnded);
      this.videoEl.removeEventListener('loadedmetadata', this.boundOnLoadedMetadata);
      this.videoEl.removeEventListener('canplay', this.boundOnCanPlay);
    }
    this.videoEl = video;
    // Only write reactive field when element actually changed
    this.localVideo = video;
    // Attach to new element
    if (video) {
      // Use bound methods so we can remove them later
      this.boundOnLocalPlay = () => this.onLocalPlay();
      this.boundOnLocalPause = () => this.onLocalPause();
      this.boundOnLocalSeeking = () => this.onLocalSeeking();
      this.boundOnLocalSeeked = () => this.onLocalSeeked();
      this.boundOnLocalEnded = () => this.onLocalEnded();
      this.boundOnLoadedMetadata = () => this.onLoadedMetadata();
      this.boundOnCanPlay = () => this.onCanPlay();
      video.addEventListener('play', this.boundOnLocalPlay);
      video.addEventListener('pause', this.boundOnLocalPause);
      video.addEventListener('seeking', this.boundOnLocalSeeking);
      video.addEventListener('seeked', this.boundOnLocalSeeked);
      video.addEventListener('ended', this.boundOnLocalEnded);
      video.addEventListener('loadedmetadata', this.boundOnLoadedMetadata);
      video.addEventListener('canplay', this.boundOnCanPlay);
    }
  }

  // Bound handlers for removal
  private boundOnLocalPlay: () => void = () => {};
  private boundOnLocalPause: () => void = () => {};
  private boundOnLocalSeeking: () => void = () => {};
  private boundOnLocalSeeked: () => void = () => {};
  private boundOnLocalEnded: () => void = () => {};
  private boundOnLoadedMetadata: () => void = () => {};
  private boundOnCanPlay: () => void = () => {};

  private onLoadedMetadata() {
    if (this.moving) return;
    const s = sessions.active;
    if (this.getState(s) === 'watching') {
      this.logDebug('local-event', 'loadedmetadata', 'reconcile');
      this.reconcile(s);
    }
  }

  private onCanPlay() {
    if (this.moving) return;
    const s = sessions.active;
    if (this.getState(s) === 'watching') {
      this.logDebug('local-event', 'canplay', 'reconcile');
      this.reconcile(s);
    }
  }

  setYoutubePlayer(player: typeof this.youtubePlayer) {
    this.youtubePlayer = player;
  }

  // The YouTube player (re)connected: bring it to the shared state
  syncPlayer() {
    const s = sessions.active;
    if (this.getState(s) === 'watching') this.reconcile(s);
  }

  // Where the session is now and whether it plays, for a player that is just being set up
  expectedPlayback(): { positionMs: number; playing: boolean } {
    const s = sessions.active;
    const state = this.getSyncState(s);
    return {
      positionMs: Math.max(0, Math.round(this.getExpectedPosition(s))),
      playing: state?.playing ?? this.getParty(s)?.playing ?? false,
    };
  }

  // The host's own shared state follows what the YouTube player really shows, so that leaving
  // and coming back (or someone joining) continues from there instead of from an old position
  private snapshotYoutube(s: Session): SyncState | null {
    const yt = this.youtubePlayer;
    const base = this.getSyncState(s);
    if (!yt || !base || this.getParty(s)?.meta.mode !== 1) return base;
    const st = yt.getPlayerState();
    const snap: SyncState = {
      ...base,
      positionMs: Math.round(yt.getCurrentTime() * 1000),
      playing: st === YT_PLAYING || st === YT_BUFFERING,
      at: getServerTime(),
    };
    this.setSyncState(s, snap);
    return snap;
  }

  async start(mode: WatchMode, options: { videoId?: string; fileMeta?: FileMeta; title: string; file?: File; torrent?: TorrentMeta; queue?: TorrentMeta[] }) {
    // Everybody else checks this too; a party nobody could join is not started
    const queue = mode === 3 && options.queue ? validTorrentQueue(options.queue) : null;
    if (mode === 3 && options.queue && !queue) throw new Error('These torrents can not be shared');
    const torrent = mode === 3 ? (queue ? queue[0] : validTorrentMeta(options.torrent)) : null;
    if (mode === 3 && !torrent) throw new Error('This torrent can not be shared');
    const s = sessions.active;
    console.log('[WatchTogether] start() called - mode:', mode, 'session:', s.server?.id, 'state:', this.getState(s));

    // Also a party we host but left: its player is still running
    if (this.getState(s) !== 'idle' || (this.getParty(s) && this.isHostFor(s))) {
      console.log('[WatchTogether] Already watching on this session, ending current party first');
      await this.end();
    }

    const self = s.self;
    console.log('[WatchTogether] session.self:', self);
    if (!self || !s.client) {
      console.log('[WatchTogether] No self or client, throwing error');
      throw new Error('You must be connected to a server to start watch together');
    }

    // A new session never inherits the position of an earlier one
    this.syncState.delete(s);
    this.storedState.delete(s);

    console.log('[WatchTogether] Setting state to joining');
    this.setState(s, 'joining');

    const meta: WatchPartyMeta = {
      mode,
      videoId: options.videoId,
      fileMeta: options.fileMeta,
      torrent: torrent ?? undefined,
      queue: queue && queue.length > 1 ? queue : undefined,
      title: options.title,
    };

    console.log('[WatchTogether] Creating party object');
    const party: WatchParty = {
      host: s,
      hostSession: self.session,
      meta,
      positionMs: 0,
      playing: false,
      participants: [self.session],
      playlist: options.videoId ? [{ id: options.videoId, title: options.title }] : [],
      currentIndex: 0,
      at: getServerTime(),
    };
    this.setParty(s, party);

    console.log('[WatchTogether] Sending start signal');
    await this.sendWatchSignal(WATCH.start, {
      mode,
      videoId: options.videoId,
      fileMeta: options.fileMeta,
      torrent: torrent ?? undefined,
      queue: queue && queue.length > 1 ? queue : undefined,
      title: options.title,
    }, s);

    console.log('[WatchTogether] Setting state to watching');
    this.setState(s, 'watching');
    console.log('[WatchTogether] State is now:', this.getState(s), 'isWatching:', this.isWatching);

    // For mode 2 (file streaming), start WebRTC streaming
    if (mode === 2 && options.file) {
      console.log('[WatchTogether] Starting stream for mode 2 with file:', options.file.name, 'size:', options.file.size);
      this.createHostVideo(s, options.file);
      await watchFileStream.startStream(s, options.file, () => this.videoEl);
      // Hashing a big file takes a while: the party starts now, the download is offered when ready
      void files.share(s, options.file, () => {}).then(meta => {
        if (typeof meta !== 'string' && this.getParty(s) === party) {
          party.fileShare = meta;
          this.setParty(s, party);
        }
      }).catch(() => {});
    }

    this.startSyncLoop(s);

    // Host starts local playback. A torrent has to be found and downloaded first, by the host and by
    // everybody who joins: it starts when the host presses play, not before anybody could see it.
    if (mode !== 3) this.play();

    console.log('[WatchTogether] start() complete');

    // Announce watch together session to others in the channel, and on the host's name in the other rooms
    s.setWatchTogether(self.session, { mode, title: options.title });
    this.announceOutside(s, party, this.outsiders(s));
  }

  async join(hostSession: number) {
    const s = sessions.active;
    // Allow host to rejoin if they have a party but left
    const existingParty = this.getParty(s);
    const canRejoin = this.getState(s) === 'idle' && existingParty && this.isHostFor(s) && hostSession === s.self?.session;
    if (canRejoin) {
      await this.rejoin();
      return;
    }
    if (this.getState(s) !== 'idle') return;
    // A host in another room shows the indicator only; the party is for the room
    if (!this.inMyChannel(s, hostSession)) return;

    // Don't join our own session
    if (hostSession === s.self?.session) {
      console.log('[WatchTogether] join - ignoring own session');
      return;
    }

    // Use existing party if available (created by handleStart), otherwise create new
    let party = existingParty;
    let isNewParty = false;
    if (!party) {
      isNewParty = true;
      party = {
        host: s,
        hostSession,
        meta: { mode: 1, title: 'Watch Together' }, // will be updated from state response
        positionMs: 0,
        playing: false,
        participants: [hostSession],
        playlist: [],
        currentIndex: 0,
        at: getServerTime(),
      };
      this.setParty(s, party);
    }

    // Announce watch together session to show indicator
    s.setWatchTogether(hostSession, { mode: party.meta.mode, title: party.meta.title });

    // If party already existed (from handleStart), ensure hostSession matches
    if (!isNewParty && party.hostSession !== hostSession) {
      party.hostSession = hostSession;
      this.setParty(s, party);
    }

    this.setState(s, 'joining');

    // The host answers with the state; the others only need to know we came, to update their lists
    const others = party.participants.filter(p => p !== hostSession && p !== s.self?.session && this.inMyChannel(s, p));
    await this.sendWatchSignal(WATCH.join, {}, s, [hostSession, ...others]);

    // For mode 2 (file streaming), WebRTC connection + file transfer can take >10s
    // Use longer timeout (60s) and only show prompt if still joining
    // handleState accepts 'idle' state so late replies still work
    const timeoutMs = party.meta.mode === 2 ? 60000 : 10000;
    setTimeout(() => {
      if (this.getState(s) === 'joining') {
        this.setState(s, 'idle');
        // Don't clear indicator here - late state will re-announce it
        this.cleanup(s);
        ui.prompt = {
          title: 'Watch Together',
          label: party.meta.mode === 2
            ? 'Failed to join watch party: no response from host (still waiting for file stream...)'
            : 'Failed to join watch party: no response from host',
          confirm: 'OK',
          input: 'none',
          onsubmit: () => {},
        };
      }
    }, timeoutMs);
  }

  async leave() {
    const s = sessions.active;
    if (this.getState(s) === 'idle') return;

    this.setState(s, 'leaving');

    const wasHost = this.isHostFor(s);
    const party = this.getParty(s);
    const syncState = this.snapshotYoutube(s) ?? this.getSyncState(s);

    if (party) {
      await this.sendWatchSignal(WATCH.leave, {}, s, undefined, true);

      // For mode 2 (file streaming), a viewer stops watching the host's stream (the host has none)
      if (!wasHost && party.meta.mode === 2 && party.hostSession) {
        await watchFileStream.stopWatching(s, party.hostSession);
      }
    }

    if (wasHost) {
      // Host leaving: pause local playback but keep party alive for rejoin
      // Store current state for rejoin (extrapolated)
      if (syncState) {
        this.storedState.set(s, {
          positionMs: syncState.positionMs,
          playing: syncState.playing,
          at: syncState.at,
          rate: syncState.rate,
        });
      }
      this.setState(s, 'idle');
      // Remove self from participants
      if (party) {
        party.participants = party.participants.filter(p => p !== s.self?.session);
        this.setParty(s, party);
      }
      if (this.streamingAway(s)) {
        // Leaving is not ending: the player goes on (silently, out of sight) because it is what
        // the viewers receive. Only end() stops it.
        if (this.hostVideo) this.hostVideo.muted = true;
      } else {
        // Pause local playback and clear references so rejoin doesn't play stale elements
        if (this.localVideo) {
          this.localVideo.pause();
          this.localVideo = null;
        }
        if (this.youtubePlayer) {
          this.youtubePlayer.pause();
          this.youtubePlayer = null;
        }
      }
      // Note: We do NOT call cleanup() - party persists for rejoin
    } else {
      // Participant leaving: clean up
      this.cleanup(s);
    }
  }

  // Host rejoin: resume watching the existing party
  async rejoin() {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party || !this.isHostFor(s) || this.getState(s) !== 'idle') return;

    // Back in the list at once, for our own tile and (through the join below) for everyone else's
    this.addParticipants(s, s.self ? [s.self.session] : []);

    if (this.streamingAway(s)) {
      // The player never stopped and the shared state followed what the viewers did meanwhile
      if (this.hostVideo) this.hostVideo.muted = false;
      if (s.self && !party.participants.includes(s.self.session)) {
        party.participants = [...party.participants, s.self.session];
        this.setParty(s, party);
      }
      this.setState(s, 'watching');
      this.startSyncLoop(s);
      await this.sendWatchSignal(WATCH.join, {}, s);
      return;
    }

    this.setState(s, 'joining');

    // Send join signal to announce we're back
    await this.sendWatchSignal(WATCH.join, {}, s);

    // As the host, we need to query the current state from viewers
    // Send WATCH.who to get current playback state from anyone still watching
    await this.sendWatchSignal(WATCH.who, {}, s);

    // Wait up to 800ms for state replies from other participants
    // handleState will transition to 'watching' and call reconcile when state arrives
    setTimeout(() => {
      if (this.getState(s) === 'joining') {
        // No reply received - fall back to stored state extrapolated
        const stored = this.storedState.get(s);
        if (stored) {
          const elapsed = Date.now() - stored.at;
          const extrapolatedPos = stored.positionMs + (stored.playing ? elapsed * (stored.rate ?? 1) : 0);
          const fallbackState: SyncState = {
            rev: 0,
            origin: s.self?.session ?? 0,
            playing: stored.playing,
            positionMs: extrapolatedPos,
            at: Date.now(),
            rate: stored.rate,
          };
          this.setSyncState(s, fallbackState);
          this.setState(s, 'watching');
          this.startSyncLoop(s);
          // reconcile() will be called when video element is ready (via loadedmetadata/canplay)
        } else {
          this.setState(s, 'idle');
          s.setWatchTogether(party.hostSession, false);
          this.cleanup(s);
          ui.prompt = {
            title: 'Watch Together',
            label: 'Failed to rejoin watch party: no response from participants',
            confirm: 'OK',
            input: 'none',
            onsubmit: () => {},
          };
        }
      }
    }, 800);
  }

  async end() {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party || !this.isHostFor(s)) return;

    // Stop WebRTC file streaming if active
    if (party.meta.mode === 2) {
      await watchFileStream.stopStream(s);
    }

    // Send end signal with priority to bypass the rate limit queue
    await this.sendWatchSignal(WATCH.end, {}, s, this.everyone(s), true);

    // Clear watch together announcement
    const self = s.self;
    if (self) {
      s.setWatchTogether(self.session, false);
    }

    this.cleanup(s);
  }

  play() {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party) return;
    const current = this.getSyncState(s);
    if (current?.playing) return; // Already playing
    const positionMs = this.getCurrentPosition();
    const newState: SyncState = {
      rev: (current?.rev ?? 0) + 1,
      origin: s.self?.session ?? 0,
      rate: current?.rate,
      playing: true,
      positionMs,
      at: getServerTime(),
    };
    this.setSyncState(s, newState);
    this.logDebug('tx', 'play', newState.rev, newState.origin, newState.playing, newState.positionMs, 'sent');
    this.sendPlaybackCommand(WATCH.play, newState, s);
    this.applySyncState(s, newState);
  }

  pause() {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party) return;
    const current = this.getSyncState(s);
    if (current && !current.playing) return; // Already paused
    const positionMs = this.getCurrentPosition();
    const newState: SyncState = {
      rev: (current?.rev ?? 0) + 1,
      origin: s.self?.session ?? 0,
      rate: current?.rate,
      playing: false,
      positionMs,
      at: getServerTime(),
    };
    this.setSyncState(s, newState);
    this.logDebug('tx', 'pause', newState.rev, newState.origin, newState.playing, newState.positionMs, 'sent');
    this.sendPlaybackCommand(WATCH.pause, newState, s);
    this.applySyncState(s, newState);
  }

  seek(positionMs: number, playing?: boolean) {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party) return;
    const current = this.getSyncState(s);
    const newState: SyncState = {
      rev: (current?.rev ?? 0) + 1,
      origin: s.self?.session ?? 0,
      rate: current?.rate,
      playing: playing ?? (current?.playing ?? party.playing),
      positionMs,
      at: getServerTime(),
    };
    this.setSyncState(s, newState);
    this.logDebug('tx', 'seek', newState.rev, newState.origin, newState.playing, newState.positionMs, 'sent');
    this.pendingSeek = true;
    this.sendPlaybackCommand(WATCH.seek, { ...newState, playing: newState.playing }, s);
    this.applySyncState(s, newState);
  }

  // The playback speed everybody plays at (YouTube), changed by anyone. It is part of the shared
  // state, so the position stays right for everyone: it is taken at the moment of the change.
  sharedRate(): number {
    return this.getSyncState(sessions.active)?.rate ?? 1;
  }

  setRate(rate: number) {
    const s = sessions.active;
    const party = this.getParty(s);
    // A streamed file (mode 2) changes speed on the host's player, which everybody sees live;
    // a torrent (mode 3) changes it on everybody's own player
    if (!party || (party.meta.mode !== 1 && party.meta.mode !== 2 && party.meta.mode !== 3)) return;
    const current = this.getSyncState(s);
    if ((current?.rate ?? 1) === rate) return;
    const newState: SyncState = {
      rev: (current?.rev ?? 0) + 1,
      origin: s.self?.session ?? 0,
      playing: current?.playing ?? party.playing,
      positionMs: this.getCurrentPosition(),
      at: getServerTime(),
      rate,
    };
    this.setSyncState(s, newState);
    this.logDebug('tx', 'rate', newState.rev, newState.origin, rate, 'sent');
    this.sendPlaybackCommand(WATCH.rate, newState, s);
    this.applySyncState(s, newState);
  }

  // Torrent together: the queue of a payload, checked, and the link at `index` (the first one when out of range)
  private torrentFrom(body: { torrent?: unknown; queue?: unknown }, index: number): { torrent: TorrentMeta; queue?: TorrentMeta[]; index: number } | null {
    if (body.queue !== undefined && body.queue !== null) {
      const queue = validTorrentQueue(body.queue);
      if (!queue) return null;
      const i = Number.isInteger(index) && index >= 0 && index < queue.length ? index : 0;
      return { torrent: queue[i], queue: queue.length > 1 ? queue : undefined, index: i };
    }
    const torrent = validTorrentMeta(body.torrent);
    return torrent ? { torrent, index: 0 } : null;
  }

  // Torrent together: anybody in the party moves everybody on to the next link, which starts paused at 0
  async nextTorrent() {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party || this.getState(s) !== 'watching' || !this.hasNextTorrent) return;
    const index = party.currentIndex + 1;
    const rev = this.applyTorrentIndex(s, index);
    if (rev === null) return;
    await this.sendWatchSignal(WATCH.next, { index, rev } satisfies NextPayload, s, undefined, true);
  }

  private handleNextTorrent(s: Session, body: NextPayload, fromSession: number) {
    const party = this.getParty(s);
    if (!party || this.getState(s) !== 'watching' || !party.participants.includes(fromSession)) return;
    if (!body || typeof body.index !== 'number') return;
    this.applyTorrentIndex(s, body.index, typeof body.rev === 'number' ? body.rev : undefined);
  }

  // Makes `index` the link being played; the one before it is let go (its files are deleted).
  // Returns the sync revision of the fresh state, or null when nothing changed (already there, or not a next link).
  private applyTorrentIndex(s: Session, index: number, rev?: number): number | null {
    const party = this.getParty(s);
    const queue = party?.meta.queue;
    if (!party || !queue || !Number.isInteger(index) || index <= party.currentIndex || index >= queue.length) return null;
    const prev = party.meta.torrent;
    const next = queue[index];
    party.currentIndex = index;
    party.meta = { ...party.meta, torrent: next, title: (next.fileName.split('/').pop() ?? next.name).slice(0, 300) };
    party.positionMs = 0;
    party.playing = false;
    party.at = getServerTime();
    this.setParty(s, party);
    const cur = this.getSyncState(s);
    const newRev = Math.max(rev ?? 0, (cur?.rev ?? 0) + 1);
    this.setSyncState(s, { rev: newRev, origin: party.hostSession, playing: false, positionMs: 0, at: party.at, rate: cur?.rate });
    // The finished one is no longer shared or kept, unless a later link is a file of the same torrent
    if (prev && !queue.slice(index).some(q => q.infoHash === prev.infoHash)) void desktop?.torrent?.stop(prev.infoHash).catch(() => {});
    return newRev;
  }

  async addToPlaylist(videoId: string, title: string) {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party || !this.isHostFor(s) || party.meta.mode !== 1) return;

    party.playlist.push({ id: videoId, title });
    this.setParty(s, party);
    await this.sendWatchSignal(WATCH.playlist, {
      videos: party.playlist,
      currentIndex: party.currentIndex,
    }, s);
  }

  async skipNext() {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party || !this.isHostFor(s) || party.currentIndex >= party.playlist.length - 1) return;
    party.currentIndex++;
    this.setParty(s, party);
    await this.playCurrentVideo();
  }

  async skipPrevious() {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party || !this.isHostFor(s) || party.currentIndex <= 0) return;
    party.currentIndex--;
    this.setParty(s, party);
    await this.playCurrentVideo();
  }

  async setCurrentIndex(index: number) {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party || !this.isHostFor(s) || index < 0 || index >= party.playlist.length) return;
    party.currentIndex = index;
    this.setParty(s, party);
    await this.playCurrentVideo();
  }

  async playCurrentVideo() {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party) return;

    const video = party.playlist[party.currentIndex];
    if (!video) return;

    party.positionMs = 0;
    this.setParty(s, party);

    await this.sendWatchSignal(WATCH.playlist, {
      videos: party.playlist,
      currentIndex: party.currentIndex,
    }, s);

    this.play();
  }

  handleSignal(s: Session, type: number, body: unknown, fromSession: number) {
    // Ignore signals from ourselves except for specific cases
    const isSelf = fromSession === s.self?.session;

    console.log('[WatchTogether] handleSignal - type:', type, 'from:', fromSession, 'isSelf:', isSelf);

    switch (type) {
      case WATCH.start:
        this.handleStart(s, body as any, fromSession);
        break;
      case WATCH.join:
        this.handleJoin(s, fromSession);
        break;
      case WATCH.leave:
        // Don't handle our own leave signals
        if (!isSelf) this.handleLeave(s, fromSession);
        break;
      case WATCH.end:
        // Don't handle our own end signals - we already called cleanup() directly
        if (!isSelf) this.handleEnd(s, fromSession);
        break;
      case WATCH.play:
        if (!isSelf) this.handlePlayPause(s, body as any, true, fromSession);
        break;
      case WATCH.pause:
        if (!isSelf) this.handlePlayPause(s, body as any, false, fromSession);
        break;
      case WATCH.seek:
        if (!isSelf) this.handleSeek(s, body as any, fromSession);
        break;
      case WATCH.rate:
        if (!isSelf) this.handleRate(s, body as any, fromSession);
        break;
      case WATCH.sync:
        this.handleSync(s, body as any, fromSession);
        break;
      case WATCH.state:
        this.handleState(s, body as any, fromSession);
        break;
      case WATCH.playlist:
        if (!isSelf) this.handlePlaylist(s, body as any, fromSession);
        break;
      case WATCH.next:
        if (!isSelf) this.handleNextTorrent(s, body as NextPayload, fromSession);
        break;
      case WATCH.who:
        // Any member (host or viewer) with a party responds to who queries
        if (this.getParty(s)) this.handleWho(s, fromSession);
        break;
      // File streaming (mode 2) - WebRTC signaling
      case WATCH.fileRequest: // Viewer sends offer via Mumble
        if (!isSelf) this.handleFileRequest(s, body as string, fromSession);
        break;
      case WATCH.fileChunk: // Host sends answer via Mumble
        if (!isSelf) this.handleFileChunk(s, body as string, fromSession);
        break;
      case WATCH.fileEnd:
        if (!isSelf) this.handleFileEnd(s, fromSession);
        break;
    }
  }

  async receive(s: Session, sender: number, dataId: string, data: Uint8Array): Promise<void> {
    if (dataId !== WATCH_DATA_ID) return;

    // Forward to WebRTC file stream for mode 2 (it uses WATCH.fileRequest/fileChunk for WebRTC setup)
    await watchFileStream.receive(s, sender, dataId, data);

    // Check for raw binary file chunk (type 30 with binary format) - legacy support
    if (data.length > 0 && data[0] === WATCH.fileChunk && data.length >= 7) {
      const { decodeFileChunk } = await import('../core/watch-together.ts');
      const decoded = decodeFileChunk(data);
      if (decoded) {
        // Handle raw binary chunk directly, bypassing assembler
        if (s.client && this.inMyChannel(s, sender)) {
          console.log('[WatchTogether] Raw binary chunk received - offset:', decoded.offset, 'length:', decoded.data.length);
          this.handleSignal(s, WATCH.fileChunk, { offset: decoded.offset, _raw: true, data: decoded.data }, sender);
        }
        return;
      }
    }

    let assembler = this.assemblers.get(s);
    if (!assembler) this.assemblers.set(s, assembler = new WatchAssembler());
    const signal = await assembler.push(sender, data);

    // Only people in our channel take part; the start, the end and the question who hosts are
    // also for the other rooms, where they only show the indicator
    const open = signal?.type === WATCH.start || signal?.type === WATCH.end || signal?.type === WATCH.who;
    if (!signal || !s.client || (!open && !this.inMyChannel(s, sender))) return;

    console.log('[WatchTogether] Signal received - type:', signal.type, 'from:', sender, 'current state:', this.getState(s));

    // For WebRTC offer/answer (fileRequest/fileChunk), the text is a raw SDP string, not JSON
    // Handle like screen sharing does - pass raw text to handler
    if (signal.type === WATCH.fileRequest || signal.type === WATCH.fileChunk) {
      if (signal.text) this.handleSignal(s, signal.type, signal.text, sender);
      return;
    }

    const body = signal.text ? JSON.parse(signal.text) : {};
    this.handleSignal(s, signal.type, body, sender);
  }

  // Internal methods
  private getCurrentPosition(): number {
    const s = sessions.active;
    const party = this.getParty(s);
    if (party?.meta.mode === 1 && this.youtubePlayer) {
      return Math.round(this.youtubePlayer.getCurrentTime() * 1000);
    } else if (this.videoEl) {
      return Math.round(this.videoEl.currentTime * 1000);
    }
    // Stream from host: a viewer has no player of its own, so the shared position is where we are
    if (this.getSyncState(s)) return Math.round(this.getExpectedPosition(s));
    return party?.positionMs ?? 0;
  }

  private async sendWatchSignal(type: number, body: unknown, s: Session, receivers?: number[], priority = false) {
    const client = s.client;
    if (!client) return;
    const chunks = await encodeWatchSignal(type as any, body);
    const targets = receivers ?? (s.self ? s.usersIn(s.self.channelId).map(u => u.session) : []);
    for (const chunk of chunks) {
      // @ts-ignore - priority is an optional parameter
      client.sendPluginData(targets, WATCH_DATA_ID, chunk, { priority });
    }
  }

  // Send file chunk only to the requesting viewer (not broadcast)
  private async sendFileChunk(type: number, body: unknown, s: Session, targetSession: number) {
    const client = s.client;
    if (!client) return;
    const chunks = await encodeWatchSignal(type as any, body);
    for (const chunk of chunks) {
      client.sendPluginData([targetSession], WATCH_DATA_ID, chunk, { priority: true });
    }
  }

  private sendPlaybackCommand(type: number, state: SyncState, s: Session) {
    return this.sendWatchSignal(type, state, s, undefined, true);
  }

  // Get/set per-session sync state
  private getSyncState(s: Session): SyncState | null {
    return this.syncState.get(s) ?? null;
  }

  private setSyncState(s: Session, state: SyncState) {
    this.syncState.set(s, state);
  }

  private applySyncState(s: Session, state: SyncState) {
    const party = this.getParty(s);
    if (!party) return;

    // Update party for UI reactivity
    party.playing = state.playing;
    party.positionMs = state.positionMs;
    party.at = state.at;
    this.setParty(s, party);

    // For local video: use reconcile() which handles readiness and play rejection
    this.reconcile(s);
  }

  private startSyncLoop(s: Session) {
    const existing = this.syncIntervals.get(s);
    if (existing) return;
    const interval = window.setInterval(() => {
      const party = this.getParty(s);
      const state = this.getState(s);
      // A host who left keeps the loop going while the party streams, so viewers stay in sync
      if (!party || (state !== 'watching' && !this.streamingAway(s))) return;

      const syncState = this.getSyncState(s);
      const isHost = this.isHostFor(s);
      const now = getServerTime();

      if (isHost) {
        // Host: compute expected position from syncState
        let expectedPos = syncState?.positionMs ?? party.positionMs;
        if (syncState?.playing) {
          expectedPos += (now - (syncState.at ?? now)) * (syncState.rate ?? 1);
        }

        // Check if video's actual state disagrees (user action)
        if (this.videoEl) {
          const actualPlaying = !this.videoEl.paused;
          if (actualPlaying !== (syncState?.playing ?? party.playing) &&
              Date.now() > (this.expectedPlayingUntil ?? 0)) {
            // Video state changed locally without our programmatic action = user action
            const actualPos = Math.round(this.videoEl.currentTime * 1000);
            const newState: SyncState = {
              rev: (syncState?.rev ?? 0) + 1,
              origin: s.self?.session ?? 0,
              rate: syncState?.rate,
              playing: actualPlaying,
              positionMs: actualPos,
              at: now,
            };
            this.setSyncState(s, newState);
            this.logDebug('tx', 'auto-play-pause', newState.rev, newState.origin, newState.playing, newState.positionMs, 'sent');
            this.sendPlaybackCommand(actualPlaying ? WATCH.play : WATCH.pause, newState, s);
            this.applySyncState(s, newState);
          }
        }

        // The host's YouTube player is held to the shared state like everyone else's: it is only
        // ever told what to do when something arrives, so one that stalls would stay behind
        if (party.meta.mode === 1) this.reconcile(s);

        // Send periodic sync with current shared state
        const currentState = this.getSyncState(s);
        if (currentState) {
          this.logDebug('tx', 'sync', currentState.rev, currentState.origin, currentState.playing, currentState.positionMs, 'sent');
          const v = this.videoEl;
          const durationMs = party.meta.mode === 2 && v && Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : undefined;
          const extra = { ...(durationMs ? { durationMs } : {}), ...(party.fileShare ? { dl: party.fileShare } : {}) };
          this.sendWatchSignal(WATCH.sync, { ...currentState, ...extra }, s);
        }
      } else {
        // Viewer: only apply host's sync, never send our own
        // Handled in handleSync
      }
    }, SYNC_INTERVAL_MS);
    this.syncIntervals.set(s, interval);
  }

  private stopSyncLoop(s: Session) {
    const interval = this.syncIntervals.get(s);
    if (interval) {
      clearInterval(interval);
      this.syncIntervals.delete(s);
    }
  }

  // Called when entering a channel - query existing watch parties
  entered(s: Session): void {
    if (!this.supported(s)) return;
    // Send a 'who' query to find existing hosts
    const client = s.client;
    if (!client) return;
    // Everybody on the server: hosts in other rooms answer with just the indicator
    const targets = this.everyone(s);
    encodeWatchSignal(WATCH.who, {}).then(chunks => {
      for (const chunk of chunks) {
        client.sendPluginData(targets, WATCH_DATA_ID, chunk, { priority: true });
      }
    });
    // Also notify watchFileStream for WebRTC file streaming
    watchFileStream.entered(s);
  }

  private cleanup(s: Session) {
    // Torrent together: whoever is done with the party stops downloading and sharing the torrent
    const meta = this.getParty(s)?.meta;
    for (const hash of new Set([...(meta?.queue ?? []), ...(meta?.torrent ? [meta.torrent] : [])].map(t => t.infoHash))) {
      void desktop?.torrent?.stop(hash).catch(() => {});
    }
    this.stopSyncLoop(s);
    this.disposeHostVideo(s);
    this.setParty(s, null);
    this.setState(s, 'idle');
    // Forget the playback position of the finished session: a new one starts from 0, not from
    // where the old one stopped plus the time that has passed since
    this.syncState.delete(s);
    this.storedState.delete(s);
    this.pendingSeek = false;
    this.latencyEstimate = 0;
    this.expectedSeekMs = null;
    this.expectedSeekUntil = 0;
    this.expectedPlaying = null;
    this.expectedPlayingUntil = 0;
    this.lastAppliedSeekServerTime = 0;
    this.lastAppliedSeekPositionMs = 0;
    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
      this.seekDebouncedPosition = null;
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
      this.pendingSettleEvents = [];
      this.settleStartTime = null;
    }
    this.settlePending = false;

    if (this.videoEl) {
      this.videoEl.removeEventListener('play', this.boundOnLocalPlay);
      this.videoEl.removeEventListener('pause', this.boundOnLocalPause);
      this.videoEl.removeEventListener('seeking', this.boundOnLocalSeeking);
      this.videoEl.removeEventListener('seeked', this.boundOnLocalSeeked);
      this.videoEl.removeEventListener('ended', this.boundOnLocalEnded);
      this.videoEl.pause();
      this.videoEl.src = '';
      this.videoEl = null;
      this.localVideo = null;
    }

    this.youtubePlayer = null;
  }

  private onLocalPlay() {
    if (this.moving) return;
    const s = sessions.active;
    if (this.getState(s) !== 'watching') return;
    // Ignore if this play event was caused by our own applySyncState
    if (this.expectedPlaying === true && Date.now() < this.expectedPlayingUntil) {
      this.logDebug('local-event', 'play', 'ignored(expected)');
      return;
    }
    this.logDebug('local-event', 'play', 'scheduled');
    this.scheduleSettle(s, 'play');
  }

  private onLocalPause() {
    if (this.moving) return;
    const s = sessions.active;
    if (this.getState(s) !== 'watching') return;
    // Ignore if this pause event was caused by our own applySyncState
    if (this.expectedPlaying === false && Date.now() < this.expectedPlayingUntil) {
      this.logDebug('local-event', 'pause', 'ignored(expected)');
      return;
    }
    this.logDebug('local-event', 'pause', 'scheduled');
    this.scheduleSettle(s, 'pause');
  }

  private onLocalSeeking() {
    if (this.moving) return;
    const s = sessions.active;
    if (this.getState(s) !== 'watching') return;
    // Ignore if this seeking event was caused by our own applySyncState
    if (this.expectedSeekMs !== null && Date.now() < this.expectedSeekUntil) {
      this.logDebug('local-event', 'seeking', 'ignored(expected)');
      return;
    }
    this.logDebug('local-event', 'seeking', 'scheduled');
    this.scheduleSettle(s, 'seeking');
  }

  private onLocalSeeked() {
    if (this.moving) return;
    const s = sessions.active;
    if (this.getState(s) !== 'watching' || !this.videoEl) return;
    const positionMs = Math.round(this.videoEl.currentTime * 1000);

    // Ignore if this seeked event was caused by our own applySyncState
    const now = Date.now();
    if (this.expectedSeekMs !== null && now < this.expectedSeekUntil) {
      if (Math.abs(positionMs - this.expectedSeekMs) < ECHO_TOLERANCE_MS) {
        this.expectedSeekMs = null;
        this.expectedSeekUntil = 0;
        this.logDebug('local-event', 'seeked', 'ignored(expected)');
        return; // This was our own programmatic seek, don't re-broadcast
      }
    }

    this.logDebug('local-event', 'seeked', 'scheduled');
    this.scheduleSettle(s, 'seeked');
  }

  private scheduleSettle(s: Session, eventType: string) {
    const now = Date.now();
    this.pendingSettleEvents.push(eventType);
    this.settlePending = true; // Local gesture waiting to publish

    // Track when the first event came in for max wait
    if (this.settleStartTime === null) {
      this.settleStartTime = now;
    }

    // Clear existing timer
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }

    // Calculate delay: either SETTLE_MS from last event, or max wait from first event
    const timeSinceFirst = now - (this.settleStartTime ?? now);
    const delay = Math.min(SETTLE_MS, Math.max(0, SETTLE_MAX_WAIT_MS - timeSinceFirst));

    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      this.flushSettle(s);
    }, delay);
  }

  private flushSettle(s: Session) {
    // If video is still seeking or not ready, defer
    if (this.videoEl && (this.videoEl.seeking || this.videoEl.readyState < 2)) {
      this.logDebug('settle', 'deferred: video still seeking');
      // Re-arm with short delay, respecting max wait
      const timeSinceFirst = Date.now() - (this.settleStartTime ?? Date.now());
      const delay = Math.min(100, Math.max(0, SETTLE_MAX_WAIT_MS - timeSinceFirst));
      if (delay > 0) {
        this.settleTimer = window.setTimeout(() => {
          this.settleTimer = null;
          this.flushSettle(s);
        }, delay);
      } else {
        // Max wait exceeded, force flush
        this.doFlushSettle(s);
      }
      return;
    }

    this.doFlushSettle(s);
  }

  private doFlushSettle(s: Session) {
    const events = this.pendingSettleEvents;
    this.pendingSettleEvents = [];
    this.settleStartTime = null;

    if (!this.videoEl || this.getState(s) !== 'watching') {
      this.settlePending = false;
      return;
    }

    const pos = Math.round(this.videoEl.currentTime * 1000);
    const playing = !this.videoEl.paused && !this.videoEl.ended;
    const state = this.getSyncState(s);

    if (!state) {
      this.settlePending = false;
      return;
    }

    const expectedPos = this.getExpectedPosition(s);
    const seeked = Math.abs(pos - expectedPos) > DRIFT_THRESHOLD_MS;
    const playChanged = playing !== state.playing;

    this.logDebug('settle', 'seeked=' + seeked, 'playChanged=' + playChanged, 'events=' + events.join(','), 'pos=' + pos, 'expectedPos=' + expectedPos, 'playing=' + playing, 'state.playing=' + state.playing);

    if (seeked) {
      // Send single seek with playing flag
      this.seek(pos, playing);
    } else if (playChanged) {
      if (playing) {
        this.play();
      } else {
        this.pause();
      }
    } else {
      this.logDebug('settle', 'no-op');
    }

    // Update local state BEFORE clearing settlePending
    // The seek/play/pause methods already call setSyncState and applySyncState
    this.settlePending = false;

    // After settling, run reconcile once to apply any deferred remote state
    this.reconcile(s);
  }

  private onLocalTimeUpdate() {
    // Handled by sync loop
  }

  private onLocalEnded() {
    const s = sessions.active;
    const party = this.getParty(s);
    if (!party || !this.isHostFor(s)) return;

    if (party.currentIndex < party.playlist.length - 1) {
      this.skipNext();
    } else {
      this.pause();
    }
  }

  private async handleStart(s: Session, body: any, fromSession: number) {
    console.log('[WatchTogether] handleStart - fromSession:', fromSession, 'self:', s.self?.session, 'current state:', this.getState(s));

    // Don't join our own start signal
    if (fromSession === s.self?.session) {
      console.log('[WatchTogether] handleStart - ignoring own start signal');
      return;
    }

    // A host in another room: only their name shows that they host, there is no party for us
    if (!this.inMyChannel(s, fromSession)) {
      if (body?.mode === 1 || body?.mode === 2 || body?.mode === 3) {
        s.setWatchTogether(fromSession, { mode: body.mode, title: String(body.title ?? '').slice(0, 300) });
      }
      return;
    }

    const currentState = this.getState(s);
    const party = this.getParty(s);

    // If we're already in a party with the same host, ignore duplicate start
    if (party && party.hostSession === fromSession && currentState === 'watching') {
      console.log('[WatchTogether] handleStart - already in party with this host, ignoring');
      return;
    }

    // If host changed or we're in a stale state, reset
    if (currentState !== 'idle') {
      console.log('[WatchTogether] handleStart - resetting stale state, was:', currentState);
      this.cleanup(s);
    }

    // Torrent together: only a well-formed torrent makes a party, and what is kept is rebuilt from it
    const got = body?.mode === 3 ? this.torrentFrom(body, 0) : null;
    if (body?.mode === 3 && !got) return;
    const torrent = got?.torrent ?? null;

    console.log('[WatchTogether] handleStart - showing indicator for party from', fromSession);

    // Just announce/show indicator - don't auto-join
    // User must click indicator to join (manual join via Members.svelte)
    s.setWatchTogether(fromSession, { mode: body.mode, title: body.title });

    // Create party with initial metadata but don't join yet
    // The 'host' field is our local session (for sending signals), hostSession is the remote host's Mumble session ID
    const newParty: WatchParty = {
      host: s,
      hostSession: fromSession,
      meta: torrent ? { mode: 3, title: String(body.title ?? '').slice(0, 300), torrent, queue: got?.queue } : body,
      positionMs: 0,
      playing: false,
      participants: [fromSession],
      playlist: body.videoId ? [{ id: body.videoId, title: body.title }] : [],
      currentIndex: 0,
      at: getServerTime(),
    };
    this.setParty(s, newParty);
    // State stays 'idle' until user manually joins
  }

  private handleJoin(s: Session, fromSession: number) {
    const party = this.getParty(s);
    if (!party) return;

    // Any member (host or viewer) with a party responds to join
    // Add joiner to participants if not already there
    if (!party.participants.includes(fromSession)) {
      party.participants.push(fromSession);
      this.setParty(s, party);
    }

    // The host is back: tell them we are in, so their list has the viewers who stayed
    this.announceToHost(s, party, fromSession);

    // EVERY member (host or viewer) replies with their current sync state
    // This allows a rejoining host to adopt the viewer's live state
    // If syncState doesn't exist yet (host just started), use party state
    const syncState = this.getSyncState(s);
    const positionMs = syncState?.positionMs ?? party.positionMs;
    const playing = syncState?.playing ?? party.playing;
    const rev = syncState?.rev ?? 0;
    const origin = syncState?.origin ?? s.self?.session ?? 0;
    const at = syncState?.at ?? getServerTime();

    this.logDebug('rx', 'join', 'from:', fromSession, 'replying with state rev:', rev, 'pos:', positionMs, 'playing:', playing);
    this.sendWatchSignal(WATCH.state, {
      mode: party.meta.mode,
      videoId: party.meta.videoId,
      fileMeta: party.meta.fileMeta,
      torrent: party.meta.torrent,
      queue: party.meta.queue,
      title: party.meta.title,
      positionMs,
      playing,
      playlist: party.playlist,
      currentIndex: party.currentIndex,
      rev,
      origin,
      at,
      rate: syncState?.rate,
      participants: this.participantsToShare(s, party),
    }, s, [fromSession], true);
  }

  private handleLeave(s: Session, fromSession: number) {
    const party = this.getParty(s);
    if (!party) return;

    party.participants = party.participants.filter(ses => ses !== fromSession);
    this.setParty(s, party);

    // Host leaving does NOT end the session for everyone - only end() does that
    // Host can leave and rejoin without affecting other participants
  }

  // The host ended the party (or is gone). Their indicator goes whether or not we are in the
  // party: someone who left keeps the indicator (to come back) and has no party to clear it with.
  private handleEnd(s: Session, hostSession: number) {
    console.log('[WatchTogether] handleEnd from', hostSession);
    s.setWatchTogether(hostSession, false);
    const party = this.getParty(s);
    // Only the host can end the party we are in
    if (!party || party.hostSession !== hostSession) return;
    this.cleanup(s);
  }

  // Handle user moving channels or leaving
  userMoved(s: Session, user: { session: number }, gone = false): void {
    if (!s.client?.self || user.session === s.client.session) return;
    if (!gone && this.inMyChannel(s, user.session)) return;

    // They are no longer here, so whatever they hosted is over for us, party or not
    s.setWatchTogether(user.session, false);

    const party = this.getParty(s);
    if (!party) return;

    // If host left the channel, end the watch party for us
    if (party.hostSession === user.session) {
      this.handleEnd(s, user.session);
      return;
    }

    // If a participant left, remove them from participants
    party.participants = party.participants.filter(ses => ses !== user.session);
    this.setParty(s, party);
  }

  // We moved to another channel: a party we host does not follow us, and the indicators of the
  // old channel are no longer ours (the viewers there end the party when they see us go)
  // A party we only watch stays behind too: it belongs to the old channel, and keeping it would
  // make us ignore the state of a party in the new one (entered() asks again afterwards).
  selfMoved(s: Session): void {
    const party = this.getParty(s);
    if (party) {
      if (this.isHostFor(s)) {
        // The party ends with the move: everybody, in any room, drops the indicator on our name
        void this.sendWatchSignal(WATCH.end, {}, s, this.everyone(s), true);
        if (party.meta.mode === 2) void watchFileStream.stopStream(s);
      } else if (party.meta.mode === 2 && this.getState(s) !== 'idle') {
        void watchFileStream.stopWatching(s, party.hostSession);
      }
      this.cleanup(s);
    }
    s.clearWatchTogether();
  }

  // The connection is gone: nothing keeps playing or streaming for it
  closed(s: Session): void {
    if (this.getParty(s) || this.hostVideoOwner === s) this.cleanup(s);
    watchFileStream.closed(s);
    s.clearWatchTogether();
  }

  private handleWho(s: Session, fromSession: number) {
    const party = this.getParty(s);
    if (!party) return;
    // Asked from another room: only the host answers, with what the indicator needs
    if (!this.inMyChannel(s, fromSession)) {
      if (this.isHostFor(s)) this.announceOutside(s, party, [fromSession]);
      return;
    }
    console.log('[WatchTogether] handleWho - responding to', fromSession);
    this.announceToHost(s, party, fromSession);
    const syncState = this.getSyncState(s);
    // Send state response to the querier
    // Use syncState if available (has correct position/playing), otherwise fall back to party
    this.sendWatchSignal(WATCH.state, {
      mode: party.meta.mode,
      videoId: party.meta.videoId,
      fileMeta: party.meta.fileMeta,
      torrent: party.meta.torrent,
      queue: party.meta.queue,
      title: party.meta.title,
      positionMs: syncState?.positionMs ?? party.positionMs,
      playing: syncState?.playing ?? party.playing,
      playlist: party.playlist,
      currentIndex: party.currentIndex,
      rev: syncState?.rev ?? 0,
      origin: syncState?.origin ?? s.self?.session ?? 0,
      at: syncState?.at ?? getServerTime(),
      rate: syncState?.rate,
      participants: this.participantsToShare(s, party),
    }, s, [fromSession]);
  }

  // File streaming handlers (mode 2) - WebRTC signaling via Mumble
  private handleFileRequest(s: Session, sdp: string, fromSession: number) {
    // Viewer sends WebRTC offer to host
    console.log('[WatchTogether] handleFileRequest - offer from:', fromSession, 'sdp length:', sdp.length);
    watchFileStream.receive(s, fromSession, WATCH_DATA_ID, new TextEncoder().encode(JSON.stringify({ type: WATCH.fileRequest, text: sdp })));
  }

  private handleFileChunk(s: Session, sdp: string, fromSession: number) {
    // Host sends WebRTC answer to viewer
    console.log('[WatchTogether] handleFileChunk - answer from:', fromSession, 'sdp length:', sdp.length);
    watchFileStream.receive(s, fromSession, WATCH_DATA_ID, new TextEncoder().encode(JSON.stringify({ type: WATCH.fileChunk, text: sdp })));
  }

  private handleFileEnd(s: Session, fromSession: number) {
    console.log('[WatchTogether] handleFileEnd from:', fromSession);
    watchFileStream.stopWatching(s, fromSession);
  }

  private handlePlayPause(s: Session, body: any, playing: boolean, fromSession: number) {
    // Note: isSelf check is done in handleSignal before calling this
    const party = this.getParty(s);
    if (!party) return;

    const incoming: SyncState = {
      rev: body.rev ?? 0,
      origin: body.origin ?? fromSession,
      playing: body.playing,
      positionMs: body.positionMs,
      at: body.at ?? getServerTime(),
      rate: body.rate ?? this.getSyncState(s)?.rate,
    };

    const current = this.getSyncState(s);
    if (!isSyncStateNewer(incoming, current)) {
      this.logDebug('rx', 'play-pause', incoming.rev, incoming.origin, incoming.playing, incoming.positionMs, 'ignored(stale)');
      return;
    }

    this.setSyncState(s, incoming);
    this.logDebug('rx', 'play-pause', incoming.rev, incoming.origin, incoming.playing, incoming.positionMs, 'applied');

    // If local gesture is pending, don't apply to video yet - let settle win
    if (!this.settlePending) {
      this.applySyncState(s, incoming);
    } else {
      this.logDebug('rx', 'play-pause', 'deferred (local gesture pending)');
    }
  }

  private handleSeek(s: Session, body: any, fromSession: number) {
    // Note: isSelf check is done in handleSignal before calling this
    const party = this.getParty(s);
    if (!party) return;

    const current = this.getSyncState(s);
    const incoming: SyncState = {
      rev: body.rev ?? 0,
      origin: body.origin ?? fromSession,
      playing: body.playing ?? (body.playing === undefined ? (current?.playing ?? party.playing) : body.playing),
      positionMs: body.positionMs,
      at: body.at ?? getServerTime(),
      rate: body.rate ?? this.getSyncState(s)?.rate,
    };

    if (!isSyncStateNewer(incoming, current)) {
      this.logDebug('rx', 'seek', incoming.rev, incoming.origin, incoming.playing, incoming.positionMs, 'ignored(stale)');
      return;
    }

    this.setSyncState(s, incoming);
    this.logDebug('rx', 'seek', incoming.rev, incoming.origin, incoming.playing, incoming.positionMs, 'applied');

    // If local gesture is pending, don't apply to video yet - let settle win
    if (!this.settlePending) {
      this.applySyncState(s, incoming);
    } else {
      this.logDebug('rx', 'seek', 'deferred (local gesture pending)');
    }
  }

  private handleRate(s: Session, body: any, fromSession: number) {
    // Note: isSelf check is done in handleSignal before calling this
    const party = this.getParty(s);
    if (!party) return;

    const current = this.getSyncState(s);
    const incoming: SyncState = {
      rev: body.rev ?? 0,
      origin: body.origin ?? fromSession,
      playing: body.playing ?? current?.playing ?? party.playing,
      positionMs: body.positionMs,
      at: body.at ?? getServerTime(),
      rate: body.rate ?? this.getSyncState(s)?.rate,
    };

    if (!isSyncStateNewer(incoming, current)) {
      this.logDebug('rx', 'rate', incoming.rev, incoming.origin, incoming.playing, incoming.positionMs, 'ignored(stale)');
      return;
    }

    this.setSyncState(s, incoming);
    this.logDebug('rx', 'rate', incoming.rev, incoming.origin, incoming.playing, incoming.positionMs, 'applied');

    // If local gesture is pending, don't apply to video yet - let settle win
    if (!this.settlePending) {
      this.applySyncState(s, incoming);
    } else {
      this.logDebug('rx', 'rate', 'deferred (local gesture pending)');
    }
  }

  private handleSync(s: Session, body: any, fromSession: number) {
    // Note: isSelf check is done in handleSignal before calling this
    const party = this.getParty(s);
    if (!party) return;

    // Only host sends sync, viewers receive
    if (this.isHostFor(s)) return;

    const incoming: SyncState = {
      rev: body.rev ?? 0,
      origin: body.origin ?? fromSession,
      playing: body.playing,
      positionMs: body.positionMs,
      at: body.at ?? getServerTime(),
      rate: body.rate ?? this.getSyncState(s)?.rate,
    };

    const current = this.getSyncState(s);
    if (incoming.rev < (current?.rev ?? 0)) {
      this.logDebug('rx', 'sync', incoming.rev, incoming.origin, incoming.playing, incoming.positionMs, 'ignored(older rev)');
      return;
    }

    // Apply sync state
    this.setSyncState(s, incoming);
    this.logDebug('rx', 'sync', incoming.rev, incoming.origin, incoming.playing, incoming.positionMs, 'applied');
    if (typeof body.durationMs === 'number' && body.durationMs > 0 && party.durationMs !== body.durationMs) {
      party.durationMs = body.durationMs;
      this.setParty(s, party);
    }

    if (body.dl && party.fileShare?.i !== body.dl.i) {
      const meta = validMeta(body.dl);
      if (meta) { party.fileShare = meta; this.setParty(s, party); }
    }

    // Use reconcile() to drive video from shared state
    if (!this.settlePending) {
      this.reconcile(s);
    } else {
      this.logDebug('rx', 'sync', 'deferred (local gesture pending)');
    }
  }

  private async handleState(s: Session, body: StatePayload, fromSession: number) {
    // Handle both joining state (when viewer joins via WATCH.join) and idle state (when late joiner sends WATCH.who)
    const currentState = this.getState(s);
    if (currentState !== 'joining' && currentState !== 'idle') return;
    const party = this.getParty(s);
    // A member that is in the session tells who else is (a host coming back learns who stayed)
    if (party && Array.isArray(body.participants)) this.addParticipants(s, [fromSession, ...body.participants]);
    // If we're joining, we should have a party with matching hostSession
    // If we're idle (late joiner), we might not have a party yet
    if (party && party.hostSession !== fromSession) return;

    const got = body.mode === 3 ? this.torrentFrom(body, body.currentIndex ?? 0) : null;
    if (body.mode === 3 && !got) return;
    const torrent = got?.torrent ?? null;
    const queueIndex = got?.index ?? 0;
    if (torrent && currentState === 'idle') {
      // An answer nobody asked for (we just came into the channel): a torrent is downloaded only by
      // those who ask to join it, because that shows their address to everybody in the swarm
      s.setWatchTogether(fromSession, { mode: 3, title: body.title });
      if (!party) {
        this.setParty(s, {
          host: s, hostSession: fromSession, meta: { mode: 3, title: body.title, torrent, queue: got?.queue },
          positionMs: body.positionMs, playing: body.playing, participants: [fromSession],
          playlist: [], currentIndex: queueIndex, at: getServerTime(),
        });
      }
      return;
    }

    // Announce watch together session to show indicator (for late joiners and regular joiners)
    s.setWatchTogether(fromSession, { mode: body.mode, title: body.title });

    // The 'host' field is our local session (for sending signals), hostSession is the remote host's Mumble session ID
    const newParty: WatchParty = {
      host: s,
      hostSession: fromSession,
      meta: {
        mode: body.mode,
        videoId: body.videoId,
        fileMeta: body.fileMeta,
        torrent: torrent ?? undefined,
        queue: got?.queue,
        title: body.title,
      },
      positionMs: body.positionMs,
      playing: body.playing,
      participants: [...new Set([fromSession, ...(s.self ? [s.self.session] : []), ...(Array.isArray(body.participants) ? body.participants.filter((p): p is number => typeof p === 'number' && this.inMyChannel(s, p)) : [])])],
      playlist: body.playlist ?? (body.videoId ? [{ id: body.videoId, title: body.title }] : []),
      currentIndex: got ? queueIndex : (body.currentIndex ?? 0),
      at: getServerTime(),
    };
    this.setParty(s, newParty);

    // Initialize sync state for late join
    const incoming: SyncState = {
      rev: body.rev ?? 0,
      origin: body.origin ?? fromSession,
      playing: body.playing,
      positionMs: body.positionMs,
      at: body.at ?? getServerTime(),
      rate: body.rate ?? this.getSyncState(s)?.rate,
    };
    this.setSyncState(s, incoming);

    this.setState(s, 'watching');
    this.startSyncLoop(s);

    // We came in without asking (an answer to our "who is here" on entering the channel, or after
    // a reconnect): nobody knows yet that we are in. Tell the host and the others, so their lists
    // and tiles include us.
    if (currentState === 'idle') {
      const others = newParty.participants.filter(p => p !== fromSession && p !== s.self?.session && this.inMyChannel(s, p));
      void this.sendWatchSignal(WATCH.join, {}, s, [fromSession, ...others]);
    }

    // Apply the playback state to the local player (uses reconcile which handles readiness)
    if (!this.settlePending) {
      this.reconcile(s);
    } else {
      this.logDebug('rx', 'state', 'deferred (local gesture pending)');
    }

    // For mode 2 (file streaming), start WebRTC watching
    if (body.mode === 2 && body.fileMeta) {
      await watchFileStream.startWatching(s, fromSession, {
        size: body.fileMeta.size,
        mimeType: body.fileMeta.mimeType,
      });
    }
  }

  private handlePlaylist(s: Session, body: any, fromSession: number) {
    const party = this.getParty(s);
    if (!party || fromSession !== party.hostSession) return;

    party.playlist = body.videos;
    party.currentIndex = body.currentIndex;
    this.setParty(s, party);
  }

  }

export const watchTogether = new WatchTogether();
