import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAndroidPip, pipProblem, shapeOf, PIP_ATTR, PIP_CLASS, type PipPlugin, type PipPicture, type PipResult } from '../../src/lib/android-pip.ts';

// A page that is just enough for the module: a root with a class list, elements with attributes, a style that can be removed
function rig() {
  const classes = new Set<string>();
  const root = { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) } } as unknown as HTMLElement;
  const element = () => { const attrs = new Set<string>(); return { setAttribute: (a: string) => attrs.add(a), removeAttribute: (a: string) => attrs.delete(a), has: (a: string) => attrs.has(a) } as unknown as HTMLElement & { has(a: string): boolean }; };
  const calls: unknown[][] = [];
  let listener: ((e: { active: boolean }) => void) | null = null;
  let entered = true;
  let answer: Partial<PipResult> | Error | null = null;
  const plugin: PipPlugin = {
    arm: async o => { calls.push(['arm', o]); },
    enter: async o => { calls.push(['enter', o]); if (answer instanceof Error) throw answer; return { supported: true, entered, ...(answer ?? {}) }; },
    exit: async () => { calls.push(['exit']); },
    addListener: async (_e, cb) => { listener = cb; return { remove: async () => {} }; }
  };
  let styles = 0;
  const timers: { f: () => void; ms: number; live: boolean }[] = [];
  const pip = createAndroidPip({
    plugin: async () => plugin, root: () => root,
    addStyle: () => { styles++; return () => { styles--; }; },
    setInterval: (f, ms) => { timers.push({ f, ms, live: true }); return timers.length - 1; },
    clearInterval: t => { timers[t as number].live = false; }
  });
  const tick = (ms: number) => timers.filter(t => t.live && t.ms === ms).forEach(t => t.f());
  const settle = () => new Promise(r => setImmediate(r));
  return { pip, classes, element, calls, emit: (active: boolean) => listener!({ active }), styles: () => styles, tick, settle, setEntered: (v: boolean) => { entered = v; }, answer: (a: Partial<PipResult> | Error | null) => { answer = a; } };
}
const pic = (el: HTMLElement, extra: Partial<PipPicture> = {}): PipPicture => ({ el, width: 1920, height: 1080, ...extra });

test('the shape is told with the short side at 100, and a missing size is 16:9', () => {
  assert.deepEqual(shapeOf({ width: 1920, height: 1080 }), { width: 178, height: 100 });
  assert.deepEqual(shapeOf({ width: 720, height: 1280 }), { width: 100, height: 178 });
  assert.deepEqual(shapeOf(null), { width: 178, height: 100 });
  assert.deepEqual(shapeOf({ width: 0, height: 0 }), { width: 178, height: 100 });
});

test('the plugin is armed while a running picture is shown, once per change, and disarmed when it goes', async () => {
  const r = rig();
  let p: PipPicture | null = pic(r.element());
  const stop = r.pip.follow(() => p);
  await r.settle();
  assert.deepEqual(r.calls.filter(c => c[0] === 'arm'), [['arm', { enabled: true, width: 178, height: 100 }]]);
  r.tick(1000); await r.settle();
  assert.equal(r.calls.filter(c => c[0] === 'arm').length, 1, 'nothing changed, nothing sent');
  p = pic(r.element(), { running: false });
  r.tick(1000); await r.settle();
  assert.deepEqual(r.calls.at(-1), ['arm', { enabled: false, width: 178, height: 100 }]);
  p = pic(r.element(), { width: 720, height: 1280 });
  r.tick(1000); await r.settle();
  assert.deepEqual(r.calls.at(-1), ['arm', { enabled: true, width: 100, height: 178 }]);
  p = null; stop(); await r.settle();
  assert.deepEqual(r.calls.at(-1), ['arm', { enabled: false, width: 178, height: 100 }]);
});

test('the small window: only the picture is left, and everything comes back with the big one', async () => {
  const r = rig();
  const el = r.element();
  const seen: boolean[] = [];
  r.pip.watch(a => seen.push(a));
  r.pip.follow(() => pic(el));
  await r.settle();
  r.emit(true);
  assert.equal(r.classes.has(PIP_CLASS), true);
  assert.equal(el.has(PIP_ATTR), true);
  assert.equal(r.styles(), 1);
  r.emit(false);
  assert.equal(r.classes.has(PIP_CLASS), false);
  assert.equal(el.has(PIP_ATTR), false);
  assert.equal(r.styles(), 0);
  assert.deepEqual(seen, [true, false]);
});

test('the button takes the picture it was pressed on, and the small window shows that one', async () => {
  const r = rig();
  const a = r.element(), b = r.element();
  r.pip.follow(() => pic(a));
  await r.settle();
  const res = await r.pip.enter(() => pic(b, { width: 720, height: 1280, running: false }));
  assert.equal(res.entered, true);
  assert.deepEqual(r.calls.at(-1), ['enter', { width: 100, height: 178 }]);
  r.emit(true);
  assert.equal(b.has(PIP_ATTR), true);
  assert.equal(a.has(PIP_ATTR), false);
  r.emit(false);
  // a later small window (leaving the app) is the newest screen's again
  r.emit(true);
  assert.equal(a.has(PIP_ATTR), true);
});

test('a picture that ends while the small window is up closes it; a refused button asks for nothing more', async () => {
  const r = rig();
  const el = r.element();
  let p: PipPicture | null = pic(el);
  r.pip.follow(() => p);
  await r.settle();
  r.emit(true);
  p = null;
  r.tick(500); await r.settle();
  assert.deepEqual(r.calls.at(-1), ['exit']);
  r.emit(false);
  r.setEntered(false);
  p = pic(el);
  assert.equal((await r.pip.enter()).entered, false);
  r.emit(true);
  assert.equal(el.has(PIP_ATTR), true);
  // nothing shown: the button has nothing to take
  p = null;
  assert.equal((await rig().pip.enter()).entered, false);
});

test('the permission was asked for: the picture is kept for the window that opens when it is allowed', async () => {
  const r = rig();
  const a = r.element(), b = r.element();
  r.pip.follow(() => pic(a));
  await r.settle();
  r.answer({ entered: false, reason: 'permission', asked: true });
  const res = await r.pip.enter(() => pic(b));
  assert.equal(res.reason, 'permission');
  assert.equal(pipProblem(res), '', 'the app asked already: nothing more to say');
  // the person allowed it in the settings, and the phone opened the window by itself
  r.emit(true);
  assert.equal(b.has(PIP_ATTR), true, 'the picture of the button, not the newest screen');
  assert.equal(a.has(PIP_ATTR), false);
});

test('what is said when it did not open: the real reason, and a build that has no native part', async () => {
  const r = rig();
  const el = r.element();
  r.pip.follow(() => pic(el));
  await r.settle();
  r.answer({ entered: false, reason: 'failed', message: 'Current activity does not support picture-in-picture.' });
  const failed = await r.pip.enter();
  assert.match(pipProblem(failed), /did not open: Current activity does not support/);
  r.answer(new Error('"LibertadPip" plugin is not implemented on android'));
  const old = await r.pip.enter();
  assert.equal(old.reason, 'plugin');
  assert.match(pipProblem(old), /Build it again/);
  r.answer(null);
  assert.equal(pipProblem(await r.pip.enter()), '');
});
