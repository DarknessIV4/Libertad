// Friends and calls over HyperDHT, between two nodes on a local test network (no internet needed).
// Skipped when hyperdht is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateIdentity } from '../electron/identity.ts';
import { P2p, FriendStore, keySeed, type Dht } from '../electron/p2p-core.ts';
import { P2P, FrameReader, encodeFrame, encodeJson, encodeAudio, decodeAudio, encodeSignalFrame, decodeSignalFrame, SIGNAL_CHANNEL, MAX_SIGNAL, parseFriendCode, type P2pState } from '../src/core/p2p-wire.ts';

let DHT: any = null, createTestnet: any = null;
try {
  DHT = (await import('hyperdht')).default;
  createTestnet = (await import('hyperdht/testnet.js')).default;
} catch { /* not installed */ }
const needDht = { skip: DHT ? false : 'hyperdht is not installed' };

test('frames survive being split and joined', () => {
  const frames = [encodeJson(P2P.hello, { name: 'Ann' }), encodeAudio(7, true, new Uint8Array([1, 2, 3])), encodeFrame(P2P.invite)];
  const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) { all.set(f, at); at += f.length; }
  const reader = new FrameReader();
  const got: { type: number; payload: Uint8Array }[] = [];
  for (let i = 0; i < all.length; i += 3) got.push(...reader.push(all.slice(i, i + 3))!);
  assert.deepEqual(got.map(f => f.type), [P2P.hello, P2P.audio, P2P.invite]);
  assert.deepEqual(decodeAudio(got[1].payload), { frame: 7, last: true, opus: new Uint8Array([1, 2, 3]) });
});

test('call signals keep their channel and packet, and bad ones are refused', () => {
  const packet = new Uint8Array([6, 1, 0, 1, 42, 43]);
  const frame = new FrameReader().push(encodeSignalFrame(SIGNAL_CHANNEL.watch, packet))![0];
  assert.equal(frame.type, P2P.signal);
  assert.deepEqual(decodeSignalFrame(frame.payload), { channel: SIGNAL_CHANNEL.watch, packet });
  assert.equal(decodeSignalFrame(new Uint8Array([SIGNAL_CHANNEL.share])), null);          // no packet
  assert.equal(decodeSignalFrame(new Uint8Array([9, 1, 2])), null);                        // not a channel
  assert.equal(decodeSignalFrame(new Uint8Array(MAX_SIGNAL + 2).fill(1)), null);           // too large
});

test('oversized and empty frames are refused', () => {
  assert.equal(new FrameReader().push(new Uint8Array([0, 1, 0, 1, 0])), null);
  assert.equal(new FrameReader().push(new Uint8Array([0, 0, 0, 0])), null);
});

test('friend codes are forgiving', () => {
  const k = 'ab'.repeat(32);
  assert.equal(parseFriendCode(k), k);
  assert.equal(parseFriendCode(` ${k.toUpperCase()}\n`), k);
  assert.equal(parseFriendCode(`libertad:friend/${k}`), k);
  assert.equal(parseFriendCode(k.replace(/(.{8})/g, '$1 ')), k);
  assert.equal(parseFriendCode(k.slice(1)), null);
  assert.equal(parseFriendCode('zz'.repeat(32)), null);
});

test('one identity is one key, and it is not derived from public data', () => {
  const a = generateIdentity('Ann');
  assert.deepEqual(keySeed(a.keyPem), keySeed(a.keyPem));
  assert.notDeepEqual(keySeed(a.keyPem), keySeed(generateIdentity('Ann').keyPem));
  assert.equal(keySeed(a.keyPem).length, 32);
});

interface Peer { node: P2p; states: P2pState[]; signals: { key: string; channel: number; packet: Uint8Array }[]; audio: { key: string; frame: number; last: boolean; opus: Uint8Array }[]; latest: () => P2pState; dht: Dht }

async function peer(bootstrap: unknown, name: string, dir: string, seed?: Uint8Array): Promise<Peer> {
  const dht = new DHT({ bootstrap }) as Dht;
  const keyPair = DHT.keyPair(seed ?? keySeed(generateIdentity(name).keyPem));
  const store = new FriendStore(path.join(dir, `${name}.json`));
  await store.load();
  const p: Peer = { states: [], signals: [], audio: [], dht, latest: () => p.states.at(-1)!, node: null as unknown as P2p };
  p.node = new P2p({
    dht, keyPair, store, name, retryMs: [200, 400], ringMs: 3000,
    onState: s => p.states.push(s),
    onAudio: (key, frame, last, opus) => p.audio.push({ key, frame, last, opus }),
    onSignal: (key, channel, packet) => p.signals.push({ key, channel, packet })
  });
  return p;
}

