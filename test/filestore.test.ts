import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileStore, classify, PART_SUFFIX, type FileStoreOptions } from '../electron/filestore-core.ts';

function setup(extra: Partial<FileStoreOptions> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mumh5-fs-'));
  const cache = path.join(root, 'cache');
  const dest = path.join(root, 'dest');
  mkdirSync(cache);
  mkdirSync(dest);
  const stateFile = path.join(root, 'state.json');
  const make = () => createFileStore({ cacheDir: () => cache, stateFile: () => stateFile, ...extra });
  return { root, cache, dest, stateFile, make, store: make(), done: () => rmSync(root, { recursive: true, force: true }) };
}

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255);

test('pieces written out of order end up in the chosen file, and nowhere else', async () => {
  const t = setup();
  const data = bytes(1000);
  const target = path.join(t.dest, 'movie.bin');
  assert.deepEqual(await t.store.begin('a1', target, data.length, 'h1'), { ok: true });
  // The part file sits beside the target while the download runs
  assert.ok(existsSync(target + PART_SUFFIX));
  assert.equal(statSync(target + PART_SUFFIX).size, 1000);
  for (const k of [3, 0, 2, 1]) await t.store.write('a1', k * 250, data.subarray(k * 250, (k + 1) * 250));
  assert.equal(await t.store.finish('a1'), target);
  assert.deepEqual(readFileSync(target), Buffer.from(data));
  assert.deepEqual(readdirSync(t.dest), ['movie.bin'], 'no part file left');
  assert.deepEqual(readdirSync(t.cache), [], 'nothing was cached: one copy only');
  assert.deepEqual(await t.store.where('a1', 'h1'), { kind: 'saved', path: target });
  t.done();
});

test('removing an unfinished download deletes the part file and stops further writes', async () => {
  const t = setup();
  const target = path.join(t.dest, 'x.bin');
  await t.store.begin('b1', target, 100, 'h');
  await t.store.write('b1', 0, bytes(10));
  await t.store.remove('b1');
  assert.deepEqual(readdirSync(t.dest), []);
  await assert.rejects(t.store.write('b1', 10, bytes(10)), /no destination/);
  assert.deepEqual(readdirSync(t.dest), [], 'a late write does not bring the file back');
  t.done();
});

test('a saved file is never deleted by remove', async () => {
  const t = setup();
  const target = path.join(t.dest, 'keep.bin');
  await t.store.begin('c1', target, 4, 'h');
  await t.store.write('c1', 0, bytes(4));
  await t.store.finish('c1');
  await t.store.remove('c1');
  assert.ok(existsSync(target));
  t.done();
});

test('writes past the announced size are refused', async () => {
  const t = setup();
  await t.store.begin('d1', path.join(t.dest, 'y.bin'), 100, 'h');
  await assert.rejects(t.store.write('d1', 95, bytes(10)), /bad write/);
  await assert.rejects(t.store.write('d1', -1, bytes(1)), /bad write/);
  await assert.rejects(t.store.write('d1', 1.5, bytes(1)), /bad write/);
  assert.equal(await t.store.write('d1', 90, bytes(10)), true);
  await t.store.remove('d1');
  t.done();
});

test('too little room on the chosen drive is refused before anything is written', async () => {
  const t = setup({ free: async () => 500 });
  const target = path.join(t.dest, 'big.bin');
  assert.deepEqual(await t.store.begin('e1', target, 1000, 'h'), { ok: false, reason: 'space', free: 500 });
  assert.deepEqual(readdirSync(t.dest), []);
  t.done();
});

test('a folder that cannot be written to is reported, not thrown', async () => {
  const t = setup();
  const r = await t.store.begin('f1', path.join(t.dest, 'missing', 'z.bin'), 10, 'h');
  assert.equal(r.ok, false);
  t.done();
});

