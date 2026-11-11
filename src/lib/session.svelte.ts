import { createCodec } from '../core/proto.ts';
import { MumbleClient, describeDenial, type Channel, type User, type TextMessage } from '../core/client.ts';
import { native, openTransport } from './native.ts';
import { share, type ShareKind } from './share.svelte.ts';
import { thumbs } from './thumbs.svelte.ts';
import { watchTogether, type WatchMode } from './watch-together.svelte.ts';
import { textChannels } from './text-channels.ts';
import { MAX_HTML, type TextMsg } from '../core/text-signal.ts';
import { PROFILE_DATA_ID, encodeProfilePing, isProfilePing, isAvatarPing } from '../core/profile-signal.ts';
import type { ServerCertInfo } from '../core/transport.ts';
import { store, type SavedServer } from './settings.svelte.ts';
import { renderIncoming, textToHtml, escapeHtml, formatBytes, type Embed } from './html.ts';
import { makeInlineImage, originalImage, videoPoster } from './images.ts';
import { ownAvatar } from './avatar.svelte.ts';
import { OWN, ownBanner, ownCard, type OwnBannerInput } from './banner.svelte.ts';
import { profileCache, type CachedSlot, type CachedProfile } from './profile-cache.ts';
import { parseBanner, withBanners, stripBanner, sameBanner, dataMime, bannerSignature, type Banner, type BannerView, type Slot } from '../core/banner.ts';
import type { FileMeta } from '../core/file-transfer.ts';
import { files, fileKind } from './files.svelte.ts';
import { announce, isPiece } from '../core/file-transfer.ts';
import { voice } from './audio/voice.svelte.ts';
import { sounds } from './audio/sounds.svelte.ts';
import { mentions } from './mentions.ts';

const codec = createCodec();

// A chat view is a channel ("ch:<id>") or a direct conversation with a user ("dm:<session>").
export type ViewKey = `ch:${number}` | `dm:${number}`;

export interface ChatEntry {
  id: number;
  kind: 'text' | 'system';
  author: string;
  authorSession: number | null;
  self: boolean;
  html: string;
  embeds: Embed[];
  time: number;
  // Someone else's message that mentions us (@name or @all)
  mention?: boolean;
}

// A file being read before it is announced
export interface FileJob {
  id: number;
  key: string;
  name: string;
  progress: number;
}

export interface CertPrompt {
  server: SavedServer;
  hostPort: string;
  fingerprint: string;
  previous: string;
}

// Right-hand panel: member list, a channel (description preview or its side chat), or a user profile
export type Panel =
  | { kind: 'members' }
  | { kind: 'channel'; id: number; tab: 'info' | 'chat' }
  | { kind: 'user'; session: number };

let nextId = 1;

export class Session {
  status = $state<'idle' | 'connecting' | 'connected'>('idle');
  error = $state('');
  server = $state<SavedServer | null>(null);
  // Bumped on every client state change; views read it to re-derive from the client's maps
  tick = $state(0);
  view = $state<ViewKey>('ch:0');
  panel = $state<Panel>({ kind: 'members' });
  logs = $state<Record<string, ChatEntry[]>>({});
  unread = $state<Record<string, number>>({});
  preparing = $state<FileJob[]>([]);
  certPrompt = $state<CertPrompt | null>(null);
  rtt = $state(0);
  // Who in our channel is sharing their screen, by session (mumh5 clients only)
  sharing = $state<Record<number, ShareKind>>({});
  // A small frame of what someone hosts (see thumbs.svelte.ts), as an object URL, by session
  frames = $state<Record<number, string>>({});
  // Who in our channel is hosting a watch together session, by session
  watchTogether = $state<Record<number, { mode: WatchMode; title: string }>>({});
  // Why the last connection ended, shown with a Reconnect button (null after a normal disconnect)
  disconnectInfo = $state<{ kind: 'kicked' | 'banned' | 'lost' | 'rejected'; by: string; reason: string } | null>(null);
  private removedBy: { kind: 'kicked' | 'banned'; by: string; reason: string } | null = null;
  // Last known channel per user, to tell joins from leaves of our channel for sounds
  private lastChannel = new Map<number, number>();
  // TLS details of the current server, for the certificate viewer and the trusted badge
  serverCert = $state<ServerCertInfo | null>(null);
  // Channel tree expansion the user chose; channels not in here follow the default
  expanded = $state<Record<number, boolean>>({});
  // Channel highlighted by a single click in the tree (a double click joins)
  selectedChannel = $state<number | null>(null);

  client: MumbleClient | null = null;
  // Incremented per connect so a slow, superseded attempt can tell it is stale
  private attempt = 0;
  // Blob hashes already requested, so a preview does not ask the server repeatedly
  private requested = new Set<string>();
  // Pictures of people here as object URLs, made the first time each one is shown
  private pictures = new Map<number, { bytes: Uint8Array; url: string }>();
  // Pictures to fetch, collected while a list renders and asked for in one request
  private wantedPictures = new Set<number>();
  // Last file announcement with a preview picture, resent without it if the server refuses it
  private lastImageSend: { key: string; fallback: string; at: number } | null = null;
  // Channel we asked to move to; the chat view switches when the server confirms it
  private pendingJoin: number | null = null;
  // A channel to enter as soon as the login is done (connect on start); the name guards against ids that changed
  autoJoin: { id: number; name: string } | null = null;
  // Mute and deafen the app set by itself (your choice from before connecting, or restored when
  // voice comes back here); the server's confirmation of exactly that plays no sound
  private applied: { mute: boolean; deaf: boolean } | null = null;
  // Your mute and deafen as last seen, so sounds follow real changes: the server repeats fields that
  // did not change (unmuting also sends "not deafened")
  private own: { mute: boolean; deaf: boolean } | null = null;

  // ─── Derived helpers ────────────────────────────────────────────────────────
  // The client mutates its objects in place. These return shallow copies and read `tick`,
  // so every state change hands Svelte new objects and dependent views update.

  get self(): User | null {
    void this.tick;
    const u = this.client?.self;
    return u ? { ...u } : null;
  }

  channel(id: number): Channel | undefined {
    void this.tick;
    const c = this.client?.channels.get(id);
    return c && { ...c };
  }

  user(session: number): User | undefined {
    void this.tick;
    const u = this.client?.users.get(session);
    return u && { ...u };
  }

  childrenOf(parent: number | null): Channel[] {
    void this.tick;
    if (!this.client) return [];
    return [...this.client.channels.values()]
      .filter(c => (parent === null ? c.id === 0 : c.parent === parent && c.id !== 0))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map(c => ({ ...c }));
  }

