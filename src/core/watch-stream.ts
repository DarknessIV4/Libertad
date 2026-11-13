// Watch Together "stream from host" (mode 2) via WebRTC media tracks, like screen sharing.
// The host plays the file and sends what the player shows, live; viewers start playing within
// a second instead of waiting for the whole file. Only the setup messages travel through Mumble.
import { WATCH, WATCH_DATA_ID, encodeWatchSignal, WatchAssembler, type WatchType } from './watch-together.ts';
import type { Session } from '../lib/session.svelte.ts';
import { rtcConfig, gathered } from '../lib/ice.ts';
import { shareSettings } from '../lib/share.svelte.ts';
import { parseCap, capFps, capScale, type ViewerCap } from '../lib/stream-quality.ts';
import { store } from '../lib/settings.svelte.ts';
import { watchFileStreamState } from '../lib/watch-file-stream.svelte.ts';

// Opus is negotiated as mono speech by default; a film's sound is stereo
const stereo = (sdp: string) => sdp.replace(/a=fmtp:(\d+) ([^\r\n]*useinbandfec=1[^\r\n]*)/g,
  (line, pt, rest) => rest.includes('stereo=1') ? line : `a=fmtp:${pt} ${rest};stereo=1;sprop-stereo=1;maxaveragebitrate=192000`);

const MAX_VIEWERS = 8;

interface FileWatcher {
  host: Session;
  session: number;        // host's session id
  state: 'connecting' | 'live' | 'failed';
  expectedSize: number;
  mimeType: string;
  stream: MediaStream | null;  // live picture and sound from the host; plays as soon as it arrives
  pc: RTCPeerConnection | null;
  gatherTimer?: ReturnType<typeof setTimeout>;  // ICE gathering timeout
  iceCheckTimer?: ReturnType<typeof setTimeout>;  // ICE check timer
}

interface FileStreamer {
  host: Session;
  file: File;
  getVideo: () => HTMLVideoElement | null;  // the host's own player; what it shows is what is sent
  stream: MediaStream | null;
  peers: Map<number, { pc: RTCPeerConnection; senders: RTCRtpSender[] }>;
  caps: Map<number, ViewerCap>;  // what each viewer asked to receive at most
}

export type { FileWatcher, FileStreamer };

class WatchFileStream {
  private streamers = new Map<Session, FileStreamer>();
  private assemblers = new Map<Session, WatchAssembler>();
  private enteredAt = new Map<Session, number>();

  // RTC config for the stream: the same servers as screen sharing and file sharing
  private rtcConfig(): Promise<RTCConfiguration> {
    return rtcConfig();
  }

  private watchersOf(s: Session): FileWatcher[] {
    return watchFileStreamState.watchersOf(s);
  }

  private setWatchers(s: Session, ws: FileWatcher[]): void {
    watchFileStreamState.setWatchers(s, ws);
  }

  private streamerOf(s: Session): FileStreamer | undefined {
    return watchFileStreamState.streamerOf(s);
  }

  private watchOf(s: Session, session: number): FileWatcher | undefined {
    return this.watchersOf(s).find(w => w.session === session);
  }

  private inMyChannel(s: Session, session: number): boolean {
    if (!s.client?.self) return false;
    if (session === s.client.session) return true;
    const u = s.client.users.get(session);
    return !!u && u.channelId === s.client.self.channelId;
  }

  // The stream goes between a host and the members of its party, who may sit in other rooms. Each
  // signal is only heard from the side it belongs to; people of our own room are heard as before.
  private accepts(s: Session, sender: number, type: number): boolean {
    if (this.inMyChannel(s, sender)) return true;
    const streamer = this.streamerOf(s);
    switch (type) {
      case WATCH.fileRequest: return !!streamer && store.settings.shareCrossRoom !== false;                                  // a viewer asks the host for the picture
      case WATCH.leave:
      case WATCH.quality: return !!streamer?.peers.has(sender);                   // a viewer we are sending to
      case WATCH.fileChunk:
      case WATCH.end: return !!this.watchOf(s, sender);                           // the host we are watching
      default: return false;
    }
  }

  private others(s: Session): number[] {
    const users = Array.from(s.client!.users.values());
    return users
      .filter(u => u.session !== s.client!.session && u.channelId === s.client!.self?.channelId)
      .map(u => u.session);
  }

