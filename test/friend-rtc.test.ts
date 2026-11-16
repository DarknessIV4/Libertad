import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FriendRtc, FriendAssembler, friendConfig, FRIEND_SIG, encodeFriendSignal, encodeFriendMessage, parseFriendMessage, type FriendMessage, type FriendHost } from '../src/core/friend-rtc.ts';

const KEY = 'a1'.repeat(32);
const NONCE = 'b2'.repeat(16);

// A real WebRTC stack for the handshake tests; skipped where it is not installed
let RTC: typeof RTCPeerConnection | undefined;
try { RTC = (await import('node-datachannel/polyfill')).RTCPeerConnection as unknown as typeof RTCPeerConnection; } catch { /* not installed */ }
const needRtc = { skip: RTC ? false : 'node-datachannel is not installed' };

test('a message survives encoding, and only the fields that belong are read', () => {
  const m: FriendMessage = { kind: 'req', key: KEY, nonce: NONCE };
  assert.deepEqual(parseFriendMessage(encodeFriendMessage(m)), m);
  assert.deepEqual(parseFriendMessage(encodeFriendMessage({ kind: 'ok', key: KEY, nonce: '' })), { kind: 'ok', key: KEY, nonce: '' });
  // An answer to a message does not drag extra fields along
  assert.deepEqual(Object.keys(parseFriendMessage(JSON.stringify({ v: 1, k: 'req', key: KEY, n: NONCE, extra: 'x' }))!).sort(), ['key', 'kind', 'nonce']);
});

test('anything that is not a well-formed message is refused', () => {
  const bad: unknown[] = [
    undefined, null, 5, '', 'ack', '[]', '{}', 'not json',
    JSON.stringify({ v: 2, k: 'req', key: KEY }),
    JSON.stringify({ v: 1, k: 'call', key: KEY }),
    JSON.stringify({ v: 1, k: 'req', key: KEY.toUpperCase() }),
    JSON.stringify({ v: 1, k: 'req', key: KEY.slice(1) }),
    JSON.stringify({ v: 1, k: 'req', key: 5 }),
    JSON.stringify({ v: 1, k: 'req', key: KEY, pad: 'x'.repeat(600) })
  ];
  for (const b of bad) assert.equal(parseFriendMessage(b), null, String(b));
  // A bad secret is dropped, not trusted
  assert.equal(parseFriendMessage(JSON.stringify({ v: 1, k: 'req', key: KEY, n: 'zz' }))?.nonce, '');
});

test('signals are descriptions only, in the Libertad signal format', async () => {
  const packets = await encodeFriendSignal('offer', 'v=0\r\n');
  assert.ok(packets.every(p => p.length <= 1000));
  assert.deepEqual(await new FriendAssembler().push(3, packets[0]), { type: FRIEND_SIG.offer, text: 'v=0\r\n' });
});

// Two clients with the server between them. Everything the server is asked to relay is recorded, and read back
// the way an operator could read it.
function pair(opts: { wantsB?: boolean; knownB?: boolean } = {}) {
  const seen: string[] = [];
  const got: { from: number; msg: FriendMessage }[] = [];
  const A = 1, B = 2;
  const gather = (pc: RTCPeerConnection) => new Promise<void>(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); });
    setTimeout(resolve, 3000);
  });
  const server = new FriendAssembler();
  const relay = (from: number, to: FriendRtc, type: 'offer' | 'answer', sdp: string) => {
    encodeFriendSignal(type, sdp).then(async packets => {
      for (const p of packets) {
        // What the operator sees: reassemble exactly as a client would
        const s = await server.push(from, p);
        if (s?.text) seen.push(s.text);
        await to.receive(from, p);
      }
    });
  };
  const host = (self: number, other: () => FriendRtc, wants: boolean, known: boolean): FriendHost => ({
    config: async () => ({ iceServers: [] }),
    gathered: gather,
    signal: (_to, type, sdp) => relay(self, other(), type, sdp),
    known: () => known,
    wants: () => wants,
    message: (from, msg) => { got.push({ from, msg }); }
  });
  const a: FriendRtc = new FriendRtc(host(A, () => b, true, true), RTC);
  const b: FriendRtc = new FriendRtc(host(B, () => a, opts.wantsB ?? true, opts.knownB ?? true), RTC);
  return { a, b, seen, got, A, B };
}

test('a request reaches the other person and the server only ever relays descriptions', needRtc, async () => {
  const { a, b, seen, got } = pair();
  const ok = await a.send(2, { kind: 'req', key: KEY, nonce: NONCE }, 10000);
  assert.equal(ok, true);
  assert.deepEqual(got, [{ from: 1, msg: { kind: 'req', key: KEY, nonce: NONCE } }]);
  // The operator saw the offer and the answer, and nothing that tells what this was
  assert.equal(seen.length, 2);
  for (const text of seen) {
    assert.ok(text.startsWith('v=0'), 'a session description');
    assert.ok(!text.includes(KEY) && !text.includes(NONCE), 'no friend code and no secret');
    assert.ok(!/friend|libertad/i.test(text), 'nothing that names the purpose');
  }
  a.close(); b.close();
});