  usersIn(channelId: number): User[] {
    void this.tick;
    if (!this.client) return [];
    return [...this.client.users.values()]
      .filter(u => u.channelId === channelId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(u => ({ ...u }));
  }

  allUsers(): User[] {
    void this.tick;
    return this.client ? [...this.client.users.values()].sort((a, b) => a.name.localeCompare(b.name)).map(u => ({ ...u })) : [];
  }

  // Users in a channel and all of its subchannels
  subtreeUserCount(id: number): number {
    void this.tick;
    const client = this.client;
    if (!client) return 0;
    const ids = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of client.channels.values()) {
        if (c.parent != null && ids.has(c.parent) && !ids.has(c.id)) { ids.add(c.id); grew = true; }
      }
    }
    let n = 0;
    for (const u of client.users.values()) if (ids.has(u.channelId)) n++;
    return n;
  }

  // Collapsed by default; channels with people in them open up, like the desktop client
  isExpanded(id: number): boolean {
    if (id === 0) return true;
    return this.expanded[id] ?? this.subtreeUserCount(id) > 0;
  }

  toggleExpanded(id: number): void {
    this.expanded[id] = !this.isExpanded(id);
  }

  // Collapsing goes back to the default: channels with people in them stay open
  setAllExpanded(open: boolean): void {
    const all: Record<number, boolean> = {};
    if (open) for (const id of this.client?.channels.keys() ?? []) all[id] = true;
    this.expanded = all;
  }

  // What the server told us about itself, for the server information dialog
  get serverInfo() {
    void this.tick;
    const c = this.client;
    if (!c) return null;
    return { version: c.serverVersion, maxBandwidth: c.maxBandwidth, config: { ...c.config }, users: c.users.size, channels: c.channels.size };
  }

  // How voice travels right now
  get voiceTransport(): { udp: boolean; rtt: number } {
    void this.tick;
    const c = this.client;
    // The setting (reactive) rather than the client's copy, so toggling it updates the view
    return { udp: !!c && c.udpOk && !voice.settings.forceTcp, rtt: c?.udpRtt ?? 0 };
  }

  // true / false when known, null when the server has not told us yet
  can(channelId: number, bit: number): boolean | null {
    void this.tick;
    return this.client?.can(channelId, bit) ?? null;
  }

  // Whether a channel lies somewhere below another (a channel cannot move into its own subtree)
  // A channel that is read and written without joining it (mumh5 clients only)
  isText(channelId: number): boolean {
    void this.tick;
    return textChannels.isText(this, channelId);
  }

  isInside(channelId: number, ancestor: number): boolean {
    let c = this.client?.channels.get(channelId);
    while (c && c.parent != null) {
      if (c.parent === ancestor) return true;
      c = this.client?.channels.get(c.parent);
    }
    return false;
  }

  viewTitle(key: string = this.view): string {
    const [kind, id] = key.split(':');
    if (kind === 'ch') return this.channel(Number(id))?.name || 'Root';
    return this.user(Number(id))?.name ?? 'Offline user';
  }

  // Keys whose chat is on screen right now (main view and an open side chat)
  private visibleKeys(): string[] {
    const keys: string[] = [this.view];
    if (this.panel.kind === 'channel' && this.panel.tab === 'chat') keys.push(`ch:${this.panel.id}`);
    return keys;
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  async connect(server: SavedServer): Promise<void> {
    this.disconnect();
    const attempt = ++this.attempt;
    this.server = server;
    this.error = '';
    this.logs = {};
    this.unread = {};
    this.expanded = {};
    this.selectedChannel = null;
    this.panel = { kind: 'members' };
    this.requested.clear();
    this.dropPictures();
    this.applied = null;
    this.own = null;
    this.serverCert = null;
    this.disconnectInfo = null;
    this.removedBy = null;
    this.status = 'connecting';

    if (!native) {
      this.fail('Connecting needs the desktop app or the web build served by a mumh5 proxy.');
      return;
    }

    let transport;
    let info;
    try {
      transport = (await openTransport(server.host, server.port, server.identityId))!;
      // Superseded while the identity was being prepared
      if (attempt !== this.attempt) return transport.close();
      info = await transport.secure;
    } catch (e) {
      if (attempt === this.attempt) this.fail((e as Error).message);
      return;
    }
    if (attempt !== this.attempt) return transport.close();
    this.serverCert = info;

    // Trust on first use: pin the certificate, and stop before sending credentials if it changed
    const hostPort = `${server.host.toLowerCase()}:${server.port}`;
    const pinned = store.pins[hostPort];
    if (!pinned) {
      store.pin(hostPort, info.fingerprint);
    } else if (pinned !== info.fingerprint && !info.authorized) {
      transport.close();
      this.certPrompt = { server, hostPort, fingerprint: info.fingerprint, previous: pinned };
      this.fail('The server certificate changed.');
      return;
    }

    const client = new MumbleClient(codec);
    client.forceTcp = voice.settings.forceTcp;
    this.client = client;
    this.wire(client);
    // TLS is up but the server may still never finish the login
    setTimeout(() => { if (this.client === client && !client.synced) client.disconnect('Login timed out'); }, 20000);
    const platform = await native.platformInfo();
    if (attempt !== this.attempt) return transport.close();
    client.connect(transport, {
      username: server.username,
      password: server.password,
      os: platform.os,
      osVersion: platform.osVersion
    });
  }

  reconnect(): void {
    if (this.server) this.connect($state.snapshot(this.server) as SavedServer);
  }

  acceptCertificate(): void {
    const p = this.certPrompt;
    if (!p) return;
    store.pin(p.hostPort, p.fingerprint);
    this.certPrompt = null;
    this.connect(p.server);
  }

  disconnect(): void {
    this.autoJoin = null;
    this.attempt++;
    const client = this.client;
    this.client = null;
    client?.disconnect();
    share.closed(this);
    thumbs.closed(this);
    textChannels.closed(this);
    files.closed(this);
    watchTogether.closed(this);
    this.dropPictures();
    this.dropFrames();
    this.sharing = {};
    this.bannerWait = false;
    this.bannerFiles = {};
    this.dropProfiles();
    sessions.onClosed(this);
    this.status = 'idle';
    this.tick++;
  }

  private fail(msg: string): void {
    this.status = 'idle';
    this.error = msg;
  }

  private wire(client: MumbleClient): void {
    const live = () => this.client === client;
    const bump = () => { if (live()) this.tick++; };

    client.on('synced', () => {
      if (!live()) return;
      this.status = 'connected';
      this.view = `ch:${client.self?.channelId ?? 0}`;
      sessions.onSynced(this);
      sounds.play('connected');
      for (const u of client.users.values()) this.lastChannel.set(u.session, u.channelId);
      // What we may do per channel, for menus (not rate limited by the server)
      for (const id of client.channels.keys()) client.requestPermissions(id);
      // Connect on start: go back to the channel you were last in, if it is still there
      if (!this.autoJoin && this.server && client.self) store.rememberChannel(this.server.id, client.self.channelId, client.channels.get(client.self.channelId)?.name ?? '');
      const back = this.autoJoin;
      this.autoJoin = null;
      if (back) {
        const ch = client.channels.get(back.id);
        if (ch && (ch.name || 'Root') === (back.name || 'Root') && client.self?.channelId !== back.id) this.joinChannel(back.id);
      }
      if (client.welcomeText) this.system(this.view, client.welcomeText, true);
      // Your picture, kept on this device (servers drop it when you leave unless you are registered)
      ownAvatar.loaded.then(() => { if (live() && ownAvatar.bytes) this.sendPicture(ownAvatar.bytes); });
      // Your banner rides in your description
      Promise.all([ownBanner.loaded, ownCard.loaded]).then(() => { if (live()) this.syncBanner(); });
      share.entered(this);
      thumbs.entered(this);
      textChannels.entered(this);
      watchTogether.entered(this);
      bump();
    });
    client.on('pluginData', (sender, dataId, data) => {
      if (!live()) return;
      share.receive(this, sender, dataId, data);
      thumbs.receive(this, sender, dataId, data);
      textChannels.receive(this, sender, dataId, data);
      files.receive(this, sender, dataId, data);
      watchTogether.receive(this, sender, dataId, data);
      this.receiveProfilePing(sender, dataId, data);
    });
    client.on('channel', ch => {
      if (live() && client.synced && !client.permissions.has(ch.id)) client.requestPermissions(ch.id);
      if (live() && client.synced) textChannels.channelChanged(this, ch.id);
      bump();
    });
    client.on('permissions', () => {
      if (!live()) return;
      // A flush means permissions changed somewhere (e.g. an ACL edit); ask again
      if (!client.permissions.size) for (const id of client.channels.keys()) client.requestPermissions(id);
      bump();
    });
    client.on('channelRemove', id => {
      if (!live()) return;
      if (this.panel.kind === 'channel' && this.panel.id === id) this.panel = { kind: 'members' };
      textChannels.channelRemoved(this, id);
      // The chat on screen is gone: back to the channel we are in
      if (this.view === `ch:${id}`) this.view = `ch:${client.self?.channelId ?? 0}`;
      delete this.logs[`ch:${id}`];
      delete this.unread[`ch:${id}`];
      bump();
    });
    client.on('ping', rtt => { if (live()) this.rtt = rtt; });
    client.on('udp', bump);

    client.on('user', (user, changed, actor, isNew) => {
      if (!live()) return;
      const self = client.self;
      const before = this.lastChannel.get(user.session);
      this.lastChannel.set(user.session, user.channelId);
      if (client.synced && self && (isNew || changed.includes('channelId'))) {
        if (user.session === self.session) {
          share.entered(this); watchTogether.selfMoved(this);
          // Not while a channel is still being entered on start: that would overwrite where we are going
          if (this.server && !this.autoJoin) store.rememberChannel(this.server.id, user.channelId, client.channels.get(user.channelId)?.name ?? '');
        }
        else { share.userMoved(this, user); thumbs.userMoved(this, user); }
      }
      let flips = { mute: false, deaf: false };
      // Our own description arrived after we asked for it: now the banner can be put into it
      if (self && user.session === self.session && this.bannerWait && changed.includes('comment')) this.syncBanner();
      if (self && user.session === self.session) {
        const was = this.own;
        this.own = { mute: user.selfMute, deaf: user.selfDeaf };
        if (was) flips = { mute: was.mute !== user.selfMute, deaf: was.deaf !== user.selfDeaf };
        if (this.applied && (changed.includes('selfMute') || changed.includes('selfDeaf'))) {
          if (user.selfMute === this.applied.mute && user.selfDeaf === this.applied.deaf) flips = { mute: false, deaf: false };
          this.applied = null;
        }
      }
      if (client.synced && self && this.isVoice()) this.userSound(user.session === self.session, user, changed, actor, isNew, before, self.channelId, flips);
      if (client.synced && self) {
        if (isNew) {
          if (user.channelId === self.channelId) this.system(`ch:${self.channelId}`, `${escapeHtml(user.name)} connected`);
        } else if (changed.includes('userId') && user.userId != null) {
          const who = user.session === self.session ? 'You are' : `${escapeHtml(user.name)} is`;
          this.system(this.view, `${who} now registered on this server`);
        } else if (changed.includes('channelId')) {
          if (user.session === self.session) {
            // Follow our own channel moves in the chat view (also from a DM when we asked to join)
            if (this.view.startsWith('ch:') || this.pendingJoin === user.channelId) this.selectView(`ch:${user.channelId}`);
            this.pendingJoin = null;
            this.system(`ch:${user.channelId}`, `You joined ${escapeHtml(this.channel(user.channelId)?.name || 'Root')}`);
          } else if (user.channelId === self.channelId) {
            this.system(`ch:${self.channelId}`, `${escapeHtml(user.name)} joined the channel`);
          }
        }
      }
      bump();
    });

    client.on('userRemove', (user, actor, reason, ban) => {
      if (!live()) return;
      // We were kicked or banned; the server closes the connection right after
      if (user.session === client.session) {
        const by = actor != null ? client.users.get(actor)?.name ?? '' : '';
        this.removedBy = { kind: ban ? 'banned' : 'kicked', by, reason };
      }
      const self = client.self;
      share.userMoved(this, user, true);
      textChannels.userLeft(this, user.session);
      files.userLeft(this, user.session);
      watchTogether.userMoved(this, user, true);
      if (self && user.session !== self.session && this.isVoice() && user.channelId === self.channelId) {
        const byOther = actor != null && actor !== user.session;
        sounds.play(ban ? 'userBanned' : byOther ? 'userKicked' : 'userDisconnected');
      }
      this.lastChannel.delete(user.session);
      if (self && user.channelId === self.channelId) {
        const by = actor != null && actor !== user.session ? client.users.get(actor)?.name : null;
        const what = by ? `${ban ? 'was banned' : 'was kicked'} by ${escapeHtml(by)}` : 'disconnected';
        this.system(`ch:${self.channelId}`, `${escapeHtml(user.name)} ${what}${reason ? `: ${escapeHtml(reason)}` : ''}`);
      }
      if (this.panel.kind === 'user' && this.panel.session === user.session) this.panel = { kind: 'members' };
      const pic = this.pictures.get(user.session);
      if (pic) { URL.revokeObjectURL(pic.url); this.pictures.delete(user.session); }
      this.dropFrame(user.session);
      this.dropProfile(user.session);
      bump();
    });

    client.on('text', msg => {
      if (!live()) return;
      // Pieces of a file we asked for: never shown
      if (isPiece(msg.html)) {
        if (msg.actor != null) files.piece(this, msg.actor, msg.html);
        return;
      }
      this.receive(client, msg);
      if (msg.actor != null && msg.actor !== client.session) {
        sounds.play(this.mentionsMe(msg.html) ? 'mention' : msg.channels.length || msg.trees.length ? 'message' : 'privateMessage');
      }
    });

    client.on('permissionDenied', d => {
      if (!live()) return;
      // A preview picture can exceed what the server accepts; the file alone still gets through
      const img = this.lastImageSend;
      if (d.type === 4 && img && Date.now() - img.at < 5000) {
        this.lastImageSend = null;
        this.system(img.key, 'The server refused the preview picture, sent the file without it');
        client.sendText(this.target(img.key), img.fallback);
        return;
      }
      if (d.channelId != null && d.channelId === this.pendingJoin) this.pendingJoin = null;
      sounds.play('denied');
      const ch = d.channelId != null ? client.channels.get(d.channelId)?.name : undefined;
      this.system(this.view, escapeHtml(describeDenial(d, ch)));
    });

    client.on('reject', (_type, reason) => {
      if (!live()) return;
      this.removedBy = null;
      this.disconnectInfo = { kind: 'rejected', by: '', reason };
    });

    client.on('close', reason => {
      if (this.client !== client) return;
      if (this.removedBy) this.disconnectInfo = this.removedBy;
      else if (!this.disconnectInfo && reason !== 'Disconnected') this.disconnectInfo = { kind: 'lost', by: '', reason };
      const kind = this.disconnectInfo?.kind;
      sounds.play(kind === 'kicked' ? 'kicked' : kind === 'banned' ? 'banned' : kind === 'lost' ? 'connectionLost' : kind === 'rejected' ? 'error' : 'disconnected');
      this.client = null;
      textChannels.closed(this);
      files.closed(this);
      watchTogether.closed(this);
      sessions.onClosed(this);
      this.status = 'idle';
      this.error = reason === 'Disconnected' ? '' : reason;
      this.tick++;
    });
  }

  // Presence sounds only come from the server where voice runs; others would be noise
  private isVoice(): boolean {
    return sessions.voiceId === this.server?.id;
  }

  // flips: which of your own mute and deafen really changed (and not by the app itself)
  private userSound(isSelf: boolean, user: User, changed: string[], actor: number | null, isNew: boolean, before: number | undefined, mine: number, flips: { mute: boolean; deaf: boolean }): void {
    if (isSelf) {
      const byOther = actor != null && actor !== user.session;
      if (changed.includes('channelId')) sounds.play(byOther ? 'moved' : 'switchedChannel');
      if (!byOther && flips.deaf) sounds.play(user.selfDeaf ? 'deafen' : 'undeafen');
      else if (!byOther && flips.mute) sounds.play(user.selfMute ? 'mute' : 'unmute');
      return;
    }
    const self = actor == null || actor === user.session;
    if (isNew) {
      if (user.channelId === mine) sounds.play('userConnected');
    } else if (changed.includes('channelId')) {
      if (user.channelId === mine) sounds.play(self ? 'userJoined' : 'userMovedIn');
      else if (before === mine) sounds.play(self ? 'userLeft' : 'userMovedOut');
    }
    if (changed.includes('recording') && user.channelId === mine) sounds.play(user.recording ? 'recordingStarted' : 'recordingStopped');
  }

  // ─── Panels, descriptions, comments ─────────────────────────────────────────

  showChannel(id: number, tab: 'info' | 'chat' = 'info'): void {
    this.panel = { kind: 'channel', id, tab };
    if (tab === 'chat') delete this.unread[`ch:${id}`];
    this.loadDescription(id);
  }

  showUser(session: number): void {
    this.panel = { kind: 'user', session };
    this.loadComment(session);
  }

  closePanel(): void {
    this.panel = { kind: 'members' };
  }

  // Long descriptions and comments are only announced by hash; fetch the text on demand
  loadDescription(id: number): void {
    const c = this.client?.channels.get(id);
    if (!c?.descriptionHash || c.description) return;
    const tag = `d:${id}:${[...c.descriptionHash].join(',')}`;
    if (this.requested.has(tag)) return;
    this.requested.add(tag);
    this.client!.requestBlob({ descriptions: [id] });
  }

  loadComment(session: number): void {
    const u = this.client?.users.get(session);
    if (!u?.commentHash || u.comment) return;
    const tag = `c:${session}:${[...u.commentHash].join(',')}`;
    if (this.requested.has(tag)) return;
    this.requested.add(tag);
    this.client!.requestBlob({ comments: [session] });
  }

  // Object URL of someone's picture, or null for the letter instead. Pictures are only announced
  // by hash; the first call asks the server for them, and the view updates when they arrive.
  avatar(session: number | null | undefined): string | null {
    void this.tick;
    const client = this.client;
    if (!client || session == null) return null;
    if (session === client.session && ownAvatar.url) return ownAvatar.url;
    const u = client.users.get(session);
    if (!u) return null;
    if (!u.texture) {
      if (u.textureHash) this.wantPicture(session, u.textureHash);
      return null;
    }
    // Empty: the picture was removed
    if (!u.texture.length) return null;
    const have = this.pictures.get(session);
    if (have?.bytes === u.texture) return have.url;
    if (have) URL.revokeObjectURL(have.url);
    const url = URL.createObjectURL(new Blob([u.texture as BlobPart]));
    this.pictures.set(session, { bytes: u.texture, url });
    return url;
  }

  private wantPicture(session: number, hash: Uint8Array): void {
    const tag = `t:${session}:${[...hash].join(',')}`;
    if (this.requested.has(tag)) return;
    this.requested.add(tag);
    this.wantedPictures.add(session);
    if (this.wantedPictures.size > 1) return;
    // Called while rendering: ask once the render is done, for everyone seen in it
    queueMicrotask(() => {
      const ids = [...this.wantedPictures];
      this.wantedPictures.clear();
      this.client?.requestBlob({ textures: ids });
    });
  }

  // The frame of what someone hosts, for their tile
  frame(session: number): string | null {
    return this.frames[session] ?? null;
  }
  setFrame(session: number, bytes: Uint8Array): void {
    const old = this.frames[session];
    this.frames[session] = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
    if (old) URL.revokeObjectURL(old);
  }
  dropFrame(session: number): void {
    const old = this.frames[session];
    if (!old) return;
    URL.revokeObjectURL(old);
    delete this.frames[session];
  }
  private dropFrames(): void {
    for (const url of Object.values(this.frames)) URL.revokeObjectURL(url);
    this.frames = {};
  }

  private dropPictures(): void {
    for (const p of this.pictures.values()) URL.revokeObjectURL(p.url);
    this.pictures.clear();
    this.wantedPictures.clear();
  }

  // Sends your picture if this server takes one that large (it drops larger ones without a word)
  sendPicture(bytes: Uint8Array): boolean {
    const client = this.client;
    if (!client || this.status !== 'connected') return false;
    const limit = client.config.imageMessageLength;
    if (limit > 0 && bytes.length > limit) return false;
    client.setTexture(bytes);
    return true;
  }

  register(session: number): void {
    this.client?.register(session);
  }

  // Mumble has no rename while connected: reconnect under the new name (saved for this server)
  changeName(name: string): void {
    const server = this.server;
    if (!server || !name.trim()) return;
    const updated = { ...$state.snapshot(server), username: name.trim() };
    store.upsertServer(updated);
    this.connect(updated);
  }

  // html comes from the rich editor, already sanitized XHTML. Your banner and card background are kept in it.
  setComment(html: string): void {
    const client = this.client;
    if (!client) return;
    const text = stripBanner(html);
    const limit = client.config.imageMessageLength;
    const withIt = withBanners(text, { banner: this.currentWire('banner'), card: this.currentWire('card'), profile: this.currentWire('profile') });
    client.setComment(limit > 0 && withIt.length > limit ? text : withIt);
    this.pingProfile();
  }

  // ─── Other people's banners and card backgrounds ────────────────────────────

  // What each person in view has, as it can be drawn (see ensureProfile)
  profiles = $state<Record<number, Record<Slot, BannerView | null>>>({});
  private profileKey = new Map<number, string>();
  private profileUrls = new Map<number, string[]>();

  // Someone's banner (or card background) as the card draws it; null: none, not here yet, or too large to fetch
  banner(session: number | null | undefined, slot: Slot = 'banner'): BannerView | null {
    void this.tick;
    const client = this.client;
    if (!client || session == null) return null;
    if (session === client.session) return OWN[slot].view();
    return this.profiles[session]?.[slot] ?? null;
  }

  // What a tile shows behind someone: their card background, else their banner
  cardBackground(session: number | null | undefined): BannerView | null {
    return this.banner(session, 'card') ?? this.banner(session, 'banner');
  }

  // Gets someone's banner and card background ready: from the description when it is here, else from
  // what this computer kept of them when their description has not changed (compared by its hash),
  // else the description is fetched. A picture too big for a description is fetched from them over
  // WebRTC, within the limit in Settings, unless the copy kept here has the same hash.
  ensureProfile(user: { session: number; name: string; comment: string; commentHash: Uint8Array | null }): void {
    const client = this.client;
    if (!client || user.session === client.session) return;
    if (!user.comment && !user.commentHash) {
      this.profileKey.delete(user.session);
      if (this.profiles[user.session]) this.dropProfile(user.session);
      return;
    }
    const hash = user.commentHash ? [...user.commentHash].map(b => b.toString(16).padStart(2, '0')).join('') : '';
    // The text itself counts too: a short description arrives without a new hash, so the hash alone says nothing
    const key = `${hash}:${user.comment ? 'text:' + bannerSignature(user.comment) : 'hash'}:${user.name}`;
    if (this.profileKey.get(user.session) === key) return;
    this.profileKey.set(user.session, key);
    void this.buildProfile(user.session, user.name, hash, user.comment, key).catch(() => {});
  }

  private setProfile(session: number, key: string, slot: Slot, view: BannerView | null): void {
    if (this.profileKey.get(session) !== key) return;
    this.profiles = { ...this.profiles, [session]: { ...(this.profiles[session] ?? { banner: null, card: null, profile: null }), [slot]: view } };
  }

  private async buildProfile(session: number, name: string, hash: string, comment: string, key: string): Promise<void> {
    const stale = () => this.profileKey.get(session) !== key || !this.client;
    const cached = await profileCache.read(name);
    if (stale()) return;
    if (!comment) {
      // Only the hash is known: the same hash as last time is the same profile
      if (cached && hash && cached.commentHash === hash) {
        const urls: string[] = [];
        for (const slot of ['banner', 'card', 'profile'] as const) {
          const c = cached[slot];
          const view = c ? await this.cachedView(name, slot, c, urls) : null;
          if (stale()) { for (const u of urls) URL.revokeObjectURL(u); return; }
          this.setProfile(session, key, slot, view);
        }
        this.keepUrls(session, urls);
        return;
      }
      this.loadComment(session);
      return;
    }
    const urls: string[] = [];
    const results = await Promise.all((['banner', 'card', 'profile'] as const).map(async slot => {
      const r = await this.resolveSlot(session, name, slot, parseBanner(comment, slot), cached, urls);
      this.setProfile(session, key, slot, r.view);
      return r;
    }));
    if (stale()) { for (const u of urls) URL.revokeObjectURL(u); return; }
    this.keepUrls(session, urls);
    // Kept for next time, when the description has a hash to compare by. Short descriptions are sent as text
    // without a new hash, so the hash here could be an old one: those are not kept.
    if (hash && comment.length > 128) {
      const meta: CachedProfile = { v: 1, commentHash: hash, banner: results[0].saved, card: results[1].saved, profile: results[2].saved };
      await profileCache.write(name, meta, { banner: results[0].blob, card: results[1].blob, profile: results[2].blob });
    }
  }

  private keepUrls(session: number, urls: string[]): void {
    for (const u of this.profileUrls.get(session) ?? []) URL.revokeObjectURL(u);
    if (urls.length) this.profileUrls.set(session, urls); else this.profileUrls.delete(session);
  }

  private async cachedView(name: string, slot: Slot, c: CachedSlot, urls: string[]): Promise<BannerView | null> {
    if (c.kind === 'color' && c.color) return { kind: 'color', color: c.color };
    if (!c.mime) return null;
    const blob = await profileCache.readBlob(name, slot, c.mime);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urls.push(url);
    return { kind: 'image', src: url, mime: c.mime, ...(c.scope && { scope: c.scope }) };
  }

  private async resolveSlot(session: number, name: string, slot: Slot, wire: Banner | null, cached: CachedProfile | null,
    urls: string[]): Promise<{ view: BannerView | null; saved: CachedSlot | null; blob: Blob | null }> {
    const none = { view: null, saved: null, blob: null };
    if (!wire) return none;
    if (wire.kind === 'color') return { view: wire, saved: { kind: 'color', color: wire.color }, blob: null };
    if (wire.kind === 'image') {
      const mime = dataMime(wire.src);
      const bytes = Uint8Array.from(atob(wire.src.slice(wire.src.indexOf(',') + 1)), c => c.charCodeAt(0));
      return { view: { kind: 'image', src: wire.src, mime, ...(wire.scope && { scope: wire.scope }) }, saved: { kind: 'image', mime, ...(wire.scope && { scope: wire.scope }) }, blob: new Blob([bytes], { type: mime }) };
    }
    const meta = wire.meta;
    // The copy kept here, when it is the same picture
    const c = cached?.[slot];
    if (c?.kind === 'file' && c.hash === meta.h && c.mime) {
      const view = await this.cachedView(name, slot, c, urls);
      // The same picture, perhaps with another scope now
      if (view?.kind === 'image') return { view: { ...view, scope: wire.scope }, saved: { ...c, scope: wire.scope }, blob: await profileCache.readBlob(name, slot, c.mime) };
    }
    // Fetched from them, if the limit in Settings allows it
    const limit = store.settings.bannerMaxMbit * 1_000_000 / 8;
    if (!(limit > 0) || meta.s > limit || !files.supported(this)) return none;
    await files.check(meta);
    const t = files.transfers[meta.i];
    if (!t || t.state === 'idle' || t.state === 'failed') files.download(this, meta, session);
    const url = await this.waitReady(meta.i);
    const blob = url ? await files.blobOf(meta.i) : null;
    if (!url || !blob) return none;
    return { view: { kind: 'image', src: url, mime: meta.m, ...(wire.scope && { scope: wire.scope }) }, saved: { kind: 'file', hash: meta.h, mime: meta.m, ...(wire.scope && { scope: wire.scope }) }, blob };
  }

  // The address of a file once it has arrived; null when the transfer fails or takes too long
  private waitReady(id: string): Promise<string | null> {
    return new Promise(resolve => {
      let stop: (() => void) | undefined;
      let done = false;
      const finish = (v: string | null) => { if (done) return; done = true; clearTimeout(timer); queueMicrotask(() => stop?.()); resolve(v); };
      const timer = setTimeout(() => finish(null), 120000);
      stop = $effect.root(() => {
        $effect(() => {
          const t = files.transfers[id];
          if (t?.state === 'ready' && t.url) finish(t.url);
          else if (t?.state === 'failed') finish(null);
        });
      });
    });
  }

  // ─── Telling others our profile changed, and hearing the same from them ──────

  // Everyone else on the server looks at our banner, card background and description again
  pingProfile(avatar = false): void {
    const client = this.client;
    if (!client || this.status !== 'connected' || client.session == null) return;
    const others = [...client.users.keys()].filter(s => s !== client.session);
    if (others.length) client.sendPluginData(others, PROFILE_DATA_ID, encodeProfilePing(avatar));
  }

  private profilePings = new Map<number, ReturnType<typeof setTimeout>>();
  private avatarPings = new Map<number, ReturnType<typeof setTimeout>>();
  private receiveProfilePing(sender: number, dataId: string, data: Uint8Array): void {
    if (dataId !== PROFILE_DATA_ID || !isProfilePing(data)) return;
    const client = this.client;
    if (!client || sender === client.session || !client.users.has(sender)) return;
    if (isAvatarPing(data)) {
      if (this.avatarPings.has(sender)) return;
      this.avatarPings.set(sender, setTimeout(() => { this.avatarPings.delete(sender); this.refreshAvatar(sender); }, 300));
      return;
    }
    // Several in a row count as one; the short wait lets the server's news of the new description arrive first
    if (this.profilePings.has(sender)) return;
    this.profilePings.set(sender, setTimeout(() => { this.profilePings.delete(sender); this.refreshProfile(sender); }, 300));
  }

  // Forgets the picture we asked for and asks the server for their current one
  private refreshAvatar(session: number): void {
    const u = this.client?.users.get(session);
    if (!u) return;
    for (const tag of this.requested) if (tag.startsWith(`t:${session}:`)) this.requested.delete(tag);
    if (u.textureHash) { u.texture = null; this.wantPicture(session, u.textureHash); }
    this.tick++;
  }

  // Forgets what we kept of someone's profile and builds it again from their description as it is now
  private refreshProfile(session: number): void {
    const user = this.client?.users.get(session);
    if (!user) return;
    this.profileKey.delete(session);
    // Asked-for marks of their description are forgotten too, so it is fetched again if it must be
    for (const tag of this.requested) if (tag.startsWith(`c:${session}:`)) this.requested.delete(tag);
    void profileCache.forget(user.name);
    this.ensureProfile(user);
  }

  private dropProfile(session: number): void {
    this.profileKey.delete(session);
    this.keepUrls(session, []);
    if (this.profiles[session]) {
      const { [session]: _, ...rest } = this.profiles;
      this.profiles = rest;
    }
  }
  private dropProfiles(): void {
    for (const t of this.profilePings.values()) clearTimeout(t);
    this.profilePings.clear();
    for (const t of this.avatarPings.values()) clearTimeout(t);
    this.avatarPings.clear();
    for (const urls of this.profileUrls.values()) for (const u of urls) URL.revokeObjectURL(u);
    this.profileUrls.clear();
    this.profileKey.clear();
    this.profiles = {};
  }

  // ─── Our own banner and card background ─────────────────────────────────────

  // As other people read them on this server. A file one is shared first, under an id from its
  // content, so it stays the same from connect to connect.
  private bannerFiles: Partial<Record<Slot, { blob: Blob; meta: FileMeta }>> = {};
  private async wireBanner(slot: Slot): Promise<Banner | null> {
    const own = OWN[slot].value;
    if (!own) return null;
    if (own.kind !== 'file') return own;
    const have = this.bannerFiles[slot];
    if (have?.blob === own.blob) return { kind: 'file', meta: have.meta, ...(own.scope && { scope: own.scope }) };
    if (!files.supported(this)) return null;
    const meta = await files.share(this, new File([own.blob], slot, { type: own.mime }), () => {}, true);
    if (typeof meta === 'string') return null;
    this.bannerFiles[slot] = { blob: own.blob, meta };
    return { kind: 'file', meta, ...(own.scope && { scope: own.scope }) };
  }
  // The same without waiting: what is known now, or what our description says already
  private currentWire(slot: Slot): Banner | null {
    const own = OWN[slot].value;
    if (!own) return null;
    if (own.kind !== 'file') return own;
    const have = this.bannerFiles[slot];
    return have?.blob === own.blob ? { kind: 'file', meta: have.meta, ...(own.scope && { scope: own.scope }) } : parseBanner(this.client?.self?.comment, slot);
  }

  // Makes our description carry our banner and card background (or none). Our description has to be
  // known first, so it is fetched when the server only announced its hash, and this runs again when it arrives.
  private bannerWait = false;
  // ping: you changed it just now (not the automatic one on connecting), so everyone else is told to look again
  private bannerPing = false;
  syncBanner(ping = false): void {
    if (ping) this.bannerPing = true;
    void this.runBannerSync();
  }
  private async runBannerSync(): Promise<void> {
    const client = this.client;
    const first = client?.self;
    if (!client || !first || this.status !== 'connected') return;
    if (first.commentHash && !first.comment) {
      this.bannerWait = true;
      this.loadComment(first.session);
      return;
    }
    this.bannerWait = false;
    const [banner, card, profile] = await Promise.all((['banner', 'card', 'profile'] as const).map(s => this.wireBanner(s).catch(() => null)));
    // The connection or our description may have changed while a file was being prepared
    const self = client.self;
    if (this.client !== client || this.status !== 'connected' || !self) return;
    if (self.commentHash && !self.comment) return;
    const ping = this.bannerPing;
    this.bannerPing = false;
    // Nothing to write, but someone who could not load it before gets another go
    if (sameBanner(parseBanner(self.comment, 'banner'), banner) && sameBanner(parseBanner(self.comment, 'card'), card) && sameBanner(parseBanner(self.comment, 'profile'), profile)) {
      if (ping) this.pingProfile();
      return;
    }
    const next = withBanners(self.comment, { banner, card, profile });
    const limit = client.config.imageMessageLength;
    // A server with a smaller limit keeps the description as it is
    if (limit > 0 && next.length > limit) return;
    client.setComment(next);
    if (ping) this.pingProfile();
  }

  // Largest description or image message the server accepts (0: no limit)
  get htmlLimit(): number {
    void this.tick;
    return this.client?.config.imageMessageLength ?? 131072;
  }

  // ─── Chat ───────────────────────────────────────────────────────────────────

  // time: for messages from earlier, which go where they belong in the log. quiet: not counted as unread.
  private push(key: string, entry: Omit<ChatEntry, 'id' | 'time'>, opts: { time?: number; quiet?: boolean } = {}): void {
    // Assign first, then push through the stored proxy; pushing onto the raw array would not be reactive
    if (!this.logs[key]) this.logs[key] = [];
    const log = this.logs[key];
    const time = opts.time ?? Date.now();
    let at = log.length;
    while (at > 0 && log[at - 1].time > time) at--;
    log.splice(at, 0, { ...entry, id: nextId++, time });
    if (!opts.quiet && (sessions.active !== this || !this.visibleKeys().includes(key))) this.unread[key] = (this.unread[key] ?? 0) + 1;
    // Files announced just now; ones from earlier wait for a click
    if (!opts.quiet && !entry.self) for (const e of entry.embeds) if (e.file) files.offered(this, e.file, entry.authorSession);
  }

  // Does this message name us (@name) or everybody (@all)?
  mentionsMe(html: string): boolean {
    const me = this.client?.self;
    return !!me && mentions(html, [me.name]);
  }

  // A text channel message: live, kept from earlier, or handed over by another client
  addText(m: TextMsg, self: boolean, quiet: boolean, sender: number | null = null): void {
    const client = this.client;
    if (!client) return;
    const online = sender != null ? client.users.get(sender) : self ? client.self : m.k ? [...client.users.values()].find(u => u.hash === m.k) : undefined;
    this.push(`ch:${m.c}`, {
      kind: 'text', author: online ? store.displayName(online) : m.n, authorSession: online?.session ?? null, self,
      mention: !self && this.mentionsMe(m.h),
      ...renderIncoming(m.h, store.trustedHosts)
    }, { time: m.t, quiet });
  }

  private system(key: string, html: string, trusted = false): void {
    const rendered = trusted ? renderIncoming(html, store.trustedHosts) : { html, embeds: [] };
    this.push(key, { kind: 'system', author: '', authorSession: null, self: false, ...rendered });
  }

  private receive(client: MumbleClient, msg: TextMessage): void {
    const self = client.self;
    const sender = msg.actor != null ? client.users.get(msg.actor) : undefined;
    let key: string;
    if (msg.actor == null) key = this.view;
    else if (msg.channels.length || msg.trees.length) key = `ch:${msg.channels[0] ?? self?.channelId ?? 0}`;
    else key = `dm:${msg.actor}`;

    const rendered = renderIncoming(msg.html, store.trustedHosts);
    if (msg.actor == null) {
      this.push(key, { kind: 'system', author: '', authorSession: null, self: false, ...rendered });
    } else {
      this.push(key, { kind: 'text', author: sender ? store.displayName(sender) : `#${msg.actor}`, authorSession: msg.actor, self: false, mention: msg.actor !== client.session && this.mentionsMe(msg.html), ...rendered });
    }
  }

  // Opening a server marks what is on screen as read
  markVisibleRead(): void {
    for (const k of this.visibleKeys()) delete this.unread[k];
  }

  selectView(key: ViewKey): void {
    this.view = key;
    delete this.unread[key];
  }

  // The view follows once the server confirms the move (see the 'user' handler). Murmur
  // silently drops own state changes sent too quickly (leaky bucket, about one per second),
  // so an unconfirmed join is sent once more before giving up.
  joinChannel(id: number): void {
    const client = this.client;
    if (!client) return;
    // Joining a channel is where you want to talk: voice moves to this server
    sessions.setVoice(this);
    if (this.self?.channelId === id) {
      this.selectView(`ch:${id}`);
      return;
    }
    this.pendingJoin = id;
    client.joinChannel(id);
    const moved = () => this.client !== client || this.pendingJoin !== id || client.self?.channelId === id;
    setTimeout(() => {
      if (moved()) return;
      client.joinChannel(id);
      setTimeout(() => {
        if (moved()) return;
        this.pendingJoin = null;
        this.system(this.view, `The server did not move you to ${escapeHtml(client.channels.get(id)?.name || 'Root')}. Try again in a moment.`);
      }, 1500);
    }, 1200);
  }

  private target(key: string): { channels?: number[]; users?: number[] } {
    const [kind, id] = key.split(':');
    return kind === 'ch' ? { channels: [Number(id)] } : { users: [Number(id)] };
  }

  // Send HTML to a view and echo it locally (the server does not echo our messages).
  sendHtml(html: string, key: string = this.view): boolean {
    const client = this.client;
    if (!client || this.status !== 'connected') return false;
    if (key.startsWith('ch:') && this.isText(Number(key.slice(3)))) {
      if (html.length > MAX_HTML) {
        this.system(key, `Message too long for a text channel (${html.length} / ${MAX_HTML} characters)`);
        return false;
      }
      // Shown in the log by the text channel code once it is on its way
      textChannels.post(this, Number(key.slice(3)), html).then(problem => { if (problem) this.system(key, escapeHtml(problem)); });
      sounds.play('messageSent');
      return true;
    }
    const limit = /<img/i.test(html) ? client.config.imageMessageLength : client.config.messageLength;
    if (limit && html.length > limit) {
      this.system(key, `Message too long for this server (${html.length} / ${limit} characters)`);
      return false;
    }
    client.sendText(this.target(key), html);
    sounds.play('messageSent');
    const rendered = renderIncoming(html, store.trustedHosts);
    this.push(key, { kind: 'text', author: client.self?.name ?? '', authorSession: client.session, self: true, ...rendered });
    return true;
  }

  sendText(text: string, key: string = this.view): boolean {
    const trimmed = text.trim();
    return trimmed ? this.sendHtml(textToHtml(trimmed), key) : false;
  }

  // Pictures that fit as they are go inline, like a pasted picture in the desktop client, and
  // everyone sees them. Everything else is announced in the chat and sent to mumh5 users who
  // ask for it, through the server (see files.svelte.ts); other clients get a preview picture.
  async sendFiles(list: File[], key: string = this.view): Promise<void> {
    const client = this.client;
    if (!client) return;
    const textKey = key.startsWith('ch:') && this.isText(Number(key.slice(3)));
    const cfg = client.config;
    // 0 means no limit; stay reasonable anyway
    const limit = textKey ? MAX_HTML : cfg.imageMessageLength || 1024 * 1024;
    for (const file of list) {
      if (!textKey && cfg.allowHtml === false) {
        this.system(key, 'This server does not allow pictures or files in messages. Text channels can still carry files.');
        return;
      }
      if (file.type.startsWith('image/')) {
        const uri = await originalImage(file, limit - 64);
        if (uri) { this.sendHtml(`<img src="${uri}"/>`, key); continue; }
      }
      if (!files.supported(this)) {
        // Old servers: no requests between clients, so pictures go scaled and other files not at all
        const uri = file.type.startsWith('image/') ? await makeInlineImage(file, limit - 64) : null;
        if (uri) this.sendHtml(`<img src="${uri}"/>`, key);
        else this.system(key, `${escapeHtml(file.name)}: sending files needs a server running Mumble 1.4 or newer`);
        continue;
      }
      const job: FileJob = { id: nextId++, key, name: file.name, progress: 0 };
      this.preparing.push(job);
      const meta = await files.share(this, file, p => {
        const live = this.preparing.find(j => j.id === job.id);
        if (live) live.progress = p;
      });
      this.preparing = this.preparing.filter(j => j.id !== job.id);
      if (typeof meta === 'string') {
        this.system(key, escapeHtml(meta));
        sounds.play('uploadFailed');
        continue;
      }
      // What other clients show; mumh5 shows its own card instead
      const visible = `<b>${escapeHtml(meta.n)}</b> (${formatBytes(meta.s)}, file shared with mumh5)`;
      const plain = announce(meta, visible);
      let preview: string | null = null;
      if (store.settings.sendThumbnails) {
        const budget = Math.min(limit, 100000) - plain.length - 64;
        const kind = fileKind(meta);
        preview = kind === 'image' ? await makeInlineImage(file, budget) : kind === 'video' ? await videoPoster(file, budget) : null;
      }
      const html = preview ? announce(meta, `${visible}<br/><img src="${preview}"/>`) : plain;
      if (preview) this.lastImageSend = { key, fallback: plain, at: Date.now() };
      this.sendHtml(html, key);
    }
  }

  // ─── Voice state and moderation ─────────────────────────────────────────────

  setSharing(session: number, kind: ShareKind | false): void {
    if (kind) this.sharing[session] = kind;
    else { delete this.sharing[session]; if (!this.watchTogether[session]) this.dropFrame(session); }
  }
  clearSharing(): void { this.sharing = {}; }

  setWatchTogether(session: number, info: { mode: WatchMode; title: string } | false): void {
    if (info) {
      this.watchTogether = { ...this.watchTogether, [session]: info };
    } else {
      const { [session]: _, ...rest } = this.watchTogether;
      this.watchTogether = rest;
      if (!this.sharing[session]) this.dropFrame(session);
    }
  }
  clearWatchTogether(): void { this.watchTogether = {}; }

  // The choice is remembered, so it also works while disconnected and carries to the next connect
  setSelfMute(v: boolean) {
    sessions.mute = v;
    if (!v) sessions.deaf = false;
    this.client?.setSelfMute(v);
  }
  setSelfDeaf(v: boolean) {
    sessions.deaf = v;
    if (v) sessions.mute = true;
    this.client?.setSelfDeaf(v);
  }

  // Mute and deafen set by the app rather than by a click, confirmed without a sound
  applyOwnState(mute: boolean, deaf: boolean): void {
    if (!this.client) return;
    const mark = { mute, deaf };
    this.applied = mark;
    this.client.send('UserState', { self_mute: mute, self_deaf: deaf });
    // No confirmation comes when nothing changed; a later click must not be silenced by this
    setTimeout(() => { if (this.applied === mark) this.applied = null; }, 3000);
  }

  kick(session: number, reason: string, ban = false) { this.client?.kick(session, reason, ban); }
  setServerMute(session: number, v: boolean) { this.client?.setUserState(session, { mute: v }); }
  setServerDeaf(session: number, v: boolean) { this.client?.setUserState(session, { deaf: v }); }
  setPrioritySpeaker(session: number, v: boolean) { this.client?.setUserState(session, { priority_speaker: v }); }
  moveUser(session: number, channelId: number) { this.client?.setUserState(session, { channel_id: channelId }); }
}

