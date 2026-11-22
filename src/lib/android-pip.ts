// Picture-in-picture on Android: a picture that is running (a screen, a camera, a watch together video) stays on top of
// everything in a small window when the app is left, or when the pop-out button is pressed.
//
// A WebView cannot give a <video> a window of its own (no requestPictureInPicture, no window.open), so it is the whole
// activity that becomes the small window (mobile/android/templates/LibertadPipPlugin.java). This file is the page's half:
//
//   - the screens that show a picture say which one (follow), and the plugin is armed while there is one, so leaving the app
//     takes it along;
//   - when the window becomes the small one, the app is hidden except that picture, which fills the window; when it is
//     the big one again, everything is back as it was. Nothing is moved in the page: the picture is only restyled
//     (a moved <video> or iframe can stop or reload).
//
// Only does anything on Android (the desktop app has its own pop-out windows).

import { isAndroid } from './platform.ts';
import { loadPlugin } from './capacitor-plugin.ts';

export interface PipPicture {
  el: HTMLElement;
  // The picture's own size, for the shape of the small window
  width: number;
  height: number;
  // Playing now (the default): only a running picture goes along when the app is left; the button works for any
  running?: boolean;
}
export type PipProvider = () => PipPicture | null;

// What the button got: opened, or why not. "permission": the person was asked (a dialog of the app, then the settings page) and
// the small window opens by itself when it is allowed; "failed": message says why; "plugin": this build has no native part
export interface PipResult { supported: boolean; entered: boolean; reason?: 'permission' | 'failed' | 'plugin'; message?: string; asked?: boolean }

export interface PipPlugin {
  arm(o: { enabled: boolean; width: number; height: number }): Promise<void>;
  enter(o: { width: number; height: number }): Promise<PipResult>;
  exit(): Promise<void>;
  state(): Promise<{ supported: boolean; allowed: boolean; active: boolean }>;
  addListener(event: 'pipChanged', cb: (e: { active: boolean }) => void): Promise<{ remove: () => Promise<void> }>;
}

export const PIP_CLASS = 'libertad-pip';
export const PIP_ATTR = 'data-pip-target';

// While the small window is up: everything is invisible, and the picture is fixed over the whole window. Whatever of the
// picture's ancestors could make "fixed" mean something else (a transform, a filter, containment) or fade it (opacity) is
// switched off for the time. `visibility` is used, not `display`: a visible child shows inside hidden parents.
export const PIP_CSS = `
html.${PIP_CLASS}, html.${PIP_CLASS} body { background: #000 !important; overflow: hidden !important; }
html.${PIP_CLASS} body * {
  visibility: hidden !important; opacity: 1 !important; transition: none !important; animation: none !important;
  transform: none !important; translate: none !important; scale: none !important; rotate: none !important;
  filter: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
  contain: none !important; container-type: normal !important; perspective: none !important; will-change: auto !important;
  clip-path: none !important; mask: none !important; -webkit-mask: none !important;
}
html.${PIP_CLASS} [${PIP_ATTR}] {
  visibility: visible !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;
  width: 100vw !important; height: 100vh !important; min-width: 0 !important; min-height: 0 !important;
  max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important;
  border: 0 !important; border-radius: 0 !important; background: #000 !important; object-fit: contain !important;
  pointer-events: none !important;
}
`;

const SIDE = 100; // the shape is told to the phone with its short side at 100: whole numbers, and a size that wobbles by a pixel is the same call
const round = (n: number) => Math.max(1, Math.round(n));

export function shapeOf(p: { width: number; height: number } | null): { width: number; height: number } {
  const w = p?.width && p.width > 0 ? p.width : 16, h = p?.height && p.height > 0 ? p.height : 9;
  const k = SIDE / Math.min(w, h);
  return { width: round(w * k), height: round(h * k) };
}

interface Deps {
  plugin: () => Promise<PipPlugin>;
  root: () => HTMLElement | null;
  addStyle: (css: string) => (() => void);
  setInterval: (f: () => void, ms: number) => unknown;
  clearInterval: (t: unknown) => void;
}

