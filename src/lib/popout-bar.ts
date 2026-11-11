// The overlay of the YouTube pop-out window: play/pause, time, seek bar, volume, and the quality,
// captions and speed buttons. The window is a plain page of its own (YouTube's controls are off, see
// YouTubePlayer), so the overlay is built here, in the opener, as DOM of the popup. Its handlers are
// functions of this window, so the popup needs no script of its own. It looks and behaves like the one
// YouTubePlayer draws in the main window, and talks to the same player.
import { watchTogether } from './watch-together.svelte.ts';
import { ICON_PATHS } from './icons.ts';
import { RATES, rateLabel, qualityLabel, IDLE_MS, DEFAULT_QUALITIES } from './yt-controls.ts';
import { CAP_FPS, CAP_HEIGHTS, capFpsLabel, capHeightLabel, isCapped, type ViewerCap } from './stream-quality.ts';

export const POPOUT_BAR_CSS = `
  #yt-stage .yt-shield { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:transparent; border:none; padding:0; cursor:pointer; color:#fff; }
  #yt-stage:not(.active) .yt-shield { cursor:none; }
  #yt-stage .yt-big { display:flex; align-items:center; justify-content:center; width:64px; height:64px; border-radius:50%; background:rgba(0,0,0,.55); opacity:0; transition:opacity .15s; pointer-events:none; }
  #yt-stage.active .yt-big { opacity:1; }
  #yt-stage .yt-bar { position:absolute; left:0; right:0; bottom:0; padding:22px 14px 7px; display:flex; flex-direction:column; gap:2px; color:#fff; font:12px system-ui, sans-serif; background:linear-gradient(transparent, rgba(0,0,0,.65)); opacity:0; pointer-events:none; transition:opacity .15s; z-index:2; }
  #yt-stage.active .yt-bar, #yt-stage.active .yt-top { opacity:1; pointer-events:auto; }
  /* fixed: the corner of the window, even when the picture is narrower than it (black bars at the sides) */
  #yt-stage .yt-top { position:fixed; top:0; left:0; right:0; padding:8px 12px 26px; display:flex; justify-content:flex-end; gap:4px; color:#fff; background:linear-gradient(rgba(0,0,0,.65), transparent); opacity:0; pointer-events:none; transition:opacity .15s; z-index:3; font:12px system-ui, sans-serif; }
  #yt-stage .yt-wrap { position:relative; }
  #yt-stage .yt-ibtn, #yt-stage .yt-mute { display:flex; align-items:center; justify-content:center; background:transparent; border:none; padding:5px; border-radius:6px; color:#fff; cursor:pointer; flex:none; }
  #yt-stage .yt-mute { padding:3px; }
  #yt-stage .yt-ibtn:hover, #yt-stage .yt-mute:hover { background:rgba(255,255,255,.2); }
  #yt-stage .yt-ibtn.on { color:#f03; }
  #yt-stage .yt-menu { position:absolute; top:100%; right:0; margin-top:4px; min-width:110px; padding:4px; display:flex; flex-direction:column; border-radius:8px; background:rgba(20,20,20,.95); box-shadow:0 4px 16px rgba(0,0,0,.5); }
  #yt-stage .yt-item { text-align:left; padding:6px 10px; border:none; border-radius:5px; background:transparent; color:#fff; font:13px system-ui, sans-serif; cursor:pointer; white-space:nowrap; }
  #yt-stage .yt-item:hover { background:rgba(255,255,255,.15); }
  #yt-stage .yt-item.on { color:#f03; font-weight:600; }
  /* The buttons of a picture's window: only while the mouse is over them (the padding is part of the hit area) */
  #yt-stage .yt-hud { position:fixed; top:0; right:0; z-index:2; display:flex; gap:4px; padding:8px; opacity:0; transition:opacity .15s; }
  #yt-stage .yt-hud:hover, #yt-stage .yt-hud.open, #yt-stage .yt-hud:has(:focus-visible) { opacity:1; }
  #yt-stage .yt-hud .yt-ibtn { background:rgba(0,0,0,.55); }
  #yt-stage .yt-hud .yt-ibtn:hover { background:rgba(255,255,255,.25); }
  /* A live picture has only its volume on the bar: a small corner that shows only while the mouse is over it */
  #yt-stage .yt-bar.corner { left:auto; right:0; padding:10px 14px 8px; pointer-events:auto; }
  #yt-stage.active .yt-bar.corner { opacity:0; }
  #yt-stage .yt-bar.corner:hover, #yt-stage.active .yt-bar.corner:hover, #yt-stage .yt-bar.corner:has(:focus-visible), #yt-stage.active .yt-bar.corner:has(:focus-visible) { opacity:1; }
  #yt-stage .yt-field { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:3px 6px; color:#fff; font:13px system-ui, sans-serif; }
  #yt-stage .yt-field select { background:#222; color:#fff; border:1px solid #444; border-radius:5px; padding:3px 6px; font:inherit; }
  #yt-stage .yt-hint { padding:2px 6px; max-width:190px; color:rgba(255,255,255,.6); font:11px system-ui, sans-serif; }
  #yt-stage .yt-time { font-variant-numeric:tabular-nums; text-shadow:0 0 3px #000; }
  #yt-stage .yt-sep { margin:0 7px; opacity:.7; }
  #yt-stage .yt-total { opacity:.7; }
  #yt-stage .yt-row { display:flex; align-items:center; gap:10px; }
  #yt-stage .yt-vol { width:90px; flex:none; }
  #yt-stage .yt-seek { flex:1; min-width:0; }
  #yt-stage .yt-seek, #yt-stage .yt-vol { -webkit-appearance:none; appearance:none; height:14px; margin:0; background:transparent; cursor:pointer; }
  #yt-stage .yt-seek:disabled { cursor:default; }
  #yt-stage .yt-seek::-webkit-slider-runnable-track, #yt-stage .yt-vol::-webkit-slider-runnable-track { height:3px; border-radius:2px; background:linear-gradient(to right, #f03 var(--pct), rgba(255,255,255,.35) var(--pct)); }
  #yt-stage .yt-seek::-webkit-slider-thumb, #yt-stage .yt-vol::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:12px; margin-top:-4.5px; border-radius:50%; border:none; background:#f03; }
`;

