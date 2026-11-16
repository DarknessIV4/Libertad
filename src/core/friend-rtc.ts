// Friend requests the Mumble server cannot read.
//
// A request used to be a private Mumble message carrying the sender's friend code, so the server and whoever
// runs it saw the code, who sent it to whom, and the answer. Now the two clients open a direct WebRTC data
// channel and the request travels on that channel, which is encrypted end to end (DTLS):
//
//   1. The sender offers and the receiver answers. These two session descriptions are the only thing that
//      passes through the server, as plugin data like the other Libertad signals. They hold network
//      addresses and a DTLS fingerprint, and no friend code, nonce or text of any kind.
//   2. Once the channel is open the sender writes the request on it, the receiver says "got it", and both
//      sides close the channel. Nothing is kept open.
//
// What the server can still see: that these two people set up a connection at this moment. What it cannot see:
// that it was a friend request, the codes, or the secret. It does not fall back to a message through the
// server when no channel opens: a request that cannot go privately does not go at all.
//
// Limit: the connection is only as authentic as the descriptions the server relays. A server that rewrites them
// while they pass could sit in the middle. That takes an active attack at that very moment, but nothing here
// would show it; comparing friend codes some other way after becoming friends does.
import { SignalAssembler, encodeSignal } from './share-signal.ts';
import { cleanNonce } from './p2p-wire.ts';

export const FRIEND_DATA_ID = 'libertad.friend';

export const FRIEND_SIG = {
  offer: 1,   // session description from the one sending the request
  answer: 2   // session description from the one receiving it
} as const;
export type FriendSig = typeof FRIEND_SIG[keyof typeof FRIEND_SIG];

export class FriendAssembler extends SignalAssembler<FriendSig> {
  constructor() {
    super(Object.values(FRIEND_SIG));
  }
}

export const encodeFriendSignal = (type: 'offer' | 'answer', sdp: string): Promise<Uint8Array[]> =>
  encodeSignal(type === 'offer' ? FRIEND_SIG.offer : FRIEND_SIG.answer, sdp);

// ─── What goes through the channel ───────────────────────────────────────────

// req: "please add me" (key: my friend code, nonce: the secret of this request).
// ok: "I accepted" (key: my friend code). See core/p2p-wire.ts for what each side does with them.
export interface FriendMessage { kind: 'req' | 'ok'; key: string; nonce: string }

const KEY = /^[0-9a-f]{64}$/;
const ACK = 'ack';
export const MAX_MESSAGE = 512;

export const encodeFriendMessage = (m: FriendMessage): string =>
  JSON.stringify({ v: 1, k: m.kind, key: m.key, ...(m.nonce && { n: m.nonce }) });

export function parseFriendMessage(text: unknown): FriendMessage | null {
  if (typeof text !== 'string' || text.length > MAX_MESSAGE) return null;
  try {
    const v = JSON.parse(text) as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || Array.isArray(v) || v.v !== 1) return null;
    if (v.k !== 'req' && v.k !== 'ok') return null;
    if (typeof v.key !== 'string' || !KEY.test(v.key)) return null;
    return { kind: v.k, key: v.key, nonce: cleanNonce(v.n) };
  } catch {
    return null;
  }
}

// ─── Which routes a request may use ──────────────────────────────────────────

// With relayOnly, every route goes through a TURN relay, so the other person only ever sees the relay's address and
// never mine. This is enforced here, on my own computer, so the other side cannot talk me out of it. It never
// quietly falls back to a direct route: with no relay to use it throws, and no request is sent or answered.
// (A STUN server does not help here: STUN is how an address is found out, not hidden.)
export function friendConfig(base: RTCConfiguration, relayOnly: boolean): RTCConfiguration {
  if (!relayOnly) return base;
  const hasRelay = (base.iceServers ?? []).some(s => [s.urls].flat().some(u => /^turns?:/i.test(u)));
  if (!hasRelay) throw new Error('Relay only is on, but there is no relay to use');
  return { ...base, iceTransportPolicy: 'relay' };
}

// ─── The connection ──────────────────────────────────────────────────────────

const CONNECT_MS = 20000;
const MAX_SDP = 20000;
// How many requests may be arriving at once, and how often one person may start a handshake with me. A handshake
// makes me answer with my network addresses, so it is not something to hand out freely.
const MAX_IN = 4;
const OFFER_GAP_MS = 5000;
// The receiver keeps the channel a moment after "got it", so the acknowledgement is not cut off
const LINGER_MS = 1500;

export interface FriendHost {
  config(): Promise<RTCConfiguration>;
  gathered(pc: RTCPeerConnection): Promise<void>;
  // Hands one description to the server to pass to this person (plugin data)
  signal(to: number, type: 'offer' | 'answer', sdp: string): void;
  // Is this session someone on the server right now
  known(session: number): boolean;
  // Is a handshake from this person welcome (requests may be turned off, and then nobody gets my address)
  wants(session: number): boolean;
  message(from: number, msg: FriendMessage): void;
}

interface Conn {
  peer: number;
  role: 'out' | 'in';
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  over: boolean;
  got: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  done: Promise<boolean>;
  settle: (ok: boolean) => void;
}

