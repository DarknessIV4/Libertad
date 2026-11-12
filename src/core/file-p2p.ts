// Direct connections between Libertad clients that carry file pieces (see core/file-transfer.ts).
// The one who wants pieces offers, the one who has them answers; both messages travel as
// plugin data through Mumble, which also tells us who is really on the other end. Each pair
// may end up with two connections (one offered by each side); either one is used for sending.
import { gathered } from '../lib/ice.ts';
import { FRAME_BYTES, FRAME_PIECE, FRAME_DONE, FRAME_PROFILE, FRAME_CONTROL, encodeFrame, decodeFrame, type RateLimiter } from './file-transfer.ts';

// Data channel buffer: sending pauses above HIGH and goes on below LOW
const HIGH = 4 * 1024 * 1024;
const LOW = 1024 * 1024;
const CONNECT_MS = 20000;
const MAX_CONNS = 32;
const MAX_SDP = 20000;
// After a failed attempt the peer is served through the server for a while
const RETRY_MS = 120000;

export interface P2PHost {
  config(): Promise<RTCConfiguration>;
  signal(to: number, type: 'offer' | 'answer', file: string, sdp: string): void;
  // The size of the piece we are waiting for from this person, or null when we asked for none
  expect(from: number, file: string, piece: number): number | null;
  piece(from: number, file: string, piece: number, bytes: Uint8Array): void;
  done(from: number, file: string): void;
  known(session: number): boolean;
  // The person's profile arrived on the direct channel / a file-transfer message did / a channel to them opened
  profile(from: number, text: string): void;
  control(from: number, packet: Uint8Array): void;
  opened(peer: number): void;
}

interface Conn {
  peer: number;
  role: 'out' | 'in';
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  open: boolean;
  born: number;
  last: number;
  partial: Map<string, { bytes: Uint8Array; got: number }>;
}

const MAX_PROFILE = 4000;


export class FileP2P {
  private peers = new Map<number, { out?: Conn; in?: Conn }>();
  private failedUntil = new Map<number, number>();
  private waiters = new Map<number, Set<() => void>>();
  private sweep: ReturnType<typeof setInterval>;
  private closed = false;
  private host: P2PHost;

  constructor(host: P2PHost) {
    this.host = host;
    this.sweep = setInterval(() => this.idle(), 15000);
  }

  private pick(peer: number): Conn | null {
    const e = this.peers.get(peer);
    if (e?.out?.open) return e.out;
    if (e?.in?.open) return e.in;
    return null;
  }

  isOpen(peer: number): boolean {
    return !!this.pick(peer);
  }

  // A connection to this person is open or being made
  trying(peer: number): boolean {
    const e = this.peers.get(peer);
    return !!(e?.out || e?.in);
  }

  // true once a connection is open; false when none comes within the time or recently failed
  async waitOpen(peer: number, ms: number): Promise<boolean> {
    if (this.isOpen(peer)) return true;
    if ((this.failedUntil.get(peer) ?? 0) > Date.now()) return false;
    const ok = await new Promise<boolean>(resolve => {
      let set = this.waiters.get(peer);
      if (!set) this.waiters.set(peer, set = new Set());
      const wake = () => { clearTimeout(timer); set!.delete(wake); resolve(this.isOpen(peer)); };
      const timer = setTimeout(wake, ms);
      set.add(wake);
    });
    if (!ok && !this.trying(peer)) this.failedUntil.set(peer, Date.now() + RETRY_MS);
    return ok;
  }

  private wake(peer: number): void {
    for (const w of [...this.waiters.get(peer) ?? []]) w();
  }

  private gathered(pc: RTCPeerConnection): Promise<void> {
    return gathered(pc);
  }

