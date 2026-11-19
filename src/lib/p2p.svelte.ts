// Friends and calls over HyperDHT, from the page's side. The network lives in the main process (electron/p2p.ts);
// this keeps what the windows show, and connects a call to the voice engine.
import { desktop } from './native.ts';
import { voice, type CallLink } from './audio/voice.svelte.ts';
import { sounds } from './audio/sounds.svelte.ts';
import { identities } from './identities.svelte.ts';
import { emptyP2pState, parseFriendCode, type P2pState, type ProfileSlot, type FriendProfileData } from '../core/p2p-wire.ts';
import { OWN } from './banner.svelte.ts';
import { store } from './settings.svelte.ts';
import { SLOTS, dataMime, isVideoMime, type BannerView } from '../core/banner.ts';

const FLAG = 'libertad.p2p.on';
const readFlag = (): boolean => { try { return localStorage.getItem(FLAG) === '1'; } catch { return false; } };
const writeFlag = (on: boolean): void => { try { localStorage.setItem(FLAG, on ? '1' : '0'); } catch { /* storage unavailable */ } };

// Go online at every launch. Until chosen, it follows what was done last time, so nothing changes for existing users.
const STARTUP = 'libertad.p2p.startup';
const readStartup = (): boolean => { try { const v = localStorage.getItem(STARTUP); return v === null ? readFlag() : v === '1'; } catch { return false; } };
const writeStartup = (on: boolean): void => { try { localStorage.setItem(STARTUP, on ? '1' : '0'); } catch { /* storage unavailable */ } };

// My description, kept here as well as on the servers, so that friends get it without one. Once it has been set (or taken
// over from a server) it is only ever changed by me, so an older copy on another server cannot bring it back.
const DESC = 'libertad.description';
const DESC_SET = 'libertad.descriptionSet';
const readDescription = (): string => { try { return localStorage.getItem(DESC) ?? ''; } catch { return ''; } };

// What a friend shows of themselves, as the page draws it (pictures are object URLs)
export interface FriendProfile {
  text: string;                  // their description, as HTML to be sanitized when shown
  avatar: string | null;         // a video carries #video, like session.avatar
  banner: BannerView | null;
  card: BannerView | null;
  profile: BannerView | null;
}

const END_TEXT = {
  hangup: 'Call ended', declined: 'Call declined', busy: 'Busy in another call',
  lost: 'Connection lost', unanswered: 'No answer', offline: 'Not online'
} as const;

class P2pStore {
  supported = !!desktop;
  state = $state<P2pState>(emptyP2pState());
  // Joined the network on purpose (kept between launches)
  enabled = $state(readFlag());
  // Go online by itself every time the app starts
  startup = $state(readStartup());
  open = $state(false);
  // My side of the current call
  muted = $state(false);
  deafened = $state(false);
  busy = $state(false);
  // Friends' profiles (by friend code), read from what the main process kept; they change when a friend's does
  profiles = $state<Record<string, FriendProfile>>({});
  description = $state(readDescription());

  private urls = new Map<string, string[]>();
  private asked = new Set<string>();
  private pushRun = 0;
  private booted = false;
  private joined = false;
  private ring: ReturnType<typeof setInterval> | null = null;
  private lastCall = '';
  private identityId = '';

  readonly link: CallLink = {
    get muted() { return p2p.muted; },
    get deafened() { return p2p.deafened; },
    send: (opus, frame, last) => desktop?.p2p.sendAudio(frame, last, opus)
  };

