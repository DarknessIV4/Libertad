// Friends and calls over HyperDHT: the Electron side. The logic is in p2p-core.ts.
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import type { IdentityStore } from './identity-store.ts';
import { P2p, FriendStore, ProfileStore, keySeed, noteSent, applyRequest, applyAnswer, friendHashes, sentHashes, type Dht, type Saved, type ServerResult } from './p2p-core.ts';
import { emptyP2pState, parseFriendCode, type P2pState, type FriendProfileData } from '../src/core/p2p-wire.ts';

interface DhtModule {
  new (opts?: object): Dht;
  keyPair(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
}

const okKey = (v: unknown): string => {
  const key = typeof v === 'string' ? parseFriendCode(v) : null;
  if (!key) throw new Error('That is not a friend code. It is 64 letters and digits (0-9, a-f).');
  return key;
};

export function registerP2p(identities: () => IdentityStore): void {
  let node: P2p | null = null;
  let dht: Dht | null = null;
  let identityId = '';
  let loading: Promise<DhtModule> | null = null;
  // One saved friend list per identity, shared by the node and by what arrives while offline
  const books = new Map<string, FriendStore>();
  async function book(id: string): Promise<FriendStore> {
    let b = books.get(id);
    if (!b) {
      b = new FriendStore(path.join(app.getPath('userData'), 'friends', `${id}.json`));
      await b.load();
      books.set(id, b);
    }
    return b;
  }

  // What was kept of each friend's profile, per identity: shown even while offline
  const kept = new Map<string, ProfileStore>();
  const profilesOf = (id: string): ProfileStore => {
    let k = kept.get(id);
    if (!k) { k = new ProfileStore(path.join(app.getPath('userData'), 'friend-profiles', id)); kept.set(id, k); }
    return k;
  };
  // My own profile as the page last gave it: handed to every node that is made, so it is not lost when the identity changes
  let ownProfile: unknown = null;

  // Not bundled: it and its native parts are loaded from node_modules, the way webtorrent is
  const load = () => (loading ??= (async () => { const spec = 'hyperdht'; return (await import(spec)).default as DhtModule; })());

  const broadcast = (channel: string, ...args: unknown[]) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  };

  async function shutdown(): Promise<void> {
    const n = node, d = dht;
    node = null; dht = null; identityId = '';
    await n?.stop();
    await d?.destroy().catch(() => {});
  }

  // The node for the identity that is the default now; a different default replaces it
  async function ensure(): Promise<P2p> {
    const id = await identities().get();
    if (node && identityId === id.id) return node;
    await shutdown();
    const DHT = await load();
    const keyPair = DHT.keyPair(keySeed(id.keyPem));
    const store = await book(id.id);
    dht = new DHT();
    // A dropped connection reports itself here; nobody needs to hear about it
    (dht as unknown as { on?: (ev: string, fn: () => void) => void }).on?.('error', () => {});
    identityId = id.id;
    node = new P2p({
      dht, keyPair, store, name: id.name, hash: id.fingerprint,
      profiles: profilesOf(id.id),
      onProfile: key => broadcast('p2p:profile', key),
      onState: s => broadcast('p2p:state', s),
      onAudio: (key, frame, isLast, opus) => broadcast('p2p:audio', key, frame, isLast, opus),
      onSignal: (key, channel, packet) => broadcast('p2p:signal', key, channel, packet)
    });
    if (ownProfile) node.setProfile(ownProfile);
    return node;
  }

  // Before the network is joined: just who I am, so the friend code can be shown and copied
  async function idle(): Promise<P2pState> {
    const id = await identities().get();
    const DHT = await load();
    const key = Buffer.from(DHT.keyPair(keySeed(id.keyPem)).publicKey).toString('hex');
    const d = (await book(id.id)).data;
    return { ...emptyP2pState(), self: { key, name: id.name }, friendHashes: friendHashes(d), sentHashes: sentHashes(d) };
  }

