import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { randomBytes, X509Certificate } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { build } from '../scripts/build-node.mjs';
import { createAndroidApi, fromB64, type Bridge } from '../../src/lib/native-android.ts';
import type { ConnectionService } from '../../src/lib/android-service.ts';
import { CH } from '../shared/protocol.ts';
import { CryptState } from '../../electron/ocb2.ts';
import { generateIdentity } from '../../electron/identity.ts';

// The Android Mumble backend end to end, on a computer: the real bundle (what nodejs-mobile runs) is started as a child
// process, and the real page-side code (src/lib/native-android.ts) drives it over the child's IPC, which stands in for
// the capacitor-nodejs channel (both carry JSON). The Mumble server is a mock: a TLS socket and an encrypted UDP socket.
//
//   node --test mobile/test/backend.test.ts
//   MOBILE_TEST_NODE=/path/to/node18 node --test mobile/test/backend.test.ts    # run the backend on another Node, e.g. 18

const within = <T>(p: Promise<T>, ms = 5000, what = 'the answer'): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms).unref())]);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const listen = (server: net.Server, port = 0) => new Promise<number>(res => server.listen(port, '127.0.0.1', () => res((server.address() as AddressInfo).port)));
const bindUdp = (sock: dgram.Socket) => new Promise<number>(res => sock.bind(0, '127.0.0.1', () => res((sock.address() as AddressInfo).port)));

let outDir = '';
let dataDir = '';
let child: ChildProcess;
let bridge: Bridge;
let api: ReturnType<typeof createAndroidApi>;
const handlers = new Map<string, ((...args: any[]) => void)[]>();
const saved: { name: string; base64: string }[] = [];

// Stands in for the Android foreground service (LibertadService plugin) and notes what the page asks of it
const serviceCalls: string[] = [];
const fakeService: ConnectionService = {
  start: async o => { serviceCalls.push(`start: ${o.text}`); return { microphone: true }; },
  stop: async () => { serviceCalls.push('stop'); },
  setCamera: async () => {},
  setImmersive: async () => ({}),
  diagnose: async () => ({ sdk: 35, release: '15', device: 'test' }),
  openSettings: async () => {},
  setSpeakerphone: async () => { /* not under test */ }
};

async function until(done: () => boolean, ms = 3000, what = 'the service'): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(serviceCalls)}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

before(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'libertad-mobile-'));
  dataDir = path.join(outDir, 'data');
  const bundle = path.join(await build(path.join(outDir, 'nodejs')), 'index.js');
  child = fork(bundle, [], {
    execPath: process.env.MOBILE_TEST_NODE || process.execPath,
    env: { ...process.env, LIBERTAD_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  });
  child.on('message', (m: any) => { for (const fn of handlers.get(m.event) ?? []) fn(...m.args); });
  bridge = {
    on: async (event, fn) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
    send: async (event, ...args) => { child.send({ event, args }); }
  };
  api = createAndroidApi(async () => bridge, {
    saveBackup: async (name, base64) => { saved.push({ name, base64 }); return `/saved/${name}.p12`; },
    service: async () => fakeService
  });
});

after(async () => {
  child?.kill();
  await rm(outDir, { recursive: true, force: true });
});

test('answers calls, and says so for one it does not know', async () => {
  const info = await api.platform.platformInfo();
  assert.equal(info.os, 'android');
  assert.ok(info.osVersion);
  await assert.rejects(api.backend.call('nope' as never), /Unknown call: nope/);
});

test('pings a server over UDP, and gives null when nobody answers', async () => {
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, from) => {
    if (msg.length !== 12) return;
    // version 1.5.2, the cookie, 3 users, 100 slots, 72000 bit/s
    const reply = Buffer.alloc(24);
    reply.writeUInt32BE((1 << 16) | (5 << 8) | 2, 0);
    msg.copy(reply, 4, 4, 12);
    reply.writeUInt32BE(3, 12);
    reply.writeUInt32BE(100, 16);
    reply.writeUInt32BE(72000, 20);
    udp.send(reply, from.port, from.address);
  });
  const port = await bindUdp(udp);
  try {
    const r = await api.platform.pingServer('127.0.0.1', port);
    assert.ok(r);
    assert.deepEqual({ users: r.users, maxUsers: r.maxUsers, bandwidth: r.bandwidth, version: r.version }, { users: 3, maxUsers: 100, bandwidth: 72000, version: '1.5.2' });
    assert.ok(r.ping >= 0);
  } finally { udp.close(); }

  const silent = dgram.createSocket('udp4');
  const silentPort = await bindUdp(silent);
  try { assert.equal(await api.platform.pingServer('127.0.0.1', silentPort), null); } finally { silent.close(); }
});

