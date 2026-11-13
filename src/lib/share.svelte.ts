// Screen sharing between Libertad clients in the same channel. Mumble has no video, so the
// picture goes directly from the sharer to each viewer over WebRTC; only the setup messages
// travel through the Mumble server (as plugin data, see core/share-signal.ts). The server has
// checked the sender's certificate, so a stream is known to come from that user.
import { SHARE, SHARE_DATA_ID, encodeShare, ShareAssembler, type ShareType } from '../core/share-signal.ts';
import type { User } from '../core/client.ts';
import type { Session } from './session.svelte.ts';
import { desktop, isWeb } from './native.ts';
import { rtcConfig, gathered } from './ice.ts';
import { store } from './settings.svelte.ts';
import { ui } from './ui.svelte.ts';
import { sounds } from './audio/sounds.svelte.ts';
import { NO_CAP, parseCap, capFps, capScale, type ViewerCap } from './stream-quality.ts';

// Every viewer is a separate upload from the sharer
const MAX_VIEWERS = 8;
// Cameras watched at once; each is a download and a decoder
const MAX_CAMERAS = 12;
// Screens watched at once; a screen is much heavier than a camera
const MAX_SCREENS = 4;
// What the person can choose for their own stream (Share dialog); each value is really applied
export const SHARE_BITRATES = [2, 4, 8, 16, 32, 64]; // Mbit/s, an upper limit
export const SHARE_HEIGHTS = [480, 720, 1080, 1440, 2160]; // picture height in pixels
export const SHARE_FPS = [30, 60, 120];
export const SHARE_MODES = { fps: 'Prefer FPS', quality: 'Prefer quality' } as const;
export type ShareMode = keyof typeof SHARE_MODES;
export interface ShareSettings { bitrate: number; height: number; fps: number; mode: ShareMode }

// The stored choices, forced onto the offered values (older or edited settings may hold others)
const nearest = (list: number[], v: number) => list.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);
export function shareSettings(): ShareSettings {
  const s = store.settings;
  return {
    bitrate: nearest(SHARE_BITRATES, Number(s.shareBitrate)),
    height: nearest(SHARE_HEIGHTS, Number(s.shareHeight)),
    fps: nearest(SHARE_FPS, Number(s.shareFps)),
    mode: s.shareMode === 'fps' ? 'fps' : 'quality'
  };
}

// Camera wishes for getUserMedia
export function cameraConstraints(): MediaTrackConstraints {
  const q = shareSettings();
  return { width: { ideal: Math.round(q.height * 16 / 9) }, height: { ideal: q.height }, frameRate: { ideal: q.fps } };
}

// Opus is negotiated as mono speech by default; shared sound is stereo and often music
const stereo = (sdp: string) => sdp.replace(/a=fmtp:(\d+) ([^\r\n]*useinbandfec=1[^\r\n]*)/g,
  (line, pt, rest) => rest.includes('stereo=1') ? line : `a=fmtp:${pt} ${rest};stereo=1;sprop-stereo=1;maxaveragebitrate=192000`);

// A new connection starts guessing its capacity at about 300 kbit/s and climbs slowly from there,
// so a picture starts blurry and stutters for a long time. Chromium takes a start and a floor from
// the video codec lines of the description; the sharer's choice goes into the offer and the
// viewer repeats it in the answer, which is what the sending side reads.
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
interface Rates { start: number; min: number; max: number } // kbit/s
function ratesFor(mbit: number): Rates {
  const max = mbit * 1000;
  return { start: clamp(Math.round(max / 2), 1500, 8000), min: clamp(Math.round(max / 8), 500, 2000), max };
}
function ratesOf(sdp: string): Rates | null {
  const get = (k: string) => Number(new RegExp(`x-google-${k}-bitrate=(\\d+)`).exec(sdp)?.[1]);
  const start = get('start'), min = get('min'), max = get('max');
  return start && max ? { start, min: min || 500, max } : null;
}
function tuneVideo(sdp: string, r: Rates): string {
  const extra = `x-google-start-bitrate=${r.start};x-google-min-bitrate=${r.min};x-google-max-bitrate=${r.max}`;
  const lines = sdp.split('\r\n');
  const out: string[] = [];
  let video = false;
  // The payload types of the real codecs of the video section (not retransmission or redundancy)
  const pts = new Set<string>();
  lines.forEach(l => {
    if (l.startsWith('m=')) video = l.startsWith('m=video');
    const m = video && /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1|H265)\//.exec(l);
    if (m) pts.add(m[1]);
  });
  video = false;
  const done = new Set<string>();
  for (const l of lines) {
    if (l.startsWith('m=')) video = l.startsWith('m=video');
    const fmtp = video && /^a=fmtp:(\d+) /.exec(l);
    if (fmtp && pts.has(fmtp[1]) && !l.includes('x-google-start-bitrate')) { out.push(`${l};${extra}`); done.add(fmtp[1]); continue; }
    out.push(l);
    const rtp = video && /^a=rtpmap:(\d+) /.exec(l);
    // A codec without a parameter line gets one right after its name
    if (rtp && pts.has(rtp[1]) && !lines.some(x => x.startsWith(`a=fmtp:${rtp[1]} `))) out.push(`a=fmtp:${rtp[1]} ${extra}`);
  }
  return out.join('\r\n');
}