// ─── Several servers at once ───────────────────────────────────────────────────
// Every server has its own Session. Text works on all of them; voice runs on one (like
// Discord): the server where you last joined a channel. On the others you are shown as
// deafened, so nobody expects you to hear them, and your state is restored when voice returns.

class Sessions {
  list = $state<Session[]>([]);
  activeId = $state<string | null>(null);
  voiceId = $state<string | null>(null);
  private idle = new Session();
  // Self mute/deaf as the user last chose it, like the desktop client: shown and toggled
  // while disconnected and applied to servers when they connect
  mute = $state(false);
  deaf = $state(false);
  // Self mute/deaf before we deafened a background server, to restore later
  private saved = new Map<Session, { mute: boolean; deaf: boolean }>();

  get active(): Session {
    return this.list.find(s => s.server?.id === this.activeId) ?? this.idle;
  }

  byServer(id: string): Session | undefined {
    return this.list.find(s => s.server?.id === id);
  }

  // Your picture for every server: saved here and sent to the ones you are on (null removes it)
  async setAvatar(bytes: Uint8Array | null): Promise<void> {
    await ownAvatar.save(bytes);
    for (const s of this.list) if (s.status === 'connected' && s.sendPicture(bytes ?? new Uint8Array(0))) s.pingProfile(true);
  }

