// Throttle when hidden: hiding the window (tray click, the X button) takes the main view down, showing it brings it back.
//   npm run build && npm run test:e2e:hidden        (on a machine without a display: xvfb-run -a npm run test:e2e:hidden)
// The main process prints "[throttle] ..." lines when run from source, which this script echoes.
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = path.resolve(import.meta.dirname, '../..');
const app = await electron.launch({
  executablePath: electronPath, cwd: root,
  args: ['.', '--no-sandbox', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'libertad-hidden-'))}`]
});
app.process().stdout.on('data', d => { for (const l of String(d).split('\n')) if (l.includes('[throttle]')) console.log('  main>', l); });
const page = await app.firstWindow();
await page.waitForLoadState('load');
await sleep(2500);

const drawn = () => page.evaluate(() => !!document.querySelector('.app, .framed'));
const onWindow = body => app.evaluate(({ BrowserWindow }, src) => new Function('w', src)(BrowserWindow.getAllWindows()[0]), body);
let failed = false;
async function step(name, body, expectDrawn) {
  const result = await onWindow(body);
  if (result === 'skip') { console.log(`SKIP  ${name} (this environment has no window manager)`); return; }
  await sleep(1200);
  const d = await drawn();
  const ok = d === expectDrawn;
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: main view ${d ? 'drawn' : 'not drawn'}`);
}

await step('tray click hides', 'w.hide()', false);
await step('tray click shows', 'w.show()', true);
await step('X button hides to the tray', 'w.close()', false);
await step('shown again', 'w.show()', true);
await step('minimize', 'w.minimize(); return w.isMinimized() ? "" : "skip"', false);
await step('restore', 'w.restore(); w.show()', true);
await app.close().catch(() => {});
process.exit(failed ? 1 : 0);