// Dynamic FPS: a screen that shows nothing new for this long is sent at 1 frame per second
const IDLE_MS = 2000;
const IDLE_FPS = 1;
// A small copy of every few frames is compared; it must be large enough that typing a letter shows
const MOTION_W = 384, MOTION_H = 216;
function differs(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    // Two pixels, so that one flickering pixel (a blinking caret's edge) does not count as motion
    if (d > 16 && ++n >= 2) return true;
  }
  return false;
}

// What a stream shows. Sent along with the announcement, so others see the right icon.
export type ShareKind = 'screen' | 'camera';

export interface Watching {
  host: Session;
  session: number;
  kind: ShareKind;
  stream: MediaStream | null;
  state: 'connecting' | 'live' | 'failed';
  // A camera that came on by itself because its owner is in our room. It goes when one of us leaves
  // the room; a stream the person asked for (a click on the indicator) stays until they stop it.
  auto?: boolean;
  // Who watches this stream, as the sharer tells us (session ids, ourselves among them)
  viewers?: number[];
}

class ScreenShare {
  // The server we are sharing on, and what we send
  host = $state.raw<Session | null>(null);
  stream = $state.raw<MediaStream | null>(null);
  kind = $state<ShareKind>('screen');
  // Show our own camera mirrored to ourselves, as a mirror would. Not a camera pointing away
  // from us (a phone's back camera), and never what the others get.
  mirror = $state(false);
  // How many cameras this device has; with more than one there is something to switch to
  cameras = $state(0);
  switching = $state(false);
  viewers = $state(0);
  // Who they are (session ids), for showing the people watching us
  viewerSessions = $state.raw<number[]>([]);
  // Streams we receive: several screens and cameras at once, from one server
  watches = $state.raw<Watching[]>([]);
  // People whose camera we chose not to see, by certificate (or name); until the app restarts
  hidden = $state<Record<string, boolean>>({});
  error = $state('');
  // The large picture is in a window of its own; the main window keeps only a bar for it
  poppedOut = $state(false);
  // Counts the times we went to look at someone else's screen while sharing our own: the stage
  // then puts our own picture aside (it keeps being shared)
  asideRequest = $state(0);
  // What we look at ourselves while sharing a screen: the same picture at a lower frame rate. Showing
  // 1080p at 60 frames per second in the page costs the processor as much as sending it does.
  preview = $state.raw<MediaStream | null>(null);
  // Dynamic FPS: the picture has not changed for a while, so only a trickle is sent
  private idle = false;
  private stopMotion: (() => void) | null = null;
  private codecPick: Promise<string | null> | null = null;
  // The server the start dialog is open for
  dialog = $state.raw<Session | null>(null);
  private usesVirtualMic = false;
  private cfg: ShareSettings = shareSettings();

  private peers = new Map<number, RTCPeerConnection>();
  private watchPcs = new Map<number, RTCPeerConnection>();
  private watchTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private assemblers = new WeakMap<Session, ShareAssembler>();
  // Viewers whose connection came up, so leaving is only announced for those
  private live = new Set<number>();
  // When we entered the channel: streams already running there are not announced with a sound
  private enteredAt = new WeakMap<Session, number>();

  // Plugin data needs a 1.4 server; older ones would not pass the signals on
  supported(s: Session): boolean {
    return !!s.client && s.client.serverVersionNum >= 0x010400 && typeof RTCPeerConnection !== 'undefined';
  }

  private rtcConfig(): Promise<RTCConfiguration> {
    return rtcConfig();
  }

  private others(s: Session): number[] {
    const self = s.client?.self;
    if (!self) return [];
    return [...s.client!.users.values()].filter(u => u.session !== self.session && u.channelId === self.channelId).map(u => u.session);
  }