const clock = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

export type PopoutFullscreen = { set: (on: boolean) => Promise<boolean>; get: () => Promise<boolean> };

// Full screen of a pop-out window itself, and back to the pop-out when it ends (the window is never
// closed). `native`: the desktop app's own window call; null uses the browser's full screen API.
function fullscreenControl(w: Window, native: PopoutFullscreen | null | undefined) {
  const d = w.document;
  let isFs = false;
  let btn: HTMLElement | null = null;
  const show = (on: boolean) => {
    isFs = on;
    const title = on ? 'Exit full screen' : 'Full screen';
    btn?.setAttribute('title', title);
    btn?.setAttribute('aria-label', title);
    btn?.classList.toggle('on', on);
  };
  const set = async (on: boolean) => {
    try {
      if (native) show(await native.set(on));
      else if (on) await d.documentElement.requestFullscreen();
      else if (d.fullscreenElement) await d.exitFullscreen();
    } catch (err) { console.warn('[popout] full screen failed', err); }
  };
  const toggle = () => set(!isFs);
  // The native window can also leave full screen by itself (the system, a shortcut): follow it
  const sync = () => { if (native) native.get().then(show, () => {}); else show(!!d.fullscreenElement); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && isFs) set(false); };
  d.addEventListener('fullscreenchange', sync);
  d.addEventListener('keydown', onKey);
  w.addEventListener('resize', sync);
  return {
    toggle,
    bind(b: HTMLElement) { btn = b; },
    stop() {
      d.removeEventListener('fullscreenchange', sync);
      d.removeEventListener('keydown', onKey);
      w.removeEventListener('resize', sync);
      // Closing the pop-out (popping back in) must not leave a full screen window behind
      if (isFs && !w.closed) native?.set(false).catch(() => {});
    }
  };
}

