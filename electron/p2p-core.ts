// Friends and calls over HyperDHT, with no Mumble server involved. This file holds the logic and takes the
// DHT as a parameter, so it can be tested against a local test network (test/p2p.test.ts); p2p.ts wires it
// to Electron.
//
// - Your DHT key pair is derived from your identity's private key, so one identity is one friend code, on
//   any computer it is imported to.
// - A friend is a public key. Both sides keep one encrypted connection open while they are online; that
//   connection is presence (online or not), friend requests, call signalling and the call's audio.
// - People who are not friends can only send a friend request. Nothing else they say is read.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, createPrivateKey } from 'node:crypto';
import type { Duplex } from 'node:stream';
import {
  P2P, FrameReader, encodeFrame, encodeJson, decodeJson, encodeAudio, decodeAudio, encodeSignalFrame, decodeSignalFrame, SIGNAL_CHANNEL, MAX_SIGNAL, keepsOutgoing, MAX_NAME, MAX_CHAT, MAX_CHAT_KEPT,
  emptyP2pState, type P2pState, type P2pCall, type P2pChatMessage, cleanHash, cleanNonce,
  PROFILE_SLOTS, PROFILE_CHUNK, PROFILE_MIME, MAX_PROFILE_FILE, MAX_PROFILE_TEXT, cleanManifest, cleanProfileHash, cleanProfileItem, isProfileSlot,
  sameProfileItem, encodeProfileData, decodeProfileData,
  type ProfileSlot, type ProfileItem, type ProfileManifest, type FriendProfileData
} from '../src/core/p2p-wire.ts';

// The seed of the DHT key pair: a keyed hash of the identity's private key. The certificate's fingerprint
// is public, so it must never be the seed.
export function keySeed(keyPem: string): Uint8Array {
  const der = createPrivateKey(keyPem).export({ type: 'pkcs8', format: 'der' });
  return new Uint8Array(createHmac('sha256', der).update('libertad/hyperdht/v1').digest());
}

// ─── What the DHT gives us ────────────────────────────────────────────────────

export interface DhtSocket extends Duplex {
  remotePublicKey: Uint8Array;
  writableLength: number;
}
export interface DhtServer {
  listen(keyPair: { publicKey: Uint8Array; secretKey: Uint8Array }): Promise<void>;
  close(): Promise<void>;
}
export interface Dht {
  connect(publicKey: Uint8Array, opts: { keyPair: { publicKey: Uint8Array; secretKey: Uint8Array } }): DhtSocket;
  createServer(opts: { firewall?: (remotePublicKey: Uint8Array) => boolean }, onconnection: (socket: DhtSocket) => void): DhtServer;
  destroy(): Promise<void>;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
// eslint-disable-next-line no-control-regex
// Message text: no control characters but line breaks and tabs
// eslint-disable-next-line no-control-regex
const cleanChat = (v: unknown): string => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_CHAT) : '';
const cleanName = (v: unknown): string => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME) : '';

// ─── Saved friends ────────────────────────────────────────────────────────────

export interface Saved {
  // answer: the secret of a request I accepted, shown to them over the friend network until they answer
  friends: { key: string; name: string; status: 'friend' | 'pending'; hash?: string; answer?: string }[];
  requests: { key: string; name: string; hash?: string; nonce?: string }[];
  blocked: string[];
  acceptRequests: boolean;
  // Requests I sent through a server: the person's certificate hash, and the secret that only they received
  sent: { hash: string; nonce: string; at: number }[];
}

export type ServerResult = 'none' | 'changed' | 'friend';

// The friend requests that travel through a Mumble server (see core/p2p-wire.ts). The server vouches for the
// certificate hash of whoever sent a message; a friend code that arrives with it is only ever a request or an
// answer to one of mine. Nothing here opens a connection.
const SENT_DAYS = 30;
const freshSent = (d: Saved) => d.sent.filter(s => Date.now() - s.at < SENT_DAYS * 86400000).slice(-100);
const sentFor = (d: Saved, hash: string) => d.sent.find(s => s.hash === hash);

export function noteSent(d: Saved, hash: string, nonce: string): boolean {
  const h = cleanHash(hash);
  const n = cleanNonce(nonce);
  if (!h || !n) return false;
  d.sent = freshSent({ ...d, sent: [...d.sent.filter(s => s.hash !== h), { hash: h, nonce: n, at: Date.now() }] });
  return true;
}

export function applyRequest(d: Saved, self: string, key: string, name: string, hash: string, nonce = ''): ServerResult {
  const h = cleanHash(hash);
  const label = cleanName(name);
  if (!h || key === self || d.blocked.includes(key)) return 'none';
  const friend = d.friends.find(f => f.key === key);
  const asked = sentFor(d, h);
  if (friend) {
    // They asked and we already are, or I had asked them by code: that settles it
    friend.hash = h;
    friend.status = 'friend';
    d.sent = d.sent.filter(s => s.hash !== h);
    return 'changed';
  }
  if (asked) {
    // We asked each other: nothing left to accept
    d.sent = d.sent.filter(s => s.hash !== h);
    d.requests = d.requests.filter(r => r.key !== key);
    d.friends.push({ key, name: label, status: 'friend', hash: h });
    return 'friend';
  }
  if (!d.acceptRequests) return 'none';
  const n = cleanNonce(nonce);
  const known = d.requests.find(r => r.key === key);
  if (known) { known.hash = h; if (n) known.nonce = n; if (label) known.name = label; return 'changed'; }
  if (d.requests.length >= 50) return 'none';
  d.requests.push({ key, name: label, hash: h, ...(n && { nonce: n }) });
  return 'changed';
}