  // Everybody on the server: who is sharing is shown on their name in every room, so these
  // announcements are not kept to the channel (watching itself still is)
  private everyone(s: Session): number[] {
    const self = s.client?.self;
    if (!self) return [];
    return [...s.client!.users.values()].filter(u => u.session !== self.session).map(u => u.session);
  }

  private inMyChannel(s: Session, session: number): boolean {
    const self = s.client?.self;
    return !!self && s.client!.users.get(session)?.channelId === self.channelId;
  }

  // Cross-room watching: with it off, what we share is for our own room only
  private crossRoom(): boolean { return store.settings.shareCrossRoom !== false; }
  private allowed(s: Session, session: number): boolean { return this.crossRoom() || this.inMyChannel(s, session); }

  // Tell the server who may see our stream: everybody, or only our room (the others are told it is off,
  // and any of them already watching is cut off)
  private announce(s: Session): void {
    if (this.host !== s) return;
    const all = this.everyone(s);
    const yes = all.filter(id => this.allowed(s, id));
    const no = all.filter(id => !yes.includes(id));
    this.send(s, yes, SHARE.on, this.kind);
    this.send(s, no, SHARE.off);
    for (const id of no) { this.caps.delete(id); this.dropPeer(id); }
  }

  // The switch in the sharing dialog was changed
  applyCrossRoom(): void {
    if (this.host?.client) this.announce(this.host);
  }

  private async send(s: Session, to: number[], type: ShareType, text?: string): Promise<void> {
    if (!to.length) return;
    // The setup messages skip the queue that paces plugin data: they are a handful of packets, and
    // waiting behind chat or other plugin data delays the start of the picture
    const urgent = type === SHARE.offer || type === SHARE.answer || type === SHARE.watch;
    for (const packet of await encodeShare(type, text)) s.client?.sendPluginData(to, SHARE_DATA_ID, packet, { priority: urgent });
  }

  // Sharer and viewer connect directly, so each learns the other's address; say so once
  private notice(): Promise<boolean> {
    if (store.settings.shareNoticeSeen) return Promise.resolve(true);
    return new Promise(resolve => {
      let answered = false;
      ui.prompt = {
        title: 'Screen sharing', label: '', confirm: 'Continue', input: 'none',
        text: 'Screen sharing connects you directly to the people watching. You see each other\'s IP address. Any Libertad user on this server can watch a stream from another room by clicking its indicator.',
        onsubmit: () => { answered = true; store.settings.shareNoticeSeen = true; store.saveSettings(); resolve(true); },
        oncancel: () => { if (!answered) resolve(false); }
      };
    });
  }

  // Opens the dialog where the source, the sound and the quality are chosen
  // kind: which menu it is. The screen, the camera and Watch Together each have their own. Opening one
  // while another runs is fine: the running one ends when the new one starts.
  dialogKind = $state<'screen' | 'camera' | 'watch'>('screen');
  async start(s: Session, kind: 'screen' | 'camera' | 'watch' = 'screen'): Promise<void> {
    if (this.dialog || !this.supported(s) || !(await this.notice())) return;
    this.error = '';
    this.dialogKind = kind;
    this.dialog = s;
  }

  // The dialog hands over what it captured
  go(s: Session, stream: MediaStream, usesVirtualMic: boolean, kind: ShareKind = 'screen'): void {
    this.dialog = null;
    // Disconnected while the dialog was open
    if (!s.client) {
      stream.getTracks().forEach(t => t.stop());
      if (usesVirtualMic) desktop?.shareAudioStop();
      return;
    }
    // One session at a time: the screen or camera that was on makes way
    if (this.stream) this.stop();
    // What was chosen when sharing started holds for the whole stream
    this.cfg = shareSettings();
    for (const t of stream.getVideoTracks()) {
      // The dialog may have captured before the frame rate was changed there
      t.applyConstraints({ frameRate: { ideal: this.cfg.fps } }).catch(() => {});
      // Prefer FPS: motion, the encoder favours smoothness. Prefer quality: detail, it favours sharp text.
      t.contentHint = this.cfg.mode === 'fps' ? 'motion' : 'detail';
      // The system's "stop sharing" control
      t.addEventListener('ended', () => this.stop());
    }
    this.usesVirtualMic = usesVirtualMic;
    this.kind = kind;
    this.mirror = kind === 'camera' && stream.getVideoTracks()[0]?.getSettings().facingMode !== 'environment';
    this.cameras = 0;
    if (kind === 'camera') navigator.mediaDevices.enumerateDevices().then(d => { this.cameras = d.filter(x => x.kind === 'videoinput').length; }).catch(() => {});
    this.host = s;
    this.stream = stream;
    this.idle = false;
    this.codecPick = null;
    if (kind === 'screen') {
      this.preview = this.makePreview(stream);
      if (store.settings.shareDynamicFps) this.watchMotion(stream);
    }
    this.announce(s);
    s.setSharing(s.client.session!, kind);
    sounds.play('shareStarted');
  }