  // Called once at start-up
  boot(): void {
    if (!desktop || this.booted) return;
    this.booted = true;
    desktop.p2p.onState(s => this.apply(s));
    desktop.p2p.onAudio((_key, frame, last, opus) => voice.receiveCall(frame, last, opus));
    desktop.p2p.onProfile(key => { void this.loadProfile(key); });
    desktop.p2p.state().then(s => this.apply(s)).catch(() => {});
    if (this.startup) { this.enabled = true; writeFlag(true); }
    if (this.enabled) this.start();
    // Friends' pictures follow the limit in Settings (Largest profile picture, banner or card to fetch): the main process fetches
    // and shows no picture above it, and looks again whenever it is changed. Mbit to bytes; 0 means never.
    $effect.root(() => {
      $effect(() => {
        const mbit = Number(store.settings.bannerMaxMbit) || 0;
        void desktop!.p2p.setPictureLimit(Math.max(0, mbit) * 1_000_000 / 8).catch(() => {});
      });
    });
    // My picture, banner, card backgrounds and description go to friends whenever one of them changes
    $effect.root(() => {
      $effect(() => {
        for (const s of SLOTS) void OWN[s].value;
        void this.description;
        const t = setTimeout(() => { void this.pushProfile(); }, 300);
        return () => clearTimeout(t);
      });
    });
    // Another default identity is another friend code and another friend list
    $effect.root(() => {
      $effect(() => {
        const id = identities.default?.id ?? '';
        if (!id || id === this.identityId) return;
        const first = !this.identityId;
        this.identityId = id;
        if (first) return;
        if (this.enabled) this.start(); else desktop!.p2p.state().then(s => this.apply(s)).catch(() => {});
      });
    });
  }

  get call() { return this.state.call; }
  get requests() { return this.state.requests; }
  get chat() { return this.state.chat; }
  sendChat = async (text: string): Promise<boolean> => (await desktop?.p2p.sendChat(text)) === true;

  nameOf(key: string): string {
    const f = this.state.friends.find(x => x.key === key) ?? this.state.requests.find(x => x.key === key);
    return f?.name || `${key.slice(0, 8)}…`;
  }

  get endNote(): string {
    const e = this.state.lastEnd;
    return e && !this.call ? `${this.nameOf(e.key)}: ${END_TEXT[e.reason]}` : '';
  }

