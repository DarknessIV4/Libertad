import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsBuild, windowsExcludeSupported } from '../electron/win-audio.ts';

test('reads the Windows build number from the OS release', () => {
  assert.equal(windowsBuild('10.0.22631'), 22631);
  assert.equal(windowsBuild('10.0.19045'), 19045);
  assert.equal(windowsBuild('unknown'), 0);
});

test('leaving this app out is only offered on Windows', async () => {
  if (process.platform !== 'win32') assert.equal(await windowsExcludeSupported(), false);
});