  // The next camera of this device (front and back on a phone), without interrupting the stream
  async switchCamera(): Promise<void> {
    const stream = this.stream;
    const old = stream?.getVideoTracks()[0];
    if (!stream || !old || this.kind !== 'camera' || this.switching) return;
    this.switching = true;
    this.error = '';
    const open = (deviceId: string) => navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, ...cameraConstraints() }
    }).catch(() => navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } }));
    try {
      const ids = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').map(d => d.deviceId);
      this.cameras = ids.length;
      const current = old.getSettings().deviceId ?? '';
      const next = ids[(ids.indexOf(current) + 1) % ids.length];
      if (ids.length < 2 || !next || next === current) return;
      let fresh: MediaStream;
      try {
        // Computers can have both open for a moment, which keeps the picture going
        fresh = await open(next);
      } catch {
        // A phone opens one camera at a time, so the old one has to go first
        old.stop();
        try {
          fresh = await open(next);
        } catch (e) {
          // Could not get the other one: back to the camera we had
          fresh = await open(current).catch(() => { throw e; });
          this.error = `Could not switch the camera: ${(e as Error).message}`;
        }
      }
      // Stopped sharing in the meantime
      if (this.stream !== stream) return fresh.getTracks().forEach(t => t.stop());
      const track = fresh.getVideoTracks()[0];
      track.contentHint = this.cfg.mode === 'fps' ? 'motion' : 'detail';
      track.addEventListener('ended', () => { if (this.stream?.getVideoTracks()[0] === track) this.stop(); });
      // Viewers keep their connection; only the picture changes
      for (const pc of this.peers.values()) {
        for (const sender of pc.getSenders()) {
          if (sender.track !== old) continue;
          await sender.replaceTrack(track).catch(e => { this.error = `A viewer did not get the new camera: ${(e as Error).message}`; });
        }
      }
      old.stop();
      this.stream = new MediaStream([track, ...stream.getAudioTracks()]);
      this.mirror = track.getSettings().facingMode !== 'environment';
    } catch (e) {
      this.error = `The camera stopped: ${(e as Error).message}`;
      this.stop();
    } finally {
      this.switching = false;
    }
  }

  private makePreview(stream: MediaStream): MediaStream | null {
    try {
      const track = stream.getVideoTracks()[0]?.clone();
      if (!track) return null;
      // Frames are thinned out for this copy only; what is sent keeps the chosen rate
      track.applyConstraints({ frameRate: { ideal: 15, max: 20 } }).catch(() => {});
      return new MediaStream([track]);
    } catch {
      return null;
    }
  }

  // Looks at the frames we capture (not at what the page shows, which stops while the window is
  // minimised) and tells the encoders to slow down when nothing has changed for IDLE_MS
  private watchMotion(stream: MediaStream): void {
    const track = stream.getVideoTracks()[0];
    const Processor = (globalThis as unknown as { MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<{ close(): void }> } }).MediaStreamTrackProcessor;
    if (!track || !Processor || typeof OffscreenCanvas === 'undefined') return;
    const ctx = new OffscreenCanvas(MOTION_W, MOTION_H).getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const reader = new Processor({ track }).readable.getReader();
    let prev: Uint8ClampedArray | null = null;
    let lastLook = 0;
    let changedAt = Date.now();
    let stopped = false;
    const timer = setInterval(() => { if (!stopped && !this.idle && Date.now() - changedAt >= IDLE_MS) this.setIdle(true); }, 250);
    void (async () => {
      while (!stopped) {
        const { done, value: frame } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done || !frame) break;
        const now = performance.now();
        if (!stopped && now - lastLook >= 66) {
          lastLook = now;
          try {
            ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, MOTION_W, MOTION_H);
            const cur = ctx.getImageData(0, 0, MOTION_W, MOTION_H).data;
            if (prev && differs(prev, cur)) {
              changedAt = Date.now();
              if (this.idle) this.setIdle(false);
            }
            prev = cur;
          } catch { /* a frame that cannot be read counts as nothing */ }
        }
        frame.close();
      }
    })();
    this.stopMotion = () => { stopped = true; clearInterval(timer); reader.cancel().catch(() => {}); };
  }

  private setIdle(idle: boolean): void {
    if (this.idle === idle) return;
    this.idle = idle;
    for (const viewer of this.peers.keys()) this.reshape(viewer);
  }

  // The frame rate and size we send one viewer: our own choice, lowered by his
  private reshape(viewer: number): void {
    const pc = this.peers.get(viewer);
    if (!pc) return;
    const cap = this.caps.get(viewer);
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      const sourceHeight = sender.track.getSettings().height ?? this.cfg.height;
      for (const enc of params.encodings) {
        enc.maxFramerate = capFps(this.idle ? IDLE_FPS : this.cfg.fps, cap);
        enc.scaleResolutionDownBy = capScale(sourceHeight, this.cfg.height, cap);
      }
      sender.setParameters(params).catch(() => {});
    }
  }

  // Encoding 1080p60 on the processor is what makes the computer hot. If this machine has a video
  // encoder in the graphics card for one of the codecs, that codec goes first in the offer (the
  // viewer takes the first one it can decode, so nothing breaks when it cannot).
  private hardwareCodec(): Promise<string | null> {
    return this.codecPick ??= (async () => {
      const caps = (navigator as unknown as { mediaCapabilities?: { encodingInfo(c: unknown): Promise<{ supported: boolean; powerEfficient: boolean }> } }).mediaCapabilities;
      if (!caps) return null;
      const c = this.cfg;
      for (const mime of ['video/H264', 'video/VP9', 'video/VP8']) {
        try {
          const info = await caps.encodingInfo({ type: 'webrtc', video: { contentType: mime, width: Math.round(c.height * 16 / 9), height: c.height, bitrate: c.bitrate * 1_000_000, framerate: c.fps } });
          if (info.supported && info.powerEfficient) return mime;
        } catch { /* not a codec this browser knows */ }
      }
      return null;
    })();
  }

  private release(): void {
    this.stopMotion?.();
    this.stopMotion = null;
    this.preview?.getTracks().forEach(t => t.stop());
    this.preview = null;
    this.idle = false;
    this.dropPeers();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.host = null;
    if (this.usesVirtualMic) desktop?.shareAudioStop();
    this.usesVirtualMic = false;
  }

  stop(): void {
    const s = this.host;
    if (this.stream) sounds.play('shareStopped');
    if (s?.client) {
      this.send(s, this.everyone(s), SHARE.off);
      if (s.client.session != null) s.setSharing(s.client.session, false);
    }
    this.release();
  }

  // What each viewer asked to receive at most (his own cap, kept while he watches); and what we asked of
  // the streams we watch, shown by their menu
  private caps = new Map<number, ViewerCap>();
  quality = $state<Record<number, ViewerCap>>({});

  private dropPeers(): void {
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.caps.clear();
    this.live.clear();
    this.viewers = 0;
    this.viewerSessions = [];
  }

  private dropPeer(session: number): void {
    this.peers.get(session)?.close();
    this.peers.delete(session);
    if (this.live.delete(session)) sounds.play('viewerLeft');
    this.setViewers();
  }

  // Who watches us: kept here and told to the viewers, who show it on their indicator
  private setViewers(): void {
    this.viewers = this.peers.size;
    this.viewerSessions = [...this.peers.keys()];
    const s = this.host;
    if (s?.client && this.viewerSessions.length) void this.send(s, this.viewerSessions, SHARE.viewers, JSON.stringify(this.viewerSessions));
  }

  // The first screen being watched, if any
  get watching(): Watching | null {
    return this.watches.find(w => w.kind === 'screen') ?? null;
  }
  watchOf(session: number): Watching | undefined {
    return this.watches.find(w => w.session === session);
  }

  // Cameras come on by themselves, like in a video call, once the note about IP addresses was
  // confirmed; each person's can be hidden, and the whole thing switched off
  get cams(): boolean {
    return store.settings.autoCameras;
  }
  private who(s: Session, session: number): string {
    const u = s.client?.users.get(session);
    return u ? u.hash || `name:${u.name}` : '';
  }
  isHidden(s: Session, session: number): boolean {
    return !!this.hidden[this.who(s, session)];
  }
  hideCamera(s: Session, session: number, hide: boolean): void {
    const key = this.who(s, session);
    if (!key) return;
    if (hide) { this.hidden[key] = true; this.unwatch(session); }
    else { delete this.hidden[key]; this.watch(s, session); }
  }
  private autoWatch(s: Session, session: number): void {
    if (this.cams && store.settings.shareNoticeSeen && this.inMyChannel(s, session) && s.sharing[session] === 'camera' && !this.isHidden(s, session)) void this.watch(s, session, true);
  }

  // Whether the room somebody is in lets us in. Watching from another room is allowed, but not
  // into a room the server keeps us out of (the server cannot enforce it for a stream, this is
  // the client being polite).
  private roomOpen(s: Session, session: number): boolean {
    const u = s.client?.users.get(session);
    const ch = u && s.client?.channels.get(u.channelId);
    return !ch || ch.canEnter;
  }

  // From any room of the server: click the indicator of someone who shares and the stream comes to
  // wherever we are. auto: started by the app (cameras of our own room), not by the person.
  async watch(s: Session, session: number, auto = false): Promise<void> {
    const kind = s.sharing[session];
    if (!this.supported(s) || !kind || this.watchOf(session)) return;
    if (!auto && !this.roomOpen(s, session)) {
      this.error = 'You are not allowed in that room, so you cannot watch from it.';
      return;
    }
    if (!(await this.notice())) return;
    // Streams from another server make way; screens and cameras of this one add up
    for (const w of this.watches) if (w.host !== s) this.unwatch(w.session);
    if (kind === 'camera' && this.watches.filter(w => w.kind === 'camera').length >= MAX_CAMERAS) return;
    if (kind === 'screen' && this.watches.filter(w => w.kind === 'screen').length >= MAX_SCREENS) {
      this.error = `You can watch up to ${MAX_SCREENS} screens at once. Stop watching one first.`;
      return;
    }
    if (!s.sharing[session] || this.watchOf(session)) return;
    // Asking for it shows it again
    delete this.hidden[this.who(s, session)];
    this.watches = [...this.watches, { host: s, session, kind, stream: null, state: 'connecting', ...(auto ? { auto: true } : {}) }];
    if (kind === 'screen' && this.stream && this.kind === 'screen' && this.host === s) this.asideRequest++;
    this.send(s, [session], SHARE.watch);
    this.watchTimers.set(session, setTimeout(() => this.setWatchState(session, 'failed'), 20000));
  }

  // One stream, or all of them
  unwatch(session?: number): void {
    for (const w of this.watches) {
      if (session != null && w.session !== session) continue;
      if (w.host.client) this.send(w.host, [w.session], SHARE.leave);
      this.endWatch(w.session);
    }
  }

  // Ask the sharer to send us at most this much (for us alone: it also lowers what he uploads)
  setQuality(s: Session, session: number, cap: ViewerCap): void {
    if (!this.watchOf(session)) return;
    this.quality = { ...this.quality, [session]: cap };
    this.send(s, [session], SHARE.quality, JSON.stringify(cap));
  }
  qualityOf(session: number): ViewerCap {
    return this.quality[session] ?? NO_CAP;
  }

  private endWatch(session: number): void {
    if (session in this.quality) { const { [session]: _gone, ...rest } = this.quality; this.quality = rest; }
    clearTimeout(this.watchTimers.get(session));
    this.watchTimers.delete(session);
    this.watchPcs.get(session)?.close();
    this.watchPcs.delete(session);
    this.watches = this.watches.filter(w => w.session !== session);
  }

  private setWatchState(session: number, state: Watching['state'], stream?: MediaStream): void {
    if (!this.watchOf(session)) return;
    if (state !== 'connecting') { clearTimeout(this.watchTimers.get(session)); this.watchTimers.delete(session); }
    this.watches = this.watches.map(w => w.session === session ? { ...w, state, stream: stream ?? w.stream } : w);
  }

  // All cameras on or off, remembered
  async setCams(s: Session, on: boolean): Promise<void> {
    if (on && (!this.supported(s) || !(await this.notice()))) return;
    store.settings.autoCameras = on;
    store.saveSettings();
    if (!on) {
      for (const w of this.watches) if (w.kind === 'camera') this.unwatch(w.session);
      return;
    }
    for (const session of Object.keys(s.sharing)) if (Number(session) !== s.client?.session) this.autoWatch(s, Number(session));
  }

  private gathered(pc: RTCPeerConnection): Promise<void> {
    return gathered(pc);
  }

  private async offerTo(s: Session, viewer: number): Promise<void> {
    const stream = this.stream;
    if (!stream || this.host !== s) return;
    const config = await this.rtcConfig();
    if (this.stream !== stream || this.host !== s) return;
    this.dropPeer(viewer);
    if (this.peers.size >= MAX_VIEWERS) return;
    const pc = new RTCPeerConnection(config);
    this.peers.set(viewer, pc);
    this.setViewers();
    pc.addEventListener('connectionstatechange', () => {
      if (this.peers.get(viewer) !== pc) return;
      if (pc.connectionState === 'connected' && !this.live.has(viewer)) {
        this.live.add(viewer);
        sounds.play('viewerJoined');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.dropPeer(viewer);
    });
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      if (track.kind !== 'video') continue;
      const params = sender.getParameters();
      const c = this.cfg;
      // Prefer FPS gives up sharpness when the connection is tight; prefer quality gives up frames
      params.degradationPreference = c.mode === 'fps' ? 'maintain-framerate' : 'maintain-resolution';
      // The picture is never enlarged: a source smaller than the chosen height is sent as it is
      const sourceHeight = track.getSettings().height ?? c.height;
      const cap = this.caps.get(viewer);
      const scale = capScale(sourceHeight, c.height, cap);
      for (const enc of params.encodings ?? []) {
        enc.priority = 'high';
        enc.networkPriority = 'high';
        enc.maxBitrate = c.bitrate * 1_000_000;
        enc.maxFramerate = capFps(this.idle ? IDLE_FPS : c.fps, cap);
        enc.scaleResolutionDownBy = scale;
      }
      await sender.setParameters(params).catch(() => {});
      const hw = await this.hardwareCodec();
      const transceiver = pc.getTransceivers().find(t => t.sender === sender);
      const offered = RTCRtpSender.getCapabilities('video');
      if (hw && transceiver && offered) {
        try { transceiver.setCodecPreferences([...offered.codecs.filter(x => x.mimeType === hw), ...offered.codecs.filter(x => x.mimeType !== hw)]); } catch { /* keep the default order */ }
      }
    }
    await pc.setLocalDescription({ type: 'offer', sdp: tuneVideo(stereo((await pc.createOffer()).sdp ?? ''), ratesFor(this.cfg.bitrate)) });
    await this.gathered(pc);
    if (this.peers.get(viewer) === pc && pc.localDescription) await this.send(s, [viewer], SHARE.offer, pc.localDescription.sdp);
  }

  private async answerTo(s: Session, sharer: number, sdp: string): Promise<void> {
    const mine = () => { const w = this.watchOf(sharer); return !!w && w.host === s; };
    if (!mine()) return;
    const config = await this.rtcConfig();
    if (!mine()) return;
    this.watchPcs.get(sharer)?.close();
    const pc = new RTCPeerConnection(config);
    this.watchPcs.set(sharer, pc);
    const current = () => this.watchPcs.get(sharer) === pc;
    // The track is announced with the description, before any route exists: the stream only
    // counts as live once the connection is up, otherwise the viewer stares at a black picture
    pc.addEventListener('track', e => {
      if (current()) this.setWatchState(sharer, pc.connectionState === 'connected' ? 'live' : 'connecting', e.streams[0]);
    });
    pc.addEventListener('connectionstatechange', () => {
      if (!current()) return;
      if (pc.connectionState === 'connected') this.setWatchState(sharer, 'live');
      else if (pc.connectionState === 'failed') this.setWatchState(sharer, 'failed');
    });
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      // The sender reads its start and floor from the answer: repeat what the offer asked for
      const answer = stereo((await pc.createAnswer()).sdp ?? '');
      await pc.setLocalDescription({ type: 'answer', sdp: tuneVideo(answer, ratesOf(sdp) ?? ratesFor(8)) });
      await this.gathered(pc);
      if (current() && pc.localDescription) await this.send(s, [sharer], SHARE.answer, pc.localDescription.sdp);
    } catch {
      if (current()) this.setWatchState(sharer, 'failed');
    }
  }

  // Raw WebRTC statistics for the overlay: of a stream we watch, or one per viewer of ours
  async reports(own: boolean, session?: number): Promise<{ viewer: number | null; report: RTCStatsReport }[]> {
    if (!own) {
      const pc = session != null ? this.watchPcs.get(session) : undefined;
      return pc ? [{ viewer: null, report: await pc.getStats() }] : [];
    }
    return Promise.all([...this.peers].map(async ([viewer, pc]) => ({ viewer, report: await pc.getStats() })));
  }

  // ─── Called by the session ────────────────────────────────────────────────

  async receive(s: Session, sender: number, dataId: string, data: Uint8Array): Promise<void> {
    if (dataId !== SHARE_DATA_ID) return;
    let assembler = this.assemblers.get(s);
    if (!assembler) this.assemblers.set(s, assembler = new ShareAssembler());
    const msg = await assembler.push(sender, data);
    // Anyone on the server may take part: a viewer can be in another room than the sharer. What each
    // signal may do is checked where it is used (an offer only counts from someone we asked to
    // watch, an answer only from a viewer we sent an offer to, a request only reaches a sharer).
    if (!msg || !s.client) return;
    switch (msg.type) {
      case SHARE.on:
        if (!s.sharing[sender] && this.inMyChannel(s, sender) && Date.now() - (this.enteredAt.get(s) ?? 0) > 3000) sounds.play('shareStarted');
        s.setSharing(sender, msg.text === 'camera' ? 'camera' : 'screen');
        this.autoWatch(s, sender);
        break;
      case SHARE.off:
        if (s.sharing[sender] && this.inMyChannel(s, sender)) sounds.play('shareStopped');
        s.setSharing(sender, false);
        if (this.watchOf(sender)?.host === s) this.endWatch(sender);
        break;
      case SHARE.who: if (this.host === s && this.allowed(s, sender)) this.send(s, [sender], SHARE.on, this.kind); break;
      case SHARE.watch: if (this.host === s && this.allowed(s, sender)) this.offerTo(s, sender).catch(() => this.dropPeer(sender)); break;
      case SHARE.leave: if (this.host === s) { this.caps.delete(sender); this.dropPeer(sender); } break;
      case SHARE.quality:
        if (this.host === s) { this.caps.set(sender, parseCap(msg.text)); this.reshape(sender); }
        break;
      case SHARE.viewers: {
        // Only from the sharer we watch
        const w = this.watchOf(sender);
        if (!w || w.host !== s || !msg.text) break;
        try {
          const ids = JSON.parse(msg.text);
          if (Array.isArray(ids)) this.watches = this.watches.map(x => x.session === sender ? { ...x, viewers: ids.filter((i: unknown): i is number => typeof i === 'number').slice(0, 64) } : x);
        } catch { /* not a list: ignored */ }
        break;
      }
      case SHARE.offer: if (msg.text) this.answerTo(s, sender, msg.text); break;
      case SHARE.answer:
        if (this.host === s && msg.text) this.peers.get(sender)?.setRemoteDescription({ type: 'answer', sdp: msg.text }).catch(() => this.dropPeer(sender));
        break;
    }
  }

  // We connected: ask who is sharing, and tell the server about our stream
  entered(s: Session): void {
    if (!this.supported(s)) return;
    const self = s.client!.session!;
    this.enteredAt.set(s, Date.now());
    s.clearSharing();
    for (const w of this.watches) if (w.host === s) this.unwatch(w.session);
    if (this.host === s) {
      this.dropPeers();
      s.setSharing(self, this.kind);
      this.announce(s);
    }
    this.send(s, this.everyone(s), SHARE.who);
  }

  // We moved to another room. Who shares is known server-wide and streams do not depend on rooms,
  // so what we watch and what we send carry on. Only cameras that came on by themselves belong to
  // a room: those of the old room go, those of the new one come on.
  moved(s: Session): void {
    if (!this.supported(s)) return;
    this.enteredAt.set(s, Date.now());
    for (const w of this.watches) if (w.host === s && w.auto && !this.inMyChannel(s, w.session)) this.unwatch(w.session);
    if (this.host === s) this.announce(s);
    for (const session of Object.keys(s.sharing)) if (Number(session) !== s.client?.session) this.autoWatch(s, Number(session));
  }

  // Someone else connected, moved or left
  userMoved(s: Session, user: User, gone = false): void {
    if (!s.client?.self || user.session === s.client.session) return;
    if (gone) {
      // A sharer who disconnected is gone, and so is whoever watched us from the same connection
      if (s.sharing[user.session]) sounds.play('shareStopped');
      s.setSharing(user.session, false);
      if (this.host === s) { this.caps.delete(user.session); this.dropPeer(user.session); }
      if (this.watchOf(user.session)?.host === s) this.endWatch(user.session);
      return;
    }
    if (this.inMyChannel(s, user.session)) {
      // Somebody came into our room: tell them what we share, and turn on their camera if it is on
      if (this.host === s) this.send(s, [user.session], SHARE.on, this.kind);
      this.autoWatch(s, user.session);
      return;
    }
    // They went to another room: with cross-room watching off, what we share is not for them any more
    if (this.host === s && !this.allowed(s, user.session)) {
      this.send(s, [user.session], SHARE.off);
      this.caps.delete(user.session); this.dropPeer(user.session);
    }
    // Whoever shares there goes on sharing, and whoever watches us goes
    // on watching, except a camera that only came on because we were together.
    const w = this.watchOf(user.session);
    if (w?.host === s && w.auto) this.unwatch(user.session);
  }

  closed(s: Session): void {
    if (this.host === s) this.release();
    if (this.dialog === s) this.dialog = null;
    for (const w of this.watches) if (w.host === s) this.endWatch(w.session);
  }
}

export const share = new ScreenShare();