  // ─── Network ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!desktop) return;
    this.busy = true;
    try { this.apply(await desktop.p2p.start()); } catch (e) { this.state = { ...this.state, error: (e as Error).message }; } finally { this.busy = false; }
  }

  setStartup(on: boolean): void {
    this.startup = on;
    writeStartup(on);
  }

  async enable(): Promise<void> {
    this.enabled = true;
    writeFlag(true);
    await this.start();
  }

  async disable(): Promise<void> {
    this.enabled = false;
    writeFlag(false);
    if (!desktop) return;
    this.busy = true;
    try { this.apply(await desktop.p2p.stop()); } catch { /* already stopped */ } finally { this.busy = false; }
  }

  // ─── Friends ────────────────────────────────────────────────────────────────

  // Returns what to tell the person, or '' when it worked
  async add(code: string, name: string): Promise<string> {
    if (!desktop) return '';
    if (!parseFriendCode(code)) return 'That is not a friend code. It is 64 letters and digits (0-9, a-f).';
    try {
      await desktop.p2p.addFriend(code, name);
      this.enabled = true;
      writeFlag(true);
      return '';
    } catch (e) {
      return (e as Error).message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
    }
  }
  // Told to answer a request that came through a server: (their certificate hash, my friend code)
  onAccepted: ((hash: string, myKey: string) => void) | null = null;
  async accept(key: string): Promise<void> {
    if (!desktop) return;
    const r = this.state.requests.find(x => x.key === key);
    await desktop.p2p.acceptRequest(key);
    const mine = this.state.self?.key;
    if (r?.hash && mine) this.onAccepted?.(r.hash, mine);
  }
  decline = (key: string) => desktop?.p2p.declineRequest(key);
  remove = (key: string) => { this.forgetProfile(key); return desktop?.p2p.removeFriend(key); };
  rename = (key: string, name: string) => desktop?.p2p.renameFriend(key, name);
  acceptRequests = (on: boolean) => desktop?.p2p.setAcceptRequests(on);

  // ─── Requests through a Mumble server ─────────────────────────────────────

  isFriend = (hash: string): boolean => !!hash && this.state.friendHashes.includes(hash.toLowerCase());
  isRequested = (hash: string): boolean => !!hash && this.state.sentHashes.includes(hash.toLowerCase());
  // Each of these says whether the saved friend list changed (false: it was ignored)
  async markSent(hash: string, nonce: string): Promise<void> { try { await desktop?.p2p.serverSent(hash, nonce); } catch { /* nothing saved */ } }
  async receiveRequest(code: string, name: string, hash: string, nonce: string): Promise<boolean> {
    try { return !!desktop && (await desktop.p2p.serverRequest(code, name, hash, nonce)) !== 'none'; } catch { return false; }
  }
  async receiveAnswer(code: string, name: string, hash: string): Promise<boolean> {
    try { return !!desktop && (await desktop.p2p.serverAnswer(code, name, hash)) !== 'none'; } catch { return false; }
  }

  // ─── Profiles ───────────────────────────────────────────────────────────────

  profileOf = (key: string): FriendProfile | null => this.profiles[key] ?? null;
  avatarOf = (key: string): string | null => this.profiles[key]?.avatar ?? null;

  setDescription(html: string): void {
    this.description = html;
    try { localStorage.setItem(DESC, html); localStorage.setItem(DESC_SET, '1'); } catch { /* storage unavailable */ }
  }
  // A description that is already on a server is taken over once, for people who set it before friends could see it
  adoptDescription(html: string): void {
    let set = false;
    try { set = localStorage.getItem(DESC_SET) === '1'; } catch { /* storage unavailable */ }
    if (!set && html.trim()) this.setDescription(html);
  }

  // Hands my profile to the main process, which tells friends when it differs from what they were told last
  private engineGuard: ReturnType<typeof setInterval> | undefined;
  private pushAfterCall = false;
  private loadAfterCall = new Set<string>();
  private async pushProfile(): Promise<void> {
    if (!desktop) return;
    // Megabytes of pictures through the page and the main process are not sent while a call is on
    if (this.joined) { this.pushAfterCall = true; return; }
    const run = ++this.pushRun;
    try {
      await Promise.all(SLOTS.map(s => OWN[s].loaded));
      const slots: Record<string, unknown> = {};
      for (const s of SLOTS) {
        const v = OWN[s].value;
        if (!v) continue;
        if (v.kind === 'color') { if (s !== 'avatar') slots[s] = { kind: 'color', color: v.color, scope: v.scope }; continue; }
        const blob = v.kind === 'file' ? v.blob : await (await fetch(v.src)).blob();
        const mime = v.kind === 'file' ? v.mime : dataMime(v.src);
        slots[s] = { kind: 'file', mime, bytes: new Uint8Array(await blob.arrayBuffer()), scope: v.scope };
      }
      // A newer change started while the pictures were being read: that one sends
      if (run !== this.pushRun) return;
      await desktop.p2p.setProfile({ text: this.description, slots });
    } catch { /* the next change sends it again */ }
  }

  async loadProfile(key: string): Promise<void> {
    if (!desktop) return;
    if (this.joined) { this.loadAfterCall.add(key); return; }
    let data: FriendProfileData | null = null;
    try { data = await desktop.p2p.profile(key); } catch { return; }
    if (!data) return;
    const urls: string[] = [];
    const view = (slot: ProfileSlot): BannerView | null => {
      const it = data!.slots[slot];
      if (!it) return null;
      if (it.kind === 'color') return { kind: 'color', color: it.color, ...(it.scope && { scope: it.scope }) };
      const src = URL.createObjectURL(new Blob([it.bytes as BlobPart], { type: it.mime }));
      urls.push(src);
      return { kind: 'image', src, mime: it.mime, ...(it.scope && { scope: it.scope }) };
    };
    const pic = view('avatar');
    const next: FriendProfile = {
      text: data.text,
      avatar: pic?.kind === 'image' ? pic.src + (isVideoMime(pic.mime) ? '#video' : '') : null,
      banner: view('banner'), card: view('card'), profile: view('profile')
    };
    const old = this.urls.get(key);
    this.urls.set(key, urls);
    this.profiles = { ...this.profiles, [key]: next };
    // The old pictures are let go a moment later, so a card that is open never points at a freed address
    if (old) setTimeout(() => old.forEach(u => URL.revokeObjectURL(u)), 5000);
  }

  private forgetProfile(key: string): void {
    this.asked.delete(key);
    this.urls.get(key)?.forEach(u => URL.revokeObjectURL(u));
    this.urls.delete(key);
    const { [key]: _gone, ...rest } = this.profiles;
    this.profiles = rest;
  }

  // ─── Calls ──────────────────────────────────────────────────────────────────

  async callFriend(key: string): Promise<void> {
    if (!desktop || this.call) return;
    this.muted = this.deafened = false;
    await desktop.p2p.call(key);
  }
  // Set by the servers (session.svelte.ts, which this file can not import): leaves every server, since the microphone and the
  // speakers belong to one thing at a time
  beforeAnswer: (() => void) | null = null;
  private leaveServers(): void {
    try { this.beforeAnswer?.(); } catch (err) { console.warn('[call] could not leave the servers', err); }
  }
  async answer(): Promise<void> {
    // Before the call is accepted: the servers let go of the voice first, so they can not take it back from the call
    this.leaveServers();
    this.muted = this.deafened = false;
    await desktop?.p2p.accept();
  }
  async refuse(): Promise<void> { await desktop?.p2p.decline(); }
  async hangUp(): Promise<void> { await desktop?.p2p.hangUp(); }

  setMuted(on: boolean): void {
    this.muted = on;
    if (!on) this.deafened = false;
    this.pushMute();
  }
  setDeafened(on: boolean): void {
    this.deafened = on;
    if (on) this.muted = true;
    this.pushMute();
  }
  private pushMute(): void {
    desktop?.p2p.setMute(this.muted, this.deafened);
    voice.refresh();
  }

  // ─── From the main process ─────────────────────────────────────────────────

  private apply(s: P2pState): void {
    this.state = s;
    // What was kept of each friend, once for each, and again whenever the main process says it changed
    for (const f of s.friends) if (f.status === 'friend' && !this.asked.has(f.key)) { this.asked.add(f.key); void this.loadProfile(f.key); }
    const c = s.call;
    const key = c ? `${c.key}:${c.dir}:${c.state}` : '';
    const changed = key !== this.lastCall;
    this.lastCall = key;

    // The microphone and speakers join the call while it is active, and leave when it ends
    if (c?.state === 'active' && !this.joined) {
      this.joined = true;
      // The call is on, whoever answered it and from wherever (this side or theirs): both leave every server first, so a server
      // can not hold the microphone and speakers the call needs
      this.leaveServers();
      voice.joinCall(this.link).then(() => this.pushMute());
      // The call is active but the audio engine is not running (it was stopped by something, or never came up): it starts again.
      // Nothing else would: the call looks fine and is silent.
      clearInterval(this.engineGuard);
      this.engineGuard = setInterval(() => {
        if (!this.joined) return;
        if (!voice.running && !voice.starting) {
          console.warn('[voice] the audio engine was not running during a call: starting it again');
          void voice.joinCall(this.link).then(() => this.pushMute());
        }
      }, 2000);
      if (changed) sounds.play('connected');
      // The call is on: the Friends window has done its job
      this.open = false;
    } else if (c?.state !== 'active' && this.joined) {
      this.joined = false;
      clearInterval(this.engineGuard);
      if (this.pushAfterCall) { this.pushAfterCall = false; void this.pushProfile(); }
      for (const k of [...this.loadAfterCall]) { this.loadAfterCall.delete(k); void this.loadProfile(k); }
      voice.leaveCall();
      this.muted = this.deafened = false;
      sounds.play('disconnected');
    }

    // A ringing call rings until it is answered or gone
    const ringing = c?.dir === 'in' && c.state === 'ringing';
    if (ringing && !this.ring) {
      sounds.play('privateMessage');
      this.ring = setInterval(() => sounds.play('privateMessage'), 2200);
    } else if (!ringing && this.ring) {
      clearInterval(this.ring);
      this.ring = null;
    }
  }
}

export const p2p = new P2pStore();
