// Direct friend connections (HyperDHT): what two Libertad clients say to each other over the encrypted stream
// they open between their identity keys. No Mumble server is involved, and nobody needs to know an IP address.
//
// A frame is [length u32 BE][type u8][payload]; the length covers the type byte and the payload.

export const P2P = {
  hello: 1,      // first thing each side sends: { name, hash } (the name the person uses, and their certificate hash)
  request: 2,    // "please add me": { name }
  accept: 3,     // "yes, we are friends" ({ nonce } when answering a request that went through a server)
  invite: 4,     // calling you
  answer: 5,     // you picked up
  decline: 6,    // you did not ({ busy } when already in a call)
  hangup: 7,     // the call is over
  audio: 8,      // [flags u8 (1 = last packet of a burst)][frame u32 BE][opus...]
  state: 9,      // { muted, deafened } for the call
  chat: 10,      // { text }: a message typed during the call, kept only until the call ends
  profile: 11,   // my profile as a list (ProfileManifest): sent when the connection opens and whenever it changes
  profileWant: 12, // { slot, hash }: send me this picture, I do not have it
  profileFile: 13, // { slot, hash, size, mime }: the picture follows in profileData frames
  profileData: 14, // [slot u8][bytes]: a piece of the picture, in order
  signal: 15       // [channel u8][bytes]: setup messages for what is shared in the call (screen, camera, Watch Together)
} as const;
export type P2pType = typeof P2P[keyof typeof P2P];

export const MAX_FRAME = 64 * 1024;
export const MAX_NAME = 64;
export const MAX_CHAT = 2000;
export const MAX_CHAT_KEPT = 200;

export function encodeFrame(type: P2pType, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, 1 + payload.length);
  out[4] = type;
  out.set(payload, 5);
  return out;
}

export const encodeJson = (type: P2pType, value: unknown): Uint8Array =>
  encodeFrame(type, new TextEncoder().encode(JSON.stringify(value)));

export function decodeJson(payload: Uint8Array): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(payload));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// Screen sharing, the camera and Watch Together signal each other with the same packets they send through a Mumble
// server as plugin data. In a call they travel on the call's own connection instead: [channel][packet].
export const SIGNAL_CHANNEL = { share: 1, watch: 2 } as const;
export type SignalChannel = typeof SIGNAL_CHANNEL[keyof typeof SIGNAL_CHANNEL];
// Larger than one packet of any signal (they are cut to 1000 bytes), far below MAX_FRAME
export const MAX_SIGNAL = 8 * 1024;

export const encodeSignalFrame = (channel: SignalChannel, packet: Uint8Array): Uint8Array => {
  const body = new Uint8Array(1 + packet.length);
  body[0] = channel;
  body.set(packet, 1);
  return encodeFrame(P2P.signal, body);
};

export function decodeSignalFrame(payload: Uint8Array): { channel: SignalChannel; packet: Uint8Array } | null {
  if (payload.length < 2 || payload.length > MAX_SIGNAL + 1) return null;
  const channel = payload[0];
  if (channel !== SIGNAL_CHANNEL.share && channel !== SIGNAL_CHANNEL.watch) return null;
  return { channel, packet: payload.slice(1) };
}

export function encodeAudio(frame: number, last: boolean, opus: Uint8Array): Uint8Array {
  const body = new Uint8Array(5 + opus.length);
  body[0] = last ? 1 : 0;
  new DataView(body.buffer).setUint32(1, frame >>> 0);
  body.set(opus, 5);
  return encodeFrame(P2P.audio, body);
}

export function decodeAudio(payload: Uint8Array): { frame: number; last: boolean; opus: Uint8Array } | null {
  if (payload.length < 5) return null;
  return {
    last: (payload[0] & 1) === 1,
    frame: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(1),
    opus: payload.slice(5)
  };
}

// Puts the stream's chunks back into frames. A peer that sends an oversized or empty frame is cut off
// by the caller (push returns null).
export class FrameReader {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): { type: number; payload: Uint8Array }[] | null {
    if (this.buf.length) {
      const joined = new Uint8Array(this.buf.length + chunk.length);
      joined.set(this.buf);
      joined.set(chunk, this.buf.length);
      this.buf = joined;
    } else this.buf = chunk;
    const out: { type: number; payload: Uint8Array }[] = [];
    let at = 0;
    while (this.buf.length - at >= 4) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset + at, 4).getUint32(0);
      if (len < 1 || len > MAX_FRAME) return null;
      if (this.buf.length - at - 4 < len) break;
      out.push({ type: this.buf[at + 4], payload: this.buf.slice(at + 5, at + 4 + len) });
      at += 4 + len;
    }
    this.buf = this.buf.slice(at);
    return out;
  }
}