  private make(peer: number, role: 'out' | 'in', config: RTCConfiguration): Conn {
    const pc = new RTCPeerConnection(config);
    const dc = pc.createDataChannel('file', { negotiated: true, id: 0, ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW;
    const c: Conn = { peer, role, pc, dc, open: false, born: Date.now(), last: Date.now(), partial: new Map() };
    const e = this.peers.get(peer) ?? {};
    this.peers.set(peer, e);
    const old = e[role];
    e[role] = c;
    if (old) this.shut(old, false);
    dc.addEventListener('open', () => {
      c.open = true;
      c.last = Date.now();
      this.failedUntil.delete(peer);
      this.wake(peer);
      this.host.opened(peer);
      void this.report(c);
    });
    dc.addEventListener('close', () => this.shut(c));
    dc.addEventListener('message', ev => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      c.last = Date.now();
      this.frame(c, new Uint8Array(ev.data));
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.shut(c);
    });
    // An attempt that goes nowhere is dropped, and the person is served through the server for a while
    setTimeout(() => {
      if (!c.open && this.peers.get(peer)?.[role] === c) {
        this.shut(c);
        if (!this.pick(peer)) this.failedUntil.set(peer, Date.now() + RETRY_MS);
        this.wake(peer);
      }
    }, CONNECT_MS);
    return c;
  }

  // Says in the console which road the connection really takes: a relayed one is as fast as the
  // relay server, and that is the usual reason for a direct transfer being slow
  private async report(c: Conn): Promise<void> {
    try {
      const stats = await c.pc.getStats();
      let pair: any;
      stats.forEach((s: any) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
      if (!pair) stats.forEach((s: any) => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s; });
      const local = pair && stats.get(pair.localCandidateId) as any;
      const remote = pair && stats.get(pair.remoteCandidateId) as any;
      if (!local) return;
      const via = `${local.candidateType}${local.relayProtocol ? `/${local.relayProtocol}` : `/${local.protocol}`} to ${remote?.candidateType ?? '?'}`;
      console.info(`[FileP2P] direct connection to ${c.peer} (${c.role}) via ${via}`);
      if (local.candidateType === 'relay' || remote?.candidateType === 'relay') console.warn('[FileP2P] this connection is relayed, so it is only as fast as the relay server');
    } catch { /* stats unavailable */ }
  }

  private shut(c: Conn, forget = true): void {
    c.open = false;
    try { c.pc.close(); } catch { /* already closed */ }
    const e = this.peers.get(c.peer);
    if (forget && e && e[c.role] === c) {
      delete e[c.role];
      if (!e.out && !e.in) this.peers.delete(c.peer);
    }
    this.wake(c.peer);
  }

  // We want pieces from this person: offer a connection
  async connect(peer: number, file: string): Promise<void> {
    if (this.closed || !this.host.known(peer) || this.isOpen(peer) || this.peers.get(peer)?.out) return;
    if ((this.failedUntil.get(peer) ?? 0) > Date.now() || this.count() >= MAX_CONNS) return;
    let c: Conn | undefined;
    try {
      c = this.make(peer, 'out', await this.host.config());
      const cc = c;
      await cc.pc.setLocalDescription(await cc.pc.createOffer());
      await this.gathered(cc.pc);
      if (this.peers.get(peer)?.out === cc && cc.pc.localDescription) this.host.signal(peer, 'offer', file, cc.pc.localDescription.sdp);
    } catch {
      if (c) this.shut(c);
    }
  }

  async onOffer(peer: number, file: string, sdp: string): Promise<void> {
    if (this.closed || !this.host.known(peer) || sdp.length > MAX_SDP) return;
    if (!this.peers.get(peer)?.in && this.count() >= MAX_CONNS) return;
    let c: Conn | undefined;
    try {
      c = this.make(peer, 'in', await this.host.config());
      const cc = c;
      await cc.pc.setRemoteDescription({ type: 'offer', sdp });
      await cc.pc.setLocalDescription(await cc.pc.createAnswer());
      await this.gathered(cc.pc);
      if (this.peers.get(peer)?.in === cc && cc.pc.localDescription) this.host.signal(peer, 'answer', file, cc.pc.localDescription.sdp);
    } catch {
      if (c) this.shut(c);
    }
  }

  async onAnswer(peer: number, sdp: string): Promise<void> {
    const c = this.peers.get(peer)?.out;
    if (!c || sdp.length > MAX_SDP || c.pc.signalingState !== 'have-local-offer') return;
    try {
      await c.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch {
      this.shut(c);
    }
  }

  private count(): number {
    let n = 0;
    for (const e of this.peers.values()) n += (e.out ? 1 : 0) + (e.in ? 1 : 0);
    return n;
  }

  // ─── Receiving ───────────────────────────────────────────────────────────

  private frame(c: Conn, data: Uint8Array): void {
    if (data.length > FRAME_BYTES + 400) return;
    if (data[0] === FRAME_PROFILE) return this.host.profile(c.peer, new TextDecoder().decode(data.subarray(1, 1 + MAX_PROFILE)));
    if (data[0] === FRAME_CONTROL) return this.host.control(c.peer, data.slice(1));
    const f = decodeFrame(data);
    if (!f) return;
    if (f.kind === FRAME_DONE) return this.host.done(c.peer, f.file);
    const key = `${f.file}:${f.piece}`;
    let part = c.partial.get(key);
    if (!part) {
      if (f.offset !== 0) return;
      const size = this.host.expect(c.peer, f.file, f.piece);
      if (size == null || size < 1) return;
      // The sender goes piece by piece; more open ones than this means something is wrong
      if (c.partial.size >= 4) c.partial.clear();
      c.partial.set(key, part = { bytes: new Uint8Array(size), got: 0 });
    }
    // Frames arrive in order on this channel; anything else is not from a sender that follows the rules
    if (f.offset !== part.got || part.got + f.bytes.length > part.bytes.length || !f.bytes.length) {
      c.partial.delete(key);
      return;
    }
    part.bytes.set(f.bytes, part.got);
    part.got += f.bytes.length;
    if (part.got === part.bytes.length) {
      c.partial.delete(key);
      this.host.piece(c.peer, f.file, f.piece, part.bytes);
    }
  }

  // ─── Sending ─────────────────────────────────────────────────────────────

  // Pauses while the channel has plenty queued, so memory stays small and the limit is felt at once
  private async room(c: Conn): Promise<boolean> {
    while (c.dc.readyState === 'open' && c.dc.bufferedAmount > HIGH) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); c.dc.removeEventListener('bufferedamountlow', done); resolve(); };
        const timer = setTimeout(done, 500);
        c.dc.addEventListener('bufferedamountlow', done);
      });
    }
    return c.dc.readyState === 'open';
  }

  // Sends a piece in frames, each first paid for to the limiter; false when it could not be sent
  async send(peer: number, file: string, piece: number, bytes: Uint8Array, limiter: RateLimiter, alive: () => boolean): Promise<boolean> {
    const c = this.pick(peer);
    if (!c) return false;
    try {
      for (let at = 0; at < bytes.length; at += FRAME_BYTES) {
        const part = bytes.subarray(at, at + FRAME_BYTES);
        await limiter.take(part.length, alive);
        if (!alive() || !await this.room(c)) return false;
        c.dc.send(encodeFrame(FRAME_PIECE, file, piece, at, part) as Uint8Array<ArrayBuffer>);
      }
      c.last = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  // Text and messages that go straight to the person, not through the server; false when no channel is open
  sendProfile(peer: number, text: string): boolean {
    return this.sendRaw(peer, FRAME_PROFILE, new TextEncoder().encode(text.slice(0, MAX_PROFILE)));
  }
  sendControl(peer: number, packet: Uint8Array): boolean {
    return this.sendRaw(peer, FRAME_CONTROL, packet);
  }
  private sendRaw(peer: number, kind: number, bytes: Uint8Array): boolean {
    const c = this.pick(peer);
    if (!c) return false;
    try {
      const out = new Uint8Array(1 + bytes.length);
      out[0] = kind;
      out.set(bytes, 1);
      c.dc.send(out as Uint8Array<ArrayBuffer>);
      return true;
    } catch {
      return false;
    }
  }
  openPeers(): number[] {
    return [...this.peers.keys()].filter(p => this.isOpen(p));
  }

  // Comes after the pieces on the same channel, so it cannot overtake them
  sendDone(peer: number, file: string): boolean {
    const c = this.pick(peer);
    if (!c) return false;
    try {
      c.dc.send(encodeFrame(FRAME_DONE, file) as Uint8Array<ArrayBuffer>);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Upkeep ──────────────────────────────────────────────────────────────

  private idle(): void {
    const now = Date.now();
    for (const e of [...this.peers.values()]) {
      for (const c of [e.out, e.in]) {
        // An open channel stays until the person leaves: it carries their profile as it changes
        if (c && !c.open && now - c.born > CONNECT_MS * 2) this.shut(c);
      }
    }
  }

  drop(peer: number): void {
    const e = this.peers.get(peer);
    if (e) for (const c of [e.out, e.in]) if (c) this.shut(c);
    this.failedUntil.delete(peer);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.sweep);
    for (const peer of [...this.peers.keys()]) this.drop(peer);
  }
}