function befriend(d: Saved, key: string, name: string, hash: string): ServerResult {
  const friend = d.friends.find(f => f.key === key);
  if (friend) { friend.hash = hash; friend.status = 'friend'; if (!friend.name) friend.name = cleanName(name); return 'changed'; }
  d.friends.push({ key, name: cleanName(name), status: 'friend', hash });
  return 'friend';
}

// Their answer to a request of mine through the server: only believed from the person it was sent to
export function applyAnswer(d: Saved, self: string, key: string, name: string, hash: string): ServerResult {
  const h = cleanHash(hash);
  if (!h || !sentFor(d, h) || key === self || d.blocked.includes(key)) return 'none';
  d.sent = d.sent.filter(s => s.hash !== h);
  return befriend(d, key, name, h);
}

// Their answer over the friend network, when we were not on a server together: it proves itself with the secret of my request
export function applyNonceAnswer(d: Saved, self: string, key: string, name: string, nonce: unknown): ServerResult {
  const n = cleanNonce(nonce);
  const asked = n ? d.sent.find(s => s.nonce === n) : undefined;
  if (!asked || key === self || d.blocked.includes(key)) return 'none';
  d.sent = d.sent.filter(s => s !== asked);
  return befriend(d, key, name, asked.hash);
}

export const sentHashes = (d: Saved): string[] => d.sent.map(s => s.hash);
export const friendHashes = (d: Saved): string[] => d.friends.map(f => f.hash).filter((h): h is string => !!h);

export class FriendStore {
  data: Saved = { friends: [], requests: [], blocked: [], acceptRequests: true, sent: [] };
  private file: string;
  constructor(file: string) { this.file = file; }

  async load(): Promise<void> {
    try {
      const d = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<Saved>;
      this.data = {
        friends: Array.isArray(d.friends) ? d.friends.filter(f => /^[0-9a-f]{64}$/.test(f?.key)).map(f => ({ key: f.key, name: cleanName(f.name), status: f.status === 'pending' ? 'pending' as const : 'friend' as const, ...(cleanHash(f.hash) && { hash: cleanHash(f.hash) }), ...(cleanNonce(f.answer) && { answer: cleanNonce(f.answer) }) })) : [],
        requests: Array.isArray(d.requests) ? d.requests.filter(r => /^[0-9a-f]{64}$/.test(r?.key)).map(r => ({ key: r.key, name: cleanName(r.name), ...(cleanHash(r.hash) && { hash: cleanHash(r.hash) }), ...(cleanNonce(r.nonce) && { nonce: cleanNonce(r.nonce) }) })) : [],
        blocked: Array.isArray(d.blocked) ? d.blocked.filter(k => /^[0-9a-f]{64}$/.test(k)) : [],
        acceptRequests: d.acceptRequests !== false,
        sent: []
      };
      this.data.sent = Array.isArray(d.sent) ? d.sent.filter(s => s && cleanHash(s.hash) && cleanNonce(s.nonce)).map(s => ({ hash: cleanHash(s.hash), nonce: cleanNonce(s.nonce), at: Number(s.at) || Date.now() })) : [];
      this.data.sent = freshSent(this.data);
    } catch { /* first run */ }
  }

  private writing: Promise<void> = Promise.resolve();
  save(): Promise<void> {
    const json = JSON.stringify(this.data);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, json, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    }).catch(() => {});
    return this.writing;
  }
}

// ─── What was kept of each friend's profile ───────────────────────────────────
// One folder per friend (their key): meta.json is the list they sent (text, colors, and for each picture its hash)
// and the pictures are files named by slot. A picture is only listed in meta.json once the file is complete, so
// what the page shows is never half of anything. Without a folder everything stays in memory (tests).

interface KeptProfile { text: string; slots: Partial<Record<ProfileSlot, ProfileItem>> }
const emptyKept = (): KeptProfile => ({ text: '', slots: {} });

export class ProfileStore {
  private dir?: string;
  private mem = new Map<string, { meta: KeptProfile; files: Map<ProfileSlot, Uint8Array> }>();
  private cache = new Map<string, KeptProfile>();
  constructor(dir?: string) { this.dir = dir; }

  private folder(key: string): string { return path.join(this.dir!, key); }
  private okKey = (key: string) => /^[0-9a-f]{64}$/.test(key);

  async meta(key: string): Promise<KeptProfile> {
    if (!this.okKey(key)) return emptyKept();
    if (!this.dir) return structuredClone(this.mem.get(key)?.meta ?? emptyKept());
    const hit = this.cache.get(key);
    if (hit) return structuredClone(hit);
    let meta = emptyKept();
    try {
      const m = cleanManifest(JSON.parse(await fs.readFile(path.join(this.folder(key), 'meta.json'), 'utf8')));
      if (m) meta = { text: m.text, slots: m.slots };
    } catch { /* nothing kept yet */ }
    this.cache.set(key, meta);
    return structuredClone(meta);
  }