// ─── Friend codes ─────────────────────────────────────────────────────────────

// A friend code is the 32-byte public key as 64 hex characters. People paste it with spaces, dashes, a
// prefix or in capitals, so all of that is forgiven.
export function parseFriendCode(input: string): string | null {
  const hex = input.trim().replace(/^libertad:(\/\/)?(friend\/)?/i, '').replace(/[\s:-]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export const friendLink = (key: string): string => `libertad:friend/${key}`;

// "a1b2c3d4 e5f6a7b8 ...": easier to read out loud and compare than one long string
export const groupKey = (key: string): string => key.replace(/(.{8})(?=.)/g, '$1 ');

// Whose connection wins when both people connect to each other at the same moment: the one that
// the smaller key opened. Both sides work this out alike, so they keep the same one.
export const keepsOutgoing = (mine: string, theirs: string): boolean => mine < theirs;

// ─── What the page sees ───────────────────────────────────────────────────────

export interface P2pFriend {
  key: string;
  name: string;
  // 'friend': both agreed. 'pending': I asked, they have not answered.
  status: 'friend' | 'pending';
  online: boolean;
  // The Mumble certificate hash of the person, when the friendship started on a server
  hash?: string;
}
export interface P2pRequest { key: string; name: string; hash?: string }
// A message of the current call: it exists only while the call does
export interface P2pChatMessage { mine: boolean; text: string; at: number }
export interface P2pCall {
  key: string;
  dir: 'in' | 'out';
  state: 'ringing' | 'active';
  // The other person's mute and deafen, for the call bar
  muted: boolean;
  deafened: boolean;
}
export interface P2pState {
  // Joined the network: calls and requests can arrive
  running: boolean;
  starting: boolean;
  error: string;
  self: { key: string; name: string } | null;
  acceptRequests: boolean;
  friends: P2pFriend[];
  requests: P2pRequest[];
  // Mumble certificate hashes: people who are my friends, and people I sent a request to that is not answered yet.
  // Kept while offline too, so a profile card knows whether to offer "Add Friend".
  friendHashes: string[];
  sentHashes: string[];
  call: P2pCall | null;
  // What was typed during the current call, by either side; gone when the call ends
  chat: P2pChatMessage[];
  // Why the last call ended, for a line in the window
  lastEnd: { key: string; reason: 'hangup' | 'declined' | 'busy' | 'lost' | 'unanswered' | 'offline' } | null;
}

export const emptyP2pState = (): P2pState => ({
  running: false, starting: false, error: '', self: null, acceptRequests: true,
  friends: [], requests: [], friendHashes: [], sentHashes: [], call: null, chat: [], lastEnd: null
});

// ─── Friend requests through a Mumble server ─────────────────────────────────
// A request from a profile card is a private Mumble message that carries only the sender's friend code, as a hidden
// HTML comment: <!--libertad:friend:req:CODE-->. Nothing else is sent: no address, no connection, and the
// other side is not contacted directly until they accept. Accepting answers the same way with their own code
// (<!--libertad:friend:ok:CODE-->), and only then do the two computers connect.
export type FriendTagKind = 'req' | 'ok';
// A request also carries a one-time secret (nonce) that only the person it was sent to gets to see. If they accept
// while the sender is away from the server, their answer travels over the friend network instead, with this secret
// as proof that it comes from the person who was asked.
const FRIEND_TAG = /<!--libertad:friend:(req|ok):([0-9a-f]{64})(?::([0-9a-f]{32}))?-->/;
export const friendTag = (kind: FriendTagKind, key: string, nonce = ''): string => `<!--libertad:friend:${kind}:${key}${nonce ? ':' + nonce : ''}-->`;
export function parseFriendTag(html: string): { kind: FriendTagKind; key: string; nonce: string } | null {
  const m = FRIEND_TAG.exec(html);
  return m ? { kind: m[1] as FriendTagKind, key: m[2], nonce: m[3] ?? '' } : null;
}
// A Mumble certificate hash (SHA-1, 40 hex digits), or ''
export const cleanHash = (v: unknown): string => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : '';
export const cleanNonce = (v: unknown): string => typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v) ? v.toLowerCase() : '';


// ─── Profiles between friends ─────────────────────────────────────────────────
// What a friend shows of themselves (picture, banner, card backgrounds, description) travels over the same
// connection as everything else, with no Mumble server. A friend sends a short list of what they have, with
// the SHA-256 of each picture; the other side compares it with what it kept of them and asks for only what
// is new or different. The list goes out when the connection opens (so a change made while we were apart is
// found at once) and again whenever the owner changes something.
export type ProfileSlot = 'avatar' | 'banner' | 'card' | 'profile';
export const PROFILE_SLOTS: readonly ProfileSlot[] = ['avatar', 'banner', 'card', 'profile'];
export type ProfileScope = 'under' | 'whole';
export type ProfileItem =
  | { kind: 'color'; color: string; scope?: ProfileScope }
  | { kind: 'file'; hash: string; mime: string; size: number; scope?: ProfileScope };
export interface ProfileManifest { text: string; slots: Partial<Record<ProfileSlot, ProfileItem>> }

export const MAX_PROFILE_TEXT = 40000;
export const MAX_PROFILE_FILE = 16 * 1024 * 1024;
export const PROFILE_CHUNK = 16 * 1024;
export const PROFILE_MIME = /^(?:image\/(?:gif|png|jpeg|webp)|video\/(?:mp4|webm))$/;
const COLOR = /^#[0-9a-f]{6}$/i;

export const isProfileSlot = (v: unknown): v is ProfileSlot => typeof v === 'string' && (PROFILE_SLOTS as readonly string[]).includes(v);
export const cleanProfileHash = (v: unknown): string => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : '';
// Only the card background of the profile has a scope: under the banner, or the whole card
const scopeOf = (slot: ProfileSlot, v: unknown): { scope?: ProfileScope } => slot === 'profile' && (v === 'under' || v === 'whole') ? { scope: v } : {};

// One entry of a list from a friend: nothing that is not exactly what is allowed gets through
export function cleanProfileItem(slot: ProfileSlot, v: unknown): ProfileItem | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  if (o.kind === 'color') return slot !== 'avatar' && typeof o.color === 'string' && COLOR.test(o.color) ? { kind: 'color', color: o.color.toLowerCase(), ...scopeOf(slot, o.scope) } : null;
  if (o.kind !== 'file') return null;
  const hash = cleanProfileHash(o.hash);
  const size = Number(o.size);
  if (!hash || typeof o.mime !== 'string' || !PROFILE_MIME.test(o.mime) || !Number.isInteger(size) || size < 1 || size > MAX_PROFILE_FILE) return null;
  return { kind: 'file', hash, mime: o.mime, size, ...scopeOf(slot, o.scope) };
}