  // Send signal through Mumble plugin data
  private async send(s: Session, targets: number[], type: WatchType, body: unknown): Promise<void> {
    const packets = await encodeWatchSignal(type, body);
    const client = s.client;
    if (!client) return;
    for (const target of targets) {
      for (const p of packets) {
        client.sendPluginData([target], WATCH_DATA_ID, p, { priority: true });
      }
    }
  }

  // ─── Host side: play the file locally and send what the player shows ──────

  async startStream(s: Session, file: File, getVideo: () => HTMLVideoElement | null): Promise<void> {
    const streamer: FileStreamer = { host: s, file, getVideo, stream: null, peers: new Map(), caps: new Map() };
    watchFileStreamState.setStreamer(s, streamer);
    // Note: WATCH.start is sent by watchTogether.start() to avoid duplicate signals
  }

  async stopStream(s: Session): Promise<void> {
    const streamer = watchFileStreamState.streamerOf(s);
    if (!streamer) return;
    // Those who watch from other rooms are told too
    const viewers = [...streamer.peers.keys()];
    for (const [, peer] of streamer.peers) peer.pc.close();
    streamer.peers.clear();
    streamer.stream?.getTracks().forEach(t => t.stop());
    await this.send(s, [...new Set([...this.others(s), ...viewers])], WATCH.end, {});
    watchFileStreamState.setStreamer(s, undefined);
  }

  // The Share dialog's bitrate, quality, FPS and mode choices, applied to the video we send
  // (lowered for a viewer who asked for less)
  private async applyQuality(sender: RTCRtpSender, cap?: ViewerCap): Promise<void> {
    const track = sender.track;
    if (track?.kind !== 'video') return;
    const c = shareSettings();
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.degradationPreference = c.mode === 'fps' ? 'maintain-framerate' : 'maintain-resolution';
    // The picture is never enlarged: a source smaller than the chosen height is sent as it is
    const scale = capScale(track.getSettings().height ?? c.height, c.height, cap);
    for (const enc of params.encodings) {
      enc.maxBitrate = c.bitrate * 1_000_000;
      enc.maxFramerate = capFps(c.fps, cap);
      enc.scaleResolutionDownBy = scale;
    }
    await sender.setParameters(params).catch(() => {});
  }