async function until(what: string, cond: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

test('friend request, accept, presence, call, audio and hangup', needDht, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2p-'));
  const net = await createTestnet(4);
  const ann = await peer(net.bootstrap, 'Ann', dir);
  const bob = await peer(net.bootstrap, 'Bob', dir);
  try {
    await ann.node.start();
    await bob.node.start();

    // Ann asks Bob using only his key
    await ann.node.addFriend(bob.node.publicKey, 'Bobby');
    await until('Bob sees the request', () => bob.latest().requests.length === 1);
    assert.equal(bob.latest().requests[0].key, ann.node.publicKey);
    assert.equal(bob.latest().requests[0].name, 'Ann');
    assert.equal(bob.latest().friends.length, 0);
    assert.equal(ann.latest().friends[0].status, 'pending');

    // Bob accepts: both are friends and see each other online
    await bob.node.acceptRequest(ann.node.publicKey);
    await until('both friends and online', () =>
      ann.latest().friends[0]?.status === 'friend' && ann.latest().friends[0].online && bob.latest().friends[0]?.online);
    assert.equal(ann.latest().friends[0].name, 'Bobby');
    assert.equal(bob.latest().friends[0].name, 'Ann');
    assert.equal(bob.latest().requests.length, 0);

    // A call
    assert.ok(ann.node.callFriend(bob.node.publicKey));
    await until('Bob is ringing', () => bob.latest().call?.state === 'ringing' && bob.latest().call?.dir === 'in');
    assert.ok(bob.node.acceptCall());
    await until('call active both sides', () => ann.latest().call?.state === 'active' && bob.latest().call?.state === 'active');

    ann.node.sendAudio(10, false, new Uint8Array([9, 8, 7]));
    ann.node.sendAudio(11, true, new Uint8Array(0));
    await until('audio arrives', () => bob.audio.length === 2);
    assert.deepEqual(bob.audio[0], { key: ann.node.publicKey, frame: 10, last: false, opus: new Uint8Array([9, 8, 7]) });
    assert.equal(bob.audio[1].last, true);

    // Setup messages of what is shared in the call reach the other side, in order, and only on the right channels
    assert.ok(ann.node.sendSignal(SIGNAL_CHANNEL.share, new Uint8Array([4])));
    assert.ok(ann.node.sendSignal(SIGNAL_CHANNEL.watch, new Uint8Array([2, 7, 7])));
    assert.equal(ann.node.sendSignal(5, new Uint8Array([1])), false);
    assert.equal(ann.node.sendSignal(SIGNAL_CHANNEL.share, new Uint8Array(0)), false);
    assert.equal(ann.node.sendSignal(SIGNAL_CHANNEL.share, new Uint8Array(MAX_SIGNAL + 1)), false);
    await until('signals arrive', () => bob.signals.length === 2);
    assert.deepEqual(bob.signals, [
      { key: ann.node.publicKey, channel: SIGNAL_CHANNEL.share, packet: new Uint8Array([4]) },
      { key: ann.node.publicKey, channel: SIGNAL_CHANNEL.watch, packet: new Uint8Array([2, 7, 7]) }
    ]);

    bob.node.setMute(true, false);
    await until('mute is shown', () => ann.latest().call?.muted === true);

    ann.node.hangUp();
    await until('call over', () => !ann.latest().call && !bob.latest().call);
    assert.equal(bob.latest().lastEnd?.reason, 'hangup');

    // Nor are signals outside a call
    assert.equal(ann.node.sendSignal(SIGNAL_CHANNEL.share, new Uint8Array([4])), false);

    // Audio outside a call is not delivered
    ann.node.sendAudio(1, false, new Uint8Array([1]));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(bob.audio.length, 2);

    // Friends are kept for next time
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'Bob.json'), 'utf8'));
    assert.equal(saved.friends[0].key, ann.node.publicKey);
  } finally {
    await ann.node.stop(); await bob.node.stop();
    await ann.dht.destroy(); await bob.dht.destroy();
    await net.destroy();
  }
});