export function createAndroidPip(deps: Deps) {
  const providers: PipProvider[] = [];
  let preferred: PipProvider | null = null;
  // The picture the button was pressed on is kept while the person is sent to the settings page to allow the small window
  // (it opens by itself when they come back), and not for ever
  let preferredUntil = 0;
  const KEEP_MS = 5 * 60 * 1000;
  let sentKey = '';
  let armTimer: unknown = null;
  let activeTimer: unknown = null;
  let active = false;
  let marked: HTMLElement | null = null;
  let removeStyle: (() => void) | null = null;
  let listening = false;
  const watchers = new Set<(active: boolean) => void>();

  // The picture to show: the one the pop-out button was pressed on, else the newest screen's
  function pick(): PipPicture | null {
    if (preferred && Date.now() > preferredUntil && !active) preferred = null;
    const asked = preferred?.();
    if (asked) return asked;
    for (let i = providers.length - 1; i >= 0; i--) {
      const p = providers[i]();
      if (p) return p;
    }
    return null;
  }

  async function sync() {
    const pic = pick();
    const shape = shapeOf(pic);
    const enabled = !!pic && pic.running !== false;
    const key = `${enabled}:${shape.width}x${shape.height}`;
    if (key === sentKey) return;
    sentKey = key;
    try { await (await deps.plugin()).arm({ enabled, ...shape }); } catch (e) { sentKey = ''; console.warn('[pip] arm:', e); }
  }

  function mark(el: HTMLElement | null) {
    if (marked === el) return;
    marked?.removeAttribute(PIP_ATTR);
    marked = el;
    el?.setAttribute(PIP_ATTR, '');
  }

  function changed(on: boolean) {
    if (on === active) return;
    active = on;
    const root = deps.root();
    if (on) {
      removeStyle ??= deps.addStyle(PIP_CSS);
      mark(pick()?.el ?? null);
      root?.classList.add(PIP_CLASS);
      // The picture can end, or be replaced, while the small window is up
      activeTimer ??= deps.setInterval(() => {
        const pic = pick();
        if (!pic) { void deps.plugin().then(p => p.exit()).catch(() => {}); return; }
        mark(pic.el);
      }, 500);
    } else {
      root?.classList.remove(PIP_CLASS);
      mark(null);
      removeStyle?.(); removeStyle = null;
      if (activeTimer !== null) { deps.clearInterval(activeTimer); activeTimer = null; }
      preferred = null;
    }
    for (const w of [...watchers]) w(on);
  }

  async function listen() {
    if (listening) return;
    listening = true;
    try { await (await deps.plugin()).addListener('pipChanged', e => changed(!!e.active)); } catch (e) { listening = false; console.warn('[pip] listener:', e); }
  }

  return {
    // A screen that shows pictures says which one is on top, now and later (null for none). Returns how to stop.
    follow(provider: PipProvider): () => void {
      providers.push(provider);
      void listen();
      void sync();
      armTimer ??= deps.setInterval(() => { void sync(); }, 1000);
      return () => {
        const i = providers.indexOf(provider);
        if (i >= 0) providers.splice(i, 1);
        if (!providers.length && armTimer !== null) { deps.clearInterval(armTimer); armTimer = null; }
        void sync();
      };
    },
    // The pop-out button: the picture of `of` (else the newest screen's) into the small window now. False when it could not.
    async enter(of?: PipProvider): Promise<PipResult> {
      await listen();
      preferred = of ?? null;
      preferredUntil = Date.now() + KEEP_MS;
      const pic = pick();
      if (!pic) { preferred = null; return { entered: false, supported: true, reason: 'failed', message: 'There is no picture to put in the small window yet.' }; }
      try {
        const r = await (await deps.plugin()).enter(shapeOf(pic));
        if (!r.entered && r.reason !== 'permission') preferred = null;
        return r;
      } catch (e) {
        preferred = null;
        console.warn('[pip] enter:', e);
        // The plugin is not in the app: the native part of this build is older than the page (it has to be built again)
        return { entered: false, supported: false, reason: 'plugin', message: e instanceof Error ? e.message : String(e) };
      }
    },
    // Heard when the small window comes (true) and goes (false)
    watch(cb: (active: boolean) => void): () => void { watchers.add(cb); return () => { watchers.delete(cb); }; },
    get active() { return active; },
    // for tests
    _changed: changed
  };
}

// ---- the real one ----
let real: ReturnType<typeof createAndroidPip> | null = null;
// The native plugin as it is (Settings, System has a test for it); its calls reject when this build has no native part
export function rawPipPlugin(): Promise<PipPlugin> {
  return loadPlugin<PipPlugin>('LibertadPip');
}
const android = () => (real ??= createAndroidPip({
  plugin: rawPipPlugin,
  root: () => document.documentElement,
  addStyle: css => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    return () => style.remove();
  },
  setInterval: (f, ms) => window.setInterval(f, ms),
  clearInterval: t => window.clearInterval(t as number)
}));

export const pipAvailable = (): boolean => isAndroid();

// No-ops off Android
export function followPip(provider: PipProvider): () => void {
  return isAndroid() ? android().follow(provider) : () => {};
}
export async function enterPip(of?: PipProvider): Promise<PipResult> {
  return isAndroid() ? android().enter(of) : { entered: false, supported: false, reason: 'failed', message: 'Only in the Android app.' };
}

// What to tell the person when the button did not open the small window (nothing for "permission": the app asked already)
export function pipProblem(r: PipResult): string {
  if (r.entered || r.reason === 'permission') return '';
  if (r.reason === 'plugin') return 'Picture-in-picture is not in this build of the app yet. Build it again (npm run build:android, then npx cap run android).';
  return `The small window did not open: ${r.message || 'Android said no'}`;
}
export function watchPip(cb: (active: boolean) => void): () => void {
  return isAndroid() ? android().watch(cb) : () => {};
}

// The picture of a <video>: its own size once it knows it
export const videoPicture = (el: HTMLVideoElement | null | undefined): PipPicture | null =>
  el && el.isConnected ? { el, width: el.videoWidth || 16, height: el.videoHeight || 9, running: !el.paused && !el.ended } : null;
