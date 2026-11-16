<script lang="ts">
  import { untrack, onDestroy } from 'svelte';
  import { titlebar } from '../lib/titlebar.svelte.ts';
  import Icon from './Icon.svelte';
  import Avatar from './Avatar.svelte';
  import { p2p } from '../lib/p2p.svelte.ts';
  import CallStage from './CallStage.svelte';
  import CallOverlay from './CallOverlay.svelte';
  import { mount, unmount } from 'svelte';
  import FriendCard from './FriendCard.svelte';
  import { callMedia } from '../lib/call-media.svelte.ts';
  import { followPointer, dockOnDrop, trackAppPointer } from '../lib/popout-follow.ts';
  import GifPicker from './GifPicker.svelte';
  import { watchTogether } from '../lib/watch-together.svelte.ts';
  import { gifs, type Gif } from '../lib/gifs.svelte.ts';
  import { store, MESSAGE_STYLES, type MessageStyle } from '../lib/settings.svelte.ts';

  // Floats over everything: a call coming in, a call going out, a call in progress, and how the last one ended
  const call = $derived(p2p.call);
  const who = $derived(call ? p2p.nameOf(call.key) : '');
  const note = $derived(p2p.endNote);

  // Screen share, camera and Watch Together work in the call once it is active, and end with it
  const activeKey = $derived(call?.state === 'active' ? call.key : '');
  $effect(() => {
    const key = activeKey;
    if (!key) return;
    untrack(() => callMedia.open(key, p2p.nameOf(key)));
    return () => callMedia.close();
  });
  $effect(() => { callMedia.rename(who); });
  const canShare = $derived(callMedia.supported);
  const screenOn = $derived(callMedia.screenOn);
  const cameraOn = $derived(callMedia.cameraOn);
  const watchOn = $derived(callMedia.watchOn);
  const watchInvite = $derived(callMedia.friendHosts && !watchOn);

  // Active call: only the friend's picture shows; the buttons come out to its sides while the mouse is over it.
  // Clicking the picture opens the friend's profile card.
  let cardOpen = $state(false);
  $effect(() => { if (call?.state !== 'active') cardOpen = false; });
  // Screen and camera share one button: it opens the share dialog (where Screen share or Camera is chosen), or stops what is shared
  const sharingNow = $derived(screenOn || cameraOn);

  // The two groups of buttons (left: share, messages; right: mute, deafen, end) are as long as this when they come out
  const groupLen = (n: number) => n * 40 + (n - 1) * 8 + 16 + 1;
  const SIDE_R = groupLen(3);
  const SIDE_L = groupLen(3);

  // The bar can be dragged and lets go at the nearest edge of the window: it is kept as an edge and a place along it (0 to 1),
  // so it stays on its edge when the window changes size. Remembered between launches.
  type Edge = 'left' | 'right' | 'top' | 'bottom';
  const DOCK = 'libertad.call.dock';
  const MARGIN = 16;
  function loadDock(): { edge: Edge; at: number } {
    try {
      const d = JSON.parse(localStorage.getItem(DOCK) ?? '');
      if (['left', 'right', 'top', 'bottom'].includes(d?.edge) && typeof d.at === 'number') return { edge: d.edge, at: Math.min(1, Math.max(0, d.at)) };
    } catch { /* nothing kept, or storage unavailable */ }
    return { edge: 'bottom', at: 1 };
  }
  let dock = $state(loadDock());
  let drag = $state<{ x: number; y: number } | null>(null);
  let vw = $state(window.innerWidth), vh = $state(window.innerHeight);
  let barW = $state(0), barH = $state(0);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(hi < lo ? lo : v, lo), Math.max(lo, hi));
  const bounds = $derived({ minX: MARGIN, maxX: vw - barW - MARGIN, minY: titlebar.height + MARGIN, maxY: vh - barH - MARGIN });
  const place = $derived.by(() => {
    if (drag) return drag;
    const { minX, maxX, minY, maxY } = bounds;
    const x = Math.max(minX, minX + dock.at * (maxX - minX)), y = Math.max(minY, minY + dock.at * (maxY - minY));
    switch (dock.edge) {
      case 'left': return { x: minX, y };
      case 'right': return { x: Math.max(minX, maxX), y };
      case 'top': return { x, y: minY };
      default: return { x, y: Math.max(minY, maxY) };
    }
  });
  // Where the groups of buttons come out. Both go sideways (one left, one right) until one of them would reach the window's left
  // or right edge; then both go vertical (one up, one down), and a vertical one that would reach the top or bottom edge turns
  // sideways again, toward the room there is. So along a side edge both are vertical, and in a corner one is vertical and one sideways.
  type Dir = 'left' | 'right' | 'up' | 'down';
  const spread = $derived.by((): { l: Dir; r: Dir } => {
    const roomL = place.x, roomR = vw - place.x - barW;
    const roomU = place.y - titlebar.height, roomD = vh - place.y - barH;
    if (roomL >= SIDE_L && roomR >= SIDE_R) return { l: 'left', r: 'right' };
    const inward: Dir = roomL < SIDE_L ? 'right' : 'left';
    let l: Dir = roomU >= SIDE_L ? 'up' : inward;
    let r: Dir = roomD >= SIDE_R ? 'down' : inward;
    if (l === r) { l = 'up'; r = 'down'; }
    return { l, r };
  });
  // When a group has to change sides, it is pulled into the picture, and comes out again on the new side. `shown` is the side it is
  // drawn on; it follows `spread` after the pull-in.
  const TURN_MS = 70; // the pull-in's length in CSS: it comes out the moment it has gone in
  let shown = $state<{ l: Dir; r: Dir }>({ l: spread.l, r: spread.r });
  let pulling = $state({ l: false, r: false });
  const turns: { l?: number; r?: number } = {};
  $effect(() => {
    const want = spread;
    for (const g of ['l', 'r'] as const) {
      if (shown[g] === want[g]) {
        if (pulling[g] && turns[g] === undefined) pulling[g] = false;
        continue;
      }
      // Already on its way in: the timer below takes the side that is wanted when it fires (a drag changes `spread` all the time,
      // so the pull-in must not start over each time)
      if (pulling[g]) continue;
      pulling[g] = true;
      turns[g] = window.setTimeout(() => {
        turns[g] = undefined;
        shown[g] = untrack(() => spread[g]);
        pulling[g] = false;
      }, TURN_MS);
    }
  });
  onDestroy(() => { clearTimeout(turns.l); clearTimeout(turns.r); });

  let grab: { dx: number; dy: number; moved: boolean; id: number; pfp: boolean } | null = null;
  function dragStart(e: PointerEvent) {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || target.closest('button, a, input')) return;
    grab = { dx: e.clientX - place.x, dy: e.clientY - place.y, moved: false, id: e.pointerId, pfp: !!target.closest('.pfp') };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function dragMove(e: PointerEvent) {
    if (!grab || e.pointerId !== grab.id) return;
    const x = e.clientX - grab.dx, y = e.clientY - grab.dy;
    if (!grab.moved && Math.hypot(x - place.x, y - place.y) < 4) return;
    grab.moved = true;
    // Past the border of the app: the bar goes to a window of its own, under the pointer
    if ((e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight) && popOutBar({ x: e.screenX, y: e.screenY })) {
      // The pointer is still held: the bar's window keeps going under it, over the desktop, until it is let go
      try { if (overlay) followPointer(e.currentTarget as HTMLElement, e.pointerId, [{ name: 'libertad-overlay', w: overlay.w, dx: 28, dy: 28 }], inside => { if (inside) dockBar(); }); } catch (err) { console.warn('[popout] follow failed', err); }
      grab = null;
      drag = null;
      return;
    }
    const { minX, maxX, minY, maxY } = bounds;
    drag = { x: clamp(x, minX, maxX), y: clamp(y, minY, maxY) };
  }
  function dragEnd(e: PointerEvent) {
    if (!grab || e.pointerId !== grab.id) return;
    const was = grab;
    grab = null;
    if (!was.moved || !drag) { drag = null; if (was.pfp && !was.moved) cardOpen = !cardOpen; return; }
    // Let go where the buttons turned into the corner layout (one group vertical, one sideways): it snaps into that corner
    const sp = spread, vert = (d: Dir) => d === 'up' || d === 'down';
    if (vert(sp.l) !== vert(sp.r)) {
      const down = (vert(sp.l) ? sp.l : sp.r) === 'down';
      const toRight = (vert(sp.l) ? sp.r : sp.l) === 'left';
      dock = { edge: down ? 'top' : 'bottom', at: toRight ? 1 : 0 };
      drag = null;
      try { localStorage.setItem(DOCK, JSON.stringify(dock)); } catch { /* storage unavailable */ }
      return;
    }
    const { minX, maxX, minY, maxY } = bounds;
    const d: Record<Edge, number> = { left: drag.x - minX, right: maxX - drag.x, top: drag.y - minY, bottom: maxY - drag.y };
    const edge = (Object.keys(d) as Edge[]).reduce((a, b) => (d[b] < d[a] ? b : a));
    const horizontal = edge === 'top' || edge === 'bottom';
    const span = horizontal ? maxX - minX : maxY - minY;
    dock = { edge, at: span > 0 ? clamp(((horizontal ? drag.x - minX : drag.y - minY) / span), 0, 1) : 0 };
    drag = null;
    try { localStorage.setItem(DOCK, JSON.stringify(dock)); } catch { /* storage unavailable */ }
  }
  // The messages sit next to the bar, on the side with more room, lined up with it
  const CHAT_W = $derived(Math.min(340, vw - 32));
  const CHAT_H = $derived(Math.min(360, vh - 140));
  const chatPos = $derived.by(() => {
    const above = place.y + barH / 2 > vh / 2;
    return {
      x: clamp(place.x + barW - CHAT_W, MARGIN, vw - CHAT_W - MARGIN),
      y: clamp(above ? place.y - 8 - CHAT_H : place.y + barH + 8, titlebar.height + 8, vh - CHAT_H - 8)
    };
  });
  // A bar along the top would cover the pictures of the call, which start at the top: they begin below it
  const stageTop = $derived(dock.edge === 'top' && !drag ? place.y + barH + 8 : undefined);

  // The call's messages: a panel above the bar. They are gone when the call ends.
  let chatOpen = $state(false);
  let pickerOpen = $state(false);
  let gifOpen = $state(false);
  // A GIF goes out as its plain link; only a GIPHY picture link shows as the picture, anything else stays text
  const GIF_LINK = /^https:\/\/media\.giphy\.com\/media\/[A-Za-z0-9]+\/giphy\.gif$/;
  const isGif = (text: string) => GIF_LINK.test(text);
  async function sendGif(g: Gif) {
    failed = !(await p2p.sendChat(g.url));
    if (failed) return;
    gifs.used(g);
    gifOpen = false;
  }
  const style = $derived(store.settings.messageStyle);
  const styleName = $derived(MESSAGE_STYLES.find(m => m.id === style)?.name ?? '');
  function pickStyle(id: MessageStyle) {
    store.settings.messageStyle = id;
    store.saveSettings();
    pickerOpen = false;
  }
  let draft = $state('');
  let seen = $state(0);
  let failed = $state(false);
  let logEl = $state<HTMLDivElement>();
  const messages = $derived(p2p.chat);
  const theirs = $derived(messages.filter(m => !m.mine).length);
  const unread = $derived(chatOpen ? 0 : Math.max(0, theirs - seen));
  $effect(() => { if (chatOpen) seen = theirs; });
  $effect(() => { if (call?.state !== 'active') { chatOpen = false; pickerOpen = false; gifOpen = false; draft = ''; seen = 0; failed = false; } });
  $effect(() => {
    void messages.length;
    if (chatOpen && logEl) queueMicrotask(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; });
  });
  async function sendChat(e: Event) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    failed = !(await p2p.sendChat(text));
    if (!failed) draft = '';
  }

  let seconds = $state(0);
  $effect(() => {
    if (call?.state !== 'active') { seconds = 0; return; }
    const t0 = Date.now();
    const id = setInterval(() => { seconds = Math.floor((Date.now() - t0) / 1000); }, 1000);
    return () => clearInterval(id);
  });
  const clock = $derived(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);

  // Dragged past the border of the app, the bar becomes a small window of its own that stays over every window on the desktop
  // (the desktop app gives the window named libertad-overlay that). Its buttons are the ones that matter in a call, and one brings
  // it back into the app. It goes with the call.
  type Overlay = { w: Window; app: Record<string, unknown>; timer: ReturnType<typeof setInterval>; stopDrop: () => void; sync: MutationObserver };
  let overlay = $state.raw<Overlay | null>(null);
  const ovProps = $state({ who: '', callKey: '', clock: '', ondock: () => dockBar() });
  $effect(() => { ovProps.who = who; ovProps.callKey = call?.key ?? ''; ovProps.clock = clock; });
  function popOutBar(at: { x: number; y: number }): boolean {
    if (overlay || call?.state !== 'active') return false;
    // Just the friend's picture, like the bar in the app (the window grows while the mouse is over it, see CallOverlay)
    const S = 56;
    const w = window.open('', 'libertad-overlay', `popup,width=${S},height=${S},left=${Math.round(at.x - S / 2)},top=${Math.round(at.y - S / 2)}`);
    if (!w) return false;
    w.document.write('<!DOCTYPE html><html><head><title>Libertad call</title></head><body></body></html>');
    w.document.close();
    // It looks like the app: the app's styles and the theme set on the page
    for (const n of document.head.querySelectorAll('style, link[rel="stylesheet"]')) w.document.head.appendChild(n.cloneNode(true));
    for (const a of Array.from(document.documentElement.attributes)) w.document.documentElement.setAttribute(a.name, a.value);
    for (const a of Array.from(document.body.attributes)) w.document.body.setAttribute(a.name, a.value);
    const own = w.document.createElement('style');
    own.textContent = 'html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent !important; }';
    w.document.head.appendChild(own);
    const app = mount(CallOverlay, { target: w.document.body, props: ovProps });
    const timer = setInterval(() => { if (w.closed) dockBar(); }, 400);
    w.addEventListener('pagehide', () => dockBar());
    // The theme and the look of the panels and the rounded edges (the roundness slider) are attributes of the app's page: the pop-out
    // keeps up with them while it is out
    const sync = new MutationObserver(() => {
      try {
        const root = w.document.documentElement;
        for (const a of Array.from(document.documentElement.attributes)) if (root.getAttribute(a.name) !== a.value) root.setAttribute(a.name, a.value);
        for (const a of Array.from(root.attributes)) if (!document.documentElement.hasAttribute(a.name)) root.removeAttribute(a.name);
      } catch { /* the window is gone */ }
    });
    sync.observe(document.documentElement, { attributes: true });
    overlay = { w, app, timer, stopDrop: dockOnDrop(w, 'libertad-overlay', () => dockBar()), sync };
    cardOpen = false;
    return true;
  }
  function dockBar() {
    const o = overlay;
    if (!o) return;
    overlay = null;
    clearInterval(o.timer);
    o.sync.disconnect();
    o.stopDrop();
    try { void unmount(o.app); } catch { /* already gone */ }
    if (!o.w.closed) o.w.close();
  }
  $effect(() => { if (call?.state !== 'active') untrack(dockBar); });
  // While a call is on, the desktop app learns where this window is on the screen, to know when a pop-out is dropped on it
  $effect(() => (call?.state === 'active' ? trackAppPointer() : undefined));
  onDestroy(dockBar);

  // The "call ended" note fades after a few seconds
  let shownNote = $state('');
  $effect(() => {
    if (!note) { shownNote = ''; return; }
    shownNote = note;
    const t = setTimeout(() => { shownNote = ''; }, 4000);
    return () => clearTimeout(t);
  });
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