export function cleanManifest(v: unknown): ProfileManifest | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const text = typeof o.text === 'string' && o.text.length <= MAX_PROFILE_TEXT ? o.text : '';
  const slots: ProfileManifest['slots'] = {};
  const given = o.slots && typeof o.slots === 'object' ? o.slots as Record<string, unknown> : {};
  for (const slot of PROFILE_SLOTS) {
    const item = cleanProfileItem(slot, given[slot]);
    if (item) slots[slot] = item;
  }
  return { text, slots };
}

export const sameProfileItem = (a: ProfileItem | undefined, b: ProfileItem | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// A piece of a picture: [slot index u8][bytes]
export function encodeProfileData(slot: ProfileSlot, bytes: Uint8Array): Uint8Array {
  const body = new Uint8Array(1 + bytes.length);
  body[0] = PROFILE_SLOTS.indexOf(slot);
  body.set(bytes, 1);
  return encodeFrame(P2P.profileData, body);
}
export function decodeProfileData(payload: Uint8Array): { slot: ProfileSlot; bytes: Uint8Array } | null {
  const slot = PROFILE_SLOTS[payload[0]];
  return payload.length >= 1 && slot ? { slot, bytes: payload.subarray(1) } : null;
}

// What a friend's saved profile looks like to the page: the pictures come as bytes
export type FriendProfileItem =
  | { kind: 'color'; color: string; scope?: ProfileScope }
  | { kind: 'file'; hash: string; mime: string; bytes: Uint8Array; scope?: ProfileScope };
export interface FriendProfileData { text: string; slots: Partial<Record<ProfileSlot, FriendProfileItem>> }