test('connects over TLS with the identity, carries bytes both ways, and voice over encrypted UDP', { timeout: 60000 }, async () => {
  const serverIdentity = generateIdentity('Mock Mumble server');

  // UDP voice: the server side of the OCB2 channel (nonces swapped, as the server has them the other way round)
  const key = randomBytes(16), clientNonce = randomBytes(16), serverNonce = randomBytes(16);
  const crypt = new CryptState();
  crypt.setKey(key, serverNonce, clientNonce);
  const voiceSeen: Buffer[] = [];
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, from) => {
    const plain = crypt.decrypt(msg);
    if (!plain) return;
    // A ping (type 1, protobuf): answered with the same bytes
    if (plain[0] === 1) { udp.send(crypt.encrypt(plain), from.port, from.address); return; }
    voiceSeen.push(plain);
    udp.send(crypt.encrypt(Buffer.from([0, 9, 8, 7])), from.port, from.address);
  });
  const port = await bindUdp(udp);

  // TLS: echoes what it gets, and notes the certificate the client showed
  const clientCerts: string[] = [];
  const server = tls.createServer({ key: serverIdentity.keyPem, cert: serverIdentity.certPem, requestCert: true, rejectUnauthorized: false }, sock => {
    clientCerts.push(sock.getPeerCertificate().fingerprint);
    sock.on('data', d => sock.write(d));
    sock.on('error', () => { /* closed */ });
  });
  await listen(server, port);

  try {
    // The first connection makes an identity, as nothing exists yet
    const t = api.openTransport('127.0.0.1', port);
    const closed = deferred<string>();
    t.onClose = r => closed.resolve(r);
    const info = await within(t.secure, 20000, 'the TLS handshake');
    assert.equal(info.fingerprint, new X509Certificate(serverIdentity.certPem).fingerprint256);
    assert.equal(info.authorized, false);
    assert.ok(info.chain[0].subject.includes('CN=Mock Mumble server'));

    const { identities } = await api.platform.identities.list();
    assert.equal(identities.length, 1);
    assert.equal(identities[0].name, 'Libertad user');
    assert.equal(identities[0].isDefault, true);
    assert.equal(clientCerts[0].replace(/:/g, '').toLowerCase(), identities[0].fingerprint);

    // 200 KB of every byte value, which arrives in many pieces and must come back in order
    const payload = new Uint8Array(randomBytes(200_000));
    payload.set([0, 1, 254, 255], 0);
    let echoed = Buffer.alloc(0);
    const all = deferred<void>();
    t.onData = chunk => { echoed = Buffer.concat([echoed, chunk]); if (echoed.length >= payload.length) all.resolve(undefined); };
    t.send(payload);
    await within(all.promise, 10000, 'the echo');
    assert.ok(echoed.equals(Buffer.from(payload)));

    // UDP voice: ping answered (the channel is up), then a voice packet each way
    const up = deferred<number>();
    const voice = deferred<Uint8Array>();
    t.udp!.onState = (ok, rtt) => { if (ok) up.resolve(rtt); };
    t.udp!.onVoice = v => voice.resolve(v);
    t.udp!.setup(key, clientNonce, serverNonce, true);
    assert.ok(await within(up.promise, 5000, 'the UDP ping') >= 0);
    t.udp!.send(Uint8Array.from([0, 1, 2, 3, 4]));
    assert.deepEqual([...await within(voice.promise, 5000, 'voice from the server')], [0, 9, 8, 7]);
    assert.deepEqual([...voiceSeen[0]], [0, 1, 2, 3, 4]);
    assert.equal((await t.udp!.clientNonce())?.length, 16);
    t.udp!.setServerNonce(serverNonce);

    t.close();
    assert.equal(await within(closed.promise, 5000, 'the close'), 'Disconnected');
  } finally {
    server.close();
    udp.close();
  }
});

