// Browser build, large files: the file picker opens first, the download streams into the picked file.
// The picker dialog is replaced by a real file handle in the browser's private file system, so
// createWritable, positioned writes, close and abort are the browser's own.
//   npm run build:web && MUMBLE_TEST_HOST=localhost:64739 node test/e2e/files-disk-web.e2e.ts
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCodec } from '../../src/core/proto.ts';
import { MumbleClient } from '../../src/core/client.ts';
import type { Transport } from '../../src/core/transport.ts';
import { openTls } from '../../electron/tls-transport.ts';
import { generateIdentity } from '../../electron/identity.ts';
import {
  FILE, FILE_DATA_ID, FileAssembler, Sender, pump as pumpPieces, announce, encodeFileSignal,
  pieceBytes, pieceCount, pieceSize, pieceForm, pieceMessage, fromRanges, sha256, rootHash, encode15
} from '../../src/core/file-transfer.ts';

const target = process.env.MUMBLE_TEST_HOST;
if (!target) {
  console.log('MUMBLE_TEST_HOST not set, skipping');
  process.exit(0);
}
const [host, port] = target.split(':');
const root = path.resolve(import.meta.dirname, '../..');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 20000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(100);
  }
}
function headless(username: string): Promise<MumbleClient> {
  const id = generateIdentity(username);
  const client = new MumbleClient(createCodec());
  const t: Transport = { onData: null, onClose: null, send: b => conn.send(b), close: () => conn.close() };
  const conn = openTls(host, Number(port), id.certPem, id.keyPem, { onSecure: () => {}, onData: c => t.onData?.(c), onClose: r => t.onClose?.(r) });
  client.connect(t, { username, os: 'test' });
  return new Promise((res, rej) => { client.on('synced', () => res(client)); client.on('close', rej); });
}