test('an answer goes the same way', needRtc, async () => {
  const { a, b, got } = pair();
  assert.equal(await b.send(1, { kind: 'ok', key: KEY, nonce: '' }, 10000), true);
  assert.deepEqual(got, [{ from: 2, msg: { kind: 'ok', key: KEY, nonce: '' } }]);
  a.close(); b.close();
});

test('with requests turned off nothing is answered, nothing is delivered, and the sender is told it failed', needRtc, async () => {
  const { a, b, seen, got } = pair({ wantsB: false });
  assert.equal(await a.send(2, { kind: 'req', key: KEY, nonce: NONCE }, 1500), false);
  assert.equal(got.length, 0);
  // Only the offer was relayed: no answer was made, so no address came back
  assert.equal(seen.length, 1);
  a.close(); b.close();
});

test('nothing is sent to someone who is not on the server', needRtc, async () => {
  const { a, b, seen } = pair();
  const gone = new FriendRtc({ ...{ config: async () => ({}), gathered: async () => {}, signal: () => {}, wants: () => true, message: () => {} }, known: () => false }, RTC);
  assert.equal(await gone.send(9, { kind: 'req', key: KEY, nonce: NONCE }), false);
  assert.equal(seen.length, 0);
  a.close(); b.close(); gone.close();
});

test('a second handshake from the same person right away is ignored', needRtc, async () => {
  const { a, b, seen, got } = pair();
  assert.equal(await a.send(2, { kind: 'req', key: KEY, nonce: NONCE }, 10000), true);
  assert.equal(await a.send(2, { kind: 'req', key: KEY, nonce: NONCE }, 1500), false);
  assert.equal(got.length, 1);
  // The offer of the second try reached the server, and no answer to it came back
  assert.equal(seen.length, 3);
  a.close(); b.close();
});

test('an oversized or garbage description is dropped without an answer', needRtc, async () => {
  const { b, seen } = pair();
  await b.receive(1, (await encodeFriendSignal('offer', 'v=0\r\n' + 'a=x\r\n'.repeat(5000)))[0]);
  await b.receive(1, new Uint8Array([FRIEND_SIG.offer, 1, 0, 1, 9, 9, 9]));
  assert.equal(seen.length, 0);
  b.close();
});

const TURN: RTCIceServer = { urls: ['turn:relay.example:3478?transport=udp'], username: 'u', credential: 'c' };
const STUN: RTCIceServer = { urls: 'stun:stun.example:3478' };

test('Relay only uses relayed routes, and refuses rather than going direct', () => {
  assert.deepEqual(friendConfig({ iceServers: [STUN, TURN] }, true), { iceServers: [STUN, TURN], iceTransportPolicy: 'relay' });
  // STUN alone, or nothing, is not a relay: it would only reveal the address
  assert.throws(() => friendConfig({ iceServers: [STUN] }, true));
  assert.throws(() => friendConfig({ iceServers: [] }, true));
  assert.throws(() => friendConfig({}, true));
  // Turned off, the normal setup is used as it is
  assert.deepEqual(friendConfig({ iceServers: [STUN] }, false), { iceServers: [STUN] });
});

test('with no relay to use, a request is not sent and an offer is not answered', needRtc, async () => {
  const refuse = async (): Promise<RTCConfiguration> => { throw new Error('no relay'); };
  const out: { type: string; sdp: string }[] = [];
  const delivered: FriendMessage[] = [];
  const host = (over: Partial<FriendHost>): FriendHost => ({
    config: async () => ({ iceServers: [] }),
    gathered: pc => new Promise<void>(r => { if (pc.iceGatheringState === 'complete') return r(); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') r(); }); setTimeout(r, 3000); }),
    signal: (_to, type, sdp) => { out.push({ type, sdp }); },
    known: () => true, wants: () => true, message: (_f, m) => { delivered.push(m); },
    ...over
  });

  // Sender without a relay: it does not even make an offer
  const none = new FriendRtc(host({ config: refuse }), RTC);
  assert.equal(await none.send(2, { kind: 'req', key: KEY, nonce: NONCE }, 1000), false);
  assert.deepEqual(out, []);

  // A real offer, captured instead of delivered
  const maker = new FriendRtc(host({}), RTC);
  assert.equal(await maker.send(2, { kind: 'req', key: KEY, nonce: NONCE }, 1000), false);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'offer');
  const offer = out.splice(0)[0];

  // Receiver without a relay: the offer gets no answer, so no address goes back, and nothing is delivered
  const receiver = new FriendRtc(host({ config: refuse }), RTC);
  for (const p of await encodeFriendSignal('offer', offer.sdp)) await receiver.receive(1, p);
  assert.deepEqual(out, []);
  assert.deepEqual(delivered, []);
  none.close(); maker.close(); receiver.close();
});
