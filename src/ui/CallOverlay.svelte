<script lang="ts">
  import Icon from './Icon.svelte';
  import Avatar from './Avatar.svelte';
  import { p2p } from '../lib/p2p.svelte.ts';
  import { followPointer } from '../lib/popout-follow.ts';
  import { desktop } from '../lib/native.ts';

  // The call bar as a window of its own, over every window on the desktop (opened by CallBar when it is dragged out of the app).
  // Like the bar inside the app it is just the friend's picture; the buttons come out beside it while the mouse is over it. The window
  // is the size of the picture, and grows to hold the buttons while they are out.
  let { who, callKey, clock, ondock }: { who: string; callKey: string; clock: string; ondock: () => void } = $props();

  const WINDOW = 'libertad-overlay';
  // The picture's box (CallBar opens the window this size) and the buttons' panel beside it: four buttons of 40px, three gaps of 8px,
  // 8px of padding on both ends, and a border on the far end
  const BAR = 56;
  const SIDE_W = 4 * 40 + 3 * 8 + 16 + 1;

  let frame = $state<HTMLElement>();
  let pfp = $state<HTMLElement>();
  // Whether the buttons are out, and the side of the picture they are on (the screen's edge can leave no room on the right)
  let out = $state(false);
  let side = $state<'right' | 'left'>('right');
  let dragging = false;
  let pointerIn = false;
  let busy = false;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;

  async function resize(width: number, to: 'auto' | 'left' | 'right'): Promise<'left' | 'right'> {
    try {
      if (desktop?.resizePopout) return await desktop.resizePopout(WINDOW, width, BAR, to);
      // In a browser: the window's own outer size is bigger than its page by the browser's frame
      const w = frame?.ownerDocument.defaultView;
      if (w) w.resizeTo(width + (w.outerWidth - w.innerWidth), BAR + (w.outerHeight - w.innerHeight));
    } catch (err) { console.warn('[popout] resize failed', err); }
    return to === 'left' ? 'left' : 'right';
  }
  async function show() {
    clearTimeout(leaveTimer);
    if (out || busy || dragging) return;
    busy = true;
    const s = await resize(BAR + SIDE_W, 'auto');
    busy = false;
    // The pointer went away (or took hold of the bar) while the window was growing
    if (!pointerIn || dragging) { void resize(BAR, s); return; }
    side = s;
    out = true;
  }
  function hide() {
    clearTimeout(leaveTimer);
    if (!out) return;
    out = false;
    void resize(BAR, side);
  }
  const enter = () => { pointerIn = true; void show(); };
  // A short wait before the buttons go back in, so a pointer that slips off the edge for a moment does not make the window flicker
  const leave = () => { pointerIn = false; clearTimeout(leaveTimer); leaveTimer = setTimeout(hide, 120); };
  $effect(() => () => clearTimeout(leaveTimer));

  // The bar is moved by the app itself, not by the window manager's own window drag (-webkit-app-region). A native drag gives the page
  // no events at all, so the app could only guess that it was over, from the next mouse move, and a bar let go over the app only went
  // back in after the mouse was swept over it a few times. Here the drag holds the pointer, so its pointerup is the exact moment of the
  // drop (also past the border of this window), and a drop over the app's window sends the bar back in at once.
  $effect(() => {
    const el = frame;
    if (!el) return;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element | null)?.closest?.('button')) return;
      const w = el.ownerDocument.defaultView;
      if (!w) return;
      const id = e.pointerId, sx = e.clientX, sy = e.clientY;
      try { el.setPointerCapture(id); } catch { /* the pointer is already gone */ }
      const cleanup = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      // A click on the picture is not a drag: it starts after the pointer has really moved
      const move = async (m: PointerEvent) => {
        if (m.pointerId !== id || Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
        cleanup();
        // While it is carried it is just the picture. The place that was picked up is worked out before the window shrinks around it.
        const box = pfp?.getBoundingClientRect();
        const dx = sx - (box?.left ?? 0) + 4, dy = sy - (box?.top ?? 0) + 4;
        dragging = true;
        clearTimeout(leaveTimer);
        if (out) { out = false; await resize(BAR, side); }
        followPointer(el, id, [{ name: WINDOW, w, dx, dy }], inside => {
          dragging = false;
          if (inside) ondock();
        });
      };
      const up = (u: PointerEvent) => {
        if (u.pointerId !== id) return;
        cleanup();
        try { el.releasePointerCapture(id); } catch { /* already released */ }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    el.addEventListener('pointerdown', down);
    return () => el.removeEventListener('pointerdown', down);
  });
