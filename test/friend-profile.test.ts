// Profiles between friends over the friend network: a change reaches an online friend at once, a change made
// while apart is found by the hash comparison when the connection opens, and nothing is fetched twice.
// Skipped when hyperdht is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateIdentity } from '../electron/identity.ts';
import { P2p, FriendStore, ProfileStore, buildOwnProfile, keySeed, type Dht } from '../electron/p2p-core.ts';
import { cleanManifest, cleanProfileItem, encodeProfileData, decodeProfileData, MAX_PROFILE_FILE, type P2pState } from '../src/core/p2p-wire.ts';

let DHT: any = null, createTestnet: any = null;
try {
  DHT = (await import('hyperdht')).default;
  createTestnet = (await import('hyperdht/testnet.js')).default;
} catch { /* not installed */ }
const needDht = { skip: DHT ? false : 'hyperdht is not installed' };

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pic = (seed: number, n = 40000) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255);

test('a list from a friend is cleaned: only what is allowed gets through', () => {
  const hash = 'a'.repeat(64);
  const m = cleanManifest({
    text: 'hello',
    slots: {
      avatar: { kind: 'color', color: '#ff0000' },                       // an avatar is never a color
      banner: { kind: 'color', color: '#AABBCC' },
      card: { kind: 'file', hash, mime: 'image/png', size: 10 },
      profile: { kind: 'file', hash, mime: 'image/gif', size: 10, scope: 'whole' },
      extra: { kind: 'color', color: '#000000' }
    }
  })!;
  assert.equal(m.text, 'hello');
  assert.equal(m.slots.avatar, undefined);
  assert.deepEqual(m.slots.banner, { kind: 'color', color: '#aabbcc' });
  assert.equal(m.slots.card?.kind, 'file');
  assert.equal((m.slots.profile as { scope?: string }).scope, 'whole');
  assert.equal(Object.keys(m.slots).length, 3);
  // wrong kinds of file, sizes and hashes
  assert.equal(cleanProfileItem('avatar', { kind: 'file', hash, mime: 'text/html', size: 10 }), null);
  assert.equal(cleanProfileItem('avatar', { kind: 'file', hash: 'zz', mime: 'image/png', size: 10 }), null);
  assert.equal(cleanProfileItem('avatar', { kind: 'file', hash, mime: 'image/png', size: MAX_PROFILE_FILE + 1 }), null);
  assert.equal(cleanProfileItem('avatar', { kind: 'file', hash, mime: 'image/png', size: 0 }), null);
  // a scope is only for the profile card background
  assert.equal((cleanProfileItem('card', { kind: 'file', hash, mime: 'image/png', size: 5, scope: 'under' }) as { scope?: string }).scope, undefined);
  assert.equal(cleanManifest('nope'), null);
});

test('pieces of a picture carry their slot', () => {
  const f = encodeProfileData('banner', new Uint8Array([1, 2, 3]));
  const d = decodeProfileData(f.slice(5))!;
  assert.equal(d.slot, 'banner');
  assert.deepEqual([...d.bytes], [1, 2, 3]);
  assert.equal(decodeProfileData(new Uint8Array([9, 1])), null);
});

test('my own profile is hashed here, and anything too big or of the wrong kind is left out', () => {
  const bytes = pic(1, 100);
  const own = buildOwnProfile({
    text: 'hi',
    slots: {
      avatar: { kind: 'file', mime: 'image/png', bytes },
      banner: { kind: 'file', mime: 'text/html', bytes },
      card: { kind: 'color', color: '#112233' },
      profile: { kind: 'file', mime: 'image/png', bytes: new Uint8Array(MAX_PROFILE_FILE + 1) }
    }
  });
  const a = own.manifest.slots.avatar;
  assert.equal(a?.kind === 'file' && a.hash, sha(bytes));
  assert.equal(own.manifest.slots.banner, undefined);
  assert.equal(own.manifest.slots.profile, undefined);
  assert.deepEqual(own.manifest.slots.card, { kind: 'color', color: '#112233' });
  assert.equal(own.files.size, 1);
});

interface Peer { node: P2p; states: P2pState[]; changed: string[]; profiles: ProfileStore; latest: () => P2pState; dht: Dht; dir: string; seed: Uint8Array }