  async file(key: string, slot: ProfileSlot): Promise<Uint8Array | null> {
    if (!this.okKey(key)) return null;
    if (!this.dir) return this.mem.get(key)?.files.get(slot) ?? null;
    try { return new Uint8Array(await fs.readFile(path.join(this.folder(key), slot))); } catch { return null; }
  }

  async has(key: string, slot: ProfileSlot): Promise<boolean> {
    if (!this.dir) return !!this.mem.get(key)?.files.has(slot);
    try { await fs.access(path.join(this.folder(key), slot)); return true; } catch { return false; }
  }

  // files: bytes to write, or null to delete. The files go first, so a cut-off save never lists what is not there.
  async save(key: string, meta: KeptProfile, files: Partial<Record<ProfileSlot, Uint8Array | null>> = {}): Promise<void> {
    if (!this.okKey(key)) return;
    if (!this.dir) {
      const e = this.mem.get(key) ?? { meta: emptyKept(), files: new Map<ProfileSlot, Uint8Array>() };
      for (const slot of PROFILE_SLOTS) { const b = files[slot]; if (b) e.files.set(slot, b); else if (b === null) e.files.delete(slot); }
      e.meta = structuredClone(meta);
      this.mem.set(key, e);
      return;
    }
    const dir = this.folder(key);
    await fs.mkdir(dir, { recursive: true });
    for (const slot of PROFILE_SLOTS) {
      const b = files[slot];
      if (b) await fs.writeFile(path.join(dir, slot), b);
      else if (b === null) await fs.rm(path.join(dir, slot), { force: true });
    }
    const tmp = path.join(dir, 'meta.json.tmp');
    await fs.writeFile(tmp, JSON.stringify(meta));
    await fs.rename(tmp, path.join(dir, 'meta.json'));
    this.cache.set(key, structuredClone(meta));
  }

  async remove(key: string): Promise<void> {
    if (!this.okKey(key)) return;
    this.mem.delete(key);
    this.cache.delete(key);
    if (this.dir) await fs.rm(this.folder(key), { recursive: true, force: true }).catch(() => {});
  }

  // For the page: the text, the colors and the pictures as bytes
  async read(key: string): Promise<FriendProfileData | null> {
    const meta = await this.meta(key);
    const out: FriendProfileData = { text: meta.text, slots: {} };
    for (const slot of PROFILE_SLOTS) {
      const item = meta.slots[slot];
      if (!item) continue;
      if (item.kind === 'color') { out.slots[slot] = item; continue; }
      const bytes = await this.file(key, slot);
      if (bytes) out.slots[slot] = { kind: 'file', hash: item.hash, mime: item.mime, bytes, ...(item.scope && { scope: item.scope }) };
    }
    return out;
  }
}

// ─── My own profile, as I hand it to friends ──────────────────────────────────

export interface OwnProfile { manifest: ProfileManifest; files: Map<string, Uint8Array> }

// What the page gives us: text, colors and the bytes of pictures. The hash of each picture is worked out
// here, so a friend can trust that a list and its pictures belong together.
export function buildOwnProfile(input: unknown): OwnProfile {
  const o = (input && typeof input === 'object' ? input : {}) as { text?: unknown; slots?: unknown };
  const given = (o.slots && typeof o.slots === 'object' ? o.slots : {}) as Record<string, unknown>;
  const manifest: ProfileManifest = { text: typeof o.text === 'string' && o.text.length <= MAX_PROFILE_TEXT ? o.text : '', slots: {} };
  const files = new Map<string, Uint8Array>();
  for (const slot of PROFILE_SLOTS) {
    const raw = given[slot] as { kind?: unknown; bytes?: unknown; mime?: unknown; color?: unknown; scope?: unknown } | undefined;
    if (!raw || typeof raw !== 'object') continue;
    if (raw.kind === 'file') {
      const bytes = raw.bytes;
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_PROFILE_FILE || typeof raw.mime !== 'string' || !PROFILE_MIME.test(raw.mime)) continue;
      const hash = createHash('sha256').update(bytes).digest('hex');
      const item = cleanProfileItem(slot, { kind: 'file', hash, mime: raw.mime, size: bytes.length, scope: raw.scope });
      if (item) { manifest.slots[slot] = item; files.set(hash, new Uint8Array(bytes)); }
    } else {
      const item = cleanProfileItem(slot, raw);
      if (item) manifest.slots[slot] = item;
    }
  }
  return { manifest, files };
}

// ─── The node ─────────────────────────────────────────────────────────────────

interface Conn {
  socket: DhtSocket;
  key: string;
  outgoing: boolean;       // I opened it
  reader: FrameReader;
  known: boolean;          // a friend, or someone I asked
  greeted: boolean;        // their hello arrived: it is a Libertad client
  theirName: string;
  timer?: ReturnType<typeof setTimeout>;
  // Their profile: what I asked them for, the picture arriving now, and what they are to be sent
  wanted: Map<ProfileSlot, ProfileItem & { kind: 'file' }>;
  incoming?: { slot: ProfileSlot; item: ProfileItem & { kind: 'file' }; chunks: Uint8Array[]; got: number };
  sendQueue: { slot: ProfileSlot; hash: string }[];
  pumping: boolean;
}