test('a retry for the same file starts clean and drops the old part file', async () => {
  const t = setup();
  const first = path.join(t.dest, 'one.bin');
  const second = path.join(t.dest, 'two.bin');
  await t.store.begin('g1', first, 10, 'h');
  await t.store.begin('g1', second, 10, 'h');
  assert.deepEqual(readdirSync(t.dest).sort(), ['two.bin' + PART_SUFFIX]);
  await t.store.remove('g1');
  t.done();
});

test('a finished file that is the wrong size is not put in place', async () => {
  const t = setup();
  const target = path.join(t.dest, 'w.bin');
  await t.store.begin('h1', target, 10, 'h');
  // Cut the part file short behind the store's back
  writeFileSync(target + PART_SUFFIX, Buffer.alloc(5));
  await assert.rejects(t.store.finish('h1'), /wrong size/);
  assert.ok(!existsSync(target));
  await t.store.remove('h1');
  assert.deepEqual(readdirSync(t.dest), []);
  t.done();
});

test('after a restart the leftovers of unfinished downloads are swept, saved files are not', async () => {
  const t = setup();
  const keep = path.join(t.dest, 'done.bin');
  const lost = path.join(t.dest, 'lost.bin');
  await t.store.begin('i1', keep, 4, 'h');
  await t.store.write('i1', 0, bytes(4));
  await t.store.finish('i1');
  await t.store.begin('i2', lost, 100, 'h');
  // An older version's partial file in the cache
  writeFileSync(path.join(t.cache, 'abc.part'), 'x');
  await t.store.flush();

  const restarted = t.make();
  await restarted.sweep();
  assert.ok(existsSync(keep));
  assert.ok(!existsSync(lost + PART_SUFFIX));
  assert.deepEqual(readdirSync(t.cache), []);
  assert.deepEqual(await restarted.where('i1', 'h'), { kind: 'saved', path: keep }, 'the record of saved files survives');
  t.done();
});

test('sweep only deletes part files, whatever the state file says', async () => {
  const t = setup();
  const precious = path.join(t.dest, 'precious.txt');
  writeFileSync(precious, 'mine');
  writeFileSync(t.stateFile, JSON.stringify({ saved: {}, partial: [precious] }));
  await t.make().sweep();
  assert.ok(existsSync(precious));
  t.done();
});

test('a saved file that was moved or changed is forgotten', async () => {
  const t = setup();
  const target = path.join(t.dest, 'm.bin');
  await t.store.begin('j1', target, 4, 'h');
  await t.store.write('j1', 0, bytes(4));
  await t.store.finish('j1');
  assert.equal((await t.store.where('j1', 'other-hash')), null, 'a different announcement is not this file');
  rmSync(target);
  assert.equal(await t.store.where('j1', 'h'), null);
  assert.equal(await t.store.savedPath('j1'), null, 'dropped from the record');
  t.done();
});

test('a file an older version cached is moved out, not copied', async () => {
  const t = setup();
  writeFileSync(t.store.cachedPath('k1'), Buffer.from(bytes(64)));
  assert.deepEqual(await t.store.where('k1', 'h'), { kind: 'cache' });
  const target = path.join(t.dest, 'old.bin');
  writeFileSync(target, 'something older at the target');
  assert.deepEqual(await t.store.moveOut('k1', target, 'h'), { ok: true, path: target });
  assert.deepEqual(readFileSync(target), Buffer.from(bytes(64)));
  assert.deepEqual(readdirSync(t.cache), [], 'it left the cache');
  assert.deepEqual(await t.store.where('k1', 'h'), { kind: 'saved', path: target });
  t.done();
});

test('moving a file that is not in the cache fails cleanly', async () => {
  const t = setup();
  assert.deepEqual(await t.store.moveOut('nope', path.join(t.dest, 'n.bin'), 'h'), { ok: false, reason: 'error' });
  t.done();
});

test('error codes map to what the person is told', () => {
  assert.equal(classify({ code: 'ENOSPC' }), 'space');
  assert.equal(classify({ code: 'EDQUOT' }), 'space');
  assert.equal(classify({ code: 'EFBIG' }), 'toolarge');
  assert.equal(classify({ code: 'EACCES' }), 'error');
  assert.equal(classify(null), 'error');
});
