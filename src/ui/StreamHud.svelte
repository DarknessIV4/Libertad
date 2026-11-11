<script lang="ts">
  import Icon from './Icon.svelte';
  import { watchTogether } from '../lib/watch-together.svelte.ts';
  import { RATES, rateLabel } from '../lib/yt-controls.ts';
  import { CAP_FPS, CAP_HEIGHTS, capFpsLabel, capHeightLabel, isCapped, type ViewerCap } from '../lib/stream-quality.ts';

  // Two small buttons in the top right corner of a picture, shown only while the mouse is over the
  // picture (or something in here has focus). cap: the viewer's own limit on the stream he receives
  // (frame rate and size, for him alone); speed: the playback speed everybody plays at, which anybody
  // can change (a streamed file).
  // Full screen and pop out only while the picture is in full screen or in a window of its own (the bar
  // above the picture has them otherwise): to leave it again.
  let { cap, speed = false, fullscreen = false, onfullscreen, popped = false, onpopout }:
    { cap: { get: () => ViewerCap; set: (c: ViewerCap) => void } | null; speed?: boolean; fullscreen?: boolean; onfullscreen: () => void; popped?: boolean; onpopout: () => void } = $props();

  let open = $state<'quality' | 'speed' | null>(null);
  let root = $state<HTMLElement>();
  const current = $derived(cap?.get() ?? { fps: 0, height: 0 });
  const rate = $derived(watchTogether.sharedRate());

  const toggle = (m: 'quality' | 'speed') => { open = open === m ? null : m; };
  // A click anywhere else closes the menu
  function outside(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) open = null;
  }
</script>

<svelte:window onpointerdown={outside} onkeydown={e => { if (e.key === 'Escape') open = null; }} />

{#if cap || speed || fullscreen || popped}
<div class="hud" class:open={!!open} bind:this={root} role="presentation" ondblclick={e => e.stopPropagation()} oncontextmenu={e => e.stopPropagation()}>
    {#if cap}
      <div class="wrap">
        <button class="ibtn" class:on={open === 'quality' || isCapped(current)} onclick={() => toggle('quality')}
          aria-label="Stream quality" aria-expanded={open === 'quality'} title="Stream quality (for you only)"><Icon name="settings" size={20} /></button>
        {#if open === 'quality'}
          <div class="menu" role="dialog" aria-label="Stream quality">
            <label class="field">Frame rate
              <select value={current.fps} onchange={e => cap.set({ ...current, fps: Number(e.currentTarget.value) })}>
                {#each CAP_FPS as v (v)}<option value={v}>{capFpsLabel(v)}</option>{/each}
              </select>
            </label>
            <label class="field">Quality
              <select value={current.height} onchange={e => cap.set({ ...current, height: Number(e.currentTarget.value) })}>
                {#each CAP_HEIGHTS as v (v)}<option value={v}>{capHeightLabel(v)}</option>{/each}
              </select>
            </label>
            <p class="hint">Only for you. The sender sends you less, and uploads less.</p>
          </div>
        {/if}
      </div>
    {/if}
    {#if speed}
      <div class="wrap">
        <button class="ibtn" class:on={open === 'speed' || rate !== 1} onclick={() => toggle('speed')}
          aria-label="Playback speed" aria-expanded={open === 'speed'} title="Playback speed (for everyone)"><Icon name="speed" size={20} /></button>
        {#if open === 'speed'}
          <div class="menu list" role="menu">
            {#each RATES as r (r)}
              <button class="item" class:on={rate === r} role="menuitemradio" aria-checked={rate === r}
                onclick={() => { watchTogether.setRate(r); open = null; }}>{rateLabel(r)}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    {#if fullscreen}<button class="ibtn" onclick={onfullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title={fullscreen ? 'Exit full screen' : 'Full screen'}><Icon name="expand" size={20} /></button>{/if}
    {#if fullscreen || popped}<button class="ibtn" class:on={popped} onclick={onpopout} aria-label={popped ? 'Bring back into the window' : 'Open in a separate window'} title={popped ? 'Bring back into the window' : 'Open in a separate window'}><Icon name="popout" size={20} /></button>{/if}
</div>
{/if}

<style>
  /* The padding is part of what the mouse has to be over: a hit area a little larger than the buttons */
  .hud { position: absolute; top: 0; right: 0; z-index: 4; display: flex; gap: 4px; padding: 8px; opacity: 0; transition: opacity 150ms; }
  /* Shown only while the mouse is over the buttons (or a menu is open, or the keyboard is on them), not
     when it moves elsewhere on the picture */
  .hud:hover, .hud.open, .hud:has(:focus-visible) { opacity: 1; }
  .wrap { position: relative; }
  .ibtn { display: flex; align-items: center; justify-content: center; padding: 5px; border: none; border-radius: 6px; background: rgba(0, 0, 0, 0.55); color: #fff; cursor: pointer; }
  .ibtn:hover, .ibtn:focus-visible { background: rgba(255, 255, 255, 0.25); }
  .ibtn.on { color: #f03; }
  .menu { position: absolute; top: 100%; right: 0; margin-top: 4px; min-width: 190px; padding: 6px; display: flex; flex-direction: column; gap: 6px; border-radius: 8px; background: rgba(20, 20, 20, 0.95); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5); color: #fff; }
  .menu.list { min-width: 110px; gap: 0; padding: 4px; }
  .field { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 2px 4px; font-size: 13px; }
  .field select { background: #222; color: #fff; border: 1px solid #444; border-radius: 5px; padding: 3px 6px; font: inherit; }
  .hint { margin: 0; padding: 2px 4px; font-size: 11px; color: rgba(255, 255, 255, 0.6); max-width: 190px; }
  .item { text-align: left; padding: 6px 10px; border: none; border-radius: 5px; background: transparent; color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .item:hover { background: rgba(255, 255, 255, 0.15); }
  .item.on { color: #f03; font-weight: 600; }
</style>
