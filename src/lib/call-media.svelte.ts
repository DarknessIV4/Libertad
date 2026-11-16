// Screen share, camera and Watch Together in a private friend call.
//
// The three already work between Libertad clients on a Mumble server: they are WebRTC streams (and a playback sync) whose
// setup messages travel as Mumble plugin data. A friend call has no Mumble server, so this gives the call a small stand-in
// for one: a session of two people, you and your friend, in the same room. The sharing code runs on it unchanged; only
// the way its setup messages get to the other side differs. They go on the call's own HyperDHT connection (a "signal"
// frame, see core/p2p-wire.ts), and the pictures and sound go straight between the two computers over WebRTC, as always.
import { MumbleClient, type User, type Channel } from '../core/client.ts';
import { createCodec } from '../core/proto.ts';
import { SHARE_DATA_ID } from '../core/share-signal.ts';
import { WATCH_DATA_ID } from '../core/watch-together.ts';
import { SIGNAL_CHANNEL, MAX_SIGNAL, type SignalChannel } from '../core/p2p-wire.ts';
import { Session } from './session.svelte.ts';
import { share } from './share.svelte.ts';
import { watchTogether } from './watch-together.svelte.ts';
import { desktop } from './native.ts';

// The two people of a call, as the sharing code knows them (Mumble session numbers)
const ME = 1;
const FRIEND = 2;
// The one room they are in
const ROOM = 0;
// Plugin data of a 1.5 server, so that nothing in the sharing code declines to run
const VERSION = 0x010500;

const user = (session: number, name: string, hash: string): User => ({
  session, name, userId: null, channelId: ROOM, mute: false, deaf: false, suppress: false, selfMute: false, selfDeaf: false,
  prioritySpeaker: false, recording: false, comment: '', commentHash: null, texture: null, textureHash: null, hash
});

const room: Channel = {
  id: ROOM, parent: null, name: 'Call', description: '', descriptionHash: null, position: 0, temporary: false,
  links: new Set(), maxUsers: 0, canEnter: true
};

// A Mumble client that has no server: what it is asked to send as plugin data goes to the other person of the call
class CallClient extends MumbleClient {
  constructor() {
    super(createCodec());
    this.serverVersionNum = VERSION;
    this.synced = true;
    this.session = ME;
    this.channels.set(ROOM, { ...room });
  }

  setPeer(name: string, key: string): void {
    this.users.set(ME, user(ME, 'You', 'self'));
    this.users.set(FRIEND, user(FRIEND, name, key));
  }

  override sendPluginData(receivers: number[], dataId: string, data: Uint8Array): void {
    if (!receivers.includes(FRIEND)) return;
    // Anything else a server session talks about (picture previews, files) is not part of a call
    const channel: SignalChannel | 0 = dataId === SHARE_DATA_ID ? SIGNAL_CHANNEL.share : dataId === WATCH_DATA_ID ? SIGNAL_CHANNEL.watch : 0;
    if (!channel || data.length > MAX_SIGNAL) return;
    void desktop?.p2p.sendSignal(channel, data).catch(() => {});
  }
}

class CallMedia {
  // The call's stand-in session while a call is active, else null
  session = $state.raw<Session | null>(null);
  private client: CallClient | null = null;
  private key = '';
  private off: (() => void) | null = null;

  // The friend's session number, for the views that look people up
  readonly friend = FRIEND;
  readonly me = ME;

  // The call became active
  open(key: string, name: string): void {
    if (!desktop || this.session) return;
    const client = new CallClient();
    client.setPeer(name, key);
    const s = new Session();
    s.client = client;
    s.status = 'connected';
    this.client = client;
    this.key = key;
    this.session = s;
    watchTogether.callSession = s;
    this.off = desktop.p2p.onSignal((from, channel, packet) => this.receive(from, channel, packet));
    // As on a server: ask who is sharing and who hosts a watch together (the other side answers if it is)
    share.entered(s);
    watchTogether.entered(s);
  }

  // The call ended, or its connection was lost: everything of it goes with it
  close(): void {
    const s = this.session;
    if (!s) return;
    this.off?.();
    this.off = null;
    this.session = null;
    this.client = null;
    this.key = '';
    share.closed(s);
    watchTogether.closed(s);
    if (watchTogether.callSession === s) watchTogether.callSession = null;
    s.client = null;
    s.status = 'idle';
    s.sharing = {};
  }

  // The name changed (a friend was renamed during the call)
  rename(name: string): void {
    const u = this.client?.users.get(FRIEND);
    if (u && u.name !== name) { u.name = name; this.session && this.session.tick++; }
  }

  private receive(from: string, channel: number, packet: Uint8Array): void {
    const s = this.session;
    if (!s || from !== this.key) return;
    if (channel === SIGNAL_CHANNEL.share) void share.receive(s, FRIEND, SHARE_DATA_ID, packet);
    else if (channel === SIGNAL_CHANNEL.watch) void watchTogether.receive(s, FRIEND, WATCH_DATA_ID, packet);
  }

  // ─── What the call bar shows and does ───────────────────────────────────────

  get supported(): boolean {
    const s = this.session;
    return !!s && share.supported(s);
  }
  // What I send in this call (a stream of mine that goes to another place does not count)
  get screenOn(): boolean { return !!this.session && share.host === this.session && !!share.stream && share.kind === 'screen'; }
  get cameraOn(): boolean { return !!this.session && share.host === this.session && !!share.stream && share.kind === 'camera'; }
  get watchOn(): boolean {
    const s = this.session;
    // In it (watching, or hosting it: also while the host stepped out). A party the friend started that we have not joined
    // yet exists too, but that one is an invitation, not something we are in.
    return !!s && watchTogether.callSession === s && watchTogether.cur() === s && (watchTogether.isWatching || watchTogether.isHostWithParty);
  }

  // The friend hosts a Watch Together I am not in: the button joins it
  get friendHosts(): boolean { return !!this.session?.watchTogether[FRIEND]; }

  toggle(kind: 'screen' | 'camera' | 'watch'): void {
    const s = this.session;
    if (!s) return;
    if (kind === 'watch') {
      if (this.watchOn) {
        if (watchTogether.isHostWithParty) void watchTogether.end();
        else void watchTogether.leave();
      } else if (this.friendHosts) void watchTogether.join(FRIEND);
      else void share.start(s, 'watch');
    } else if (kind === 'screen' ? this.screenOn : this.cameraOn) {
      share.stop();
    } else {
      void share.start(s, kind);
    }
  }
}

export const callMedia = new CallMedia();
