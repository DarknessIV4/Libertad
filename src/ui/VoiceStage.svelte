<script lang="ts">
  import { tip } from '../lib/tip.ts';
  import { onDestroy, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import MediaFill from './MediaFill.svelte';
  import Avatar from './Avatar.svelte';
  import { session } from '../lib/session.svelte.ts';
  import { store } from '../lib/settings.svelte.ts';
  import { menu } from '../lib/menu.svelte.ts';
  import { ui } from '../lib/ui.svelte.ts';
  import { userMenu, openProfile } from '../lib/actions.ts';
  import { voice } from '../lib/audio/voice.svelte.ts';
  import { share } from '../lib/share.svelte.ts';
  import { desktop } from '../lib/native.ts';
  import { watchTogether } from '../lib/watch-together.svelte.ts';
  import { sessions } from '../lib/session.svelte.ts';
  import ResizeHandle from './ResizeHandle.svelte';
  import ShareStats from './ShareStats.svelte';
  import WatchTogetherBar from './WatchTogetherBar.svelte';
  import WatchPlayer from './WatchPlayer.svelte';
  import StreamVolume from './StreamVolume.svelte';
  import StreamHud from './StreamHud.svelte';
  import { watchFileStream } from '../core/watch-stream.ts';
  import { watchFileStreamState } from '../lib/watch-file-stream.svelte.ts';
  import type { ViewerCap } from '../lib/stream-quality.ts';
  import { mountPopoutBar, mountVideoPopoutBar, POPOUT_BAR_CSS } from '../lib/popout-bar.ts';
  import { spotState } from '../lib/spot-state.svelte.ts';
  import { zoomable } from '../lib/zoom.ts';
  import { menuJustClosed } from '../lib/overlay.ts';
  import { canSaveFrame, saveVideoFrame } from '../lib/save-frame.ts';
  import { stills, bgPause } from '../lib/still.svelte.ts';
  import { hiddenCards } from '../lib/hidden-cards.svelte.ts';

  // People in your voice channel as tiles, always shown. A screen, camera or watch together session
  // is shown large above the tiles, which become a strip. One bar on top serves every running
  // session: who is watching, pop out, full screen, leave (door) and, for the host, end (x).
  // fill: take all the room the parent gives, without a height of its own (the voice screen)
  let { fill = false }: { fill?: boolean } = $props();

// Track popup window reference for YouTube
let youtubePopupWindow = $state<Window | null>(null);
let popoutBarStop: (() => void) | null = null;

const self = $derived(session.self);
  const channel = $derived(self ? session.channel(self.channelId) : undefined);
  const inChannel = $derived(self ? session.usersIn(self.channelId) : []);
  const here = (s: { server?: { id: string } | null } | null | undefined) => !!s && s.server?.id === session.server?.id;

  const watches = $derived(share.watches.filter(w => here(w.host)));
  const watchOf = (s: number) => watches.find(w => w.session === s);
  const mine = $derived(share.stream && here(share.host) ? share.stream : null);
  const anySharing = $derived(inChannel.some(u => session.sharing[u.session]));
    const isWatchingTogether = $derived(watchTogether.isWatching);

  // The YouTube overlay shows the pop-out and full screen buttons itself while full screen
  $effect(() => { spotState.fullscreen = isFullscreen; });
  $effect(() => { spotState.poppedOut = share.poppedOut; });
  onDestroy(() => { spotState.fullscreen = false; spotState.poppedOut = false; });
  $effect(() => {
    const onSpot = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      if (action === 'fullscreen') fullscreen(WT);
      else if (action === 'popout') togglePip(WT);
    };
    window.addEventListener('libertad-spot', onSpot);
    return () => window.removeEventListener('libertad-spot', onSpot);
  });

  // The keyboard shortcuts for full screen and pop-out (Settings, Accessibility): they act on the picture
  // in full screen, else on one that is in its own window (to bring it back), else the first one shown
  $effect(() => {
    const onShortcut = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      const popped = Object.keys(videoPops).map(Number)[0];
      const id = fsId ?? (share.poppedOut ? WT : popped) ?? stack[0];
      if (id === undefined || id === null || Number.isNaN(id)) return;
      if (action === 'fullscreen') void fullscreen(id);
      else if (action === 'popout') void togglePip(id);
    };
    window.addEventListener('libertad-shortcut', onShortcut);
    return () => window.removeEventListener('libertad-shortcut', onShortcut);
  });

  // Listen for pop-in signal from YouTube popup window
  $effect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data && e.data.type === 'libertad-youtube-popin') {
        console.log('[VoiceStage] Received YouTube pop-in signal from popup');
        if (share.poppedOut) {
          popInYouTube();
          share.poppedOut = false;
        }
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  });

  const visible = $derived(!!self);

  // Everyone in the channel has their banner or card background ready for their tile
  $effect(() => {
    for (const u of inChannel) {
      void u.comment; void u.commentHash; void u.name;
      untrack(() => session.ensureProfile(u));
    }
  });
  // The picture we have of someone: our own stream, or one we are watching
  function streamOf(s: number): MediaStream | null {
    // Our own screen is shown from a lighter copy of the picture, not the one being sent
    if (s === self?.session) return share.kind === 'screen' && share.preview && mine ? share.preview : mine;
    return watchOf(s)?.stream ?? null;
  }
  // A camera plays in the person's tile; a screen never does
  const camOf = (s: number) => session.sharing[s] === 'camera' ? streamOf(s) : null;

  // People with a stream we can show come first, then others who share
  const rank = (s: number) => streamOf(s) ? 0 : session.sharing[s] ? 1 : 2;
  const people = $derived([...inChannel].sort((a, b) => rank(a.session) - rank(b.session)));
  // Everyone in the channel gets a tile, whatever is being shown above them, except those you hid
  const shown = $derived(people.filter(u => u.session === self?.session || !hiddenCards.has(u)));

  // Screens and the watch together session are all shown, one under the other, all controlled from
  // the bar on top. A camera is enlarged one at a time (focus), and joins the stack while it is.
  const WT = -1;
  let focus = $state<number | null>(null);
  // Panels the person closed with the door (the stream itself keeps running); shown again by a click
  // on the tile, or when a new stream or session starts
  let hidden = $state<Record<number, boolean>>({});
  const screenIds = $derived.by(() => {
    const ids: number[] = [];
    if (mine && share.kind === 'screen' && self) ids.push(self.session);
    for (const w of watches) if (w.kind === 'screen') ids.push(w.session);
    return ids;
  });
  // A camera we watch from another room has no tile here (the tiles are the people of this room), so
  // it is shown large like a screen
  const awayCams = $derived(watches.filter(w => w.kind === 'camera' && !inChannel.some(u => u.session === w.session)).map(w => w.session));
  const stack = $derived.by(() => {
    const ids: number[] = [];
    if (isWatchingTogether && !hidden[WT]) ids.push(WT);
    for (const id of screenIds) if (!hidden[id]) ids.push(id);
    for (const id of awayCams) if (!hidden[id] && !ids.includes(id)) ids.push(id);
    if (focus != null && focus !== WT && !ids.includes(focus) && session.sharing[focus] === 'camera' && streamOf(focus)) ids.push(focus);
    return ids;
  });
  const meeting = $derived(stack.length > 0);
  const inStack = (id: number) => stack.includes(id);
  const kindOf = (id: number) => id === WT ? 'watch' : session.sharing[id] || 'screen';
  // What the bar on top has a group of controls for: the watch together session we are in, our own
  // stream (also while its panel is closed, it is still running), and every other picture shown
  const allIds = $derived.by(() => {
    const ids: number[] = [];
    if (isWatchingTogether) ids.push(WT);
    if (mine && self) ids.push(self.session);
    for (const id of stack) if (!ids.includes(id)) ids.push(id);
    return ids;
  });
  // The bar on top serves a single picture; with several each has its own bar, and the one on top
  // keeps only what has no picture shown (our own stream while its panel is closed)
  const barIds = $derived(stack.length > 1 ? allIds.filter(id => !stack.includes(id)) : allIds);
  // How many are watching: the people in a watch together session, the people connected to our
  // stream. Of someone else's stream we only know ourselves.
  // A picture that comes from another room says whose it is and where they are
  function awayOf(id: number): string {
    const hostId = id === WT ? watchTogether.party?.hostSession : id;
    if (hostId == null || !self || hostId === self.session) return '';
    const u = session.user(hostId);
    return u && u.channelId !== self.channelId ? `${store.displayName(u)} in ${session.channel(u.channelId)?.name || 'Root'}` : '';
  }
  // What we host (a screen, a camera, a watch together) knows who watches: the people in our room, and
  // those who watch from other rooms (counted apart, and listed with a picture and a name on hover)
  const hostedBySelf = (id: number) => id === WT ? watchTogether.isHost : !!self && id === self.session;
  function viewersOf(id: number): { inside: number[]; outside: number[] } {
    // A watch together counts its host too (while they are in it: they can leave without ending it)
    const all = id === WT ? watchTogether.participants : share.viewerSessions;
    const inside = all.filter(v => session.user(v)?.channelId === self?.channelId);
    return { inside, outside: all.filter(v => !inside.includes(v)) };
  }
  // Of someone else's session: everybody in it, one indicator (a watch together lists its members, a stream
  // what its sharer told us)
  function othersOf(id: number): number[] {
    if (id === WT) return watchTogether.participants;
    return watchOf(id)?.viewers ?? [];
  }
  function watching(id: number): number {
    if (id === WT) return watchTogether.participants.length;
    if (self && id === self.session) return share.viewers;
    return 1;
  }
  // The door: leave a watch together session, stop watching someone's stream, or close the panel of
  // our own (it keeps being shared). The x ends what we host, nobody else's.
  function leave(id: number) {
    if (id === WT) watchTogether.leave();
    else if (self && id === self.session) { if (focus === id) focus = null; else hidden[id] = true; }
    else share.unwatch(id);
  }
  function end(id: number) {
    if (id === WT) watchTogether.end();
    else share.stop();
  }
  // Something that was enlarged is gone
  $effect(() => { if (focus != null && !streamOf(focus)) focus = null; });
  // A stream or session that starts is shown, even if an earlier one of the same person was closed
  let knownScreens = new Set<number>();
  $effect(() => {
    const now = new Set([...screenIds, ...awayCams]);
    untrack(() => { for (const id of now) if (!knownScreens.has(id)) delete hidden[id]; });
    knownScreens = now;
  });
  let hadWatchTogether = false;
  $effect(() => {
    if (isWatchingTogether && !hadWatchTogether) untrack(() => { delete hidden[WT]; });
    hadWatchTogether = isWatchingTogether;
  });
  // Show watch together when requested from the channel tree or the members list
  $effect(() => {
    void watchTogether.focusRequest;
    if (watchTogether.isWatching) untrack(() => { delete hidden[WT]; });
  });

  // The stage is as tall as the user drags it; the tiles grow and shrink to fill it. The
  // meeting view (one picture large) remembers its own height.
  const stored = (key: string, fallback: number) => { try { return Number(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
  let tilesHeight = $state(stored('libertad.stageHeight', 210));
  let meetingHeight = $state(stored('libertad.stageHeightMeeting', 460));
  const maxHeight = () => Math.max(160, window.innerHeight - 220);

  // The people's cards while a picture is shown: under it or above it (hold a card and drag it over the picture), as tall as
  // they were dragged (the handle under them). Only on this computer, nothing is shared.
  const storedText = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  let cardsPos = $state<'below' | 'above'>(storedText('libertad.cardsPos', 'below') === 'above' ? 'above' : 'below');
  let cardsHeight = $state(Math.max(70, stored('libertad.cardsHeight', 150)));
  let stageEl = $state<HTMLElement>();
  let meetingEl = $state<HTMLElement>();
  let cardsEl = $state<HTMLElement>();
  let movingCards = $state(false);
  let sizingCards = $state(false);
  const MIN_CARDS = 70;
  const saveCards = () => {
    try { localStorage.setItem('libertad.cardsPos', cardsPos); localStorage.setItem('libertad.cardsHeight', String(cardsHeight)); } catch { /* storage unavailable */ }
  };
  // Free room under the picture and the cards, down to the edge: the bottom of the stage when it fills its column (the voice
  // screen and the docked chat, where the stage is always as tall as the column), else the bottom of the window.
  // Negative when they already reach past it.
  function roomBelow(): number {
    if (!stageEl) return 0;
    const content = Math.max(...[meetingEl, cardsEl].map(e => e?.getBoundingClientRect().bottom ?? 0));
    const edge = fill ? stageEl.getBoundingClientRect().bottom : window.innerHeight - 5;
    return edge - content;
  }
  // How tall the picture and the cards may be right now: no taller than what ends at the edge
  const meetingRoom = () => Math.max(240, meetingHeight + roomBelow());
  const cardsRoom = () => Math.max(MIN_CARDS, cardsHeight + roomBelow());
  // A smaller window shows less of it
  function fitCardsToWindow() {
    if (!meeting || !stageEl) return;
    const room = cardsRoom();
    if (cardsHeight > room) cardsHeight = room;
  }
  $effect(() => {
    void meeting; void stackHeight; void collapsed;
    const raf = requestAnimationFrame(fitCardsToWindow);
    const onResize = () => fitCardsToWindow();
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  });

  // Holding a card and dragging it: over the upper half of the picture all the cards go above it, over the lower half under it.
  // A drag is not a click, so the card does not open anything when let go.
  let dragged = false;
  function cardDrag(e: PointerEvent) {
    if (!meeting || e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    let on = false;
    const move = (ev: PointerEvent) => {
      if (!on) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) return;
        on = true; movingCards = true; dragged = true;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      }
      if (!meetingEl) return;
      const r = meetingEl.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      if (ev.clientY < mid && cardsPos === 'below') cardsPos = 'above';
      else if (ev.clientY > mid && cardsPos === 'above') cardsPos = 'below';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!on) return;
      movingCards = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      saveCards();
      fitCardsToWindow();
      setTimeout(() => { dragged = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // The handle under the cards (under the whole stage when they are below the picture, between them and the picture when above):
  // dragging down makes them taller, until the stage reaches the edge of the window
  function sizeCards(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    sizingCards = true;
    document.body.style.userSelect = 'none';
    const y0 = e.clientY, h0 = cardsHeight;
    const move = (ev: PointerEvent) => {
      const want = Math.max(MIN_CARDS, h0 + ev.clientY - y0);
      cardsHeight = Math.round(Math.min(want, cardsRoom()));
    };
    const up = () => {
      sizingCards = false;
      document.body.style.userSelect = '';
      saveCards();
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  function cardsKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') cardsHeight = Math.min(cardsHeight + 16, cardsRoom());
    else if (e.key === 'ArrowUp') cardsHeight = Math.max(MIN_CARDS, cardsHeight - 16);
    else return;
    e.preventDefault();
    saveCards();
  }

  // The view is as tall as it was dragged, whatever is in it: several panels share that height equally,
  // so one drag of the handle resizes all of them at once
  const stackHeight = $derived(meetingHeight);

  // The tiles fill the stage completely, like a meeting's tile view: rows of equal tiles, with
  // the number of columns chosen so the tiles come closest to a 16:9 shape. A last row with
  // fewer people stretches, so no space is left over. Measured live, so it follows every resize.
  let gridW = $state(0), gridH = $state(0);
  const GAP = 8, PAD = 8;
  const cols = $derived.by(() => {
    const n = shown.length;
    const w = gridW - PAD * 2, h = gridH - PAD * 2;
    if (n < 2 || w <= 0 || h <= 0) return 1;
    let best = 1, bestSize = 0;
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      // Width of the largest 16:9 picture that fits one cell
      const size = Math.min((w - GAP * (c - 1)) / c, ((h - GAP * (r - 1)) / r) * 16 / 9);
      if (size > bestSize + 0.5) { best = c; bestSize = size; }
    }
    return best;
  });
  // In the meeting view everyone sits in one row under the picture
  const rows = $derived.by(() => {
    const out: (typeof shown)[] = [];
    for (let i = 0; i < shown.length; i += cols) out.push(shown.slice(i, i + cols));
    return out;
  });
  const avatar = $derived.by(() => {
    const cellW = (gridW - PAD * 2 - GAP * (cols - 1)) / cols;
    const cellH = (gridH - PAD * 2 - GAP * (rows.length - 1)) / Math.max(1, rows.length);
    return Math.max(24, Math.min(128, Math.round(Math.min(cellH * 0.5, cellW * 0.34))));
  });

  let folded = $state(load());
  const collapsed = $derived(folded && !fill);
  function load(): boolean {
    try { return localStorage.getItem('libertad.stageCollapsed') === '1'; } catch { return false; }
  }
  function toggle() {
    if (fill) return;
    folded = !folded;
    try { localStorage.setItem('libertad.stageCollapsed', folded ? '1' : '0'); } catch { /* storage unavailable */ }
  }

  const talking = (s: number) => !!voice.talking[s] || (s === self?.session && voice.transmitting);

  // Mobile browsers do not always honour autoplay for a stream attached later, so play is asked for too
  function media(node: HTMLMediaElement, stream: MediaStream | null) {
    const attach = (s: MediaStream | null) => {
      node.srcObject = s;
      if (s) node.play().catch(() => {});
    };
    attach(stream);
    return { update(next: MediaStream | null) { if (node.srcObject !== next) attach(next); } };
  }

  // Sound comes from hidden players, one per stream that has any, so it plays once however
  // many pictures are shown. They all follow the stream volume.
  const withSound = $derived(watches.filter(w => w.stream?.getAudioTracks().length));
  const hasSound = (id: number) => withSound.some(w => w.session === id);
  function loud(node: HTMLMediaElement) {
    $effect(() => {
      node.volume = store.settings.shareVolume;
      node.muted = store.settings.shareVolume === 0;
    });
  }

  function tileClick(session_: number, at?: Element) {
    if (streamOf(session_) || (watchOf(session_) && session.sharing[session_] !== 'camera')) {
      // A screen is shown or closed; a camera is enlarged or put back
      if (session.sharing[session_] === 'camera') focus = focus === session_ ? null : session_;
      else hidden[session_] = !hidden[session_];
    } else if (session.sharing[session_] && session_ !== self?.session) {
      share.watch(sessions.active, session_);
    }
    else if (session.watchTogether[session_] && session_ !== self?.session) watchTogether.join(session_);
    // The host who left (not ended) goes back into their own session
    else if (session_ === self?.session && watchTogether.isHost && watchTogether.hasActiveParty && !watchTogether.isWatching) watchTogether.join(session_);
    else openProfile(session_, at ?? { x: window.innerWidth / 2, y: window.innerHeight / 3 });
  }

  // Right-click on the picture
  let statsFor = $state<number | null>(null);
  const streamItems = (id: number) => [
    { label: 'Open in a separate window', action: () => popOut(id) },
    { label: 'Full screen', action: () => fullscreen(id) },
    ...(self && id === self.session && mine && share.kind === 'camera' && share.cameras > 1
      ? [{ label: 'Switch to the next camera', disabled: share.switching, action: () => share.switchCamera() }] : []),
    // The stream's volume: only someone else's stream with sound has one
    ...(id !== WT && id !== self?.session && hasSound(id)
      ? [{ separator: true, label: '' },
         ...([['Mute', 0], ['Volume 50%', 0.5], ['Volume 100%', 1]] as const).map(([label, v]) =>
           ({ label, checked: store.settings.shareVolume === v, action: () => { store.settings.shareVolume = v; store.saveSettings(); } }))]
      : []),
    // Stats are about a stream's connection (screen share, camera); watch together has none
    ...(id !== WT
      ? [{ separator: true, label: '' },
         { label: 'Stats for nerds', checked: statsFor === id, action: () => (statsFor = statsFor === id ? null : id) }]
      : [])
  ];
  const streamMenu = (e: MouseEvent, id: number) => menu.show(e, streamItems(id));
  // Touch screens have no right-click: holding a finger on the picture opens the same menu
  let hold: ReturnType<typeof setTimeout> | undefined;
  function touchStart(e: TouchEvent, id: number) {
    const touch = e.touches[0];
    clearTimeout(hold);
    if (e.touches.length !== 1) return;
    const { clientX, clientY } = touch;
    hold = setTimeout(() => menu.showAt(clientX, clientY, streamItems(id)), 550);
  }
  const touchEnd = () => clearTimeout(hold);

  // The panel that fills the screen, if any (a stream's session, or WT)
  let fsId = $state<number | null>(null);
  const isFullscreen = $derived(fsId !== null);
  // The pictures, to ask one of them for picture-in-picture
  let videos = $state<Record<number, HTMLVideoElement | undefined>>({});

  async function fullscreen(id: number) {
    fsId = fsId === id ? null : id;

    if (desktop) {
      // Use Electron's native fullscreen for the entire window
      await desktop.setFullScreen(fsId !== null);
    }
  }

  // The picture is gone (the host stopped sharing or ended the watch party, we left the channel):
  // leave full screen at once, otherwise the window stays full screen with nothing to see
  function leaveFullscreen() {
    fsId = null;
    desktop?.setFullScreen(false);
  }
  $effect(() => { if (fsId !== null && !stack.includes(fsId)) leaveFullscreen(); });
  onDestroy(() => { if (isFullscreen) leaveFullscreen(); });

  // Add escape key handler for fullscreen
  $effect(() => {
    if (!isFullscreen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        fsId = null;
        if (desktop) {
          desktop.setFullScreen(false);
        }
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  });

  // Picture-in-picture for video
  const popped = $derived(share.poppedOut);

  // Full screen of a pop-out window by the name it was opened with (null in the browser build)
  const popFullscreen = (name: string) => {
    const native = desktop;
    return native ? { set: (on: boolean) => native.setPopoutFullScreen(name, on), get: () => native.isPopoutFullScreen(name) } : null;
  };

  async function popOut(id: number) {
    // Popping out from full screen: the window behind must not stay full screen with nothing in it
    if (fsId === id) leaveFullscreen();
    // Use native picture-in-picture API
    if (id === WT) {
      const mode = watchTogether.mode;

      // A file the host streams: the player goes to the same kind of window as YouTube
      if (mode === 2 || mode === 3) return popOutVideo(id);
      // YouTube: use popup window (iframe doesn't support native PiP)
      const videoId = watchTogether.currentVideo?.id;
      if (videoId) {
        // Get current playback state BEFORE moving iframe
        const currentTime = watchTogether.youtubePlayer?.getCurrentTime() ?? 0;
        const playerState = watchTogether.youtubePlayer?.getPlayerState() ?? -1;
        console.log('[VoiceStage] YouTube pop-out - Saved state:', { currentTime, playerState });

        // Store playback state in party for pop-in to read
        if (watchTogether.party) {
          watchTogether.party.popoutPositionMs = Math.round(currentTime * 1000);
          watchTogether.party.popoutPlaying = playerState === 1; // YT_PLAYING = 1
          console.log('[VoiceStage] YouTube pop-out - Stored in party:', watchTogether.party.popoutPositionMs, watchTogether.party.popoutPlaying);
        }

        const existingIframe = document.querySelector('.youtube-iframe') as HTMLIFrameElement;
        if (existingIframe) {
          // Store references for restoration
          (existingIframe as any)._mainWindowParent = existingIframe.parentElement;
          (existingIframe as any)._mainWindowNextSibling = existingIframe.nextSibling;
          (existingIframe as any)._mainWindowStyle = existingIframe.style.cssText;

          // Store the playback state on the iframe element itself for the popup to use
          (existingIframe as any)._popoutTime = currentTime;
          (existingIframe as any)._popoutPlaying = playerState === 1;

          // Create the popup with a script that will handle the iframe
          const w = window.open('', 'libertad-watch', 'popup,width=960,height=600');
          if (!w) {
            share.error = 'The watch party could not be opened in a separate window. If your browser blocked a pop-up, allow it for this page and try again.';
            return;
          }
          share.poppedOut = true;
          youtubePopupWindow = w;

          // Write the popup HTML with external script (CSP compliant)
          w.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Libertad Watch Together</title>
              <style>
                html, body { margin:0; height:100%; background:#000; overflow:hidden; }
                body { display:flex; align-items:center; justify-content:center; }
                /* Same crop as in the main window: YouTube draws its title bar and bottom strip at the
                   edges of the frame, so the frame is taller than the picture and the extra is clipped */
                #yt-stage { position:relative; flex:none; width:min(100vw, 100vh * 16 / 9); aspect-ratio:16 / 9; overflow:hidden; }
                ${POPOUT_BAR_CSS}
                .youtube-iframe { position:absolute !important; left:50% !important; top:50% !important; transform-origin:center !important; border:none; display:block; }
              </style>
            </head>
            <body>
              <div id="yt-stage"></div>
              <script src="/youtube-popout-handler.js"><\/script>
            </body>
            </html>
          `);
          w.document.close();

          // Wait for popup to signal ready before moving iframe
          // This ensures the popup's MutationObserver is ready to catch the iframe
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              window.removeEventListener('message', handler);
              reject(new Error('Popup ready timeout'));
            }, 5000);

            function handler(e: MessageEvent) {
              if (e.data && e.data.type === 'libertad-popup-ready' && e.source === w) {
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                resolve();
              }
            }
            window.addEventListener('message', handler);
          });

          // Now move the iframe to the popup
          const popStage = w.document.getElementById('yt-stage') ?? w.document.body;
          // A moved frame loads its address again. Give it one that starts where the video is now (and
          // plays if it plays), set while the frame is out of any page so it does not load twice.
          const fresh = watchTogether.youtubePlayer?.prepareMove?.();
          existingIframe.remove();
          if (fresh) existingIframe.setAttribute('src', fresh);
          popStage.appendChild(existingIframe);
          // YouTube's own controls are off: the play/pause button, time and seek bar are drawn into the popup from here
          popoutBarStop?.();
          popoutBarStop = mountPopoutBar(w, popStage, popFullscreen('libertad-watch'), () => togglePip(WT));

          // Moving the frame reloads it. YouTubePlayer notices, and puts the player back where the
          // session is and in its play/pause state, so nothing is sent to it from here.
        }
        return;
      }
      share.error = 'No video to play';
      return;
    }

    // Screen share and camera: the same window
    return popOutVideo(id);
  }

  // The buttons in the corner of a picture: the viewer's own cap on a screen or a streamed file (the
  // sender then sends him less), and the speed of a streamed file, which everybody shares
  function hudOf(id: number): { cap: { get: () => ViewerCap; set: (c: ViewerCap) => void } | null; speed: boolean } | null {
    if (id === WT) {
      if (watchTogether.mode !== 2) return null;
      const host = watchTogether.party?.hostSession;
      const cap = !watchTogether.isHost && host != null
        ? { get: () => watchFileStreamState.qualityOf(host), set: (c: ViewerCap) => watchFileStream.setQuality(sessions.active, host, c) } : null;
      return { cap, speed: true };
    }
    if (!self || id === self.session || kindOf(id) !== 'screen') return null;
    return { cap: { get: () => share.qualityOf(id), set: (c: ViewerCap) => share.setQuality(sessions.active, id, c) }, speed: false };
  }

  // A picture that is a plain <video> (a screen, a camera, the stream of a watch together session
  // whose host plays a file) goes to a window of its own, the same one YouTube gets: the video
  // element itself moves there, with the same overlay, and comes back when the window is closed.
  type Pop = { w: Window; video: HTMLVideoElement; parent: Node | null; next: Node | null; style: string; stopBar: () => void; timer: ReturnType<typeof setInterval> };
  // One window per picture, any number of them at once
  let videoPops = $state.raw<Record<number, Pop>>({});
  const videoOf = (id: number): HTMLVideoElement | null =>
    id === WT ? (watchTogether.isHost && watchTogether.mode === 2 ? watchTogether.hostVideo : document.querySelector<HTMLVideoElement>('.local-video')) : videos[id] ?? null;

  function popOutVideo(id: number) {
    if (videoPops[id]) return;
    const video = videoOf(id);
    if (!video) { share.error = 'There is no picture to open in a separate window yet'; return; }
    const w = window.open('', `libertad-pop-${id}`, 'popup,width=960,height=600');
    if (!w) {
      share.error = 'The picture could not be opened in a separate window. If your browser blocked a pop-up, allow it for this page and try again.';
      return;
    }
    w.document.write(`<!DOCTYPE html><html><head><title>Libertad</title><style>
      html, body { margin:0; height:100%; background:#000; overflow:hidden; }
      #yt-stage { position:relative; width:100vw; height:100vh; }
      ${POPOUT_BAR_CSS}
    </style></head><body><div id="yt-stage"></div></body></html>`);
    w.document.close();
    const stage = w.document.getElementById('yt-stage')!;
    const watch = id === WT;
    const own = !!self && id === self.session;
    const parent = video.parentNode, next = video.nextSibling, style = video.style.cssText;
    const wasPlaying = !video.paused;
    const put = () => {
      video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000';
      stage.insertBefore(video, stage.firstChild);
      if (!watch && wasPlaying && video.paused) video.play().catch(() => {});
    };
    // A watch together player is moved without the session noticing, and keeps its place
    if (watch) watchTogether.moveVideo(video, put); else put();
    // A watch together player has its own volume; a screen's sound comes from the stream volume (hidden players)
    const volume = watch
      ? { get: () => (video.muted ? 0 : video.volume), set: (v: number) => { video.volume = v; video.muted = v === 0; } }
      : own ? null
      : { get: () => store.settings.shareVolume, set: (v: number) => { store.settings.shareVolume = v; store.saveSettings(); } };
    const fsName = `libertad-pop-${id}`;
    const fullscreen = popFullscreen(fsName);
    const stopBar = mountVideoPopoutBar(w, stage, { video, watch, volume, fullscreen, hud: { cap: hudOf(id)?.cap ?? null, speed: hudOf(id)?.speed ?? false, frame: id !== WT && canSaveFrame() ? () => void saveVideoFrame(video) : undefined, onpopin: () => popInVideo(id) } });
    const timer = setInterval(() => { if (w.closed) popInVideo(id); }, 400);
    w.addEventListener('pagehide', () => popInVideo(id));
    videoPops = { ...videoPops, [id]: { w, video, parent, next, style, stopBar, timer } };
  }

  function popInVideo(id: number) {
    const p = videoPops[id];
    if (!p) return;
    const { [id]: _gone, ...rest } = videoPops;
    videoPops = rest;
    clearInterval(p.timer);
    p.stopBar();
    const wasPlaying = !p.video.paused;
    const back = () => {
      p.video.style.cssText = p.style;
      if (p.parent?.isConnected) {
        if (p.next && p.next.parentNode === p.parent) p.parent.insertBefore(p.video, p.next);
        else p.parent.appendChild(p.video);
      }
      if (id !== WT && wasPlaying && p.video.paused) p.video.play().catch(() => {});
    };
    if (id === WT) watchTogether.moveVideo(p.video, back); else back();
    if (!p.w.closed) p.w.close();
  }
  // A picture is gone (stopped, ended, left): its window goes with it
  $effect(() => {
    for (const key of Object.keys(videoPops)) if (!stack.includes(Number(key))) untrack(() => popInVideo(Number(key)));
  });
  onDestroy(() => { for (const key of Object.keys(videoPops)) popInVideo(Number(key)); });

  // Pop-in for YouTube - restores iframe from popup window
  async function popInYouTube() {
    const videoId = watchTogether.currentVideo?.id;
    if (!videoId) return;

    // The iframe was moved to document.body by the popup's script
    // Find it and move it back to the correct position
    popoutBarStop?.();
    popoutBarStop = null;
    const existingIframe = document.querySelector('.youtube-iframe') as HTMLIFrameElement;
    if (!existingIframe) {
      console.log('[VoiceStage] YouTube pop-in - No iframe found in document');
      return;
    }

    const parent = (existingIframe as any)._mainWindowParent;
    const nextSibling = (existingIframe as any)._mainWindowNextSibling;
    const originalStyle = (existingIframe as any)._mainWindowStyle;

    if (parent) {
      // Restore original style
      // Not the style saved when the window opened: the stage may have another size now (full screen
      // ended, the window was resized), and that old size left the picture cropped. The player sets
      // the style for the stage as it is.
      existingIframe.style.cssText = originalStyle || '';
      watchTogether.youtubePlayer?.refitFrame?.();
      // The moved frame loads its address again: make it start where the video is now
      const fresh = watchTogether.youtubePlayer?.prepareMove?.();
      existingIframe.remove();
      if (fresh) existingIframe.setAttribute('src', fresh);

      // Move back to main window
      if (nextSibling && nextSibling.parentNode === parent) {
        parent.insertBefore(existingIframe, nextSibling);
      } else {
        parent.appendChild(existingIframe);
      }

      // Moving the frame reloads it: YouTubePlayer puts the player back where the session is,
      // not where it was when the window was opened (it has played on since)

      // Clean up
      delete (existingIframe as any)._mainWindowParent;
      delete (existingIframe as any)._mainWindowNextSibling;
      delete (existingIframe as any)._mainWindowStyle;

      // Clear stored popout state
      if (watchTogether.party) {
        delete watchTogether.party.popoutPositionMs;
        delete watchTogether.party.popoutPlaying;
      }
    }
  }

  // Toggle picture-in-picture / popup window
  async function togglePip(id: number) {
    if (videoPops[id]) { popInVideo(id); return; }
    if (id === WT && watchTogether.mode === 1) {
      // YouTube: toggle popup window
      if (share.poppedOut) {
        // Tell popup to close (it will move iframe back and signal us)
        if (youtubePopupWindow && !youtubePopupWindow.closed) {
          youtubePopupWindow.postMessage({ type: 'libertad-close-youtube-popout' }, '*');
        } else {
          // Popup already closed? Try to pop in anyway
          await popInYouTube();
          share.poppedOut = false;
        }
      } else {
        await popOut(id);
      }
      return;
    }

    await popOut(id);
  }
</script>

{#if voice.error && session.status === 'connected'}<div class="bar bad" role="alert"><span>Voice is not working: {voice.error}</span></div>{/if}
{#if share.error}<div class="bar bad" role="alert"><span>{share.error}</span><button class="btn" onclick={() => (share.error = '')}>Dismiss</button></div>{/if}

{#snippet viewerList(ids: number[])}
  <span class="pop" role="list">
    {#each ids as v (v)}
      {@const u = session.user(v)}
      {#if u}
        <span class="vrow" role="listitem">
          <Avatar name={u.name} size={22} src={session.avatar(v)} />
          <span class="vname">{store.displayName(u)}{#if u.channelId !== self?.channelId}<em>{session.channel(u.channelId)?.name || 'Root'}</em>{/if}</span>
        </span>
      {/if}
    {/each}
  </span>
{/snippet}

{#snippet controls(id: number)}
  {@const isWT = id === WT}
  {@const isMine = !!self && id === self.session}
  {@const kind = kindOf(id)}
  {@const open = inStack(id)}
  {@const n = watching(id)}
  {@const away = awayOf(id)}
  <span class="ctl" role="group" aria-label={isWT ? 'Watch together' : kind === 'camera' ? 'Camera' : 'Screen share'}>
    {#if hostedBySelf(id)}
      {@const v = viewersOf(id)}
      <span class="viewers" role="status" tabindex="0" aria-label="{v.inside.length} watching in your room">
        <span class="status"><Icon name={kind} size={14} />{v.inside.length}</span>
        {#if v.inside.length}{@render viewerList(v.inside)}{/if}
      </span>
      {#if v.outside.length}
        <span class="vsep" aria-hidden="true"></span>
        <span class="viewers" role="status" tabindex="0" aria-label="{v.outside.length} watching from other rooms">
          <span class="status"><Icon name="globe" size={14} />{v.outside.length}</span>
          {@render viewerList(v.outside)}
        </span>
      {/if}
    {:else}
    {@const all = othersOf(id)}
    <span class="viewers" role="status" tabindex="0" aria-label="{all.length || n} watching{away ? `, from ${away}` : ''}">
      <span class="status"><Icon name={kind} size={14} />{all.length || n}{#if away} · {away}{/if}</span>
      {#if all.length}{@render viewerList(all)}{/if}
    </span>
    {/if}
    {#if open}
      <button use:tip class="icon-btn" title="Toggle picture-in-picture" aria-label="Toggle picture-in-picture" onclick={() => togglePip(id)}><Icon name="popout" size={16} /></button>
      <button use:tip class="icon-btn" title="Full screen" aria-label="Full screen" onclick={() => fullscreen(id)}><Icon name="expand" size={16} /></button>
    {/if}
    {#if isWT || !isMine || open}
      <button use:tip class="icon-btn" title={isWT ? 'Leave watch together' : isMine ? `Close your ${kind} (it keeps being shared)` : 'Stop watching'}
        aria-label={isWT ? 'Leave watch together' : isMine ? `Close your ${kind}` : 'Stop watching'} onclick={() => leave(id)}><Icon name="door" size={16} /></button>
    {/if}
    {#if isWT ? watchTogether.isHost : isMine}
      <button use:tip class="icon-btn" title={isWT ? 'End watch together' : `Stop sharing your ${kind}`}
        aria-label={isWT ? 'End watch together' : `Stop sharing your ${kind}`} onclick={() => end(id)}><Icon name="x" size={16} /></button>
    {/if}
  </span>
{/snippet}

{#snippet spot(id: number)}
  {@const isWT = id === WT}
  {@const isMine = !!self && id === self.session}
  {@const kind = kindOf(id)}
  {@const w = isWT ? undefined : watchOf(id)}
  {#if self}
    <div class="spot" class:fullscreen={fsId === id} class:yt={isWT && watchTogether.mode === 1} class:multi={stack.length > 1}
      role="region" aria-label={isWT ? 'Watch together' : kind === 'camera' ? 'Camera' : 'Screen share'}>
      <!-- Several pictures: each has its own bar above it. One picture is served by the bar on top. -->
      {#if stack.length > 1 && fsId !== id}
        <div class="spot-bar">{@render controls(id)}</div>
      {/if}
      <!-- svelte-ignore a11y_media_has_caption -->
      <div class="pic" role="presentation" use:zoomable oncontextmenu={e => streamMenu(e, id)}
        ontouchstart={e => touchStart(e, id)} ontouchend={touchEnd} ontouchmove={touchEnd} ontouchcancel={touchEnd}
        ondblclick={isWT ? () => { if (!menuJustClosed()) fullscreen(id); } : undefined}>
        {#if isWT}
          <!-- Watch together player -->
          <WatchPlayer />
          {#if watchTogether.mode === 1 && watchTogether.playlist.length > 1}
          <WatchTogetherBar />
          {/if}
        {:else}
          <!-- Large, your own camera is shown as the others see it; only the small tile is a mirror -->
          <video bind:this={videos[id]} use:media={streamOf(id)} autoplay playsinline muted ondblclick={() => { if (!menuJustClosed()) fullscreen(id); }}></video>
          {#if !isMine && w && w.state !== 'live'}
            <p class="pending" class:bad={w.state === 'failed'}>{w.state === 'failed'
              ? 'Could not connect to the stream. Across the internet both of you need a STUN server; networks that block direct connections need a relay. Both are in Settings, Voice.'
              : 'Connecting to the stream...'}</p>
          {/if}
          {#if statsFor === id}<ShareStats own={isMine} session={id} onclose={() => (statsFor = null)} />{/if}
        {/if}
        <!-- The stream's volume, bottom right, in the app and in full screen, only while the mouse is over it (watch together has its own bar) -->
        {#if !isWT && !isMine && hasSound(id)}
          <StreamVolume />
        {/if}
        <!-- Top right, only while the mouse is over the picture: quality (a viewer's own cap), speed, full screen, pop out (the YouTube player has these in its own overlay) -->
        {#if !(isWT && watchTogether.mode === 1)}
          {@const hud = hudOf(id)}
          <StreamHud video={isWT ? null : videos[id] ?? null} cap={hud?.cap ?? null} speed={hud?.speed ?? false} fullscreen={fsId === id} onfullscreen={() => fullscreen(id)}
            popped={!!videoPops[id]}
            onpopout={async () => { if (fsId === id) await leaveFullscreen(); await togglePip(id); }} />
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet tiles()}
      <div class="tiles" role="group" aria-label="People in this channel" bind:clientWidth={gridW} bind:clientHeight={gridH}>
        {#each rows as row, r (r)}
          <div class="row" role="presentation">
        {#each row as u (u.session)}
          {@const stream = streamOf(u.session)}
          {@const sharing = session.sharing[u.session]}
          {@const watchTogetherInfo = session.watchTogether[u.session]}
          {@const isSelf = u.session === self?.session}
          <!-- Also check global watchTogether store for host's own session (voice session may differ from text session) -->
          {@const hostWatchTogether = isSelf && watchTogether.isHost && watchTogether.isWatching && watchTogether.mode ? { mode: watchTogether.mode, title: watchTogether.party?.meta?.title || 'Watch together' } : null}
          {@const effectiveWatchTogether = watchTogetherInfo || hostWatchTogether}
          <!-- While a camera is shown large, its tile goes back to the avatar: one picture, not two -->
          {@const cam = focus === u.session ? null : camOf(u.session)}
          {@const w = watchOf(u.session)}
          <button class="tile" class:dragging={movingCards} class:talking={talking(u.session)} class:self={isSelf} class:focused={inStack(u.session)}
            onpointerdown={cardDrag}
            onclick={e => { if (dragged) { e.preventDefault(); return; } tileClick(u.session, e.currentTarget); }}
            oncontextmenu={e => menu.show(e, userMenu(u))}
            title={stream ? (inStack(u.session) ? 'Hide the stream' : 'Show the stream') : sharing && !isSelf ? `Sharing their ${sharing}. Click to watch` : effectiveWatchTogether && !isSelf ? `Watching together: ${effectiveWatchTogether.title}. Click to join` : isSelf && hostWatchTogether ? `Hosting watch together: ${hostWatchTogether.title}` : store.displayName(u)}
            aria-label={stream ? `${inStack(u.session) ? 'Hide' : 'Show'} the ${sharing || 'stream'} of ${store.displayName(u)}` : sharing && !isSelf ? `Watch the ${sharing} of ${store.displayName(u)}` : effectiveWatchTogether && !isSelf ? `Join watch together: ${effectiveWatchTogether.title}` : isSelf && hostWatchTogether ? `Hosting watch together: ${hostWatchTogether.title}` : store.displayName(u)}>
            {#if cam}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video class:mirror={isSelf && share.mirror} use:media={cam} autoplay playsinline muted></video>
            {:else}
              <!-- Hosting: a frame of the share or the watch together session instead of the avatar -->
              {@const frame = sharing === 'screen' || (isSelf && !!mine && share.kind === 'screen') || effectiveWatchTogether ? session.frame(u.session) : null}
              {#if frame && !meeting}<img class="frame-bg" src={frame} alt="" draggable="false" />
              {:else}{@const bv = session.cardBackground(u.session)}
                {#if bv?.kind === 'color'}<span class="card-bg" style="background-color:{bv.color}" aria-hidden="true"></span>
                {:else if bv?.kind === 'image'}<MediaFill class="card-bg" view={bv} paused={bgPause.paused(u)} crop={bv.mime.startsWith('video/') ? null : stills.crop(bv)} />{/if}{/if}
              <Avatar name={u.name} size={avatar} speaking={talking(u.session)} src={session.avatar(u.session)} />
            {/if}
            <span class="who">{store.displayName(u)}</span>
            {#if w && w.state !== 'live'}
              <span class="note">{w.state === 'connecting' ? 'Connecting...' : 'Could not connect'}</span>
            {/if}
            {#if sharing}<span class="badge live"><Icon name={sharing} size={13} /></span>
            {:else if effectiveWatchTogether}<span class="badge live"><Icon name="watch" size={13} /></span>
            {:else if u.deaf || u.selfDeaf}
              <span class="badge" class:admin={u.deaf}><Icon name="headphones-off" size={13} /></span>
            {:else if u.mute || u.selfMute || u.suppress}
              <span class="badge" class:admin={u.mute || u.suppress}><Icon name="mic-off" size={13} /></span>
            {/if}
            {#if isSelf ? (watchTogether.isHost && watchTogether.isWatching) : (watchTogether.isWatching && !!watchTogether.party && watchTogether.party.hostSession === u.session)}
            <span class="host-tag">Host</span>
            {/if}
          </button>
        {/each}
          </div>
        {/each}
      </div>
{/snippet}

{#if visible && self}
  <section class="stage" bind:this={stageEl} class:meeting class:collapsed class:fill class:fs={isFullscreen} aria-label="Voice channel"
    style:height={collapsed || fill || meeting ? undefined : `${tilesHeight}px`}>
    <header class="top">
    <button class="title" onclick={toggle} aria-expanded={!collapsed}>
        <svg class="caret" class:collapsed width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3l3 4 3-4" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>
        <span class="name">{channel?.name || 'Root'}</span>
        <span class="count">{people.length}</span>
        {#if collapsed}
          <span class="mini" aria-hidden="true">
            {#each people.slice(0, 8) as u (u.session)}<Avatar name={u.name} size={18} speaking={talking(u.session)} src={session.avatar(u.session)} />{/each}
          </span>
        {/if}
      </button>
      {#each barIds as id (id)}{@render controls(id)}{/each}
    </header>
    {#if !collapsed && !fill && !(meeting && popped)}
      {#if !meeting}
        <!-- Tiles-only handle: absolute at the stage bottom, only when NOT in meeting view. Not inside the header: its blur would make the header the handle's positioning parent -->
        <ResizeHandle bind:width={tilesHeight} edge="bottom" min={110} max={maxHeight} initial={210} storageKey="libertad.stageHeight" label="Resize the tiles" />
      {/if}
    {/if}

    {#if meeting}
      <!-- Meeting view: the panels + their resize handle as a unit, separate from tiles -->
      <div class="meeting-view" bind:this={meetingEl} style:height="{stackHeight}px">
        <div class="panels" class:multi={stack.length > 1}>
          {#each stack as id (id)}{@render spot(id)}{/each}
        </div>
        <ResizeHandle inline bind:width={meetingHeight} edge="bottom" min={240} max={meetingRoom} initial={460} storageKey="libertad.stageHeightMeeting" label="Resize the meeting view" />
      </div>
    {/if}

    {#each withSound as w (w.session)}<audio use:media={w.stream} use:loud autoplay></audio>{/each}

    {#if !collapsed}
      {#if meeting}
        <!-- The cards fill the room above or under the picture. Always the same place in the markup (the order is CSS), so a card dragged across the picture keeps being the same element -->
        <div class="cards" bind:this={cardsEl} class:above={cardsPos === 'above'} style:height="{cardsHeight}px">
          {@render tiles()}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div class="cards-resize" class:active={sizingCards} role="separator" aria-orientation="horizontal" aria-label="Resize the cards" aria-valuenow={cardsHeight} tabindex="0"
            title="Drag down to make the cards taller, double-click to reset" onpointerdown={sizeCards} ondblclick={() => { cardsHeight = Math.min(150, cardsRoom()); saveCards(); }} onkeydown={cardsKey}></div>
        </div>
      {:else}
        {@render tiles()}
      {/if}
      {#if watches.some(w => w.state === 'failed')}
        <p class="failed">Could not connect to the stream. Across the internet both of you need a STUN server, chosen in Settings, Voice (the person sharing has to restart the stream afterwards).</p>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .stage.fill { flex: 1; border-bottom: 0; }
  .stage { position: relative; flex: none; display: flex; flex-direction: column; min-height: 0; border-bottom: 5px solid transparent; background: transparent; --rh-shift: 2.5px; z-index: 1; }
  /* The divider under the tiles: 5px, 40% dark and 10px blur like the others; the resize handle is centered on it */
  /* Full screen: the stage is its own stacking context, so lift the whole stage above the side panels, their resize handles and dividers (otherwise they draw over the picture), and drop the stage's own divider */
  .stage.fs { z-index: 9999; }
  .stage:not(.fill)::after { content: ''; position: absolute; left: 0; right: 0; bottom: -5px; height: 5px; background: var(--panel-divider, rgb(0 0 0 / 0.4)); backdrop-filter: blur(var(--panel-blur, 10px)); pointer-events: none; }
  .stage.fs::after { display: none; }
  header { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 4px 8px 4px 4px; background-color: var(--glass-1, transparent); background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0.4)), rgb(0 0 0 / var(--panel-shade, 0.4))); backdrop-filter: blur(var(--panel-blur, 10px)); }
  .ctl { display: inline-flex; align-items: center; gap: 2px; margin-left: 6px; }
  .title { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 6px 8px; text-align: left; }
  .title:hover { background: var(--bg-hover); }
  .caret { flex: none; color: var(--text-faint); }
  .caret.collapsed { transform: rotate(-90deg); }
  .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .count { font-size: 12px; color: var(--text-faint); }
  .mini { display: flex; gap: 3px; min-width: 0; overflow: hidden; margin-left: 4px; }

  /* Tile view: equal 16:9 tiles, centered, sized by the script to fill the stage */
  .cards { position: relative; flex: none; display: flex; flex-direction: column; min-height: 0; order: 1; }
  /* The bar stays on top of the picture (same order, and first in the markup); the cards go before it when they are above */
  .cards.above { order: -1; }
  .cards .tiles { flex: 1; }
  .tile.dragging { cursor: grabbing; }
  .cards-resize { position: absolute; z-index: 5; left: 0; right: 0; bottom: -4px; height: 8px; cursor: row-resize; touch-action: none; }
  .cards-resize:hover, .cards-resize:focus-visible, .cards-resize.active { outline: none; background: linear-gradient(to bottom, transparent 3px, var(--accent) 3px, var(--accent) 5px, transparent 5px); }
  .tiles { flex: 1; min-height: 0; padding: 8px; display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
  .row { flex: 1 1 0; min-height: 0; display: flex; gap: 8px; }
  .tile { position: relative; flex: 1 1 0; min-width: 0; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden;
    background: var(--bg-2); border: 2px solid transparent; transition: border-color 80ms; }
  .tile:hover { background: var(--bg-hover); }
  .tile.talking { border-color: var(--speaking); box-shadow: 0 0 0 1px var(--speaking), 0 0 18px -4px var(--speaking); }
  .tile.focused { border-color: var(--accent); }
  /* A camera keeps its own shape inside the tile, whatever size the tile is: nothing is cut
     off, a phone held upright gets bars at the sides. Your own is mirrored, like a mirror. */
  .tile video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
  .tile video.mirror { transform: scaleX(-1); }
  /* Hosting: the share / watch together frame fills the whole tile, half blurred, behind the avatar and tags.
     The scale hides the soft edges the blur leaves. */
  .tile :global(.card-bg) { position: absolute; inset: 0; background-size: cover; background-position: center; background-repeat: no-repeat; pointer-events: none; }
  .tile .frame-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: blur(5px); transform: scale(1.05); pointer-events: none; }
  .tile :global(.avatar) { position: relative; }
  /* Name tag over the lower left corner */
  .who { position: absolute; left: 4px; bottom: 4px; max-width: calc(100% - 8px); padding: 1px 6px; font-size: 12px; color: #fff; background: rgb(0 0 0 / 0.6);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tile.self .who { font-weight: 600; }
  .note { position: absolute; left: 0; right: 0; top: 4px; text-align: center; font-size: 11px; color: var(--text-dim); }
  .badge { position: absolute; top: 4px; right: 4px; display: inline-flex; padding: 2px; color: #fff; background: rgb(0 0 0 / 0.6); }
  .badge.admin { color: var(--danger); }
  .badge.live { color: var(--speaking); }
  .host-tag { position: absolute; top: 4px; left: 4px; padding: 1px 5px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; background: var(--accent); color: var(--accent-text); }
  .failed { flex: none; margin: 0; padding: 0 12px 8px; font-size: 12px; color: var(--danger); }

  .bar { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 13px; background: var(--bg-1); border-bottom: 1px solid var(--line); }
  .bar span { flex: 1; min-width: 0; }
  .bar.bad { color: var(--danger); }
  .bar .btn { padding: 4px 10px; font-size: 12px; flex: none; }
  .viewers { position: relative; display: inline-flex; align-items: center; outline: none; }
  .viewers .status { cursor: default; }
  .vsep { width: 1px; height: 14px; margin: 0 6px 0 2px; background: var(--line); flex: none; }
  .pop { display: none; position: absolute; left: 100%; top: 50%; transform: translateY(-50%); margin-left: 8px; z-index: 30; flex-direction: column; gap: 6px; padding: 8px 10px; min-width: 140px; max-height: 260px; overflow-y: auto; background: var(--bg-1); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 20px rgb(0 0 0 / 0.4); }
  .viewers:hover .pop, .viewers:focus-visible .pop, .viewers:focus-within .pop { display: flex; }
  .vrow { display: flex; align-items: center; gap: 8px; white-space: nowrap; color: var(--text); font-size: 13px; }
  .vname { display: flex; flex-direction: column; line-height: 1.15; }
  .vname em { font-style: normal; font-size: 11px; color: var(--text-dim); }
  .status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--speaking); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; margin-right: 4px; }

  /* Meeting view: the chosen picture large, everyone in one row below */
  .spot { flex: 1; min-height: 0; display: flex; flex-direction: column; background: #000; }
  /* Full screen: the picture covers the window; its own buttons (top right, on hover) leave it again */
  .spot.fullscreen { position: fixed !important; inset: 0 !important; z-index: 9999 !important; flex: none !important; background: #000 !important; }
  .spot.fullscreen .pic { position: absolute !important; inset: 0 !important; }
  .pic { position: relative; flex: 1; min-height: 0; display: flex; overflow: hidden; -webkit-touch-callout: none; user-select: none; }
  /* Ctrl + wheel zoom (lib/zoom.ts sets the numbers): only the picture is moved and scaled, never the buttons and bars over it */
  .pic:global(.zoomed) :global(video), .pic:global(.zoomed) :global(.yt-stage) { transform: translate(var(--zx, 0px), var(--zy, 0px)) scale(var(--zs, 1)); transform-origin: 50% 50%; will-change: transform; }
  .pending { position: absolute; inset: 0; margin: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px;
    color: #ddd; font-size: 13px; background: rgb(0 0 0 / 0.6); }
  .pending.bad { color: #ffb3ad; }
  .spot video { flex: 1; min-width: 0; min-height: 0; width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }
  /* One row of a fixed height; tiles share the width and scroll sideways when there are many */
  .tiles.strip { flex: none; height: 92px; padding: 6px 8px; overflow-x: auto; overflow-y: hidden; }
  .tiles.strip .tile { flex: 1 0 120px; max-width: 220px; }

  /* Meeting view: spot + its resize handle as a unit, tiles below */
  /* In a small window the picture never gets less room than its own content needs (header row,
     video): the view grows past the dragged height instead of spilling over the tiles below,
     and the resize handle stays on its bottom edge */
  .meeting-view { flex: 0 0 auto; display: flex; flex-direction: column; position: relative; min-height: min-content; }
  .meeting-view .spot { min-height: min-content; }
  /* The picture's own size must not count towards that floor (a video's natural height would
     stop the view from being made smaller): it needs 200 px, and gets the rest by flex */
  .meeting-view .pic { contain: size; min-height: 200px; }
  /* Several panels one under the other, sharing the view's height */
  .panels { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .panels.multi { gap: 2px; }
  /* Each of several panels takes an equal share of the view */
  .spot.multi { flex: 1 1 0 !important; min-height: 0; }
  .spot-bar { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 2px; min-height: 32px; padding: 0 8px; background: var(--bg-1); }
</style>