test('identities: create, back up, restore, rename, remove', { timeout: 60000 }, async () => {
  const ids = api.platform.identities;
  const created = await ids.create('Alice', 'alice@example.com');
  assert.match(created.fingerprint, /^[0-9a-f]{40}$/);
  assert.equal(created.name, 'Alice');
  assert.equal(created.isDefault, false);
  assert.equal((await ids.list()).identities.length, 2);

  await ids.setDefault(created.id);
  await ids.rename(created.id, 'Alice 2');
  const listed = (await ids.list()).identities.find(i => i.id === created.id);
  assert.equal(listed?.isDefault, true);
  assert.equal(listed?.name, 'Alice 2');

  // The backup is handed to the page, which saves it
  assert.equal(await ids.exportP12(created.id, 'secret'), '/saved/Alice 2.p12');
  const bytes = fromB64(saved[0].base64);
  await assert.rejects(ids.importP12(bytes, 'secret', 'Copy'), /already stored/);
  await assert.rejects(ids.importP12(bytes, 'wrong', 'Copy'), /Could not open the file/);
  await ids.remove(created.id);
  const restored = await ids.importP12(bytes, 'secret', 'Restored');
  assert.equal(restored.fingerprint, created.fingerprint);
  assert.equal(restored.name, 'Restored');

  assert.equal((await ids.list()).setupDone, false);
  await ids.finishSetup();
  assert.equal((await ids.list()).setupDone, true);
  assert.equal(await ids.findMumble(), null);
  await assert.rejects(ids.importMumble(''), /no desktop Mumble/i);

  // Kept in the data folder, for the app's user only
  if (process.platform !== 'win32') assert.equal((await stat(path.join(dataDir, 'libertad', 'identities.json'))).mode & 0o777, 0o600);
});

test('describes certificates, and skips what is not one', async () => {
  const pem = generateIdentity('Cert Subject').certPem;
  const x = new X509Certificate(pem);
  const [d] = await api.platform.describeCerts([x.raw]);
  assert.ok(d.subject.includes('CN=Cert Subject'));
  assert.equal(d.fingerprint, x.fingerprint);
  assert.equal(d.ca, false);
  assert.equal(d.keyType, 'rsa');
  assert.equal(d.keyBits, 2048);
  assert.deepEqual(await api.platform.describeCerts([Uint8Array.from([1, 2, 3])]), []);
});

test('reads the public server list', async () => {
  const web = http.createServer((req, res) => {
    if (req.url === '/empty') { res.end('nothing here'); return; }
    res.setHeader('content-type', 'text/xml');
    res.end('<servers><server name="Test &amp; Co" ip="203.0.113.7" port="64739" country="Germany" country_code="DE" continent_code="EU" ca="1" url="www.example.com"/></servers>');
  });
  const port = await listen(web);
  try {
    assert.deepEqual(await api.platform.publicServers(`http://127.0.0.1:${port}/list`), [
      { name: 'Test & Co', host: '203.0.113.7', port: 64739, url: 'http://www.example.com', country: 'Germany', countryCode: 'de', continent: 'eu', ca: true }
    ]);
    await assert.rejects(api.platform.publicServers(`http://127.0.0.1:${port}/empty`), /no servers were found/);
    await assert.rejects(api.platform.publicServers('ftp://example.com/list'), /Invalid list address/);
  } finally { web.close(); }
});

test('a refused connection and bad arguments fail with a reason', async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise(res => probe.close(res));
  const refused = api.openTransport('127.0.0.1', port);
  const closed = deferred<string>();
  refused.onClose = r => closed.resolve(r);
  await assert.rejects(within(refused.secure, 5000, 'the refusal'), /ECONNREFUSED/);
  assert.match(await within(closed.promise), /ECONNREFUSED/);

  await assert.rejects(api.openTransport('127.0.0.1', 70000).secure, /Invalid port/);
  await assert.rejects(api.openTransport('', 64738).secure, /Invalid server address/);
});