  // The player's picture and sound as a MediaStream. Waits until the player has something to show.
  private async hostStream(streamer: FileStreamer): Promise<MediaStream | null> {
    const alive = (st: MediaStream | null) => !!st && st.getVideoTracks().some(t => t.readyState === 'live');
    if (alive(streamer.stream)) return streamer.stream;
    for (let i = 0; i < 100; i++) { // up to 10 s
      const video = streamer.getVideo();
      if (video && video.readyState >= 2) {
        const capture = (video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream });
        const st = capture.captureStream?.() ?? capture.mozCaptureStream?.() ?? null;
        if (alive(st)) {
          st!.getVideoTracks().forEach(t => { t.contentHint = 'motion'; });
          streamer.stream = st;
          return st;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }

  // Handle incoming offer from viewer
  private async handleFileOffer(s: Session, sender: number, sdp: string): Promise<void> {
    const streamer = this.streamerOf(s);
    if (!streamer) return;
    if (streamer.peers.size >= MAX_VIEWERS && !streamer.peers.has(sender)) return;
    this.dropPeer(s, sender);

    const config = await this.rtcConfig();
    const pc = new RTCPeerConnection(config);
    const peer = { pc, senders: [] as RTCRtpSender[] };
    streamer.peers.set(sender, peer);

    pc.addEventListener('connectionstatechange', () => {
      if (streamer.peers.get(sender)?.pc !== pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.dropPeer(s, sender);
    });

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const stream = await this.hostStream(streamer);
      if (streamer.peers.get(sender)?.pc !== pc) return;
      if (!stream) throw new Error('The player has nothing to send yet');
      for (const track of stream.getTracks()) {
        const rtpSender = pc.addTrack(track, stream);
        peer.senders.push(rtpSender);
        await this.applyQuality(rtpSender, streamer.caps.get(sender));
      }
      await pc.setLocalDescription({ type: 'answer', sdp: stereo((await pc.createAnswer()).sdp ?? '') });
      await this.gathered(pc);
      if (streamer.peers.get(sender)?.pc === pc && pc.localDescription) {
        await this.send(s, [sender], WATCH.fileChunk, pc.localDescription.sdp); // reuse fileChunk for the answer
      }
    } catch (e) {
      console.error('[WatchStream] Error in handleFileOffer:', e);
      this.dropPeer(s, sender);
    }
  }

  // Handle answer from host (viewer side)
  private async handleFileAnswer(s: Session, sender: number, sdp: string): Promise<void> {
    const watcher = this.watchOf(s, sender);
    if (!watcher || watcher.host !== s || !watcher.pc) return;
    try {
      await watcher.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (e) {
      console.error('[WatchStream] Error in handleFileAnswer:', e);
      this.setWatchState(s, sender, 'failed');
    }
  }

  // A viewer the host sent out of the session (cross-room watching was turned off)
  dropViewer(s: Session, viewer: number): void {
    this.streamerOf(s)?.caps.delete(viewer);
    this.dropPeer(s, viewer);
  }

  private dropPeer(s: Session, viewer: number): void {
    const streamer = this.streamerOf(s);
    if (!streamer) return;
    const peer = streamer.peers.get(viewer);
    if (peer) {
      peer.pc.close();
      streamer.peers.delete(viewer);
    }
  }

  private dropPeers(s: Session): void {
    const streamer = this.streamerOf(s);
    if (!streamer) return;
    for (const [, peer] of streamer.peers) peer.pc.close();
    streamer.peers.clear();
  }

  // ─── Viewer side: watch a file stream ──────────────────────────────────

  async startWatching(s: Session, hostSession: number, fileMeta: { size: number; mimeType: string }): Promise<void> {
    // A repeated announcement must not leave an old connection behind
    this.watchOf(s, hostSession)?.pc?.close();
    const watcher: FileWatcher = {
      host: s,
      session: hostSession,
      state: 'connecting',
      expectedSize: fileMeta.size,
      mimeType: fileMeta.mimeType,
      stream: null,
      pc: null,
    };
    this.setWatchers(s, [...this.watchersOf(s).filter(w => w.session !== hostSession), watcher]);

    const config = await this.rtcConfig();
    const pc = new RTCPeerConnection(config);
    watcher.pc = pc;
    // We only receive: picture and sound come from the host's player
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const current = () => this.watchOf(s, hostSession)?.pc === pc;
    const incoming = new MediaStream();
    pc.addEventListener('track', e => {
      if (!current()) return;
      incoming.addTrack(e.track);
      const ws = this.watchersOf(s);
      const i = ws.findIndex(w => w.session === hostSession);
      if (i !== -1) {
        ws[i] = { ...ws[i], stream: incoming };
        this.setWatchers(s, [...ws]);
      }
    });
    pc.addEventListener('connectionstatechange', () => {
      if (!current()) return;
      if (pc.connectionState === 'connected') this.setWatchState(s, hostSession, 'live');
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.setWatchState(s, hostSession, 'failed');
    });

    try {
      await pc.setLocalDescription({ type: 'offer', sdp: (await pc.createOffer()).sdp ?? '' });
      await this.gathered(pc);
      if (current() && pc.localDescription) {
        await this.send(s, [hostSession], WATCH.fileRequest, pc.localDescription.sdp); // reuse fileRequest for the offer
      }
    } catch (e) {
      console.error('[WatchStream] Error in startWatching:', e);
      this.setWatchState(s, hostSession, 'failed');
    }
  }

  private setWatchState(s: Session, session: number, state: FileWatcher['state']): void {
    const ws = this.watchersOf(s);
    const i = ws.findIndex(w => w.session === session);
    if (i === -1) return;
    ws[i] = { ...ws[i], state };
    this.setWatchers(s, [...ws]);
  }

  private endWatch(s: Session, session: number): void {
    watchFileStreamState.setQuality(session, null);
    const ws = this.watchersOf(s);
    const watcher = ws.find(w => w.session === session);
    if (watcher) {
      if (watcher.gatherTimer) clearTimeout(watcher.gatherTimer);
      if (watcher.iceCheckTimer) clearTimeout(watcher.iceCheckTimer);
      watcher.pc?.close();
    }
    const filtered = ws.filter(w => w.session !== session);
    this.setWatchers(s, filtered);
  }

  // Ask the host to send us at most this much (for us alone: it also lowers what he uploads)
  setQuality(s: Session, hostSession: number, cap: ViewerCap): void {
    if (!this.watchOf(s, hostSession)) return;
    watchFileStreamState.setQuality(hostSession, cap);
    void this.send(s, [hostSession], WATCH.quality, cap);
  }

  async stopWatching(s: Session, hostSession: number): Promise<void> {
    const watcher = this.watchOf(s, hostSession);
    if (!watcher) return;
    await this.send(s, [hostSession], WATCH.leave, {});
    watcher.pc?.close();
    this.endWatch(s, hostSession);
  }

  // ─── Signal handling ────────────────────────────────────────────────────

  private gathered(pc: RTCPeerConnection): Promise<void> {
    return gathered(pc);
  }

  async receive(s: Session, sender: number, dataId: string, data: Uint8Array): Promise<void> {
    if (dataId !== WATCH_DATA_ID) return;
    let assembler = this.assemblers.get(s);
    if (!assembler) this.assemblers.set(s, assembler = new WatchAssembler());
    const msg = await assembler.push(sender, data);
    if (!msg || !s.client || !this.accepts(s, sender, msg.type)) return;

    console.log('[WatchStream] receive - type:', msg.type, 'from:', sender, 'hasText:', !!msg.text);
    // Check if this is a file streaming signal (using fileRequest/fileChunk for WebRTC setup)
    switch (msg.type) {
      case WATCH.fileRequest: // Viewer sends offer (via fileRequest)
        if (msg.text) await this.handleFileOffer(s, sender, msg.text);
        break;
      case WATCH.fileChunk: // Host sends answer (via fileChunk)
        if (msg.text) await this.handleFileAnswer(s, sender, msg.text);
        break;
      case WATCH.leave:
        // A viewer stopped watching our stream. When the host sends it, it only means they left
        // the party: their player goes on and the stream with it, so ours stays.
        console.log('[WatchStream] Received leave from:', sender);
        this.streamerOf(s)?.caps.delete(sender);
        this.dropPeer(s, sender);
        break;
      case WATCH.quality: {
        // A viewer wants to receive less: only his stream is shaped
        const streamer = this.streamerOf(s);
        const peer = streamer?.peers.get(sender);
        if (!streamer) break;
        const cap = parseCap(msg.text);
        streamer.caps.set(sender, cap);
        for (const rtpSender of peer?.senders ?? []) await this.applyQuality(rtpSender, cap);
        break;
      }
      case WATCH.end:
        // Host ended the party - stop watching
        this.endWatch(s, sender);
        break;
    }
  }

  // ─── Accessors for UI ──────────────────────────────────────────────────

  getWatcher(s: Session, hostSession: number): FileWatcher | undefined {
    return this.watchOf(s, hostSession);
  }

  getStreamer(s: Session): FileStreamer | undefined {
    return this.streamerOf(s);
  }

  // moved: we changed rooms while connected. A stream we send does not depend on rooms, so it carries on.
  entered(s: Session, moved = false): void {
    if (!s.client) return;
    const self = s.client.session!;
    this.enteredAt.set(s, Date.now());
    if (this.streamerOf(s) && !moved) {
      this.dropPeers(s);
      this.send(s, this.others(s), WATCH.start, { mode: 2 }); // re-announce
    }
    // Ask who is streaming
    this.send(s, this.others(s), WATCH.who, {});
  }

  userMoved(s: Session, user: { session: number }, gone = false): void {
    if (!s.client?.self || user.session === s.client.session) return;
    // Viewers and the host are not tied to a room (a viewer can watch from another one), so only
    // someone who disconnected ends a stream. A host who moved takes the party, and the stream, along.
    if (!gone) return;
    // Viewer left
    if (this.streamerOf(s)?.peers.has(user.session)) { this.streamerOf(s)?.caps.delete(user.session); this.dropPeer(s, user.session); }
    // Host left
    if (this.watchOf(s, user.session)?.host === s) this.endWatch(s, user.session);
  }

  closed(s: Session): void {
    if (this.streamerOf(s)) this.stopStream(s);
    for (const w of this.watchersOf(s)) if (w.host === s) this.endWatch(s, w.session);
  }
}

export const watchFileStream = new WatchFileStream();