export class FriendRtc {
  private out = new Map<number, Conn>();
  private inn = new Map<number, Conn>();
  private lastOffer = new Map<number, number>();
  private assembler = new FriendAssembler();
  private closed = false;
  private host: FriendHost;
  private rtc: typeof RTCPeerConnection;

  constructor(host: FriendHost, rtc: typeof RTCPeerConnection = globalThis.RTCPeerConnection) {
    this.host = host;
    this.rtc = rtc;
  }

  private make(peer: number, role: 'out' | 'in', config: RTCConfiguration, ms: number): Conn {
    const pc = new this.rtc(config);
    const dc = pc.createDataChannel('friend', { negotiated: true, id: 0, ordered: true });
    let settle: (ok: boolean) => void = () => {};
    const done = new Promise<boolean>(resolve => { settle = resolve; });
    const c: Conn = { peer, role, pc, dc, over: false, got: false, timer: undefined, done, settle };
    (role === 'out' ? this.out : this.inn).set(peer, c);
    c.timer = setTimeout(() => this.end(c, false), ms);
    dc.addEventListener('close', () => this.end(c, false));
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.end(c, false);
    });
    return c;
  }

  private end(c: Conn, ok: boolean, linger = 0): void {
    if (c.over) return;
    c.over = true;
    clearTimeout(c.timer);
    const map = c.role === 'out' ? this.out : this.inn;
    if (map.get(c.peer) === c) map.delete(c.peer);
    const shut = () => {
      try { c.dc.close(); } catch { /* already closed */ }
      try { c.pc.close(); } catch { /* already closed */ }
    };
    if (linger > 0) setTimeout(shut, linger); else shut();
    c.settle(ok);
  }

  // Sends one message to this person, privately. true once they confirmed they have it; false when no channel
  // came up in time (they are not running a version that understands this, requests are off, the network
  // refused, ...). Nothing is sent by any other road.
  async send(peer: number, msg: FriendMessage, ms = CONNECT_MS): Promise<boolean> {
    if (this.closed || !this.rtc || this.out.has(peer) || !this.host.known(peer)) return false;
    let c: Conn | undefined;
    try {
      const config = await this.host.config();
      if (this.closed || this.out.has(peer)) return false;
      const conn = c = this.make(peer, 'out', config, ms);
      conn.dc.addEventListener('open', () => {
        try { conn.dc.send(encodeFriendMessage(msg)); } catch { this.end(conn, false); }
      });
      conn.dc.addEventListener('message', ev => { if (ev.data === ACK) this.end(conn, true); });
      await conn.pc.setLocalDescription(await conn.pc.createOffer());
      await this.host.gathered(conn.pc);
      const sdp = conn.pc.localDescription?.sdp;
      if (conn.over) return conn.done;
      if (!sdp) { this.end(conn, false); return false; }
      this.host.signal(peer, 'offer', sdp);
      return await conn.done;
    } catch {
      if (c) this.end(c, false);
      return false;
    }
  }

  // Everything that arrives as plugin data under FRIEND_DATA_ID
  async receive(sender: number, data: Uint8Array): Promise<void> {
    if (this.closed) return;
    const sig = await this.assembler.push(sender, data);
    if (!sig || sig.text == null) return;
    if (sig.type === FRIEND_SIG.offer) await this.onOffer(sender, sig.text);
    else if (sig.type === FRIEND_SIG.answer) await this.onAnswer(sender, sig.text);
  }

  private async onOffer(peer: number, sdp: string): Promise<void> {
    if (sdp.length > MAX_SDP || !this.host.known(peer) || !this.host.wants(peer)) return;
    const now = Date.now();
    if (now - (this.lastOffer.get(peer) ?? 0) < OFFER_GAP_MS) return;
    if (this.inn.has(peer) || this.inn.size >= MAX_IN) return;
    if (this.lastOffer.size > 256) this.lastOffer.clear();
    this.lastOffer.set(peer, now);
    let c: Conn | undefined;
    try {
      const config = await this.host.config();
      if (this.closed || this.inn.has(peer)) return;
      const conn = c = this.make(peer, 'in', config, CONNECT_MS);
      conn.dc.addEventListener('message', ev => {
        // One message per connection, and it must be the request itself
        if (conn.got) return;
        conn.got = true;
        const msg = typeof ev.data === 'string' ? parseFriendMessage(ev.data) : null;
        if (!msg) return this.end(conn, false);
        this.host.message(peer, msg);
        try { conn.dc.send(ACK); } catch { /* the sender will time out and say so */ }
        this.end(conn, true, LINGER_MS);
      });
      await conn.pc.setRemoteDescription({ type: 'offer', sdp });
      await conn.pc.setLocalDescription(await conn.pc.createAnswer());
      await this.host.gathered(conn.pc);
      const answer = conn.pc.localDescription?.sdp;
      if (!conn.over && answer) this.host.signal(peer, 'answer', answer);
    } catch {
      if (c) this.end(c, false);
    }
  }

  private async onAnswer(peer: number, sdp: string): Promise<void> {
    const c = this.out.get(peer);
    if (!c || sdp.length > MAX_SDP || c.pc.signalingState !== 'have-local-offer') return;
    try {
      await c.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch {
      this.end(c, false);
    }
  }

  close(): void {
    this.closed = true;
    for (const c of [...this.out.values(), ...this.inn.values()]) this.end(c, false);
    this.lastOffer.clear();
  }
}