// Adds the overlay to `stage` (in the popup `w`); returns the function that takes it away again
export function mountPopoutBar(w: Window, stage: HTMLElement, fullscreen?: PopoutFullscreen | null, onpopin?: () => void): () => void {
  const d = w.document;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement) => {
    const e = d.createElement(tag);
    e.className = cls;
    parent.appendChild(e);
    return e;
  };
  // An icon whose shape can be swapped
  const icon = (parent: HTMLElement, size: number) => {
    const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ width: String(size), height: String(size), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'square', 'stroke-linejoin': 'miter' })) svg.setAttribute(k, v);
    const path = d.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(path);
    parent.appendChild(svg);
    return (name: string) => path.setAttribute('d', ICON_PATHS[name] ?? '');
  };
  const player = () => watchTogether.youtubePlayer;

  // ---- picture: a click plays or pauses (or closes a menu)
  const shield = make('button', 'yt-shield', stage);
  shield.setAttribute('aria-label', 'Play or pause');
  const big = make('span', 'yt-big', shield);
  const bigIcon = icon(big, 36);

  // ---- top right: quality, captions, speed
  const top = make('div', 'yt-top', stage);
  const qWrap = make('div', 'yt-wrap', top);
  const qBtn = make('button', 'yt-ibtn', qWrap);
  qBtn.title = 'Quality';
  qBtn.setAttribute('aria-label', 'Quality');
  icon(qBtn, 20)('settings');
  const cBtn = make('button', 'yt-ibtn', top);
  cBtn.title = 'Captions';
  cBtn.setAttribute('aria-label', 'Captions');
  icon(cBtn, 20)('captions');
  const sWrap = make('div', 'yt-wrap', top);
  const sBtn = make('button', 'yt-ibtn', sWrap);
  sBtn.title = 'Playback speed';
  sBtn.setAttribute('aria-label', 'Playback speed');
  icon(sBtn, 20)('speed');
  // Back into the main window: left of full screen
  if (onpopin) {
    const back = make('button', 'yt-ibtn on', top);
    back.title = 'Bring back into the window';
    back.setAttribute('aria-label', 'Bring back into the window');
    icon(back, 20)('popout');
    back.addEventListener('click', onpopin);
  }
  const fs = fullscreenControl(w, fullscreen);
  const fsBtn = make('button', 'yt-ibtn', top);
  fsBtn.title = 'Full screen';
  fsBtn.setAttribute('aria-label', 'Full screen');
  icon(fsBtn, 20)('expand');
  fs.bind(fsBtn);
  fsBtn.addEventListener('click', fs.toggle);

  let menu: 'quality' | 'speed' | null = null;
  let menuEl: HTMLElement | null = null;
  const closeMenu = () => {
    menuEl?.remove();
    menuEl = null;
    menu = null;
    qBtn.classList.remove('on');
    sBtn.classList.toggle('on', (player()?.getRate?.() ?? 1) !== 1);
  };
  const openMenu = (kind: 'quality' | 'speed') => {
    if (menu === kind) { closeMenu(); return; }
    closeMenu();
    menu = kind;
    const wrap = kind === 'quality' ? qWrap : sWrap;
    (kind === 'quality' ? qBtn : sBtn).classList.add('on');
    menuEl = make('div', 'yt-menu', wrap);
    const items: [string, string, boolean, () => void][] = kind === 'quality'
      ? ['auto', ...(player()?.getQualities?.() ?? DEFAULT_QUALITIES)].map(q => [q, qualityLabel(q), (player()?.getQuality?.() ?? 'auto') === q, () => player()?.setQuality?.(q)])
      : RATES.map(r => [String(r), rateLabel(r), (player()?.getRate?.() ?? 1) === r, () => watchTogether.setRate(r)]);
    for (const [, label, on, pick] of items) {
      const item = make('button', on ? 'yt-item on' : 'yt-item', menuEl);
      item.textContent = label;
      item.addEventListener('click', () => { pick(); closeMenu(); });
    }
  };
  qBtn.addEventListener('click', () => openMenu('quality'));
  sBtn.addEventListener('click', () => openMenu('speed'));
  cBtn.addEventListener('click', () => player()?.setCaptions?.(!(player()?.getCaptions?.() ?? false)));

  // ---- bottom: time, seek bar, volume
  const bar = make('div', 'yt-bar', stage);
  const time = make('span', 'yt-time', bar);
  const now = make('span', 'yt-now', time);
  const sep = make('span', 'yt-sep', time);
  sep.textContent = '/';
  const total = make('span', 'yt-total', time);
  const row = make('div', 'yt-row', bar);
  const seek = make('input', 'yt-seek', row);
  seek.type = 'range';
  seek.min = '0';
  seek.step = '1000';
  seek.setAttribute('aria-label', 'Seek');
  const mute = make('button', 'yt-mute', row);
  mute.setAttribute('aria-label', 'Mute');
  const muteIcon = icon(mute, 18);
  const vol = make('input', 'yt-vol', row);
  vol.type = 'range';
  vol.min = '0';
  vol.max = '1';
  vol.step = '0.05';
  vol.setAttribute('aria-label', 'Volume');

  // The frame has the geometry it has at full screen, scaled to the window (see YouTubePlayer)
  const frame = stage.querySelector('iframe');
  const fit = () => {
    // The stage has the picture's shape (16:9 until it is known)
    const a = watchTogether.youtubePlayer?.getAspect?.() ?? 16 / 9;
    stage.style.aspectRatio = String(a);
    stage.style.width = `min(100vw, ${a * 100}vh)`;
    const sw = stage.clientWidth;
    if (!frame || !sw) return;
    const fw = Math.max(1600, Math.ceil(sw));
    const width = `${fw}px`, height = `${fw / a + fw / 8}px`, transform = `translate(-50%, -50%) scale(${sw / fw})`;
    // Checked against the frame itself, not remembered: the main window's player writes this style too
    // (when its own stage changes size) and must not leave the pop-out with its size
    if (frame.style.width === width && frame.style.height === height && frame.style.transform === transform) return;
    frame.style.width = width;
    frame.style.height = height;
    frame.style.transform = transform;
  };

  let dragging = false;
  let draggingVol = false;
  let lastVol = 1;
  let shownPlaying: boolean | null = null;
  const paint = (ms: number, dur: number) => {
    now.textContent = clock(ms);
    sep.style.display = total.style.display = dur ? '' : 'none';
    total.textContent = clock(dur);
    seek.style.setProperty('--pct', `${dur ? Math.min(100, (ms / dur) * 100) : 0}%`);
  };

  shield.addEventListener('dblclick', fs.toggle);
  shield.addEventListener('click', () => {
    if (menu) { closeMenu(); return; }
    if (watchTogether.sharedPlaying()) watchTogether.pause(); else watchTogether.play();
  });
  seek.addEventListener('input', () => { dragging = true; paint(Number(seek.value), Number(seek.max)); });
  seek.addEventListener('change', () => { watchTogether.seek(Number(seek.value)); dragging = false; seek.blur(); });
  mute.addEventListener('click', () => {
    const v = player()?.getVolume?.() ?? 1;
    player()?.setVolume?.(v === 0 ? (lastVol || 1) : 0);
  });
  vol.addEventListener('input', () => { draggingVol = true; player()?.setVolume?.(Number(vol.value)); });
  vol.addEventListener('change', () => { draggingVol = false; vol.blur(); });

  // ---- the overlay is there while the mouse moves, and goes IDLE_MS after it stopped
  let idle: ReturnType<typeof setTimeout> | null = null;
  const sleep = () => {
    if (menu || dragging || draggingVol) { idle = setTimeout(sleep, IDLE_MS); return; }
    stage.classList.remove('active');
    idle = null;
  };
  const wake = () => {
    stage.classList.add('active');
    if (idle) clearTimeout(idle);
    idle = setTimeout(sleep, IDLE_MS);
  };
  const leave = () => {
    if (idle) { clearTimeout(idle); idle = null; }
    stage.classList.remove('active');
    closeMenu();
  };
  // The whole window wakes it: the buttons are in its corner, which may be outside a narrower picture
  d.addEventListener('pointermove', wake);
  d.addEventListener('pointerdown', wake);
  d.documentElement.addEventListener('pointerleave', leave);

  const tick = () => {
    if (w.closed) { stop(); return; }
    fit();
    const p = player();
    const playing = watchTogether.sharedPlaying();
    if (playing !== shownPlaying) {
      shownPlaying = playing;
      bigIcon(playing ? 'pause' : 'play');
    }
    const v = p?.getVolume?.() ?? 1;
    if (v > 0) lastVol = v;
    muteIcon(v === 0 ? 'volume-off' : 'volume');
    vol.style.setProperty('--pct', `${v * 100}%`);
    if (!draggingVol) vol.value = String(v);
    cBtn.classList.toggle('on', p?.getCaptions?.() ?? false);
    if (!menu) sBtn.classList.toggle('on', (p?.getRate?.() ?? 1) !== 1);
    if (dragging) return;
    const dur = p?.getDurationMs?.() ?? 0;
    const ms = Math.min(watchTogether.sharedPosition(), dur || Infinity);
    seek.disabled = !dur;
    seek.max = String(dur || 1);
    seek.value = String(ms);
    paint(ms, dur);
  };
  const timer = setInterval(tick, 200);
  tick();

  function stop() {
    clearInterval(timer);
    if (idle) clearTimeout(idle);
    d.removeEventListener('pointermove', wake);
    d.removeEventListener('pointerdown', wake);
    d.documentElement.removeEventListener('pointerleave', leave);
    fs.stop();
    shield.remove();
    bar.remove();
    top.remove();
    stage.classList.remove('active');
  }
  return stop;
}