</script>

<!-- The window's page: the picture sits at one end (where the window keeps its edge), the buttons come out toward the other -->
<div class="frame" bind:this={frame} data-dir={side} role="group" aria-label="Call with {who}"
  onpointerenter={enter} onpointermove={enter} onpointerleave={leave}>
  <!-- The same classes as the bar inside the app: the panel settings (Appearance) and the roundness slider (rounded.css) reach it -->
  <div class="bar callbar compact">
    <div class="pfp" bind:this={pfp} role="presentation" title="{who} · {clock}">
      <Avatar name={who} size={48} speaking src={p2p.avatarOf(callKey)} />
      {#if p2p.muted || p2p.deafened}<span class="state" aria-hidden="true"><Icon name={p2p.deafened ? 'headphones-off' : 'mic-off'} size={12} /></span>{/if}
    </div>
    {#if out}
      <div class="side" data-dir={side}>
        <button class="round" class:on={p2p.muted} aria-label={p2p.muted ? 'Unmute' : 'Mute'} title={p2p.muted ? 'Unmute' : 'Mute'} onclick={() => p2p.setMuted(!p2p.muted)}>
          <Icon name={p2p.muted ? 'mic-off' : 'mic'} size={20} />
        </button>
        <button class="round" class:on={p2p.deafened} aria-label={p2p.deafened ? 'Undeafen' : 'Deafen'} title={p2p.deafened ? 'Undeafen' : 'Deafen'} onclick={() => p2p.setDeafened(!p2p.deafened)}>
          <Icon name={p2p.deafened ? 'headphones-off' : 'headphones'} size={20} />
        </button>
        <button class="round end" aria-label="End call" title="End call" onclick={() => p2p.hangUp()}><Icon name="phone-off" size={20} /></button>
        <button class="round" aria-label="Back into the app" title="Back into the app" onclick={ondock}><Icon name="popout" size={18} /></button>
      </div>
    {/if}
  </div>
</div>

<style>
  .frame { position: relative; width: 100vw; height: 100vh; overflow: hidden; user-select: none; cursor: grab; touch-action: none; }
  .bar {
    position: absolute; z-index: 0; top: 0; width: 56px; height: 56px; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
    padding: 4px; background: none; border: 0;
  }
  .frame[data-dir='right'] .bar { left: 0; }
  .frame[data-dir='left'] .bar { right: 0; }
  /* The picture's panel is drawn behind it (as in the app): a blur inside a blurred parent shows nothing, and the side must blur the page */
  .bar::before {
    content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit;
    background-color: color-mix(in srgb, var(--bg-2) var(--panel-solid, 100%), transparent);
    background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0)), rgb(0 0 0 / var(--panel-shade, 0)));
    backdrop-filter: blur(var(--panel-blur, 0px));
    border: 1px solid var(--line-strong);
  }
  .pfp { position: relative; flex: none; display: flex; }
  .state { position: absolute; right: -4px; bottom: -4px; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--danger); color: #fff; }
  .side {
    position: absolute; top: 0; bottom: 0; display: flex; align-items: center; gap: 8px; padding: 0 8px; white-space: nowrap; color: var(--text);
    background-color: color-mix(in srgb, var(--bg-2) var(--panel-solid, 100%), transparent);
    background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0)), rgb(0 0 0 / var(--panel-shade, 0)));
    backdrop-filter: blur(var(--panel-blur, 0px));
    border: 1px solid var(--line-strong);
  }
  /* Beside the picture, the edge toward it has no border so they join */
  .side[data-dir='right'] { left: 100%; border-left: 0; }
  .side[data-dir='left'] { right: 100%; border-right: 0; flex-direction: row-reverse; }
  button { cursor: pointer; }
  .round { flex: none; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--bg-3); color: var(--text); border: 0; padding: 0; }
  .round:hover { background: var(--bg-hover); }
  .round.on { background: var(--danger); color: #fff; }
  .round.end { background: var(--danger); color: #fff; }
</style>