async function peer(bootstrap: unknown, name: string, dir: string, seed?: Uint8Array): Promise<Peer> {
  const dht = new DHT({ bootstrap }) as Dht;
  const sd = seed ?? keySeed(generateIdentity(name).keyPem);
  const keyPair = DHT.keyPair(sd);
  const store = new FriendStore(path.join(dir, `${name}.json`));
  await store.load();
  const profiles = new ProfileStore(path.join(dir, `${name}-profiles`));
  const p: Peer = { states: [], changed: [], profiles, dht, dir, seed: sd, latest: () => p.states.at(-1)!, node: null as unknown as P2p };
  p.node = new P2p({ dht, keyPair, store, name, retryMs: [200, 400], ringMs: 3000, profiles, onState: s => p.states.push(s), onAudio: () => {}, onProfile: k => p.changed.push(k) });
  return p;
}

async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

async function befriend(a: Peer, b: Peer): Promise<void> {
  await a.node.start();
  await b.node.start();
  await a.node.addFriend(b.node.publicKey, 'Bob');
  await until('request', () => b.latest().requests.length === 1);
  await b.node.acceptRequest(a.node.publicKey);
  await until('both online', () => !!a.latest().friends[0]?.online && !!b.latest().friends[0]?.online);
}

test('a friend’s profile arrives, changes reach me while online, and a change made while apart is found on reconnect', needDht, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2p-prof-'));
  const net = await createTestnet(4);
  const ann = await peer(net.bootstrap, 'Ann', dir);
  let bob = await peer(net.bootstrap, 'Bob', dir);
  try {
    // Ann has a picture and a description before they even are friends: it is sent once they are
    const first = pic(1);
    ann.node.setProfile({ text: '<p>Ann here</p>', slots: { avatar: { kind: 'file', mime: 'image/png', bytes: first }, banner: { kind: 'color', color: '#336699' } } });
    await befriend(ann, bob);

    const got = async () => (await bob.profiles.read(ann.node.publicKey))!;
    await until('Bob has Ann’s picture', async () => (await got()).slots.avatar?.kind === 'file');
    let p = await got();
    assert.equal(p.text, '<p>Ann here</p>');
    assert.deepEqual(p.slots.banner, { kind: 'color', color: '#336699' });
    const av = p.slots.avatar!;
    assert.ok(av.kind === 'file' && av.hash === sha(first) && sha(av.bytes) === sha(first));

    // Ann changes her picture while both are online: Bob gets it without asking
    const second = pic(2, 70000);
    ann.node.setProfile({ text: '<p>Ann here</p>', slots: { avatar: { kind: 'file', mime: 'image/png', bytes: second }, banner: { kind: 'color', color: '#336699' } } });
    await until('Bob has the new picture', async () => { const a = (await got()).slots.avatar; return a?.kind === 'file' && a.hash === sha(second); });
    p = await got();
    assert.ok(p.slots.avatar?.kind === 'file' && sha(p.slots.avatar.bytes) === sha(second));

    // Text and colors change without any picture moving
    const before = bob.changed.length;
    ann.node.setProfile({ text: '<p>New text</p>', slots: { avatar: { kind: 'file', mime: 'image/png', bytes: second }, banner: { kind: 'color', color: '#aa0000' } } });
    await until('text and color', async () => (await got()).text === '<p>New text</p>');
    assert.deepEqual((await got()).slots.banner, { kind: 'color', color: '#aa0000' });
    assert.ok(bob.changed.length > before);

    // The same list again changes nothing and tells nobody
    const quiet = bob.changed.length;
    ann.node.setProfile({ text: '<p>New text</p>', slots: { avatar: { kind: 'file', mime: 'image/png', bytes: second }, banner: { kind: 'color', color: '#aa0000' } } });
    await new Promise(r => setTimeout(r, 400));
    assert.equal(bob.changed.length, quiet);

    // Bob goes away; Ann changes everything meanwhile; Bob comes back (a new node, the same saved folders)
    await bob.node.stop();
    await bob.dht.destroy();
    const third = pic(3, 25000);
    ann.node.setProfile({ text: '<p>While you were away</p>', slots: { avatar: { kind: 'file', mime: 'image/png', bytes: third } } });
    const again = await peer(net.bootstrap, 'Bob', dir, bob.seed);
    bob = again;
    await bob.node.start();
    await until('Bob catches up', async () => { const x = await got(); return x.text === '<p>While you were away</p>' && x.slots.avatar?.kind === 'file' && x.slots.avatar.hash === sha(third); });
    p = await got();
    assert.equal(p.slots.banner, undefined);                    // removed while away
    assert.ok(p.slots.avatar?.kind === 'file' && sha(p.slots.avatar.bytes) === sha(third));
  } finally {
    await ann.node.stop(); await bob.node.stop();
    await ann.dht.destroy(); await bob.dht.destroy();
    await net.destroy();
  }
});

