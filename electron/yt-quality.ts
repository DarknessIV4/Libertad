// Sets the quality and the playback speed of the YouTube embed from outside its frame.
//
// The page cannot reach into the frame (another origin), and the embed ignores most quality requests
// sent to it by message. The main process can run code inside any frame, so the choice is made in the
// frame itself: first through the player's own API, and when that does not take, the way a person
// would, through the player's settings menu (Settings > Quality > the entry).
import { app, webContents, type WebContents } from 'electron';

const LEVELS = new Set(['auto', 'highres', 'hd2880', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny']);
const EMBED = /^https:\/\/www\.youtube(-nocookie)?\.com\/embed\//;

export interface QualityResult { method: 'api' | 'menu' | 'none'; quality?: string; error?: string }

// Runs inside the frame. No backslashes: it lives in a template string.
const script = (level: string) => `(async () => {
  const level = ${JSON.stringify(level)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const LABEL = { highres: '4320', hd2880: '2880', hd2160: '2160', hd1440: '1440', hd1080: '1080', hd720: '720', large: '480', medium: '360', small: '240', tiny: '144' };
  const find = () => document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  let p = null;
  // The player takes a moment to exist, and to know which qualities the video has
  for (let i = 0; i < 40; i++) {
    p = find();
    try { if (p && p.getAvailableQualityLevels && p.getAvailableQualityLevels().length) break; } catch (e) {}
    await sleep(150);
  }
  if (!p) return { method: 'none', error: 'the player was not found' };
  const current = () => { try { return p.getPlaybackQuality(); } catch (e) { return ''; } };
  const text = el => (el.textContent || '').trim();

  const viaApi = async () => {
    try {
      p.setPlaybackQualityRange(level, level);
      p.setPlaybackQuality(level);
    } catch (e) { return false; }
    await sleep(900);
    return current() === level;
  };

  // Settings > Quality > entry, as a person does it
  const viaMenu = async () => {
    const button = p.querySelector('.ytp-settings-button');
    if (!button) return false;
    button.click();
    await sleep(250);
    const rows = Array.from(p.querySelectorAll('.ytp-panel-menu .ytp-menuitem'));
    // The quality row is the one that shows a resolution (it is the last row otherwise)
    const row = rows.find(r => /[0-9]{3,4}p/.test(text(r))) || rows[rows.length - 1];
    if (!row) { button.click(); return false; }
    row.click();
    await sleep(300);
    const options = Array.from(p.querySelectorAll('.ytp-quality-menu .ytp-menuitem'));
    const option = level === 'auto'
      ? options.find(o => !/^[0-9]/.test(text(o)))
      : options.find(o => text(o).startsWith(LABEL[level] + 'p'));
    if (!option) { button.click(); return false; }
    option.click();
    await sleep(300);
    return true;
  };

  if (level === 'auto') {
    if (await viaMenu()) return { method: 'menu', quality: current() };
    try { p.setPlaybackQualityRange('auto', 'auto'); p.setPlaybackQuality('default'); } catch (e) {}
    return { method: 'api', quality: current() };
  }
  if (await viaApi()) return { method: 'api', quality: current() };
  if (await viaMenu()) return { method: 'menu', quality: current() };
  return { method: 'none', quality: current(), error: 'the player did not take the quality' };
})()`;

// Runs inside the frame, like the one above. The speed is set through the player's API and on the
// video element itself, kept there by a guard (the player puts its own value back now and then), and
// when neither takes, through the player's settings menu (Settings > Playback speed > the entry).
const rateScript = (rate: number) => `(async () => {
  const rate = ${JSON.stringify(rate)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const find = () => document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  const text = el => (el.textContent || '').trim();
  let p = null;
  for (let i = 0; i < 30; i++) {
    p = find();
    if (p && document.querySelector('video')) break;
    await sleep(150);
  }
  const video = () => document.querySelector('video');
  const set = () => {
    try { const pl = find(); if (pl && pl.setPlaybackRate) pl.setPlaybackRate(window.__libertadRate); } catch (e) {}
    try { const v = video(); if (v && v.playbackRate !== window.__libertadRate) v.playbackRate = window.__libertadRate; } catch (e) {}
  };
  const effective = () => { const v = video(); return v ? v.playbackRate : 0; };

  window.__libertadRate = rate;
  if (!window.__libertadRateGuard) {
    window.__libertadRateGuard = setInterval(() => { const v = video(); if (v && v.playbackRate !== window.__libertadRate) set(); }, 400);
  }
  set();
  await sleep(350);
  if (effective() === rate) return { method: 'api', rate: effective() };

  // Settings > Playback speed > the entry, as a person does it
  const button = p && p.querySelector('.ytp-settings-button');
  if (button) {
    button.click();
    await sleep(250);
    const rows = Array.from(p.querySelectorAll('.ytp-panel-menu .ytp-menuitem'));
    const row = rows.find(r => /^(normal|[0-9]+([.][0-9]+)?x?)$/i.test(text(r.querySelector('.ytp-menuitem-content') || r)));
    if (row) {
      row.click();
      await sleep(300);
      const label = rate === 1 ? '1' : String(rate);
      const options = Array.from(p.querySelectorAll('.ytp-panel-menu .ytp-menuitem'));
      const option = options.find(o => {
        const t = text(o).replace(/x$/i, '');
        return rate === 1 ? (/^normal$/i.test(t) || t === '1') : t === label;
      });
      if (option) { option.click(); await sleep(300); }
      else button.click();
    } else {
      button.click();
    }
    set();
    await sleep(300);
    if (effective() === rate) return { method: 'menu', rate: effective() };
  }
  return { method: 'none', rate: effective(), error: 'the player did not take the speed' };
})()`;

// One frame of the picture, as a small JPEG data address (null while there is none, or it cannot be read)
const frameScript = (full: boolean) => `(async () => {
  try {
    const v = document.querySelector('video');
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    const full = ${full};
    const w = full ? v.videoWidth : 320, h = full ? v.videoHeight : Math.max(1, Math.round(w * v.videoHeight / v.videoWidth));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    return full ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.7);
  } catch (e) { return null; }
})()`;

// The size of the picture the player is playing, for the shape of the frame it is shown in
const sizeScript = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 24; i++) {
    const v = document.querySelector('video');
    if (v && v.videoWidth > 0 && v.videoHeight > 0) return { width: v.videoWidth, height: v.videoHeight };
    await sleep(250);
  }
  return null;
})()`;

const allFrames = () => webContents.getAllWebContents()
  .filter(wc => !wc.isDestroyed())
  .flatMap(wc => wc.mainFrame.framesInSubtree);
// By address, or by origin (a frame in another process may not have told its address yet)
// (youtube.com is the embed's origin while signed in; any other youtube.com frame has an address of its own)
const isEmbed = (f: Electron.WebFrameMain) => EMBED.test(f.url) || f.origin === 'https://www.youtube-nocookie.com' || (!f.url && f.origin === 'https://www.youtube.com');
const embedFrames = () => allFrames().filter(isEmbed);
const describeFrames = () => allFrames().map(f => `${f.url || '(no address)'} [${f.origin}]`).join(', ') || 'none';

export interface RateResult { method: 'api' | 'menu' | 'none'; rate?: number; error?: string }

export async function getYoutubeFrame(full = false): Promise<string | null> {
  const frames = embedFrames();
  if (!frames.length) return null;
  try {
    const url = await frames[0].executeJavaScript(frameScript(full)) as string | null;
    return typeof url === 'string' && url.startsWith(full ? 'data:image/png' : 'data:image/jpeg') ? url : null;
  } catch {
    return null;
  }
}

export async function getYoutubeVideoSize(): Promise<{ width: number; height: number } | null> {
  const frames = embedFrames();
  if (!frames.length) return null;
  try {
    return await frames[0].executeJavaScript(sizeScript) as { width: number; height: number } | null;
  } catch {
    return null;
  }
}

export async function setYoutubeRate(rate: number): Promise<RateResult> {
  if (!Number.isFinite(rate) || rate < 0.25 || rate > 2) return { method: 'none', error: 'unsupported speed' };
  const frames = embedFrames();
  if (!frames.length) return { method: 'none', error: `no YouTube player found (frames: ${describeFrames()})` };
  try {
    return await frames[0].executeJavaScript(rateScript(rate)) as RateResult;
  } catch (e) {
    return { method: 'none', error: String(e) };
  }
}

export async function setYoutubeQuality(level: string): Promise<QualityResult> {
  if (!LEVELS.has(level)) return { method: 'none', error: 'unknown quality' };
  const frames = embedFrames();
  if (!frames.length) return { method: 'none', error: `no YouTube player found (frames: ${describeFrames()})` };
  try {
    return await frames[0].executeJavaScript(script(level)) as QualityResult;
  } catch (e) {
    return { method: 'none', error: String(e) };
  }
}


// The player's own pause / play indicator (the small icon in the middle of the picture that flashes when
// the video is paused or resumed) is hidden: the app draws its own. The page cannot style another origin's
// frame, but the main process can run code in it. The rule goes in as a constructed style sheet, which the
// embed's content security policy does not block (a <style> element can be), with a <style> element and
// a direct hide of the element as fallbacks. Idempotent, and no backslashes (template string).
// Whatever the player draws on top of the picture, except the picture itself, the captions and its
// error message: with the controls off (see YouTubePlayer) what is left is the pause / play flash, the
// buffering spinner and the like. Made invisible and untouchable rather than removed, so the player's own
// code (and the quality menu code above) keeps finding its elements. The class names change now and
// then, hence the broad rule next to the known names.
const SELECTOR = '[class*="bezel"], .ytp-large-play-button, .ytp-pause-overlay, .html5-video-player > :not(.html5-video-container):not([class*="caption"]):not([class*="error"]):not(video)';
const HIDE_CSS = SELECTOR + ' { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; animation: none !important; }';
const hideScript = `(() => {
  const css = ${JSON.stringify(HIDE_CSS)};
  const add = () => {
    if (window.__libertadHideIndicator) return true;
    if (!document.documentElement) return false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch (e) {
      try { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); } catch (e2) {}
    }
    // Belt and braces: whatever the player draws with that class is hidden as it appears
    const hide = () => document.querySelectorAll(${JSON.stringify(SELECTOR)}).forEach(el => {
      el.style.setProperty('opacity', '0', 'important');
    });
    new MutationObserver(hide).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    hide();
    window.__libertadHideIndicator = true;
    return true;
  };
  if (add()) return;
  const t = setInterval(() => { if (add()) clearInterval(t); }, 25);
  setTimeout(() => clearInterval(t), 5000);
})()`;

const hideLogged = new Set<string>();
function hideIndicator(wc: WebContents) {
  if (wc.isDestroyed()) return;
  let frames: Electron.WebFrameMain[] = [];
  // By address, or by origin: a frame in another process may not have told its address yet (see isEmbed)
  try { frames = wc.mainFrame.framesInSubtree.filter(isEmbed); } catch { return; }
  for (const f of frames) {
    f.executeJavaScript(hideScript)
      .then(() => { const k = f.url || f.origin; if (!hideLogged.has(k)) { hideLogged.add(k); console.log('[yt-hide] injected into', k); } })
      .catch(e => { if (process.env.LIBERTAD_DEBUG) console.log('[yt-hide] failed in', f.url || f.origin, String(e)); });
  }
}

// Call once at start up (before the first window opens)
export function hideYoutubeIndicator() {
  app.on('web-contents-created', (_e, wc) => {
    // The frame may not be ready at the event: try again a few times (the script does nothing twice)
    const run = () => { for (const ms of [0, 300, 1200, 3000]) setTimeout(() => hideIndicator(wc), ms); };
    // F12 or Ctrl+Shift+I (Cmd+Alt+I) opens the developer tools of any window, including the pop-outs
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const mod = process.platform === 'darwin' ? input.meta && input.alt : input.control && input.shift;
      if (input.key === 'F12' || (mod && input.key.toLowerCase() === 'i')) { e.preventDefault(); wc.toggleDevTools(); }
    });
    for (const ev of ['did-frame-finish-load', 'did-frame-navigate', 'did-finish-load', 'dom-ready'] as const) wc.on(ev as any, run);
  });
}
