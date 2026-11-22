import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../../src/lib/capacitor-plugin.ts';

test('a native call that answers passes through, one that never answers fails instead of hanging', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000, 'The phone'), 7);
  await assert.rejects(withTimeout(new Promise(() => {}), 20, 'The phone'), /The phone did not answer/);
  await assert.rejects(withTimeout(Promise.reject(new Error('no')), 1000, 'The phone'), /no/);
});
