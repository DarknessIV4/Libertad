// Large files: the app asks where to save first, writes straight into that file, keeps no second copy.
//   npm run build && MUMBLE_TEST_HOST=localhost:64739 node test/e2e/files-disk.e2e.ts
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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

function headless(username: string): Promise<MumbleClient> {
  const codec = createCodec();
  const id = generateIdentity(username);
  const client = new MumbleClient(codec);
  const t: Transport = { onData: null, onClose: null, send: b => conn.send(b), close: () => conn.close() };
  const conn = openTls(host, Number(port), id.certPem, id.keyPem, { onSecure: () => {}, onData: c => t.onData?.(c), onClose: r => t.onClose?.(r) });
  client.connect(t, { username, password: '', os: 'test' });
  return new Promise((res, rej) => { client.on('synced', () => res(client)); client.on('close', rej); });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 20000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(100);
  }
}

const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
const userData = mkdtempSync(path.join(tmpdir(), 'libertad-e2e-disk-'));
const dest = path.join(userData, 'chosen');
mkdirSync(dest);
const app = await electron.launch({
  executablePath: electronPath as unknown as string,
  args: [root, `--user-data-dir=${userData}`, '--ozone-platform=x11', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
  env: env as Record<string, string>
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
  await page.getByLabel('Address').fill(host);
  await page.getByLabel('Port').fill(port);
  await page.getByLabel('Label').fill('Test Server');
  await page.getByRole('button', { name: 'Save and connect' }).click();
  await page.getByText(/Connected/).first().waitFor();
  const alice = [...bob.users.values()].find(u => u.name === 'alice')!.session;

  // Anything from 100 KB up counts as large, so the test needs no huge file
  await page.evaluate(() => localStorage.setItem('libertad.diskMin', '100000'));
  // The Save dialog is replaced: the test decides the answer, and when it is given
  await app.evaluate(({ dialog }) => {
    const g = globalThis as any;
    g.__dialogCalls = 0;
    g.__answer = null;
    dialog.showSaveDialog = (async () => {
      g.__dialogCalls++;
      while (!g.__answer) await new Promise(r => setTimeout(r, 25));
      const a = g.__answer;
      g.__answer = null;
      return a;
    }) as any;
  });
  const dialogCalls = () => app.evaluate(() => (globalThis as any).__dialogCalls as number);
  const answer = (a: { canceled: boolean; filePath?: string }) => app.evaluate((_e, a) => { (globalThis as any).__answer = a; }, a);

  // Bob serves files the way the app does and notes every request
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
  async function offer(name: string, size: number, serve: boolean, from = bob, leave = false) {
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
    const c = pieceBytes(bob.config);
    const pm = { s: size, c };
    const digests: Uint8Array[] = [];
    for (let k = 0; k < pieceCount(pm); k++) digests.push(await sha256(data.subarray(k * c, k * c + pieceSize(pm, k))));
    const meta = { i: 'e2edisk' + Math.random().toString(36).slice(2, 8), n: name, s: size, m: '', c, h: await rootHash(digests) };
    if (serve) served.set(meta.i, { meta, data });
    from.sendText({ channels: [0] }, announce(meta, `<b>${name}</b> (${size} B, file shared with Libertad)`));
    const card = page.locator('.chat .msg .file', { hasText: name });
    await card.waitFor();
    // The announcer leaves, so nobody is left who has it
    if (leave) { await sleep(300); from.disconnect(); await sleep(500); }
    return { meta, data, card };
  }
  const leftovers = () => [...(existsSync(path.join(userData, 'files')) ? readdirSync(path.join(userData, 'files')) : [])];

  // 1. Nothing is fetched until the person has chosen where to save
  const one = await offer('big.bin', 700_000, true);
  await sleep(1500);
  assert.equal(await dialogCalls(), 0, 'no dialog without a click: large files are never fetched by themselves');
  assert.equal(wants.length, 0, 'nothing requested without a click');
  const saved = path.join(dest, 'Chosen name.bin');
  await one.card.getByRole('button', { name: 'Download' }).click();
  await until('dialog 1', async () => (await dialogCalls()) >= 1);
  assert.equal(await dialogCalls(), 1, 'the dialog opens on the click');
  await sleep(1500);
  assert.equal(wants.length, 0, 'while the dialog is open nothing is requested');
  assert.deepEqual(readdirSync(dest), [], 'and nothing is written');
  await answer({ canceled: false, filePath: saved });
  await one.card.getByText(/saved to/).waitFor({ timeout: 30000 });
  assert.ok(readFileSync(saved).equals(one.data), 'the file is in the chosen place, intact');
  assert.deepEqual(readdirSync(dest), ['Chosen name.bin'], 'no part file left');
  assert.deepEqual(leftovers(), [], 'no second copy in the app folder');
  assert.ok(await one.card.getByRole('button', { name: 'Show in folder' }).isVisible());
  console.log('ok: the dialog comes first, then the file is written straight into the chosen place (one copy)');

  // 2. Closing the dialog cancels: nothing is fetched or written
  const two = await offer('refused.bin', 300_000, true);
  const before = wants.length;
  await two.card.getByRole('button', { name: 'Download' }).click();
  await until('dialog 2', async () => (await dialogCalls()) >= 2);
  await answer({ canceled: true });
  await sleep(1500);
  assert.equal(wants.length, before, 'nothing requested after cancelling');
  assert.ok(await two.card.getByRole('button', { name: 'Download' }).isVisible(), 'the card offers Download again');
  assert.deepEqual(readdirSync(dest), ['Chosen name.bin']);
  console.log('ok: closing the Save dialog cancels the download');

  // 3. Nobody has the file: the part file is deleted at once, not at the next start
  const carol = await headless('carol');
  const three = await offer('nobody.bin', 300_000, false, carol, true);
  const lost = path.join(dest, 'nobody.bin');
  await three.card.getByRole('button', { name: 'Download' }).click();
  await until('dialog 3', async () => (await dialogCalls()) >= 3);
  await answer({ canceled: false, filePath: lost });
  await until('the part file to appear', () => existsSync(lost + '.libertadpart'), 5000);
  await three.card.getByText('Nobody online has this file right now').waitFor({ timeout: 15000 });
  await until('the part file to be deleted', () => !existsSync(lost + '.libertadpart'), 5000);
  assert.ok(!existsSync(lost));
  assert.deepEqual(leftovers(), []);
  assert.ok(await three.card.getByRole('button', { name: 'Try again' }).isVisible());
  console.log('ok: a download that fails deletes its part file straight away');

  // 4. Stopping a download does the same
  const four = await offer('stopped.bin', 40_000_000, true);
  const stopPath = path.join(dest, 'stopped.bin');
  await four.card.getByRole('button', { name: 'Download' }).click();
  await until('dialog 4', async () => (await dialogCalls()) >= 4);
  await answer({ canceled: false, filePath: stopPath });
  await until('part file', () => existsSync(stopPath + '.libertadpart'), 5000);
  await four.card.getByRole('button', { name: /Stop downloading/ }).click();
  await until('the part file to be deleted after Stop', () => !existsSync(stopPath + '.libertadpart'), 5000);
  assert.ok(await four.card.getByRole('button', { name: 'Download' }).isVisible());
  console.log('ok: stopping a download deletes its part file');

  // 5. Small files (under the large-file size) are unchanged: fetched by themselves, no dialog
  const calls = await dialogCalls();
  const small = await offer('small.bin', 50_000, true);
  await small.card.locator('a[download="small.bin"]').waitFor({ timeout: 30000 });
  assert.equal(await dialogCalls(), calls, 'no dialog for a small file');
  console.log('ok: small files still download by themselves and are saved from the card as before');

  // 6. Sending still works, for a small and for a large file
  for (const [name, size] of [['sent-small.bin', 50_000], ['sent-large.bin', 300_000]] as const) {
    const data = Buffer.alloc(size);
    crypto.getRandomValues(data.subarray(0, 65536));
    const file = path.join(userData, name);
    writeFileSync(file, data);
    const announced = new Promise<string>(res => bob.on('text', m => { if (m.html.includes('<!--libertad:file:') && m.html.includes(name)) res(m.html); }));
    await page.locator('.chat .composer input[type=file]').first().setInputFiles(file);
    await announced;
    await page.locator('.chat .msg .file', { hasText: name }).getByText(/\d+(\.\d+)? (KB|MB)/).first().waitFor();
  }
  console.log('ok: the app can still send a small and a large file');
} finally {
  bob.disconnect();
  await app.close();
}
console.log('all large-file steps passed');