export interface P2pOptions {
  dht: Dht;
  keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  name: string;
  // My certificate hash, told to friends so their profile cards know me
  hash?: string;
  store: FriendStore;
  onState: (state: P2pState) => void;
  onAudio: (key: string, frame: number, last: boolean, opus: Uint8Array) => void;
  // A setup message of something shared in the call (screen, camera, Watch Together) from the other person
  onSignal?: (key: string, channel: number, packet: Uint8Array) => void;
  // Waits before trying again to reach a friend who is not online, doubling up to the last one
  retryMs?: number[];
  ringMs?: number;
  // Where friends' profiles are kept, and who to tell when one of them changed (without these nothing is kept)
  profiles?: ProfileStore;
  onProfile?: (key: string) => void;
}

export class P2p {
  private o: P2pOptions;
  private selfKey: string;
  private server: DhtServer | null = null;
  private peers = new Map<string, Conn>();
  private strangers = new Set<Conn>();
  private connecting = new Set<string>();
  private retries = new Map<string, { timer: ReturnType<typeof setTimeout>; step: number }>();
  private stopped = true;
  private ringTimer: ReturnType<typeof setTimeout> | undefined;
  private call: P2pCall | null = null;
  private chat: P2pChatMessage[] = [];
  private myMute = { muted: false, deafened: false };
  private lastEnd: P2pState['lastEnd'] = null;
  private error = '';
  private starting = false;
  private mine: OwnProfile | null = null;
  private profileWork = new Map<string, Promise<void>>();

  constructor(o: P2pOptions) {
    this.o = o;
    this.selfKey = hex(o.keyPair.publicKey);
  }