const proxyPort = 18000 + Math.floor(Math.random() * 1000);
const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
const proxy = spawn(process.execPath, [path.join(root, 'dist-proxy/proxy.mjs')], {
  env: { ...env, MUMH5_PORT: String(proxyPort), MUMH5_SERVERS: `${target}=Test Server`, MUMH5_STUN_PORT: String(proxyPort + 1000), MUMH5_STUN_BIND: '127.0.0.1', MUMH5_ALLOW_PRIVATE: '1', MUMH5_TURN_IP: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'inherit']
});
await new Promise<void>((res, rej) => {
  proxy.stdout.on('data', d => { if (String(d).includes('listening')) res(); });
  proxy.on('exit', code => rej(new Error(`proxy exited with ${code}`)));
});
const app = await electron.launch({
  executablePath: electronPath as unknown as string,
  args: [path.join(root, 'test/e2e/web-shell.cjs'), `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'mumh5-e2e-'))}`, '--ozone-platform=x11', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
  env: { ...env, MUMH5_WEB_URL: `http://127.0.0.1:${proxyPort}/`, MUMH5_DOWNLOADS: mkdtempSync(path.join(tmpdir(), 'mumh5-e2e-dl-')) } as Record<string, string>
});
const bob = await headless('bob');
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('dialog', { name: 'Set up your identity' }).waitFor();
  await page.getByRole('button', { name: /Create a new identity/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('alice');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('dialog', { name: 'Set up your identity' }).waitFor({ state: 'detached' });
  await page.getByTitle('Add a server').click();
  await page.getByLabel('Server', { exact: true }).waitFor();
  await page.getByLabel('Username').fill(`webalice${Date.now() % 100000}`);
  await page.getByRole('button', { name: 'Save and connect' }).click();
  await page.getByText(/Connected/).first().waitFor();
  await page.locator('.sidebar').getByText('bob').waitFor();

  await page.evaluate(() => {
    const w = window as any;
    localStorage.setItem('mumh5.diskMin', '100000');
    w.__calls = 0; w.__mode = 'wait';
    // The browser's own picker is replaced: the test decides the answer, and when
    w.showSaveFilePicker = async (o: { suggestedName: string }) => {
      w.__calls++;
      while (w.__mode === 'wait') await new Promise(r => setTimeout(r, 25));
      const mode = w.__mode;
      w.__mode = 'wait';
      if (mode === 'cancel') throw new DOMException('closed', 'AbortError');
      return (await navigator.storage.getDirectory()).getFileHandle(o.suggestedName, { create: true });
    };
  });
  const calls = () => page.evaluate(() => (window as any).__calls as number);
  const choose = (mode: 'ok' | 'cancel') => page.evaluate(m => { (window as any).__mode = m; }, mode);
  const stored = (name: string) => page.evaluate(async n => {
    const f = await (await (await navigator.storage.getDirectory()).getFileHandle(n)).getFile();
    const sum = await crypto.subtle.digest('SHA-256', await f.arrayBuffer());
    return { size: f.size, sha: [...new Uint8Array(sum)].map(b => b.toString(16).padStart(2, '0')).join('') };
  }, name);

  const fileAsm = new FileAssembler();
  const sender = new Sender();
  const served = new Map<string, { meta: { s: number; c: number }; data: Buffer }>();
  const wants: string[] = [];
  let pumping = false;
  const bobSignal = async (to: number[], type: (typeof FILE)[keyof typeof FILE], body: unknown) => {
    for (const packet of await encodeFileSignal(type, body)) bob.sendPluginData(to, FILE_DATA_ID, packet);
  };
  bob.on('pluginData', async (from, id, packet) => {
    if (id !== FILE_DATA_ID) return;
    const sig = await fileAsm.push(from, packet);
    if (!sig) return;
    const body = JSON.parse(sig.text!);
    if (sig.type === FILE.want) wants.push(body.i);
    const mine = served.get(body.i);
    if (!mine) return;
    if (sig.type === FILE.who) return void bobSignal([from], FILE.have, { i: body.i });
    if (sig.type === FILE.want) {
      sender.want(body.i, from, fromRanges(body.r, pieceCount(mine.meta))!);
      if (!pumping) {
        pumping = true;
        pumpPieces({
          client: bob, sender, alive: () => true,
          read: async (f, k) => { const x = served.get(f)!; return pieceMessage(pieceForm(bob.config), f, k, encode15(x.data.subarray(k * x.meta.c, k * x.meta.c + pieceSize(x.meta, k)))); },
          done: (r, f) => bobSignal([r], FILE.done, { i: f }), gone: () => {}
        }).finally(() => { pumping = false; });
      }
    }
  });
  async function offer(name: string, size: number) {
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
    const c = pieceBytes(bob.config);
    const pm = { s: size, c };
    const digests: Uint8Array[] = [];
    for (let k = 0; k < pieceCount(pm); k++) digests.push(await sha256(data.subarray(k * c, k * c + pieceSize(pm, k))));
    const meta = { i: 'e2eweb' + Math.random().toString(36).slice(2, 8), n: name, s: size, m: '', c, h: await rootHash(digests) };
    served.set(meta.i, { meta, data });
    bob.sendText({ channels: [0] }, announce(meta, `<b>${name}</b> (${size} B, file shared with mumh5)`));
    const card = page.locator('.chat .msg .file', { hasText: name });
    await card.waitFor();
    return { data, card };
  }

  // 1. The picker opens on the click and nothing is fetched until it is answered
  const one = await offer('big.bin', 700_000);
  await sleep(1500);
  assert.equal(await calls(), 0, 'no picker without a click');
  assert.equal(wants.length, 0, 'large files are not fetched by themselves');
  await one.card.getByRole('button', { name: 'Download' }).click();
  await until('the picker', async () => (await calls()) >= 1);
  await sleep(1500);
  assert.equal(wants.length, 0, 'nothing requested while the picker is open');
  await choose('ok');
  await one.card.getByText(/saved as big\.bin/).waitFor({ timeout: 30000 });
  const got = await stored('big.bin');
  assert.equal(got.size, one.data.length);
  assert.equal(got.sha, createHash('sha256').update(one.data).digest('hex'), 'the picked file holds the file, intact');
  console.log('ok: browser: picker first, then the file streams into the picked file');

  // 2. Closing the picker cancels
  const two = await offer('refused.bin', 300_000);
  const before = wants.length;
  await two.card.getByRole('button', { name: 'Download' }).click();
  await until('picker 2', async () => (await calls()) >= 2);
  await choose('cancel');
  await sleep(1500);
  assert.equal(wants.length, before);
  assert.ok(await two.card.getByRole('button', { name: 'Download' }).isVisible());
  console.log('ok: browser: closing the picker cancels the download');

  // 3. Stopping mid-download leaves nothing written in the picked file
  const three = await offer('stopped.bin', 40_000_000);
  await three.card.getByRole('button', { name: 'Download' }).click();
  await until('picker 3', async () => (await calls()) >= 3);
  await choose('ok');
  await three.card.getByRole('button', { name: /Stop downloading/ }).waitFor();
  await sleep(4000);
  await three.card.getByRole('button', { name: /Stop downloading/ }).click();
  await three.card.getByRole('button', { name: 'Download' }).waitFor();
  await sleep(500);
  assert.equal((await stored('stopped.bin')).size, 0, 'what was streamed is discarded');
  console.log('ok: browser: stopping discards what was streamed');
} finally {
  bob.disconnect();
  await app.close();
  proxy.kill();
}
console.log('all browser large-file steps passed');