test('a picture Bob already has is not sent again when he reconnects', needDht, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2p-prof-'));
  const net = await createTestnet(4);
  const ann = await peer(net.bootstrap, 'Ann', dir);
  let bob = await peer(net.bootstrap, 'Bob', dir);
  try {
    const bytes = pic(5, 50000);
    ann.node.setProfile({ text: '', slots: { avatar: { kind: 'file', mime: 'image/png', bytes } } });
    await befriend(ann, bob);
    await until('first copy', async () => (await bob.profiles.read(ann.node.publicKey))?.slots.avatar?.kind === 'file');

    // Count what Ann writes after Bob returns: a list, and no picture
    await bob.node.stop();
    await bob.dht.destroy();
    const annConns = ann.node as unknown as { peers: Map<string, { socket: { write: (c: unknown) => boolean } }> };
    let heavy = 0;
    const wrap = () => { for (const c of annConns.peers.values()) { const w = c.socket.write.bind(c.socket); c.socket.write = (chunk: unknown) => { if (chunk instanceof Uint8Array && chunk.length > 20000) heavy++; return w(chunk); }; } };
    bob = await peer(net.bootstrap, 'Bob', dir, bob.seed);
    await bob.node.start();
    await until('online again', () => !!bob.latest().friends[0]?.online && !!ann.latest().friends[0]?.online);
    wrap();
    ann.node.setProfile({ text: 'x', slots: { avatar: { kind: 'file', mime: 'image/png', bytes } } });
    await until('text', async () => (await bob.profiles.read(ann.node.publicKey))?.text === 'x');
    assert.equal(heavy, 0);
  } finally {
    await ann.node.stop(); await bob.node.stop();
    await ann.dht.destroy(); await bob.dht.destroy();
    await net.destroy();
  }
});

test('a stranger or a friend I only asked cannot give me a profile, and a wrong picture is thrown away', needDht, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2p-prof-'));
  const net = await createTestnet(4);
  const ann = await peer(net.bootstrap, 'Ann', dir);
  const bob = await peer(net.bootstrap, 'Bob', dir);
  try {
    await ann.node.start();
    await bob.node.start();
    // Ann asks Bob; he has not answered: she is a pending friend for Ann, so nothing she is sent is kept
    ann.node.setProfile({ text: 'hi', slots: {} });
    bob.node.setProfile({ text: 'bob', slots: {} });
    await ann.node.addFriend(bob.node.publicKey, 'Bob');
    await until('request', () => bob.latest().requests.length === 1);
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await bob.profiles.read(ann.node.publicKey))!.text, '');
    assert.equal((await ann.profiles.read(bob.node.publicKey))!.text, '');

    // A picture that does not match its hash is dropped
    await bob.node.acceptRequest(ann.node.publicKey);
    await until('both online', () => !!ann.latest().friends[0]?.online && !!bob.latest().friends[0]?.online);
    await until('texts', async () => (await bob.profiles.read(ann.node.publicKey))!.text === 'hi');
    const bobConn = (bob.node as unknown as { peers: Map<string, any> }).peers.get(ann.node.publicKey)!;
    const real = pic(9, 3000);
    const fake = Uint8Array.from(real).reverse();
    const { hash } = (buildOwnProfile({ slots: { avatar: { kind: 'file', mime: 'image/png', bytes: real } } }).manifest.slots.avatar as { hash: string });
    // Ann claims `real` but sends `fake` bytes
    const lying = (ann.node as unknown as { mine: unknown });
    lying.mine = { manifest: { text: 'liar', slots: { avatar: { kind: 'file', hash, mime: 'image/png', size: real.length } } }, files: new Map([[hash, fake]]) };
    (ann.node as unknown as { sendProfileTo(k: string): void }).sendProfileTo(bob.node.publicKey);
    await until('Bob read the list', async () => (await bob.profiles.read(ann.node.publicKey))!.text === 'liar');
    await new Promise(r => setTimeout(r, 500));
    const kept = (await bob.profiles.read(ann.node.publicKey))!;
    assert.equal(kept.slots.avatar, undefined);
    assert.ok(bobConn);
  } finally {
    await ann.node.stop(); await bob.node.stop();
    await ann.dht.destroy(); await bob.dht.destroy();
    await net.destroy();
  }
});