test('declined and unanswered calls, and a second call while busy', needDht, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2p-'));
  const net = await createTestnet(4);
  const [ann, bob, cy] = await Promise.all(['Ann', 'Bob', 'Cy'].map(n => peer(net.bootstrap, n, dir)));
  try {
    for (const p of [ann, bob, cy]) await p.node.start();
    await ann.node.addFriend(bob.node.publicKey);
    await bob.node.addFriend(ann.node.publicKey); // both asked: settles without anyone accepting
    await cy.node.addFriend(bob.node.publicKey);
    await bob.node.addFriend(cy.node.publicKey);
    await until('everyone online', () => ann.latest().friends[0]?.online && bob.latest().friends.filter(f => f.online).length === 2 && cy.latest().friends[0]?.online);
    assert.equal(ann.latest().friends[0].status, 'friend');

    ann.node.callFriend(bob.node.publicKey);
    await until('ringing', () => bob.latest().call?.state === 'ringing');
    // Cy calls Bob while he rings for Ann: busy
    cy.node.callFriend(bob.node.publicKey);
    await until('Cy is told busy', () => cy.latest().lastEnd?.reason === 'busy');
    bob.node.declineCall();
    await until('Ann sees declined', () => ann.latest().lastEnd?.reason === 'declined');

    // Nobody picks up
    cy.node.callFriend(bob.node.publicKey);
    await until('Bob rings again', () => bob.latest().call?.dir === 'in');
    await until('gives up', () => !cy.latest().call && !bob.latest().call, 8000);
    assert.equal(cy.latest().lastEnd?.reason, 'unanswered');
  } finally {
    for (const p of [ann, bob, cy]) { await p.node.stop(); await p.dht.destroy(); }
    await net.destroy();
  }
});

test('strangers can only ask; declining blocks them; a lost connection ends the call', needDht, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2p-'));
  const net = await createTestnet(4);
  const ann = await peer(net.bootstrap, 'Ann', dir);
  const bob = await peer(net.bootstrap, 'Bob', dir);
  try {
    await ann.node.start(); await bob.node.start();
    await ann.node.addFriend(bob.node.publicKey);
    await until('request', () => bob.latest().requests.length === 1);
    // A pending request does not let Ann call
    assert.equal(ann.node.callFriend(bob.node.publicKey), false);
    await bob.node.declineRequest(ann.node.publicKey);
    assert.equal(bob.latest().requests.length, 0);
    // Blocked: she can not even connect, so no new request shows up
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(bob.latest().requests.length, 0);
    assert.equal(ann.latest().friends[0].online, false);

    // Turning requests off keeps unknown keys out
    const cy = await peer(net.bootstrap, 'Cy', dir);
    await cy.node.start();
    await bob.node.setAcceptRequests(false);
    await cy.node.addFriend(bob.node.publicKey);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(bob.latest().requests.length, 0);
    await cy.node.stop(); await cy.dht.destroy();

    // Bob unblocks and accepts Ann; she disappears mid-call and the call ends
    await bob.node.setAcceptRequests(true);
    await bob.node.unblock(ann.node.publicKey);
    await bob.node.addFriend(ann.node.publicKey);
    await until('friends online', () => bob.latest().friends[0]?.online && ann.latest().friends[0]?.status === 'friend');
    bob.node.callFriend(ann.node.publicKey);
    await until('Ann rings', () => ann.latest().call?.state === 'ringing');
    ann.node.acceptCall();
    await until('active', () => bob.latest().call?.state === 'active');
    await ann.node.stop();
    await until('Bob notices', () => !bob.latest().call);
    assert.equal(bob.latest().lastEnd?.reason, 'lost');
    await until('Ann shows offline', () => bob.latest().friends[0]?.online === false);
  } finally {
    await bob.node.stop();
    await ann.dht.destroy(); await bob.dht.destroy();
    await net.destroy();
  }
});

test('both connect at once and end up with one connection', needDht, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2p-'));
  const net = await createTestnet(4);
  const ann = await peer(net.bootstrap, 'Ann', dir);
  const bob = await peer(net.bootstrap, 'Bob', dir);
  try {
    await ann.node.start(); await bob.node.start();
    await Promise.all([ann.node.addFriend(bob.node.publicKey), bob.node.addFriend(ann.node.publicKey)]);
    await until('online', () => ann.latest().friends[0]?.online && bob.latest().friends[0]?.online);
    // Stay online: a dropped duplicate must not flap the presence
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(ann.latest().friends[0].online, true);
    assert.equal(bob.latest().friends[0].online, true);
    ann.node.callFriend(bob.node.publicKey);
    await until('rings', () => bob.latest().call?.state === 'ringing');
  } finally {
    await ann.node.stop(); await bob.node.stop();
    await ann.dht.destroy(); await bob.dht.destroy();
    await net.destroy();
  }
});