  // A friend request, or the answer to one, that came through a Mumble server. It only changes the saved list: the
  // network is not joined for it, and nobody is contacted before both sides agreed.
  async function viaServer(run: (d: Saved, self: string) => ServerResult, key = ''): Promise<ServerResult> {
    if (node) return node.viaServer(run, key);
    const id = await identities().get();
    const DHT = await load();
    const self = Buffer.from(DHT.keyPair(keySeed(id.keyPem)).publicKey).toString('hex');
    const store = await book(id.id);
    const result = run(store.data, self);
    if (result !== 'none') {
      await store.save();
      broadcast('p2p:state', await idle());
    }
    return result;
  }

  ipcMain.handle('p2p:state', async () => (node ? node.snapshot() : idle()));
  ipcMain.handle('p2p:start', async () => { const n = await ensure(); await n.start(); return n.snapshot(); });
  ipcMain.handle('p2p:stop', async () => { await shutdown(); return idle(); });

  ipcMain.handle('p2p:addFriend', async (_e, code: unknown, name: unknown) => {
    const n = await ensure();
    await n.start();
    await n.addFriend(okKey(code), typeof name === 'string' ? name : '');
  });
  ipcMain.handle('p2p:serverSent', (_e, hash: unknown, nonce: unknown) => viaServer(d => noteSent(d, String(hash ?? ''), String(nonce ?? '')) ? 'changed' : 'none'));
  ipcMain.handle('p2p:serverRequest', (_e, code: unknown, name: unknown, hash: unknown, nonce: unknown) => {
    const key = okKey(code);
    return viaServer((d, self) => applyRequest(d, self, key, String(name ?? ''), String(hash ?? ''), String(nonce ?? '')), key);
  });
  ipcMain.handle('p2p:serverAnswer', (_e, code: unknown, name: unknown, hash: unknown) => {
    const key = okKey(code);
    return viaServer((d, self) => applyAnswer(d, self, key, String(name ?? ''), String(hash ?? '')), key);
  });
  ipcMain.handle('p2p:acceptRequest', async (_e, key: unknown) => { await node?.acceptRequest(okKey(key)); });
  ipcMain.handle('p2p:declineRequest', async (_e, key: unknown) => { await node?.declineRequest(okKey(key)); });
  ipcMain.handle('p2p:removeFriend', async (_e, key: unknown) => { await node?.removeFriend(okKey(key)); });
  ipcMain.handle('p2p:renameFriend', async (_e, key: unknown, name: unknown) => { await node?.renameFriend(okKey(key), String(name ?? '')); });
  ipcMain.handle('p2p:acceptRequests', async (_e, on: unknown) => { await node?.setAcceptRequests(!!on); });

  // My profile, for friends: text, colors and the bytes of pictures. Sent to them when it differs from the last one.
  ipcMain.handle('p2p:setProfile', (_e, input: unknown) => { ownProfile = input; node?.setProfile(input); });
  // A friend's profile as kept on this computer (nothing needs the network for this)
  ipcMain.handle('p2p:profile', async (_e, key: unknown): Promise<FriendProfileData | null> => {
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return null;
    const id = await identities().get();
    return profilesOf(id.id).read(key);
  });

  ipcMain.handle('p2p:call', (_e, key: unknown) => node?.callFriend(okKey(key)) ?? false);
  ipcMain.handle('p2p:accept', () => node?.acceptCall() ?? false);
  ipcMain.handle('p2p:decline', () => { node?.declineCall(); });
  ipcMain.handle('p2p:hangup', () => { node?.hangUp(); });
  ipcMain.handle('p2p:chat', (_e, text: unknown) => node?.sendChat(text) ?? false);
  ipcMain.on('p2p:mute', (_e, muted: unknown, deafened: unknown) => node?.setMute(!!muted, !!deafened));
  // Setup messages of what is shared in the call; a message that does not fit is dropped (the call has no queue for them)
  ipcMain.handle('p2p:signal', (_e, channel: unknown, packet: unknown) => node?.sendSignal(channel, packet) ?? false);
  ipcMain.on('p2p:audio', (_e, frame: unknown, isLast: unknown, opus: unknown) => {
    if (!(opus instanceof Uint8Array) || opus.length > 4000 || typeof frame !== 'number') return;
    node?.sendAudio(frame, !!isLast, opus);
  });

  app.on('will-quit', () => { void shutdown(); });
}
