import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isAndroid } from '../../src/lib/platform.ts';

// settings.svelte.ts starts the interface as Rooms when this is true (the Android app) and standard otherwise
const g = globalThis as { Capacitor?: unknown };
afterEach(() => { delete g.Capacitor; });

test('Android only when Capacitor says so', () => {
  assert.equal(isAndroid(), false);
  g.Capacitor = { getPlatform: () => 'ios' };
  assert.equal(isAndroid(), false);
  g.Capacitor = { getPlatform: () => 'web' };
  assert.equal(isAndroid(), false);
  g.Capacitor = {};
  assert.equal(isAndroid(), false);
  g.Capacitor = { getPlatform: () => 'android' };
  assert.equal(isAndroid(), true);
});