{#if call?.state === 'active'}<CallStage {who} top={stageTop} />{/if}

{#if cardOpen && call && !overlay}<FriendCard friendKey={call.key} onclose={() => (cardOpen = false)} />{/if}

{#if call?.state === 'active' && chatOpen && !overlay}
  <div class="callchat" class:dragging={!!drag} role="dialog" aria-label="Messages with {who}" style:left="{chatPos.x}px" style:top="{chatPos.y}px" style:width="{CHAT_W}px" style:height="{CHAT_H}px">
    <!-- Dragging the header moves the whole call overlay, and the messages with it -->
    <div class="chathead" onpointerdown={dragStart} onpointermove={dragMove} onpointerup={dragEnd} onpointercancel={dragEnd}>
      <strong>{who}</strong>
      <div class="picker">
        <button class="btn style" aria-haspopup="listbox" aria-expanded={pickerOpen} title="Message style" onclick={() => (pickerOpen = !pickerOpen)}>
          {styleName}
        </button>
        {#if pickerOpen}
          <div class="styles" role="listbox" aria-label="Message style">
            {#each MESSAGE_STYLES as m (m.id)}
              <button class="opt" class:sel={m.id === style} role="option" aria-selected={m.id === style} onclick={() => pickStyle(m.id)}>
                <span class="name">{m.name}</span>
                <span class="note">{m.note}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <button class="icon-btn close" aria-label="Close messages" title="Close" onclick={() => { chatOpen = false; pickerOpen = false; gifOpen = false; }}><Icon name="x" size={14} /></button>
    </div>
    <div class="log {style}" bind:this={logEl}>
      {#if !messages.length}<p class="empty">Messages here disappear when the call ends.</p>{/if}
      {#each messages as m, i (i)}
        {#if style === 'bubbles'}
          <div class="msg" class:mine={m.mine}>
            {#if isGif(m.text)}<img class="gif" src={m.text} alt="GIF" loading="lazy" referrerpolicy="no-referrer" />{:else}<span>{m.text}</span>{/if}
          </div>
        {:else}
          <div class="line" class:mine={m.mine}><b>{m.mine ? 'You' : who}</b>{#if isGif(m.text)}<img class="gif" src={m.text} alt="GIF" loading="lazy" referrerpolicy="no-referrer" />{:else}<span>{m.text}</span>{/if}</div>
        {/if}
      {/each}
    </div>
    {#if gifOpen}<GifPicker onpick={sendGif} onclose={() => (gifOpen = false)} />{/if}
    <form onsubmit={sendChat}>
      <button class="icon-btn gif-btn" type="button" title="GIFs" aria-label="GIFs" aria-expanded={gifOpen}
        onmousedown={e => e.preventDefault()} onclick={() => (gifOpen = !gifOpen)}><Icon name="gif" size={20} /></button>
      <input bind:value={draft} maxlength="2000" placeholder="Message {who}" autocomplete="off" aria-label="Message" />
      <button class="btn primary" type="submit" disabled={!draft.trim()} aria-label="Send" title="Send"><Icon name="send" size={16} /></button>
    </form>
    {#if failed}<p class="problem">Not sent. The connection to {who} is down.</p>{/if}
  </div>
{/if}

{#if call?.state === 'active'}
  {#if !overlay}
  <div class="bar callbar compact" role="group" aria-label="Call with {who}" class:dragging={!!drag}
    bind:clientWidth={barW} bind:clientHeight={barH} style:left="{place.x}px" style:top="{place.y}px"
    onpointerdown={dragStart} onpointermove={dragMove} onpointerup={dragEnd} onpointercancel={dragEnd}>
    <div class="side" data-dir={shown.l} class:pulling={pulling.l}>
      <button class="round" class:live={sharingNow} disabled={!sharingNow && !canShare} aria-pressed={sharingNow}
        aria-label={screenOn ? 'Stop sharing your screen' : cameraOn ? 'Stop sharing your camera' : 'Share your screen or camera'}
        title={screenOn ? 'Stop sharing your screen' : cameraOn ? 'Stop sharing your camera' : 'Share your screen or camera'}
        onclick={() => callMedia.toggle(cameraOn ? 'camera' : 'screen')}><Icon name="screen" size={20} /></button>
      <button class="round watchbtn" class:live={watchOn} class:invite={watchInvite} disabled={!watchOn && !watchInvite && !canShare} aria-pressed={watchOn}
        aria-label={watchOn ? (watchTogether.isHostWithParty ? 'End watch together' : 'Leave watch together') : watchInvite ? 'Join watch together' : 'Start a watch together'}
        title={watchOn ? (watchTogether.isHostWithParty ? 'End watch together' : 'Leave watch together') : watchInvite ? `Join watch together with ${who}` : 'Start a watch together'}
        onclick={() => callMedia.toggle('watch')}><Icon name="watch" size={20} /></button>
      <button class="round chatbtn" class:open={chatOpen} aria-label="Messages" title="Messages" onclick={() => (chatOpen = !chatOpen)}>
        <Icon name="message" size={20} />
        {#if unread}<span class="badge">{unread > 9 ? '9+' : unread}</span>{/if}
      </button>
    </div>
    <div class="pfp" role="button" tabindex="0" aria-label="Profile of {who}" title="{who} · {clock}"
      onkeydown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cardOpen = !cardOpen; } }}>
      <Avatar name={who} size={48} speaking src={p2p.avatarOf(call.key)} />
      {#if p2p.muted || p2p.deafened}<span class="state" aria-hidden="true"><Icon name={p2p.deafened ? 'headphones-off' : 'mic-off'} size={12} /></span>{/if}
      {#if unread && !chatOpen}<span class="badge">{unread > 9 ? '9+' : unread}</span>{/if}
    </div>
    <div class="side" data-dir={shown.r} class:pulling={pulling.r}>
      <button class="round" class:on={p2p.muted} aria-label={p2p.muted ? 'Unmute' : 'Mute'} title={p2p.muted ? 'Unmute' : 'Mute'} onclick={() => p2p.setMuted(!p2p.muted)}>
        <Icon name={p2p.muted ? 'mic-off' : 'mic'} size={20} />
      </button>
      <button class="round" class:on={p2p.deafened} aria-label={p2p.deafened ? 'Undeafen' : 'Deafen'} title={p2p.deafened ? 'Undeafen' : 'Deafen'} onclick={() => p2p.setDeafened(!p2p.deafened)}>
        <Icon name={p2p.deafened ? 'headphones-off' : 'headphones'} size={20} />
      </button>
      <button class="round end" aria-label="End call" title="End call" onclick={() => p2p.hangUp()}><Icon name="phone-off" size={20} /></button>
    </div>
  </div>
  {/if}
{:else if call}
  <div class="bar callbar" role="alertdialog" aria-label="Call with {who}" class:ring={call.state === 'ringing'} class:dragging={!!drag}
    bind:clientWidth={barW} bind:clientHeight={barH} style:left="{place.x}px" style:top="{place.y}px"
    onpointerdown={dragStart} onpointermove={dragMove} onpointerup={dragEnd} onpointercancel={dragEnd}>
    <Avatar name={who} size={42} src={p2p.avatarOf(call.key)} />
    <div class="text">
      <strong>{who}</strong>
      <span>{call.dir === 'in' ? 'is calling you…' : 'Calling…'}</span>
    </div>
    {#if call.dir === 'in'}
      <button class="round go" aria-label="Answer" title="Answer" onclick={() => p2p.answer()}><Icon name="phone" size={20} /></button>
      <button class="round end" aria-label="Decline" title="Decline" onclick={() => p2p.refuse()}><Icon name="phone-off" size={20} /></button>
    {:else}
      <button class="round end" aria-label="Cancel call" title="Cancel" onclick={() => p2p.hangUp()}><Icon name="phone-off" size={20} /></button>
    {/if}
  </div>
{:else if shownNote}
  <div class="bar callbar note" role="status" bind:clientWidth={barW} bind:clientHeight={barH} style:left="{place.x}px" style:top="{place.y}px">{shownNote}</div>
{/if}

<style>
  .bar {
    position: fixed; z-index: 120; max-width: calc(100vw - 32px); cursor: grab; touch-action: none; user-select: none;
    transition: left 180ms var(--ease), top 180ms var(--ease);
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    /* A panel: panel transparency, darkness and blur (Settings > Appearance) */
    background-color: color-mix(in srgb, var(--bg-2) var(--panel-solid, 100%), transparent);
    background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0)), rgb(0 0 0 / var(--panel-shade, 0)));
    backdrop-filter: blur(var(--panel-blur, 0px));
    border: 1px solid var(--line-strong); box-shadow: var(--shadow-pop);
    animation: rise 160ms var(--ease);
  }
  /* Active call: just the picture. The buttons are panels at its sides, shown while the mouse is over the bar (or the keyboard is in it; a mouse click leaves focus behind, which must not keep them open) */
  .bar.compact { padding: 4px; gap: 0; background: none; backdrop-filter: none; border: 0; box-shadow: none; }
  /* The picture's panel is drawn behind it, not by the bar itself: a blur inside a blurred parent shows nothing, and the sides must blur the page */
  .bar.compact::before {
    content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit;
    background-color: color-mix(in srgb, var(--bg-2) var(--panel-solid, 100%), transparent);
    background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0)), rgb(0 0 0 / var(--panel-shade, 0)));
    backdrop-filter: blur(var(--panel-blur, 0px));
    border: 1px solid var(--line-strong); box-shadow: var(--shadow-pop);
  }
  .pfp { position: relative; flex: none; display: flex; cursor: pointer; }
  .pfp:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .state { position: absolute; right: -4px; bottom: -4px; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--danger); color: #fff; }
  .pfp .badge { top: -4px; right: -4px; }
  .side {
    position: absolute; display: flex; align-items: center; gap: 8px; white-space: nowrap;
    background-color: color-mix(in srgb, var(--bg-2) var(--panel-solid, 100%), transparent);
    background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0)), rgb(0 0 0 / var(--panel-shade, 0)));
    backdrop-filter: blur(var(--panel-blur, 0px));
    border: 1px solid var(--line-strong); box-shadow: var(--shadow-pop);
    opacity: 0; pointer-events: none; transition: opacity 120ms var(--ease), transform 70ms ease-in;
  }
  /* Beside the picture, or above or below it; the edge toward the picture has no border so they join */
  .side[data-dir='left'], .side[data-dir='right'] { top: -1px; bottom: -1px; padding: 0 8px; }
  .side[data-dir='up'], .side[data-dir='down'] { left: -1px; right: -1px; flex-direction: column; padding: 8px 0; }
  /* Pulled into the picture (squeezed toward it), and let out again on the side it is drawn on next */
  .side[data-dir='left'] { transform-origin: 100% 50%; animation: out-l 90ms ease-out; }
  .side[data-dir='right'] { transform-origin: 0 50%; animation: out-r 90ms ease-out; }
  .side[data-dir='up'] { transform-origin: 50% 100%; animation: out-u 90ms ease-out; }
  .side[data-dir='down'] { transform-origin: 50% 0; animation: out-d 90ms ease-out; }
  .side.pulling[data-dir='left'], .side.pulling[data-dir='right'] { transform: scaleX(0); }
  .side.pulling[data-dir='up'], .side.pulling[data-dir='down'] { transform: scaleY(0); }
  @keyframes out-l { from { transform: scaleX(0); } }
  @keyframes out-r { from { transform: scaleX(0); } }
  @keyframes out-u { from { transform: scaleY(0); } }
  @keyframes out-d { from { transform: scaleY(0); } }
  @media (prefers-reduced-motion: reduce) { .side { animation: none !important; transition: opacity 120ms; } }
  .side[data-dir='left'] { right: 100%; border-right: 0; }
  .side[data-dir='right'] { left: 100%; border-left: 0; }
  .side[data-dir='up'] { bottom: 100%; border-bottom: 0; }
  .side[data-dir='down'] { top: 100%; border-top: 0; }
  .compact:hover .side, .compact:has(:focus-visible) .side, .compact.dragging .side { opacity: 1; pointer-events: auto; }
  .compact.dragging .side { pointer-events: none; }
  .bar.dragging { cursor: grabbing; transition: none; }
  .bar :global(button) { cursor: pointer; }
  .bar.ring { border-color: var(--accent); }
  .bar.note { padding: 10px 16px; color: var(--text-dim); font-size: 13px; }
  .text { min-width: 0; display: flex; flex-direction: column; line-height: 1.3; margin-right: 6px; }
  .text strong, .text span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .text span { font-size: 13px; color: var(--text-dim); }
  .round { flex: none; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--bg-3); color: var(--text); }
  .round:hover { background: var(--bg-hover); }
  .round.on { background: var(--danger); color: #fff; }
  .round:disabled { opacity: 0.4; cursor: default; }
  .round.live { background: var(--speaking); color: var(--bg-0); }
  .round.invite { animation: pulse 1.1s ease-in-out infinite; }
  .round.go { background: var(--success); color: #08210f; }
  .round.end { background: var(--danger); color: #fff; }
  .ring .round.go { animation: pulse 1.1s ease-in-out infinite; }
  .chatbtn { position: relative; }
  .chatbtn.open { background: var(--bg-hover); }
  .badge { position: absolute; top: -3px; right: -3px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--accent); color: #fff; font-size: 11px; line-height: 16px; text-align: center; }
  /* A window: it follows the window transparency and the rounded edges (glass.css, rounded.css) */
  .callchat {
    position: fixed; z-index: 120;
    display: flex; flex-direction: column; background: var(--bg-2); border: 1px solid var(--line-strong); box-shadow: var(--shadow-pop);
    animation: rise 160ms var(--ease);
    transition: left 180ms var(--ease), top 180ms var(--ease);
  }
  .callchat.dragging { transition: none; }
  .chathead { cursor: grab; touch-action: none; user-select: none; }
  .chathead :global(button) { cursor: pointer; }
  .chathead .close { flex: none; width: 24px; height: 24px; }
  .chathead .picker { margin-left: auto; }
  .log { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
  .empty { margin: auto; text-align: center; font-size: 13px; color: var(--text-faint); }
  .msg { display: flex; justify-content: flex-start; }
  .msg.mine { justify-content: flex-end; }
  .msg span { max-width: 85%; padding: 6px 10px; background: var(--bg-3); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; user-select: text; }
  .msg.mine span { background: var(--accent); color: #fff; }
  /* The GIF menu fills the panel above the message box */
  .callchat :global(.gif-menu) { left: 6px; right: 6px; top: 6px; bottom: 56px; width: auto; height: auto; }
  .gif { display: block; max-width: 100%; max-height: 180px; background: var(--bg-0); }
  .msg .gif { max-width: 85%; }
  .log.compact .gif { max-height: 100px; }
  .chathead { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px 6px 10px; border-bottom: 1px solid var(--line); font-size: 13px; }
  .chathead strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .picker { position: relative; flex: none; }
  .style { font-size: 12px; padding: 3px 8px; }
  .styles { position: absolute; z-index: 1; right: 0; top: calc(100% + 4px); min-width: 220px; display: flex; flex-direction: column; background: var(--bg-2); border: 1px solid var(--line-strong); box-shadow: var(--shadow-pop); }
  .opt { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 10px; text-align: left; background: none; color: var(--text); }
  .opt:hover { background: var(--bg-hover); }
  .opt.sel { box-shadow: inset 3px 0 0 var(--accent); }
  .opt .note { font-size: 12px; color: var(--text-dim); }
  /* Lines: the name in front, no boxes */
  .log.lines { gap: 8px; }
  .line { display: flex; flex-direction: column; font-size: 14px; line-height: 1.35; }
  .line b { font-size: 12px; font-weight: 650; color: var(--text-dim); }
  .line.mine b { color: var(--accent); }
  .line span { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  /* Compact: name and message share one line, tightly stacked */
  .log.compact { gap: 1px; padding: 6px 8px; }
  .log.compact .line { display: block; font-size: 13px; line-height: 1.35; }
  .log.compact .line b { font-size: 13px; margin-right: 2px; }
  .log.compact .line b::after { content: ':'; }
  form { display: flex; gap: 8px; padding: 8px; border-top: 1px solid var(--line); }
  form input { flex: 1; min-width: 0; }
  .problem { margin: 0; padding: 0 10px 8px; font-size: 12px; color: var(--danger); }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
  @keyframes pulse { 50% { transform: scale(1.1); } }
</style>