test('a new page closes the connections of the old one; the same page saying hello again does not', async () => {
  const serverIdentity = generateIdentity('Mock Mumble server');
  const serverClosed = deferred<void>();
  const server = tls.createServer({ key: serverIdentity.keyPem, cert: serverIdentity.certPem }, sock => {
    sock.on('data', d => sock.write(d));
    sock.on('close', () => serverClosed.resolve(undefined));
    sock.on('error', () => { /* closed */ });
  });
  const port = await listen(server);
  try {
    const t = api.openTransport('127.0.0.1', port);
    const closed = deferred<string>();
    t.onClose = r => closed.resolve(r);
    await within(t.secure, 10000, 'the TLS handshake');

    const answered = deferred<unknown>();
    await bridge.on(CH.ready, token => { if (token === 'another-page') answered.resolve(token); });
    await bridge.send(CH.hello, 'another-page');
    assert.equal(await within(answered.promise, 5000, 'ready'), 'another-page');
    await within(serverClosed.promise, 5000, 'the old connection to close');
    await within(closed.promise, 5000, 'the old page to hear of it');

    // The new page's own connection stays open when it says hello again (the page repeats it until it hears `ready`)
    const again = api.openTransport('127.0.0.1', port);
    await within(again.secure, 10000, 'the TLS handshake');
    const echo = (bytes: number[]) => {
      const got = deferred<Uint8Array>();
      again.onData = c => got.resolve(c);
      again.send(Uint8Array.from(bytes));
      return within(got.promise, 5000, 'the echo').then(c => [...c]);
    };
    assert.deepEqual(await echo([1, 2, 3]), [1, 2, 3]);
    const again2 = deferred<unknown>();
    await bridge.on(CH.ready, token => { if (token === 'another-page') again2.resolve(token); });
    await bridge.send(CH.hello, 'another-page');
    await within(again2.promise, 5000, 'ready');
    assert.deepEqual(await echo([4, 5, 6]), [4, 5, 6]);
    again.close();
  } finally { server.close(); }
});

test('the connection service runs while a server is connected, and only then', { timeout: 30000 }, async () => {
  const serverIdentity = generateIdentity('Mock Mumble server');
  const server = tls.createServer({ key: serverIdentity.keyPem, cert: serverIdentity.certPem }, sock => { sock.on('error', () => { /* closed */ }); });
  const port = await listen(server);
  const closedPort = await (async () => { const p = net.createServer(); const n = await listen(p); await new Promise(res => p.close(res)); return n; })();
  try {
    // Earlier tests left connections whose last close stops the service a moment later: let that finish first
    await until(() => serviceCalls.length === 0 || serviceCalls.at(-1) === 'stop', 3000, 'the earlier tests to settle');
    await new Promise(r => setTimeout(r, 50));

    // A refused connection never starts it
    serviceCalls.length = 0;
    await assert.rejects(api.openTransport('127.0.0.1', closedPort).secure, /ECONNREFUSED/);
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(serviceCalls, []);

    // The first connection that is up starts it, named in the notification
    const a = api.openTransport('127.0.0.1', port);
    await within(a.secure, 10000, 'the TLS handshake');
    await until(() => serviceCalls.length === 1);
    assert.deepEqual(serviceCalls, ['start: Connected to 127.0.0.1']);

    // A second one only updates the notification
    const b = api.openTransport('127.0.0.1', port);
    await within(b.secure, 10000, 'the TLS handshake');
    await until(() => serviceCalls.length === 2);
    assert.equal(serviceCalls[1], 'start: Connected to 2 servers');

    // Closing one updates it again; closing the last stops it
    a.close();
    await until(() => serviceCalls.length === 3);
    assert.equal(serviceCalls[2], 'start: Connected to 127.0.0.1');
    b.close();
    await until(() => serviceCalls.length === 4);
    assert.equal(serviceCalls[3], 'stop');
  } finally { server.close(); }
});