  // Your banner for every server: saved here and written into your description on the ones you are on
  async setBanner(slot: Slot, b: OwnBannerInput | null): Promise<void> {
    // A card background over the whole card would hide a new banner: it gives way
    if (slot === 'banner' && b && OWN.profile.value && OWN.profile.value.kind !== 'color' && OWN.profile.value.scope === 'whole') await OWN.profile.set(null);
    await OWN[slot].set(b);
    for (const s of this.list) if (s.status === 'connected') s.syncBanner(true);
  }

  // At app start: reconnect to the server and channel you were last in
  restoreLast(): void {
    const l = store.lastChannel;
    const server = l.serverId ? store.servers.find(x => x.id === l.serverId) : undefined;
    if (!server || this.byServer(server.id)) return;
    this.open(server);
    const s = this.byServer(server.id);
    if (s) s.autoJoin = { id: l.channelId, name: l.name };
  }

  // Show a server, connecting if needed
  open(server: SavedServer): void {
    let s = this.byServer(server.id);
    this.activeId = server.id;
    s?.markVisibleRead();
    if (!s) {
      s = new Session();
      this.list.push(s);
      s = this.list[this.list.length - 1];
    }
    if (s.status === 'idle') s.connect(server);
  }

  select(id: string): void {
    this.activeId = id;
    this.active.markVisibleRead();
  }