  get publicKey(): string { return this.selfKey; }
  private get data() { return this.o.store.data; }
  private friend = (key: string) => this.data.friends.find(f => f.key === key);

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.starting = true;
    this.error = '';
    this.push();
    try {
      const server = this.o.dht.createServer({ firewall: pk => !this.allowed(hex(pk)) }, socket => this.attach(socket, false));
      this.server = server;
      await server.listen(this.o.keyPair);
      if (this.stopped) return;
      for (const f of this.data.friends) this.reach(f.key, 0);
    } catch (e) {
      this.error = (e as Error).message || 'Could not join the network';
      this.stopped = true;
    } finally {
      this.starting = false;
      this.push();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped && !this.server) return;
    this.stopped = true;
    if (this.call) this.finishCall('hangup', true);
    for (const r of this.retries.values()) clearTimeout(r.timer);
    this.retries.clear();
    for (const c of [...this.peers.values(), ...this.strangers]) { clearTimeout(c.timer); c.socket.destroy(); }
    this.peers.clear();
    this.strangers.clear();
    this.connecting.clear();
    const server = this.server;
    this.server = null;
    await server?.close().catch(() => {});
    this.push();
  }

  // ─── Who may connect ────────────────────────────────────────────────────────

  private known = (key: string) => !!this.friend(key);
  // Strangers get in only to send a request, and only while requests are accepted
  private allowed(key: string): boolean {
    if (key === this.selfKey || this.data.blocked.includes(key)) return false;
    // A stranger may also be the answer to a request of mine, which only its secret can tell
    return this.known(key) || this.data.acceptRequests || this.data.sent.length > 0;
  }

  // ─── Connections ────────────────────────────────────────────────────────────

  private attach(socket: DhtSocket, outgoing: boolean): void {
    socket.on('error', () => {});
    const key = hex(socket.remotePublicKey);
    if (!this.allowed(key)) { socket.destroy(); return; }
    const conn: Conn = { socket, key, outgoing, reader: new FrameReader(), known: this.known(key), greeted: false, theirName: '', wanted: new Map(), sendQueue: [], pumping: false };
    socket.on('data', (chunk: Buffer) => this.onData(conn, chunk));
    socket.on('close', () => this.onClose(conn));

    if (!conn.known) {
      // A stranger: wait for a request, and no longer than a few seconds
      this.strangers.add(conn);
      conn.timer = setTimeout(() => socket.destroy(), 10000);
      return;
    }
    const old = this.peers.get(key);
    if (old) {
      // Both of us connected at once: keep the one the smaller key opened. Two from the same side: the newer.
      const keepNew = old.outgoing === outgoing || outgoing === keepsOutgoing(this.selfKey, key);
      if (!keepNew) { socket.destroy(); return; }
      this.peers.delete(key);
      old.socket.destroy();
    }
    this.peers.set(key, conn);
    this.retries.delete(key);
    socket.write(encodeJson(P2P.hello, { name: this.o.name, ...(this.o.hash && { hash: this.o.hash }) }));
    const f = this.friend(key)!;
    socket.write(f.status === 'pending' ? encodeJson(P2P.request, { name: this.o.name }) : f.answer ? encodeJson(P2P.accept, { nonce: f.answer }) : encodeFrame(P2P.accept));
    if (this.call?.key === key && this.call.state === 'active') this.sendTo(key, encodeJson(P2P.state, this.myMute));
    this.sendProfileTo(key);
  }

  private onClose(conn: Conn): void {
    clearTimeout(conn.timer);
    this.strangers.delete(conn);
    if (this.peers.get(conn.key) !== conn) return;
    this.peers.delete(conn.key);
    if (this.call?.key === conn.key) this.finishCall('lost', false);
    this.push();
    if (!this.stopped) this.reach(conn.key, 0, 1500);
  }

  // Tries to reach a friend now or after a delay, and again later while they are away
  private reach(key: string, step: number, delay = 0): void {
    if (this.stopped || !this.friend(key) || this.peers.has(key) || this.connecting.has(key)) return;
    const old = this.retries.get(key);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => this.connect(key, step), delay);
    timer.unref?.();
    this.retries.set(key, { timer, step });
  }

  private connect(key: string, step: number): void {
    this.retries.delete(key);
    if (this.stopped || !this.friend(key) || this.peers.has(key) || this.connecting.has(key)) return;
    this.connecting.add(key);
    const waits = this.o.retryMs ?? [5000, 15000, 30000, 60000];
    const next = () => { this.connecting.delete(key); this.reach(key, step + 1, waits[Math.min(step, waits.length - 1)]); };
    let socket: DhtSocket;
    try { socket = this.o.dht.connect(unhex(key), { keyPair: this.o.keyPair }); } catch { return next(); }
    socket.on('error', () => {});
    let opened = false;
    socket.once('open', () => {
      opened = true;
      this.connecting.delete(key);
      if (this.stopped) return socket.destroy();
      this.attach(socket, true);
    });
    socket.once('close', () => { if (!opened) next(); });
  }

  private sendTo(key: string, frame: Uint8Array): boolean {
    const c = this.peers.get(key);
    if (!c || c.socket.destroyed) return false;
    c.socket.write(frame);
    return true;
  }

  // ─── Messages ───────────────────────────────────────────────────────────────

  private onData(conn: Conn, chunk: Buffer): void {
    // A plain Uint8Array, so that slices are copies and what goes to the page is not a Buffer view
    const frames = conn.reader.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (!frames) return void conn.socket.destroy();
    for (const f of frames) {
      if (conn.socket.destroyed) return;
      if (!conn.known) { this.onStranger(conn, f.type, f.payload); continue; }
      // The connection may have turned into a friend's since it opened
      if (this.peers.get(conn.key) !== conn) return;
      this.onFriend(conn, f.type, f.payload);
    }
  }

  private onStranger(conn: Conn, type: number, payload: Uint8Array): void {
    const key = conn.key;
    if (type === P2P.hello) { conn.theirName = cleanName(decodeJson(payload)?.name); return; }
    if (type === P2P.accept) {
      // The answer to a request I sent through a server, from someone I was not on a server with: it carries the request's secret
      if (applyNonceAnswer(this.data, this.selfKey, key, conn.theirName, decodeJson(payload)?.nonce) === 'none') return;
      this.o.store.save();
      this.push();
      conn.socket.destroy();
      this.reach(key, 0, 300);
      return;
    }
    if (type !== P2P.request || !this.data.acceptRequests) return;
    if (this.data.requests.length < 50 && !this.data.requests.some(r => r.key === key)) {
      this.data.requests.push({ key, name: cleanName(decodeJson(payload)?.name) });
      this.o.store.save();
      this.push();
    }
    // Their answer comes by a new connection, from whichever side
    conn.socket.destroy();
  }

  private onFriend(conn: Conn, type: number, payload: Uint8Array): void {
    const key = conn.key;
    const f = this.friend(key);
    if (!f) return;
    switch (type) {
      case P2P.hello: {
        conn.greeted = true;
        conn.theirName = cleanName(decodeJson(payload)?.name);
        const hash = cleanHash(decodeJson(payload)?.hash);
        if (!f.name && conn.theirName) { f.name = conn.theirName; this.o.store.save(); }
        // Which Mumble certificate they have, so a profile card knows they are a friend
        if (hash && f.hash !== hash) { f.hash = hash; this.o.store.save(); }
        this.push();
        break;
      }
      case P2P.request:
        // They asked and I had asked them (or we already are): that settles it
        f.status = 'friend';
        this.sendTo(key, encodeFrame(P2P.accept));
        this.o.store.save();
        this.push();
        this.sendProfileTo(key);
        break;
      case P2P.accept:
        // Heard back: the secret of the request I accepted has done its work
        if (f.status === 'pending' || f.answer) { f.status = 'friend'; delete f.answer; this.o.store.save(); this.push(); this.sendProfileTo(key); }
        break;
      case P2P.invite:
        if (f.status !== 'friend' || !conn.greeted) break;
        if (this.call) { this.sendTo(key, encodeJson(P2P.decline, { busy: true })); break; }
        this.call = { key, dir: 'in', state: 'ringing', muted: false, deafened: false };
        this.lastEnd = null;
        this.startRing();
        this.push();
        break;
      case P2P.answer:
        if (this.call?.key === key && this.call.dir === 'out' && this.call.state === 'ringing') this.activate();
        break;
      case P2P.decline:
        if (this.call?.key === key && this.call.state === 'ringing') this.finishCall(decodeJson(payload)?.busy ? 'busy' : 'declined', false);
        break;
      case P2P.hangup:
        if (this.call?.key === key) this.finishCall('hangup', false);
        break;
      case P2P.state: {
        if (this.call?.key !== key) break;
        const s = decodeJson(payload);
        this.call = { ...this.call, muted: s?.muted === true, deafened: s?.deafened === true };
        this.push();
        break;
      }
      case P2P.chat: {
        if (this.call?.key !== key || this.call.state !== 'active') break;
        const text = cleanChat(decodeJson(payload)?.text);
        if (text) this.addChat(false, text);
        break;
      }
      case P2P.profile: {
        if (f.status !== 'friend') break;
        const m = cleanManifest(decodeJson(payload));
        if (m) this.later(key, () => this.takeManifest(conn, m));
        break;
      }
      case P2P.profileWant: {
        if (f.status !== 'friend') break;
        const w = decodeJson(payload);
        const slot = w?.slot;
        const hash = cleanProfileHash(w?.hash);
        if (!isProfileSlot(slot) || !hash) break;
        const item = this.mine?.manifest.slots[slot];
        if (item?.kind !== 'file' || item.hash !== hash || !this.mine?.files.has(hash)) break;
        if (!conn.sendQueue.some(q => q.slot === slot && q.hash === hash)) conn.sendQueue.push({ slot, hash });
        void this.pump(conn);
        break;
      }
      case P2P.profileFile: {
        if (f.status !== 'friend') break;
        const h = decodeJson(payload);
        const slot = h?.slot;
        const item = isProfileSlot(slot) ? conn.wanted.get(slot) : undefined;
        // Only what I asked for, exactly as announced
        if (!isProfileSlot(slot) || !item || h?.hash !== item.hash || h?.size !== item.size || h?.mime !== item.mime) { conn.incoming = undefined; break; }
        conn.incoming = { slot, item, chunks: [], got: 0 };
        break;
      }
      case P2P.profileData: {
        const inc = conn.incoming;
        const d = decodeProfileData(payload);
        if (f.status !== 'friend' || !inc || !d || d.slot !== inc.slot) break;
        inc.got += d.bytes.length;
        if (inc.got > inc.item.size) { conn.incoming = undefined; break; }
        inc.chunks.push(d.bytes.slice());
        if (inc.got < inc.item.size) break;
        conn.incoming = undefined;
        this.later(key, () => this.takeFile(conn, inc));
        break;
      }
      case P2P.signal: {
        if (this.call?.key !== key || this.call.state !== 'active') break;
        const s = decodeSignalFrame(payload);
        if (s) this.o.onSignal?.(key, s.channel, s.packet);
        break;
      }
      case P2P.audio: {
        if (this.call?.key !== key || this.call.state !== 'active') break;
        const a = decodeAudio(payload);
        if (a) this.o.onAudio(key, a.frame, a.last, a.opus);
        break;
      }
    }
  }

  // ─── Profiles ───────────────────────────────────────────────────────────────

  // Work on one friend's saved profile goes one piece at a time, so two lists that arrive close together never mix
  private later(key: string, run: () => Promise<void>): void {
    const next = (this.profileWork.get(key) ?? Promise.resolve()).then(run).catch(() => {});
    this.profileWork.set(key, next);
    void next.then(() => { if (this.profileWork.get(key) === next) this.profileWork.delete(key); });
  }

  // My profile, as the page has it now. Friends are told when it differs from what they were told last.
  setProfile(input: unknown): void {
    const next = buildOwnProfile(input);
    const changed = !this.mine || JSON.stringify(this.mine.manifest) !== JSON.stringify(next.manifest);
    this.mine = next;
    if (!changed) return;
    for (const f of this.data.friends) this.sendProfileTo(f.key);
  }

  private sendProfileTo(key: string): void {
    if (!this.mine || this.friend(key)?.status !== 'friend') return;
    this.sendTo(key, encodeJson(P2P.profile, this.mine.manifest));
  }

  // Their list: what changed against what I kept (by hash) is asked for, the rest stays as it is. Text and colors
  // are taken at once; a picture replaces the old one only when all of it has arrived.
  private async takeManifest(conn: Conn, m: ProfileManifest): Promise<void> {
    const store = this.o.profiles;
    const key = conn.key;
    if (!store || this.peers.get(key) !== conn) return;
    const had = await store.meta(key);
    const next: KeptProfile = { text: m.text, slots: {} };
    const drop: Partial<Record<ProfileSlot, null>> = {};
    const wanted = new Map<ProfileSlot, ProfileItem & { kind: 'file' }>();
    let changed = m.text !== had.text;
    for (const slot of PROFILE_SLOTS) {
      const item = m.slots[slot];
      const old = had.slots[slot];
      if (!item) { if (old) { changed = true; if (old.kind === 'file') drop[slot] = null; } continue; }
      if (item.kind === 'color') {
        next.slots[slot] = item;
        if (!sameProfileItem(old, item)) changed = true;
        if (old?.kind === 'file') drop[slot] = null;
        continue;
      }
      if (old?.kind === 'file' && old.hash === item.hash && await store.has(key, slot)) {
        // The same picture: only its placement can differ
        next.slots[slot] = item;
        if (!sameProfileItem(old, item)) changed = true;
        continue;
      }
      // New or different: the old one stays until the new one is complete
      if (old?.kind === 'file') next.slots[slot] = old;
      wanted.set(slot, item);
    }
    conn.wanted = wanted;
    if (conn.incoming && conn.wanted.get(conn.incoming.slot)?.hash !== conn.incoming.item.hash) conn.incoming = undefined;
    if (changed) {
      await store.save(key, next, drop);
      this.o.onProfile?.(key);
    }
    for (const [slot, item] of wanted) this.sendTo(key, encodeJson(P2P.profileWant, { slot, hash: item.hash }));
  }

  // A picture arrived whole: it must be the one that was announced
  private async takeFile(conn: Conn, inc: NonNullable<Conn['incoming']>): Promise<void> {
    const store = this.o.profiles;
    const key = conn.key;
    if (!store || this.friend(key)?.status !== 'friend') return;
    const bytes = new Uint8Array(inc.item.size);
    let at = 0;
    for (const c of inc.chunks) { bytes.set(c, at); at += c.length; }
    if (createHash('sha256').update(bytes).digest('hex') !== inc.item.hash) return;
    // Their list may have moved on while it was coming
    if (conn.wanted.get(inc.slot)?.hash !== inc.item.hash) return;
    conn.wanted.delete(inc.slot);
    const meta = await store.meta(key);
    meta.slots[inc.slot] = inc.item;
    await store.save(key, meta, { [inc.slot]: bytes });
    this.o.onProfile?.(key);
  }

  // Sends the pictures a friend asked for, one at a time, and not while we are in a call with them: the call's
  // voice has the connection first
  private async pump(conn: Conn): Promise<void> {
    if (conn.pumping) return;
    conn.pumping = true;
    try {
      while (conn.sendQueue.length && !conn.socket.destroyed && this.peers.get(conn.key) === conn) {
        if (this.call?.key === conn.key) return;
        const { slot, hash } = conn.sendQueue[0];
        const item = this.mine?.manifest.slots[slot];
        const bytes = this.mine?.files.get(hash);
        if (item?.kind !== 'file' || item.hash !== hash || !bytes) { conn.sendQueue.shift(); continue; }
        conn.socket.write(encodeJson(P2P.profileFile, { slot, hash, size: bytes.length, mime: item.mime }));
        let cut = false;
        for (let at = 0; at < bytes.length; at += PROFILE_CHUNK) {
          if (conn.socket.destroyed) return;
          if (this.call?.key === conn.key) { cut = true; break; }
          if (!conn.socket.write(encodeProfileData(slot, bytes.subarray(at, at + PROFILE_CHUNK)))) {
            await new Promise<void>(done => {
              const end = () => { conn.socket.off('drain', end); conn.socket.off('close', end); done(); };
              conn.socket.once('drain', end);
              conn.socket.once('close', end);
            });
          }
        }
        // A call began in the middle: it starts again from the top afterwards
        if (cut) return;
        conn.sendQueue.shift();
      }
    } finally {
      conn.pumping = false;
    }
  }

  // ─── Friends ────────────────────────────────────────────────────────────────

  async addFriend(key: string, name = ''): Promise<void> {
    if (key === this.selfKey) throw new Error('That is your own friend code.');
    const label = cleanName(name);
    const existing = this.friend(key);
    if (existing) {
      if (label) existing.name = label;
    } else {
      // Asking someone who already asked me is accepting
      const asked = this.data.requests.find(r => r.key === key);
      this.data.requests = this.data.requests.filter(r => r.key !== key);
      this.data.blocked = this.data.blocked.filter(k => k !== key);
      this.data.friends.push({ key, name: label || asked?.name || '', status: asked ? 'friend' : 'pending' });
    }
    await this.o.store.save();
    this.push();
    const c = this.peers.get(key);
    if (c) this.sendTo(key, this.friend(key)!.status === 'pending' ? encodeJson(P2P.request, { name: this.o.name }) : encodeFrame(P2P.accept));
    else this.reach(key, 0);
  }

  async acceptRequest(key: string): Promise<void> {
    const r = this.data.requests.find(x => x.key === key);
    if (!r) return;
    await this.addFriend(key, r.name);
    const f = this.friend(key);
    if (f && (r.hash || r.nonce)) {
      if (r.hash) f.hash = r.hash;
      // Shown to them over the friend network, so the answer arrives even when they are not on the server now
      if (r.nonce) f.answer = r.nonce;
      await this.o.store.save();
      this.push();
      const c = this.peers.get(key);
      if (c && f.answer) this.sendTo(key, encodeJson(P2P.accept, { nonce: f.answer }));
    }
  }

  // A request or answer that came through a Mumble server (see applyRequest, applyAnswer). A new friend is reached
  // right away, which is only when both sides have agreed.
  async viaServer(run: (d: Saved, self: string) => ServerResult, key = ''): Promise<ServerResult> {
    const result = run(this.data, this.selfKey);
    if (result === 'none') return result;
    await this.o.store.save();
    this.push();
    if (result === 'friend' && key) this.reach(key, 0);
    return result;
  }

  // Declining also blocks: that key can no longer connect at all
  async declineRequest(key: string): Promise<void> {
    this.data.requests = this.data.requests.filter(r => r.key !== key);
    if (!this.data.blocked.includes(key)) this.data.blocked.push(key);
    await this.o.store.save();
    this.push();
  }

  async removeFriend(key: string): Promise<void> {
    if (this.call?.key === key) this.hangUp();
    this.data.friends = this.data.friends.filter(f => f.key !== key);
    const r = this.retries.get(key);
    if (r) clearTimeout(r.timer);
    this.retries.delete(key);
    const c = this.peers.get(key);
    this.peers.delete(key);
    c?.socket.destroy();
    await this.o.store.save();
    await this.o.profiles?.remove(key);
    this.push();
  }

  async unblock(key: string): Promise<void> {
    this.data.blocked = this.data.blocked.filter(k => k !== key);
    await this.o.store.save();
  }

  async renameFriend(key: string, name: string): Promise<void> {
    const f = this.friend(key);
    if (!f) return;
    f.name = cleanName(name);
    await this.o.store.save();
    this.push();
  }

  async setAcceptRequests(on: boolean): Promise<void> {
    this.data.acceptRequests = on;
    await this.o.store.save();
    if (!on) for (const c of this.strangers) c.socket.destroy();
    this.push();
  }

  // ─── Calls ──────────────────────────────────────────────────────────────────

  callFriend(key: string): boolean {
    const c = this.peers.get(key);
    if (this.call || !c?.greeted || this.friend(key)?.status !== 'friend') return false;
    this.call = { key, dir: 'out', state: 'ringing', muted: false, deafened: false };
    this.lastEnd = null;
    this.sendTo(key, encodeFrame(P2P.invite));
    this.startRing();
    this.push();
    return true;
  }

  // A message to the person in the call; false when there is no call in progress to send it in
  sendChat(text: unknown): boolean {
    const c = this.call;
    const clean = cleanChat(text);
    if (!clean || c?.state !== 'active' || !this.sendTo(c.key, encodeJson(P2P.chat, { text: clean }))) return false;
    this.addChat(true, clean);
    return true;
  }

  private addChat(mine: boolean, text: string): void {
    this.chat = [...this.chat, { mine, text, at: Date.now() }].slice(-MAX_CHAT_KEPT);
    this.push();
  }

  acceptCall(): boolean {
    const c = this.call;
    if (!c || c.dir !== 'in' || c.state !== 'ringing' || !this.sendTo(c.key, encodeFrame(P2P.answer))) return false;
    this.activate();
    return true;
  }

  declineCall(): void {
    const c = this.call;
    if (!c || c.dir !== 'in' || c.state !== 'ringing') return;
    this.sendTo(c.key, encodeJson(P2P.decline, {}));
    this.finishCall('declined', true);
  }

  // Ends a call that is ringing or active (cancels a call I started)
  hangUp(): void {
    const c = this.call;
    if (!c) return;
    this.sendTo(c.key, encodeFrame(P2P.hangup));
    this.finishCall('hangup', true);
  }

  setMute(muted: boolean, deafened: boolean): void {
    this.myMute = { muted, deafened };
    if (this.call?.state === 'active') this.sendTo(this.call.key, encodeJson(P2P.state, this.myMute));
  }

  // A setup message for what is shared in the call; false when there is no call in progress to send it in
  sendSignal(channel: unknown, packet: unknown): boolean {
    const c = this.call;
    if (c?.state !== 'active' || (channel !== SIGNAL_CHANNEL.share && channel !== SIGNAL_CHANNEL.watch)) return false;
    if (!(packet instanceof Uint8Array) || !packet.length || packet.length > MAX_SIGNAL) return false;
    return this.sendTo(c.key, encodeSignalFrame(channel, packet));
  }

  // One packet of my voice; late ones are dropped rather than queued behind a slow connection
  sendAudio(frame: number, last: boolean, opus: Uint8Array): void {
    const c = this.call;
    if (!c || c.state !== 'active') return;
    const conn = this.peers.get(c.key);
    if (!conn || conn.socket.destroyed || (conn.socket.writableLength > 32 * 1024 && !last)) return;
    conn.socket.write(encodeAudio(frame, last, opus));
  }

  private activate(): void {
    if (!this.call) return;
    clearTimeout(this.ringTimer);
    this.call = { ...this.call, state: 'active' };
    this.sendTo(this.call.key, encodeJson(P2P.state, this.myMute));
    this.push();
  }

  private startRing(): void {
    clearTimeout(this.ringTimer);
    this.ringTimer = setTimeout(() => {
      if (this.call?.state !== 'ringing') return;
      const mine = this.call.dir === 'out';
      if (mine) this.sendTo(this.call.key, encodeFrame(P2P.hangup));
      this.finishCall('unanswered', true);
    }, this.o.ringMs ?? 45000);
    this.ringTimer.unref?.();
  }

  private finishCall(reason: NonNullable<P2pState['lastEnd']>['reason'], quiet: boolean): void {
    const c = this.call;
    clearTimeout(this.ringTimer);
    this.call = null;
    // What was typed during a call goes with it
    this.chat = [];
    if (c) this.lastEnd = { key: c.key, reason };
    if (!quiet || c) this.push();
    const conn = c && this.peers.get(c.key);
    if (conn?.sendQueue.length) void this.pump(conn);
  }

  // ─── State for the page ─────────────────────────────────────────────────────

  snapshot(): P2pState {
    return {
      ...emptyP2pState(),
      running: !this.stopped,
      starting: this.starting,
      error: this.error,
      self: { key: this.selfKey, name: this.o.name },
      acceptRequests: this.data.acceptRequests,
      friends: this.data.friends.map(f => ({ key: f.key, name: f.name || this.peers.get(f.key)?.theirName || '', status: f.status, online: !!this.peers.get(f.key)?.greeted, ...(f.hash && { hash: f.hash }) })),
      requests: this.data.requests.map(r => ({ ...r })),
      friendHashes: friendHashes(this.data),
      sentHashes: sentHashes(this.data),
      call: this.call ? { ...this.call } : null,
      chat: this.chat.map(m => ({ ...m })),
      lastEnd: this.lastEnd
    };
  }

  private push(): void {
    this.o.onState(this.snapshot());
  }
}