// The same overlay for the pop-out of a plain <video>: a screen share, or the stream of a watch
// together session whose host plays a file. A click plays or pauses (watch together only, a screen
// share is live), double click is full screen, and the bottom bar has time and seek (watch together)
// and the volume (`volume` is null when there is no sound to control, as for our own screen).
export interface VideoPopout {
  video: HTMLVideoElement;
  watch: boolean;
  volume: { get: () => number; set: (v: number) => void } | null;
  // Top right, like the YouTube window's: the viewer's own limit on what he receives (cap), and the
  // playback speed everybody plays at (speed)
  // onpopin: bring the picture back into the main window (which closes this one)
  // Full screen of this window: native (the desktop app) or null for the browser's own full screen API
  fullscreen?: PopoutFullscreen | null;
  hud?: { cap: { get: () => ViewerCap; set: (c: ViewerCap) => void } | null; speed: boolean; onpopin: () => void };
}
export function mountVideoPopoutBar(w: Window, stage: HTMLElement, o: VideoPopout): () => void {
  const d = w.document;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement) => {
    const e = d.createElement(tag);
    e.className = cls;
    parent.appendChild(e);
    return e;
  };
  const icon = (parent: HTMLElement, size: number) => {
    const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ width: String(size), height: String(size), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'square', 'stroke-linejoin': 'miter' })) svg.setAttribute(k, v);
    const path = d.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(path);
    parent.appendChild(svg);
    return (name: string) => path.setAttribute('d', ICON_PATHS[name] ?? '');
  };

  const shield = make('button', 'yt-shield', stage);
  shield.setAttribute('aria-label', o.watch ? 'Play or pause' : 'Picture');
  const big = make('span', 'yt-big', shield);
  const bigIcon = icon(big, 36);
  if (!o.watch) big.style.display = 'none';

  const bar = make('div', o.watch ? 'yt-bar' : 'yt-bar corner', stage);
  const time = make('span', 'yt-time', bar);
  const now = make('span', 'yt-now', time);
  const sep = make('span', 'yt-sep', time);
  sep.textContent = '/';
  const total = make('span', 'yt-total', time);
  const row = make('div', 'yt-row', bar);
  const seek = make('input', 'yt-seek', row);
  seek.type = 'range';
  seek.min = '0';
  seek.step = '1000';
  seek.setAttribute('aria-label', 'Seek');
  const mute = make('button', 'yt-mute', row);
  mute.setAttribute('aria-label', 'Mute');
  const muteIcon = icon(mute, 18);
  const vol = make('input', 'yt-vol', row);
  vol.type = 'range';
  vol.min = '0';
  vol.max = '1';
  vol.step = '0.05';
  vol.setAttribute('aria-label', 'Volume');
  if (!o.watch) { time.style.display = 'none'; seek.style.display = 'none'; seek.disabled = true; }
  if (!o.volume) { mute.style.display = 'none'; vol.style.display = 'none'; }

  // ---- full screen of this window, and back to the pop-out when it ends
  const fs = fullscreenControl(w, o.fullscreen);

  // ---- top right: quality (the viewer's own cap) and speed
  let menuOpen = false;
  let menuEl: HTMLElement | null = null;
  let top: HTMLElement | null = null;
  let qBtn: HTMLElement | null = null;
  let sBtn: HTMLElement | null = null;
  const refreshHud = () => {
    top?.classList.toggle('open', !!menuEl);
    qBtn?.classList.toggle('on', menuEl?.dataset.kind === 'quality' || isCapped(o.hud?.cap?.get()));
    sBtn?.classList.toggle('on', menuEl?.dataset.kind === 'speed' || watchTogether.sharedRate() !== 1);
  };
  const closeMenu = () => {
    menuEl?.remove(); menuEl = null; menuOpen = false; refreshHud();
    // The mouse may have gone while the menu was open
    if (!stage.matches(':hover')) stage.classList.remove('active');
  };
  if (o.hud) {
    top = make('div', 'yt-hud', stage);
    const hud = o.hud;
    const button = (title: string, name: string) => {
      const wrap = make('div', 'yt-wrap', top!);
      const btn = make('button', 'yt-ibtn', wrap);
      btn.title = title;
      btn.setAttribute('aria-label', title);
      icon(btn, 20)(name);
      return { wrap, btn };
    };
    const open = (kind: 'quality' | 'speed', wrap: HTMLElement) => {
      if (menuEl?.dataset.kind === kind) { closeMenu(); return; }
      closeMenu();
      menuOpen = true;
      const menu = make('div', 'yt-menu', wrap);
      menuEl = menu;
      menu.dataset.kind = kind;
      if (kind === 'speed') {
        for (const r of RATES) {
          const item = make('button', watchTogether.sharedRate() === r ? 'yt-item on' : 'yt-item', menu);
          item.textContent = rateLabel(r);
          item.addEventListener('click', () => { watchTogether.setRate(r); closeMenu(); });
        }
      } else if (hud.cap) {
        const cap = hud.cap;
        const field = (label: string, values: number[], name: (v: number) => string, now: number, pick: (v: number) => void) => {
          const row = make('label', 'yt-field', menu);
          row.append(label);
          const select = make('select', '', row);
          for (const v of values) {
            const opt = d.createElement('option');
            opt.value = String(v);
            opt.textContent = name(v);
            opt.selected = v === now;
            select.appendChild(opt);
          }
          select.addEventListener('change', () => { pick(Number(select.value)); refreshHud(); });
        };
        field('Frame rate', CAP_FPS, capFpsLabel, cap.get().fps, v => cap.set({ ...cap.get(), fps: v }));
        field('Quality', CAP_HEIGHTS, capHeightLabel, cap.get().height, v => cap.set({ ...cap.get(), height: v }));
        make('div', 'yt-hint', menu).textContent = 'Only for you. The sender sends you less, and uploads less.';
      }
      refreshHud();
    };
    if (hud.cap) { const q = button('Stream quality (for you only)', 'settings'); qBtn = q.btn; q.btn.addEventListener('click', () => open('quality', q.wrap)); }
    if (hud.speed) { const sp = button('Playback speed (for everyone)', 'speed'); sBtn = sp.btn; sp.btn.addEventListener('click', () => open('speed', sp.wrap)); }
    // Back into the main window, then full screen of this window (the pop-out button is left of full screen)
    const back = button('Bring back into the window', 'popout');
    back.btn.classList.add('on');
    back.btn.addEventListener('click', () => hud.onpopin());
    const fsb = button('Full screen', 'expand');
    fs.bind(fsb.btn);
    fsb.btn.addEventListener('click', fs.toggle);
    d.addEventListener('pointerdown', e => { if (menuEl && !top!.contains(e.target as Node)) closeMenu(); });
    refreshHud();
  }

  let dragging = false;
  let draggingVol = false;
  let lastVol = 1;
  let shownPlaying: boolean | null = null;
  const paint = (ms: number, dur: number) => {
    now.textContent = clock(ms);
    sep.style.display = total.style.display = dur ? '' : 'none';
    total.textContent = clock(dur);
    seek.style.setProperty('--pct', `${dur ? Math.min(100, (ms / dur) * 100) : 0}%`);
  };

  shield.addEventListener('click', () => {
    if (!o.watch) return;
    if (watchTogether.sharedPlaying()) watchTogether.pause(); else watchTogether.play();
  });
  shield.addEventListener('dblclick', fs.toggle);
  seek.addEventListener('input', () => { dragging = true; paint(Number(seek.value), Number(seek.max)); });
  seek.addEventListener('change', () => { watchTogether.seek(Number(seek.value)); dragging = false; seek.blur(); });
  mute.addEventListener('click', () => { const v = o.volume!.get(); o.volume!.set(v === 0 ? (lastVol || 1) : 0); });
  vol.addEventListener('input', () => { draggingVol = true; o.volume!.set(Number(vol.value)); });
  vol.addEventListener('change', () => { draggingVol = false; vol.blur(); });

  // A live picture's overlay is there only while the mouse is over the window. A streamed file's bar
  // (time, seek, volume) goes IDLE_MS after the mouse stopped moving, like it does in full screen.
  let idle: ReturnType<typeof setTimeout> | null = null;
  const sleep = () => {
    // A menu, or a slider being dragged, keeps it
    if (menuOpen || dragging || draggingVol) { idle = setTimeout(sleep, IDLE_MS); return; }
    stage.classList.remove('active');
    idle = null;
  };
  const wake = () => {
    stage.classList.add('active');
    if (!o.watch) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(sleep, IDLE_MS);
  };
  const leave = () => {
    // A menu stays while the mouse is on its list, which can be outside the window's picture
    if (menuOpen) return;
    if (idle) { clearTimeout(idle); idle = null; }
    stage.classList.remove('active');
  };
  stage.addEventListener('pointerenter', wake);
  stage.addEventListener('pointermove', wake);
  stage.addEventListener('pointerleave', leave);

  const tick = () => {
    if (w.closed) { stop(); return; }
    if (top) refreshHud();
    if (o.watch) {
      const playing = watchTogether.sharedPlaying();
      if (playing !== shownPlaying) { shownPlaying = playing; bigIcon(playing ? 'pause' : 'play'); }
    }
    if (o.volume) {
      const v = o.volume.get();
      if (v > 0) lastVol = v;
      muteIcon(v === 0 ? 'volume-off' : 'volume');
      vol.style.setProperty('--pct', `${v * 100}%`);
      if (!draggingVol) vol.value = String(v);
    }
    if (!o.watch || dragging) return;
    // The host's own player knows its length; a viewer's live picture has none, the session does
    const len = o.video.duration;
    const dur = watchTogether.isHost ? (Number.isFinite(len) ? Math.round(len * 1000) : 0) : watchTogether.durationMs;
    const ms = Math.min(watchTogether.sharedPosition(), dur || Infinity);
    seek.disabled = !dur;
    seek.max = String(dur || 1);
    seek.value = String(ms);
    paint(ms, dur);
  };
  const timer = setInterval(tick, 200);
  tick();

  function stop() {
    clearInterval(timer);
    if (idle) clearTimeout(idle);
    stage.removeEventListener('pointerenter', wake);
    stage.removeEventListener('pointermove', wake);
    stage.removeEventListener('pointerleave', leave);
    fs.stop();
    shield.remove();
    bar.remove();
    top?.remove();
    stage.classList.remove('active');
  }
  return stop;
}
