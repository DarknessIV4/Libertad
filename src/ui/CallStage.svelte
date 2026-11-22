<script lang="ts">
  import { untrack, onDestroy } from 'svelte';
  import { desktop } from '../lib/native.ts';
  import { isAndroid } from '../lib/platform.ts';
  import { setAndroidImmersive, immersiveProblem } from '../lib/android-service.ts';
  import { followPip, enterPip, pipProblem, videoPicture, type PipPicture } from '../lib/android-pip.ts';
  import { tip } from '../lib/tip.ts';
  import { touchReveal } from '../lib/touch-reveal.ts';
  import Icon from './Icon.svelte';
  import WatchPlayer from './WatchPlayer.svelte';
  import WatchTogetherBar from './WatchTogetherBar.svelte';
  import StreamHud from './StreamHud.svelte';
  import { share } from '../lib/share.svelte.ts';
  import { watchTogether } from '../lib/watch-together.svelte.ts';
  import { callMedia } from '../lib/call-media.svelte.ts';
  import { spotState } from '../lib/spot-state.svelte.ts';
  import { mountVideoPopoutBar, mountPopoutBar, POPOUT_BAR_CSS } from '../lib/popout-bar.ts';
  import { followPointer, dockOnDrop, type Follower } from '../lib/popout-follow.ts';
  import { canSaveFrame, saveVideoFrame } from '../lib/save-frame.ts';
  import { watchFileStream } from '../core/watch-stream.ts';
  import { watchFileStreamState } from '../lib/watch-file-stream.svelte.ts';
  import type { ViewerCap } from '../lib/stream-quality.ts';

  // The pictures of a friend call, in two windows: what the friend shares (a screen or a camera) and the Watch Together in one,
  // what you share yourself in the other. They stack at the page's top right, above the call bar, and shrink to fit the
  // window; either can be dragged out and resized on its own. Each is only there while there is something to show.
  let { who, top }: { who: string; top?: number } = $props();

  const s = $derived(callMedia.session);
  const FRIEND = callMedia.friend;

  // What the friend sends us, one stream each; our own picture has a window of its own
  const watches = $derived(s ? share.watches.filter(w => w.host === s) : []);
  const mineKind = $derived(s && share.host === s && share.stream ? share.kind : null);
  const together = $derived(callMedia.watchOn);
  const invited = $derived(!!s && callMedia.friendHosts && !together);
  const invite = $derived(s?.watchTogether[FRIEND]);
  // Something of theirs that is not on screen (the note about IP addresses was turned down, or the stream was closed)
  const offered = $derived(!!s && !!s.sharing[FRIEND] && !watches.length);
  const hasTheirs = $derived(watches.length > 0 || offered);
  const hasTogether = $derived(together || invited);
  const hasMine = $derived(!!mineKind);
  const shown = $derived(hasTheirs || hasTogether || hasMine);

  // In a call, what the friend starts to share is shown at once (nothing is sent to them for this: they chose to share with
  // the person they are talking to). A stream we closed ourselves stays closed until they start another.
  const sharing = $derived(s?.sharing[FRIEND] ?? null);
  $effect(() => {
    const call = s, kind = sharing;
    if (!call || !kind) return;
    untrack(() => { if (!share.watchOf(FRIEND)) void share.watch(call, FRIEND, true); });
  });

  // Plays a stream in a <video>
  function media(node: HTMLVideoElement, stream: MediaStream | null) {
    node.srcObject = stream;
    return { update(next: MediaStream | null) { if (node.srcObject !== next) node.srcObject = next; }, destroy() { node.srcObject = null; } };
  }

  type Part = 'theirs' | 'together' | 'mine';
  const PARTS: Part[] = ['theirs', 'together', 'mine'];

  // Full screen is the window's own (as for a stream on a server), with the panel filling it
  let fsPart = $state<Part | null>(null);
  // The window's own full screen (desktop), or the whole screen with the status and navigation bars hidden (Android), where a
  // wide picture also turns the phone to landscape
  async function systemFullscreen(on: boolean, part?: Part) {
    if (desktop) await desktop.setFullScreen(on);
    else if (isAndroid()) {
      const pic = on && part ? pipPictureOf(part) : null;
      const landscape = on && !!part && (part === 'together' || !pic || pic.width >= pic.height);
      const r = await setAndroidImmersive(on, landscape)
        .catch(e => { if (on) share.error = `Full screen could not hide the bars: ${e instanceof Error ? e.message : String(e)}`; return null; });
      if (on && immersiveProblem(r)) share.error = immersiveProblem(r);
    }
  }
  async function fullscreen(part: Part) {
    fsPart = fsPart === part ? null : part;
    await systemFullscreen(fsPart !== null, part);
  }
  function leaveFullscreen() {
    if (!fsPart) return;
    fsPart = null;
    void systemFullscreen(false);
  }
  // Android's back button leaves full screen instead of the call: full screen takes one step of the page's history, and going
  // back one step (the button) ends it. Leaving by a button gives the step back.
  let fsStep = false;
  $effect(() => {
    if (!isAndroid()) return;
    if (fsPart && !fsStep) { fsStep = true; try { history.pushState({ libertadFs: 1 }, ''); } catch { fsStep = false; } }
    else if (!fsPart && fsStep) { fsStep = false; if (history.state?.libertadFs) history.back(); }
  });
  function fsBack() {
    if (!fsStep || !fsPart) return;
    fsStep = false;
    leaveFullscreen();
  }
  $effect(() => {
    if (!fsPart) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') leaveFullscreen(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  });
  // The YouTube player draws its own buttons: tell it we are in full screen, and answer its full screen button
  $effect(() => {
    if (!together) return;
    spotState.call = true;
    spotState.fullscreen = fsPart === 'together';
    const onSpot = (e: Event) => { if ((e as CustomEvent<string>).detail === 'fullscreen') void fullscreen('together'); };
    window.addEventListener('libertad-spot', onSpot);
    return () => {
      window.removeEventListener('libertad-spot', onSpot);
      spotState.call = false;
      spotState.fullscreen = false;
    };
  });
  // The window in full screen has nothing left to show, or the call is over: the window does not stay in full screen
  $effect(() => { if (fsPart && !(fsPart === 'theirs' ? hasTheirs : fsPart === 'together' ? hasTogether : hasMine)) leaveFullscreen(); });
  onDestroy(leaveFullscreen);

  // Each window: the size the person gave it (any edge or corner), and where they put it (the distance of its right edge
  // and its top from the page's). Both are kept. Without a place it stacks with the others at the top right; dragged, it
  // floats where it was let go. The windows never overlap: one dragged or resized against another stops at its edge, and
  // clings to it when it comes close.
  type Size = { w: number; h: number };
  type Pos = { r: number; t: number };
  const KEYS = {
    theirs: { size: 'libertad.call.stage', pos: 'libertad.call.stagePos' },
    together: { size: 'libertad.call.stage.together', pos: 'libertad.call.stagePos.together' },
    mine: { size: 'libertad.call.stage.mine', pos: 'libertad.call.stagePos.mine' }
  } as const;
  function readSize(part: Part): Size | null {
    try { const d = JSON.parse(localStorage.getItem(KEYS[part].size) ?? ''); if (d && d.w > 0 && d.h > 0) return { w: d.w as number, h: d.h as number }; } catch { /* nothing kept */ }
    return null;
  }
  function readPos(part: Part): Pos | null {
    try { const d = JSON.parse(localStorage.getItem(KEYS[part].pos) ?? ''); if (d && Number.isFinite(d.r) && Number.isFinite(d.t)) return { r: d.r as number, t: d.t as number }; } catch { /* nothing kept */ }
    return null;
  }
  const keep = (key: string, value: unknown) => {
    try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch { /* storage unavailable */ }
  };
  const panels = $state<Record<Part, { size: Size | null; pos: Pos | null; dragging: boolean; minimized: boolean }>>({
    theirs: { size: readSize('theirs'), pos: readPos('theirs'), dragging: false, minimized: false },
    together: { size: readSize('together'), pos: readPos('together'), dragging: false, minimized: false },
    mine: { size: readSize('mine'), pos: readPos('mine'), dragging: false, minimized: false }
  });
  let stageEls = $state<Record<Part, HTMLElement | undefined>>({ theirs: undefined, mine: undefined, together: undefined });

  const MIN_W = 280, MIN_H = 180;
  const EDGE = 16, SNAP = 28, CLING = 14;
  const titlebar = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h')) || 0;
  // Keeps the box inside the window, and snaps it to an edge of the window when it is within reach of one
  function place(box: { width: number; height: number }, r: number, t: number, snap: boolean): Pos {
    const minT = titlebar() + EDGE, maxR = Math.max(EDGE, window.innerWidth - box.width - EDGE), maxT = Math.max(minT, window.innerHeight - box.height - EDGE);
    r = Math.min(maxR, Math.max(EDGE, r));
    t = Math.min(maxT, Math.max(minT, t));
    if (snap) {
      if (r - EDGE < SNAP) r = EDGE; else if (maxR - r < SNAP) r = maxR;
      if (t - minT < SNAP) t = minT; else if (maxT - t < SNAP) t = maxT;
    }
    return { r: Math.round(r), t: Math.round(t) };
  }

  // ---- Out of the app ----
  // A window dragged past the border of the app becomes a window of its own (the same pop-out window a stream on a server gets):
  // the <video> itself moves there, with the same overlay, and comes back when that window is closed or its pop-in button is pressed.
  // Only pictures that are a plain <video> can: a screen, a camera, a streamed file. YouTube's frame stays in the app.
  type Pop = { part: Part; w: Window; video: HTMLVideoElement | null; frame?: HTMLIFrameElement; parent: Node | null; next: Node | null; style: string; together: boolean; stopBar: () => void; stopDrop: () => void; timer: ReturnType<typeof setInterval> };
  let pops = $state.raw<Record<string, Pop>>({});
  let mineVideo = $state<HTMLVideoElement | undefined>();
  const away = (part: Part) => Object.values(pops).some(p => p.part === part);
  // A picture is a plain <video>, or (YouTube) the player's frame
  type Pic = { key: string; video: HTMLVideoElement | null; frame?: HTMLIFrameElement; sid?: number };
  function picsOf(part: Part): Pic[] {
    if (part === 'mine') return mineVideo ? [{ key: 'mine', video: mineVideo }] : [];
    if (part === 'theirs') return watches.flatMap(w => { const v = videos[w.session]; return v ? [{ key: `theirs-${w.session}`, video: v, sid: w.session }] : []; });
    if (!together) return [];
    // YouTube: the frame of the player moves to the window, with the overlay the app already draws for it there
    if (watchTogether.mode === 1) {
      const f = stageEls.together?.querySelector<HTMLIFrameElement>('iframe.youtube-iframe') ?? null;
      return f ? [{ key: 'together', video: null, frame: f }] : [];
    }
    const v = watchTogether.isHost && watchTogether.mode === 2 ? watchTogether.hostVideo : stageEls.together?.querySelector<HTMLVideoElement>('video.local-video') ?? null;
    return v ? [{ key: 'together', video: v }] : [];
  }
  // ---- Android: the small window that stays on top of everything (lib/android-pip.ts) ----
  function pipPictureOf(part: Part, sid?: number): PipPicture | null {
    if (part === 'mine') return videoPicture(mineVideo);
    if (part === 'theirs') {
      if (sid !== undefined) return videoPicture(videos[sid]);
      for (const w of watches) { const p = videoPicture(videos[w.session]); if (p) return p; }
      return null;
    }
    if (!together) return null;
    const running = watchTogether.sharedPlaying();
    if (watchTogether.mode === 1) {
      const frame = stageEls.together?.querySelector<HTMLElement>('iframe.youtube-iframe') ?? null;
      return frame ? { el: frame, width: 16, height: 9, running } : null;
    }
    const v = watchTogether.isHost && watchTogether.mode === 2 ? watchTogether.hostVideo : stageEls.together?.querySelector<HTMLVideoElement>('video.local-video') ?? null;
    const pic = videoPicture(v);
    return pic ? { ...pic, running } : null;
  }
  function pipAuto(): PipPicture | null {
    const all = [fsPart, ...PARTS].map(p => (p ? pipPictureOf(p) : null)).filter((p): p is PipPicture => !!p);
    return all.find(p => p.running !== false) ?? all[0] ?? null;
  }
  $effect(() => {
    if (!isAndroid()) return;
    return untrack(() => followPip(pipAuto));
  });
  function pipOnPhone(part: Part, sid?: number) {
    if (!pipPictureOf(part, sid)) return;
    void enterPip(() => pipPictureOf(part, sid)).then(r => { const problem = pipProblem(r); if (problem) share.error = problem; });
  }
  const popFullscreen = (name: string) => (desktop ? { set: (on: boolean) => desktop.setPopoutFullScreen(name, on), get: () => desktop.isPopoutFullScreen(name) } : null);

  // at: where the pointer is on the screen, the new window opens under it
  // Returns the windows it opened, each with the place on it that is held (they follow the pointer while the drag goes on)
  function popOutPart(part: Part, at: { x: number; y: number }): Follower[] {
    const el = stageEls[part];
    const pics = picsOf(part).filter(p => !pops[p.key]);
    const opened: Follower[] = [];
    if (!el || !pics.length) return opened;
    const box = el.getBoundingClientRect();
    const W = Math.max(320, Math.round(box.width)), H = Math.max(200, Math.round(box.height));
    let n = 0;
    for (const pic of pics) {
      const name = `libertad-pop-call-${pic.key}`;
      const w = window.open('', name, `popup,width=${W},height=${H},left=${Math.round(at.x - W / 2) + n * 30},top=${Math.round(at.y - 16) + n * 30}`);
      if (!w) { share.error = 'The picture could not be opened in a separate window. If your browser blocked a pop-up, allow it for this page and try again.'; break; }
      opened.push({ name, w, dx: W / 2 - n * 30, dy: 16 - n * 30 });
      n++;
      mountPop(part, pic, w, name);
    }
    return opened;
  }
  // YouTube's frame in a window of its own: the same page and overlay as the Watch Together pop-out outside a call
  function mountYoutubePop(part: Part, frame: HTMLIFrameElement, key: string, w: Window, name: string) {
    w.document.write(`<!DOCTYPE html><html><head><title>Libertad Watch Together</title><style>
      html, body { margin:0; height:100%; background:#000; overflow:hidden; }
      body { display:flex; align-items:center; justify-content:center; }
      #yt-stage { position:relative; flex:none; width:min(100vw, 100vh * 16 / 9); aspect-ratio:16 / 9; overflow:hidden; }
      ${POPOUT_BAR_CSS}
      .youtube-iframe { position:absolute !important; left:50% !important; top:50% !important; transform-origin:center !important; border:none; display:block; }
    </style></head><body><div id="yt-stage"></div></body></html>`);
    w.document.close();
    const stage = w.document.getElementById('yt-stage')!;
    const parent = frame.parentNode, next = frame.nextSibling, style = frame.style.cssText;
    // A moved frame loads its address again: it gets one that starts where the video is now
    const fresh = watchTogether.youtubePlayer?.prepareMove?.();
    frame.remove();
    if (fresh) frame.setAttribute('src', fresh);
    stage.appendChild(frame);
    const stopBar = mountPopoutBar(w, stage, popFullscreen(name), () => popInPart(part));
    const timer = setInterval(() => { if (w.closed) popInPart(part); }, 400);
    w.addEventListener('pagehide', () => popInPart(part));
    const stopDrop = dockOnDrop(w, name, () => popInPart(part));
    pops = { ...pops, [key]: { part, w, video: null, frame, parent, next, style, together: true, stopBar, stopDrop, timer } };
  }
  function mountPop(part: Part, pic: Pic, w: Window, name: string) {
    const { key } = pic;
    if (pic.frame) { mountYoutubePop(part, pic.frame, key, w, name); return; }
    const video = pic.video!;
    w.document.write(`<!DOCTYPE html><html><head><title>Libertad</title><style>
      html, body { margin:0; height:100%; background:#000; overflow:hidden; }
      #yt-stage { position:relative; width:100vw; height:100vh; }
      ${POPOUT_BAR_CSS}
    </style></head><body><div id="yt-stage"></div></body></html>`);
    w.document.close();
    const stage = w.document.getElementById('yt-stage')!;
    const watch = part === 'together';
    const parent = video.parentNode, next = video.nextSibling, style = video.style.cssText;
    const wasPlaying = !video.paused;
    const put = () => {
      video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000';
      stage.insertBefore(video, stage.firstChild);
      if (!watch && wasPlaying && video.paused) video.play().catch(() => {});
    };
    // A watch together player is moved without the session noticing, and keeps its place
    if (watch) watchTogether.moveVideo(video, put); else put();
    const volume = part === 'mine' ? null : { get: () => (video.muted ? 0 : video.volume), set: (v: number) => { video.volume = v; video.muted = v === 0; } };
    let cap: { get: () => ViewerCap; set: (c: ViewerCap) => void } | null = null;
    let speed = false;
    if (part === 'theirs' && pic.sid !== undefined) {
      const sid = pic.sid;
      cap = { get: () => share.qualityOf(sid), set: c => { if (s) share.setQuality(s, sid, c); } };
    } else if (watch && watchTogether.mode === 2) {
      speed = true;
      const host = watchTogether.party?.hostSession;
      if (!watchTogether.isHost && host != null) cap = { get: () => watchFileStreamState.qualityOf(host), set: c => { if (s) watchFileStream.setQuality(s, host, c); } };
    }
    const stopBar = mountVideoPopoutBar(w, stage, { video, watch, volume, fullscreen: popFullscreen(name),
      hud: { cap, speed, frame: !watch && canSaveFrame() ? () => void saveVideoFrame(video) : undefined, onpopin: () => popInPart(part) } });
    const timer = setInterval(() => { if (w.closed) popInPart(part); }, 400);
    w.addEventListener('pagehide', () => popInPart(part));
    const stopDrop = dockOnDrop(w, name, () => popInPart(part));
    pops = { ...pops, [key]: { part, w, video, parent, next, style, together: watch, stopBar, stopDrop, timer } };
  }
  // Every picture of a window comes back into it, and the window shows again
  function popInPart(part: Part) {
    for (const [key, p] of Object.entries(pops)) {
      if (p.part !== part) continue;
      const { [key]: _gone, ...rest } = pops;
      pops = rest;
      clearInterval(p.timer);
      p.stopDrop();
      p.stopBar();
      if (p.frame) {
        // Back in the stage with the size and scale it has now, and starting where the video is now (moving it reloads it)
        p.frame.style.cssText = p.style;
        watchTogether.youtubePlayer?.refitFrame?.();
        const fresh = watchTogether.youtubePlayer?.prepareMove?.();
        p.frame.remove();
        if (fresh) p.frame.setAttribute('src', fresh);
        if (p.parent?.isConnected) {
          if (p.next && p.next.parentNode === p.parent) p.parent.insertBefore(p.frame, p.next);
          else p.parent.appendChild(p.frame);
        }
        if (!p.w.closed) p.w.close();
        continue;
      }
      const video = p.video!;
      const wasPlaying = !video.paused;
      const back = () => {
        video.style.cssText = p.style;
        if (p.parent?.isConnected) {
          if (p.next && p.next.parentNode === p.parent) p.parent.insertBefore(video, p.next);
          else p.parent.appendChild(video);
        }
        if (!p.together && wasPlaying && video.paused) video.play().catch(() => {});
      };
      if (p.together) watchTogether.moveVideo(video, back); else back();
      if (!p.w.closed) p.w.close();
    }
  }
  // A picture is gone (stopped, ended, left): its window goes with it
  $effect(() => {
    const live = new Set([...(mineKind ? ['mine'] : []), ...(together ? ['together'] : []), ...watches.map(w => `theirs-${w.session}`)]);
    for (const key of Object.keys(pops)) if (!live.has(key)) untrack(() => popInPart(pops[key]?.part ?? 'mine'));
  });
  onDestroy(() => { for (const part of PARTS) popInPart(part); });

  // ---- No overlap ----
  // A box in page coordinates: left, top, right and bottom edge
  type Box = { l: number; t: number; r: number; b: number };
  const shown_ = (): Part[] => PARTS.filter(p => !!stageEls[p] && !away(p));
  const boxOf = (el: HTMLElement): Box => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  const othersOf = (part: Part): Box[] => shown_().filter(p => p !== part).map(p => boxOf(stageEls[p] as HTMLElement));
  // Touching is not overlapping
  const hit = (a: Box, o: Box) => a.l < o.r - 1 && a.r > o.l + 1 && a.t < o.b - 1 && a.b > o.t + 1;
  const posOf = (b: Box): Pos => ({ r: Math.round(window.innerWidth - b.r), t: Math.round(b.t) });
  const within = (margin: number) => (b: Box) =>
    b.l >= margin - 1 && b.r <= window.innerWidth - margin + 1 && b.t >= titlebar() + margin - 1 && b.b <= window.innerHeight - margin + 1;

  // The windows still in the stack at the top right are put where they are, so that one leaving the stack does not move the others
  function freezeOthers(part: Part) {
    for (const p of shown_()) {
      if (p === part || panels[p].pos) continue;
      panels[p].pos = posOf(boxOf(stageEls[p] as HTMLElement));
    }
  }

  // A box being moved clings to the edges of the others (side by side, above and below, or lined up with one) when it comes close
  function cling(box: Box, others: Box[]): Box {
    let dx = Infinity, dy = Infinity;
    for (const o of others) {
      if (box.t < o.b + CLING && box.b > o.t - CLING) for (const d of [o.r - box.l, o.l - box.r, o.l - box.l, o.r - box.r]) if (Math.abs(d) < Math.abs(dx)) dx = d;
      if (box.l < o.r + CLING && box.r > o.l - CLING) for (const d of [o.b - box.t, o.t - box.b, o.t - box.t, o.b - box.b]) if (Math.abs(d) < Math.abs(dy)) dy = d;
    }
    if (Math.abs(dx) > CLING) dx = 0;
    if (Math.abs(dy) > CLING) dy = 0;
    return { l: box.l + dx, r: box.r + dx, t: box.t + dy, b: box.b + dy };
  }

  // A box that overlaps another is moved out of it, the shortest way that stays inside the window; null when there is no way
  function pushOut(box: Box, others: Box[], inside: (b: Box) => boolean): Box | null {
    let cur = box;
    for (let i = 0; i < 6; i++) {
      const o = others.find(x => hit(cur, x));
      if (!o) return cur;
      const w = cur.r - cur.l, h = cur.b - cur.t;
      const tries: Box[] = [
        { l: o.l - w, t: cur.t, r: o.l, b: cur.b }, { l: o.r, t: cur.t, r: o.r + w, b: cur.b },
        { l: cur.l, t: o.t - h, r: cur.r, b: o.t }, { l: cur.l, t: o.b, r: cur.r, b: o.b + h }
      ].filter(inside);
      if (!tries.length) return null;
      const cost = (x: Box) => (others.some(y => hit(x, y)) ? 1e6 : 0) + Math.abs(x.l - cur.l) + Math.abs(x.t - cur.t);
      tries.sort((a, b) => cost(a) - cost(b));
      cur = tries[0];
    }
    return others.some(x => hit(cur, x)) ? null : cur;
  }

  // Windows that overlap (one that came up, or a saved place) are moved apart, those without a place of their own first
  function settle() {
    if (fsPart) return;
    const ps = shown_();
    const boxes = new Map<Part, Box>(ps.map(p => [p, boxOf(stageEls[p] as HTMLElement)]));
    const clash = (p: Part) => ps.some(q => q !== p && hit(boxes.get(p) as Box, boxes.get(q) as Box));
    if (!ps.some(clash)) return;
    const placed = new Set(ps.filter(p => panels[p].pos));
    for (const p of ps) if (!panels[p].pos) panels[p].pos = posOf(boxes.get(p) as Box);
    for (const p of [...ps].sort((a, b) => Number(placed.has(a)) - Number(placed.has(b)))) {
      if (!clash(p)) continue;
      const fixed = pushOut(boxes.get(p) as Box, ps.filter(q => q !== p).map(q => boxes.get(q) as Box), within(0));
      if (fixed) { boxes.set(p, fixed); panels[p].pos = posOf(fixed); }
    }
  }

  // Edges and corners: n s e w, and the four pairs. The window is placed by its right edge and top, so a drag works out
  // the box first (the opposite edges stay where they are) and the right edge and top from it.
  type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
  const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  function resizeStart(e: PointerEvent, part: Part, edge: Edge) {
    const stage = stageEls[part];
    if (!stage || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    freezeOthers(part);
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const start = boxOf(stage);
    const others = othersOf(part);
    const x0 = e.clientX, y0 = e.clientY, minT = titlebar() + EDGE;
    const hasE = edge.includes('e'), hasW = edge.includes('w'), hasS = edge.includes('s'), hasN = edge.includes('n');
    const area = (b: Box) => (b.r - b.l) * (b.b - b.t);
    // The box the pointer asks for, held back by the others: it stops at the edge of one that is in its way, and clings to it when close
    function fit(want: Box): Box | null {
      let box = want;
      for (let pass = 0; pass < 3; pass++) {
        for (const o of others) {
          if (!hit(box, o)) continue;
          const tries: Box[] = [];
          if (hasE && o.l >= start.r - 1) tries.push({ ...box, r: o.l });
          if (hasW && o.r <= start.l + 1) tries.push({ ...box, l: o.r });
          if (hasS && o.t >= start.b - 1) tries.push({ ...box, b: o.t });
          if (hasN && o.b <= start.t + 1) tries.push({ ...box, t: o.b });
          const free = tries.filter(x => !hit(x, o));
          if (!free.length) return null;
          box = free.sort((a, b) => area(b) - area(a))[0];
        }
      }
      if (others.some(o => hit(box, o))) return null;
      for (const o of others) {
        const rows = box.t < o.b && box.b > o.t, cols = box.l < o.r && box.r > o.l;
        if (hasE && rows && o.l >= start.r - 1 && o.l - box.r >= 0 && o.l - box.r < CLING) box = { ...box, r: o.l };
        if (hasW && rows && o.r <= start.l + 1 && box.l - o.r >= 0 && box.l - o.r < CLING) box = { ...box, l: o.r };
        if (hasS && cols && o.t >= start.b - 1 && o.t - box.b >= 0 && o.t - box.b < CLING) box = { ...box, b: o.t };
        if (hasN && cols && o.b <= start.t + 1 && box.t - o.b >= 0 && box.t - o.b < CLING) box = { ...box, t: o.b };
      }
      // Next to another window (snapped together), a width or height close to its own becomes the same; a little more resizing goes past it
      const next = (o: Box) => {
        const rows = box.t < o.b && box.b > o.t, cols = box.l < o.r && box.r > o.l;
        return (rows && (Math.abs(box.l - o.r) <= CLING || Math.abs(o.l - box.r) <= CLING)) || (cols && (Math.abs(box.t - o.b) <= CLING || Math.abs(o.t - box.b) <= CLING));
      };
      const okBox = (x: Box) => x.r - x.l >= MIN_W - 0.5 && x.b - x.t >= MIN_H - 0.5 && within(EDGE)(x) && !others.some(o => hit(x, o));
      for (const o of others) {
        if (!next(o)) continue;
        const ow = o.r - o.l, oh = o.b - o.t;
        if ((hasE || hasW) && Math.abs(box.r - box.l - ow) < CLING) {
          const x = hasE ? { ...box, r: box.l + ow } : { ...box, l: box.r - ow };
          if (okBox(x)) box = x;
        }
        if ((hasS || hasN) && Math.abs(box.b - box.t - oh) < CLING) {
          const x = hasS ? { ...box, b: box.t + oh } : { ...box, t: box.b - oh };
          if (okBox(x)) box = x;
        }
      }
      return box;
    }
    const move = (m: PointerEvent) => {
      const dx = m.clientX - x0, dy = m.clientY - y0;
      let { l, t, r, b } = start;
      if (hasE) r = Math.min(window.innerWidth - EDGE, Math.max(l + MIN_W, r + dx));
      if (hasW) l = Math.max(EDGE, Math.min(r - MIN_W, l + dx));
      if (hasS) b = Math.min(window.innerHeight - EDGE, Math.max(t + MIN_H, b + dy));
      if (hasN) t = Math.max(minT, Math.min(b - MIN_H, t + dy));
      const box = fit({ l, t, r, b });
      if (!box || box.r - box.l < MIN_W - 0.5 || box.b - box.t < MIN_H - 0.5) return;
      const panel = panels[part];
      panel.size = { w: Math.round(box.r - box.l), h: Math.round(box.b - box.t) };
      panel.pos = posOf(box);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      keep(KEYS[part].size, panels[part].size);
      keep(KEYS[part].pos, panels[part].pos);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  const resetSize = (part: Part) => { panels[part].size = null; keep(KEYS[part].size, null); };

  function dragStart(e: PointerEvent, part: Part) {
    const stage = stageEls[part];
    if (!stage || fsPart === part || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    freezeOthers(part);
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const box = stage.getBoundingClientRect();
    const others = othersOf(part);
    const x0 = e.clientX, y0 = e.clientY, r0 = window.innerWidth - box.right, t0 = box.top;
    const panel = panels[part];
    panel.dragging = true;
    const move = (m: PointerEvent) => {
      // Past the border of the app: the picture goes to a window of its own, under the pointer
      if (m.clientX < 0 || m.clientY < 0 || m.clientX > window.innerWidth || m.clientY > window.innerHeight) {
        const out = popOutPart(part, { x: m.screenX, y: m.screenY });
        if (out.length) {
          up();
          // The pointer is still held: the new window(s) keep going under it, over the desktop, until it is let go
          try { followPointer(handle, m.pointerId, out, inside => { if (inside) popInPart(part); }); } catch (err) { console.warn('[popout] follow failed', err); }
          return;
        }
      }
      const p = place(box, r0 - (m.clientX - x0), t0 + (m.clientY - y0), true);
      const want: Box = { l: window.innerWidth - p.r - box.width, t: p.t, r: window.innerWidth - p.r, b: p.t + box.height };
      const fixed = pushOut(cling(want, others), others, within(EDGE));
      if (fixed) panel.pos = posOf(fixed);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      panel.dragging = false;
      keep(KEYS[part].pos, panel.pos);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  const resetPos = (part: Part) => { panels[part].pos = null; keep(KEYS[part].pos, null); };
  // A smaller window must not leave one out of reach (the stacked ones shrink by themselves)
  $effect(() => {
    const fit = () => {
      if (fsPart) return;
      for (const part of PARTS) {
        const p = panels[part], el = stageEls[part];
        if (p.pos && el) p.pos = place(el.getBoundingClientRect(), p.pos.r, p.pos.t, false);
      }
      settle();
    };
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  });
  // Whatever comes up, grows, or is put back (a new picture, a window shown again, a size reset, a saved place) is looked at for
  // overlap once it has settled (the windows slide in for a moment)
  $effect(() => {
    void watches.length; void together; void invited; void offered; void mineKind; void fsPart;
    void Object.keys(pops).length;
    for (const p of PARTS) { void panels[p].minimized; void panels[p].size; void panels[p].pos; }
    const id = window.setTimeout(settle, 220);
    return () => clearTimeout(id);
  });
  let videos = $state<Record<number, HTMLVideoElement | undefined>>({});
  // A new picture opens its window again
  $effect(() => { void watches.length; panels.theirs.minimized = false; });
  $effect(() => { void together; void invited; panels.together.minimized = false; });
  $effect(() => { void mineKind; panels.mine.minimized = false; });
  // The X in each window's bar: stop sharing what you send, stop watching what you get, or leave / end the watch together
  function closePart(part: Part) {
    if (part === 'mine') { if (mineKind) callMedia.toggle(mineKind); return; }
    if (part === 'together') { if (together) { if (watchTogether.isHostWithParty) watchTogether.end(); else watchTogether.leave(); } return; }
    for (const w of [...watches]) share.unwatch(w.session);
  }
  function closeTitle(part: Part): string {
    if (part === 'mine') return `Stop sharing your ${mineKind}`;
    if (part === 'together') return watchTogether.isHostWithParty ? 'End watch together' : 'Leave watch together';
    return 'Stop watching';
  }
  const closable = (part: Part) => part === 'mine' ? !!mineKind : part === 'together' ? together : watches.length > 0;
</script>

<svelte:window onpopstate={fsBack} />

{#snippet panel(part: Part)}
  {@const fs = fsPart === part}
  {@const p = panels[part]}
  {@const sized = !!p.size && !p.minimized}
  <section class="stage" class:away={away(part)} class:min={p.minimized} class:fs class:free={!!p.pos && !fs} class:dragging={p.dragging} class:sized
    style:right={p.pos && !fs ? `${p.pos.r}px` : undefined} style:top={p.pos && !fs ? `${p.pos.t}px` : undefined}
    style:width={sized && !fs ? `${p.size?.w}px` : undefined} style:height={sized && !fs ? `${p.size?.h}px` : undefined}
    bind:this={stageEls[part]} aria-label={part === 'mine' ? `Your ${mineKind}` : part === 'together' ? `Watch together with ${who}` : `Shared in the call with ${who}`}>
    <header onpointerdown={e => dragStart(e, part)} ondblclick={e => { if (!(e.target as HTMLElement).closest('button')) resetPos(part); }} title="Drag to move. Double-click to put it back">
      <strong>{part === 'mine' ? `Your ${mineKind}` : part === 'together' ? 'Watch together' : who}</strong>
      <span class="spacer"></span>
      {#if part === 'mine' && mineKind === 'camera' && share.cameras > 1}
        <button use:tip class="icon-btn" title="Switch camera" aria-label="Switch camera" disabled={share.switching} onclick={() => share.switchCamera()}><Icon name="switch" size={16} /></button>
      {/if}
      <button use:tip class="icon-btn" title="Full screen" aria-label="Full screen" onclick={() => fullscreen(part)}><Icon name="expand" size={16} /></button>
      <button use:tip class="icon-btn" title={p.minimized ? 'Show' : 'Hide'} aria-label={p.minimized ? 'Show' : 'Hide'} onclick={() => (p.minimized = !p.minimized)}>
        <Icon name={p.minimized ? 'expand' : 'menu'} size={16} />
      </button>
      {#if closable(part)}
        <button use:tip class="icon-btn" title={closeTitle(part)} aria-label={closeTitle(part)} onclick={() => closePart(part)}><Icon name="x" size={16} /></button>
      {/if}
    </header>

    {#if !p.minimized}
      <div class="pics">
        {#if part === 'together'}
          {#if invited && invite}
            <div class="invite">
              <p><b>{who}</b> is watching together: {invite.title}</p>
              <button class="btn primary" onclick={() => callMedia.toggle('watch')}>Join</button>
            </div>
          {/if}

          {#if together}
            <div class="pic wt" role="region" aria-label="Watch together" use:touchReveal>
              <WatchPlayer />
              {#if watchTogether.mode === 1 && watchTogether.playlist.length > 1}<WatchTogetherBar />{/if}
              <!-- YouTube has these in its own overlay -->
              {#if watchTogether.mode !== 1}<StreamHud video={null} cap={null} fullscreen={fs} onfullscreen={() => fullscreen(part)} />{/if}
            </div>
          {/if}
        {:else if part === 'theirs'}
          {#if offered && s}
            <div class="invite">
              <p><b>{who}</b> is sharing their {s.sharing[FRIEND]}</p>
              <button class="btn primary" onclick={() => { if (s) void share.watch(s, FRIEND); }}>Watch</button>
            </div>
          {/if}

          {#each watches as w (w.session)}
            <div class="pic" role="region" aria-label={w.kind === 'camera' ? 'Camera' : 'Screen'} use:touchReveal>
              <!-- svelte-ignore a11y_media_has_caption -->
              <video bind:this={videos[w.session]} use:media={w.stream} autoplay playsinline></video>
              {#if w.state !== 'live'}
                <p class="pending" class:bad={w.state === 'failed'}>{w.state === 'failed'
                  ? 'Could not connect to the stream. Across the internet both of you need a STUN server; networks that block direct connections need a relay. Both are in Settings, Voice.'
                  : 'Connecting to the stream...'}</p>
              {/if}
              <StreamHud video={videos[w.session] ?? null} cap={{ get: () => share.qualityOf(w.session), set: c => { if (s) share.setQuality(s, w.session, c); } }} speed={false} fullscreen={fs} onfullscreen={() => fullscreen(part)} popped={false} onpopout={() => { if (isAndroid()) pipOnPhone('theirs', w.session); else void videos[w.session]?.requestPictureInPicture?.().catch(() => {}); }} />
            </div>
          {/each}
        {:else if mineKind}
          <!-- What you send: a camera mirrored, a screen from a lighter copy -->
          <div class="pic" class:cam={mineKind === 'camera'} role="region" aria-label="Your {mineKind}" use:touchReveal>
            <!-- svelte-ignore a11y_media_has_caption -->
            <video bind:this={mineVideo} class:mirror={mineKind === 'camera' && share.mirror} use:media={mineKind === 'screen' ? (share.preview ?? share.stream) : share.stream} autoplay playsinline muted></video>
            <StreamHud video={null} cap={null} fullscreen={fs} onfullscreen={() => fullscreen(part)} />
            {#if !share.viewers}<span class="label">Connecting…</span>{/if}
          </div>
        {/if}
      </div>
      {#if part === 'theirs' && share.error}<p class="problem">{share.error}</p>{/if}
      {#if !fs}
        {#each EDGES as edge (edge)}
          <div class="rz {edge}" role="presentation" onpointerdown={e => resizeStart(e, part, edge)} ondblclick={() => resetSize(part)}></div>
        {/each}
      {/if}
    {/if}
  </section>
{/snippet}

{#if shown}
  <div class="stages" class:fs={!!fsPart} style:top={top != null ? `${top}px` : undefined}>
    {#if hasTheirs}{@render panel('theirs')}{/if}
    {#if hasTogether}{@render panel('together')}{/if}
    {#if hasMine}{@render panel('mine')}{/if}
  </div>
{/if}

<style>
  /* The windows stack here, at the top right; one that was dragged out floats by itself (.free) */
  .stages {
    position: fixed; z-index: 119; right: 16px; top: calc(var(--titlebar-h, 0px) + 16px);
    max-width: calc(100vw - 32px); max-height: calc(100vh - var(--titlebar-h, 0px) - 100px);
    transition: top 180ms var(--ease);
    display: flex; flex-direction: column; align-items: flex-end; gap: 8px; pointer-events: none;
  }
  .stages.fs { z-index: 9999; max-width: none; max-height: none; }
  .stage {
    position: relative; pointer-events: auto; flex: 0 1 auto; min-height: 140px; max-width: calc(100vw - 32px);
    width: min(720px, calc(100vw - 32px));
    display: flex; flex-direction: column; background: var(--bg-2); border: 1px solid var(--line-strong); box-shadow: var(--shadow-pop);
    animation: rise 160ms var(--ease);
  }
  .stage.free { position: fixed; }
  .stage.free:not(.sized) { max-height: calc(100vh - var(--titlebar-h, 0px) - 100px); }
  .stage.dragging { transition: none; animation: none; user-select: none; }
  .stage.away { display: none; }
  .stage.fs header { display: none; }
  /* One window in full screen: the others stay out of its way */
  .stages.fs .stage:not(.fs) { visibility: hidden; }
  .stage.fs { position: fixed; width: 100vw; height: 100vh; max-width: none; max-height: none; inset: 0; z-index: 9999; border: 0; background: #000; animation: none; }
  .stage.min { height: auto; min-height: 0; width: min(320px, calc(100vw - 32px)); }
  header { cursor: grab; touch-action: none; flex: none; display: flex; align-items: center; gap: 4px; padding: 4px 6px 4px 10px; font-size: 13px; border-bottom: 1px solid var(--line); }
  header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stage.dragging header { cursor: grabbing; }
  .spacer { flex: 1; }
  .pics { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; background: #000; }
  .stage.fs .pics, .stage.sized .pics { overflow: hidden; }
  /* A picture keeps its shape while there is room, and shrinks (the video fits inside it) when the window has less */
  .pic { position: relative; flex: 0 1 auto; min-height: 0; aspect-ratio: 16 / 9; background: #000; overflow: hidden; }
  .stage.fs .pic, .stage.sized .pic { flex: 1; aspect-ratio: auto; }
  .pic video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }
  .pic.wt { min-height: 240px; }
  /* Resize handles on every edge and corner, a little outside the window so they are easy to grab */
  .rz { position: absolute; z-index: 8; touch-action: none; }
  .rz.n, .rz.s { left: 10px; right: 10px; height: 8px; cursor: ns-resize; }
  .rz.e, .rz.w { top: 10px; bottom: 10px; width: 8px; cursor: ew-resize; }
  .rz.n { top: -4px; } .rz.s { bottom: -4px; } .rz.e { right: -4px; } .rz.w { left: -4px; }
  .rz.ne, .rz.nw, .rz.se, .rz.sw { width: 14px; height: 14px; }
  .rz.ne { top: -4px; right: -4px; cursor: nesw-resize; } .rz.sw { bottom: -4px; left: -4px; cursor: nesw-resize; }
  .rz.nw { top: -4px; left: -4px; cursor: nwse-resize; } .rz.se { bottom: -4px; right: -4px; cursor: nwse-resize; }
  .mirror { transform: scaleX(-1); }
  .label { position: absolute; left: 6px; bottom: 6px; padding: 2px 6px; font-size: 12px; background: rgb(0 0 0 / 0.6); color: #fff; }
  .pending { position: absolute; inset: 0; margin: 0; display: flex; align-items: center; justify-content: center; padding: 16px; text-align: center; font-size: 13px; color: #ddd; background: rgb(0 0 0 / 0.55); }
  .pending.bad { color: var(--danger); }
  .invite { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; background: var(--bg-2); }
  .invite p { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
  .problem { margin: 0; padding: 6px 10px; font-size: 12px; color: var(--danger); background: var(--bg-2); }
  @keyframes rise { from { opacity: 0; transform: translateY(-6px); } }
</style>