  close(id: string): void {
    const s = this.byServer(id);
    if (!s) return;
    s.disconnect();
    this.list = this.list.filter(x => x !== s);
    if (this.activeId === id) this.activeId = this.list.find(x => x.status !== 'idle')?.server?.id ?? null;
  }

  get voiceSession(): Session | undefined {
    return this.list.find(s => s.server?.id === this.voiceId);
  }

  onSynced(s: Session): void {
    const want = { mute: this.mute, deaf: this.deaf };
    if (!this.voiceId || !this.voiceSession?.client) {
      this.setVoice(s, true);
      if (want.mute) s.applyOwnState(true, want.deaf);
    } else {
      this.toBackground(s);
      // A fresh login is unmuted; restore the user's choice when voice comes here
      if (this.saved.has(s)) this.saved.set(s, want);
    }
  }

  onClosed(s: Session): void {
    this.saved.delete(s);
    if (this.voiceId !== s.server?.id) return;
    voice.detach();
    // Hand voice to another connected server, if any
    const next = this.list.find(x => x !== s && x.client && x.status === 'connected');
    this.voiceId = null;
    if (next) this.setVoice(next);
  }

  setVoice(s: Session, first = false): void {
    const id = s.server?.id ?? null;
    if (!id || (this.voiceId === id && !first)) return;
    const prev = this.voiceSession;
    if (prev && prev !== s) {
      voice.detach();
      this.toBackground(prev);
    }
    this.voiceId = id;
    this.fromBackground(s);
    if (s.client) voice.attach(s.client);
  }

  private toBackground(s: Session): void {
    const self = s.client?.self;
    if (!s.client || !self || this.saved.has(s)) return;
    this.saved.set(s, { mute: self.selfMute, deaf: self.selfDeaf });
    if (!self.selfDeaf) s.client.setSelfDeaf(true);
  }

  private fromBackground(s: Session): void {
    const prev = this.saved.get(s);
    this.saved.delete(s);
    if (!prev || !s.client || prev.deaf) return;
    s.applyOwnState(prev.mute, false);
  }
}

export const sessions = new Sessions();

// The session of the server on screen. Forwards to the active Session so components keep
// using `session.x`; methods are bound to the real instance so async work stays with its server.
export const session = new Proxy({} as Session, {
  get(_t, prop) {
    const a = sessions.active;
    const v = Reflect.get(a, prop, a);
    return typeof v === 'function' ? v.bind(a) : v;
  },
  set(_t, prop, value) {
    return Reflect.set(sessions.active, prop, value, sessions.active);
  }
});
