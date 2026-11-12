<script lang="ts">
  import { untrack, onMount } from 'svelte';
  // Drag handle on one edge of a panel. `edge` is the side the handle sits on: a panel on
  // the right of the window is resized from its left edge and vice versa; a panel at the
  // bottom from its top edge and one at the top from its bottom edge (then `width` is its
  // height). The size is remembered.
  // inline: when true, the handle is a flex item instead of absolute; width still means
  // the full panel height, but the handle follows the pointer during drag.
  let { width = $bindable(), edge, min, max, initial, storageKey, label, inline = false }:
    { width: number; edge: 'left' | 'right' | 'top' | 'bottom'; min: number; max: () => number; initial: number; storageKey: string; label: string; inline?: boolean } = $props();

  let resizing = $state(false);
  // The size the user chose. A smaller window shows less of it, and it comes back when the
  // window grows again; only dragging, the keys and double-click change it.
  let chosen = untrack(() => width);

  const fit = (w: number) => Math.round(Math.max(min, Math.min(max(), w)));
  // A size kept from a bigger window (full screen) must fit the window it opens in: without this it only
  // fitted after the next resize, and a stage taller than the window pushed the chat and the panels out of place
  onMount(() => {
    width = fit(chosen);
    const raf = requestAnimationFrame(() => (width = fit(chosen)));
    return () => cancelAnimationFrame(raf);
  });
  function setWidth(w: number) {
    width = chosen = fit(w);
    try { localStorage.setItem(storageKey, String(width)); } catch { /* storage unavailable */ }
  }

  function start(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    resizing = true;
    document.body.style.userSelect = 'none';
    const box = (handle.parentElement as HTMLElement).getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    // For inline bottom handle, measure how much of the parent sits below the handle
    const below = inline && edge === 'bottom' ? box.bottom - handleRect.bottom : 0;
    const move = (ev: PointerEvent) => setWidth(edge === 'left' ? box.right - ev.clientX : edge === 'top' ? box.bottom - ev.clientY : edge === 'bottom' ? ev.clientY - box.top + below : ev.clientX - box.left);
    const up = () => {
      resizing = false;
      document.body.style.userSelect = '';
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  function onkeydown(e: KeyboardEvent) {
    const grow = edge === 'left' ? 'ArrowLeft' : edge === 'top' ? 'ArrowUp' : edge === 'bottom' ? 'ArrowDown' : 'ArrowRight';
    const shrink = edge === 'left' ? 'ArrowRight' : edge === 'top' ? 'ArrowDown' : edge === 'bottom' ? 'ArrowUp' : 'ArrowLeft';
    if (e.key === grow) setWidth(width + 16);
    else if (e.key === shrink) setWidth(width - 16);
    else return;
    e.preventDefault();
  }
</script>

<svelte:window onresize={() => (width = fit(chosen))} />

<!-- Focusable separator is the ARIA window-splitter pattern -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="resize {edge}" class:active={resizing} role="separator" aria-orientation={edge === 'top' || edge === 'bottom' ? 'horizontal' : 'vertical'} aria-label={label}
  aria-valuenow={width} aria-valuemin={min} aria-valuemax={max()} tabindex="0" title="Drag to resize, double-click to reset"
  onpointerdown={start} ondblclick={() => setWidth(initial)} {onkeydown}></div>

<style>
  .resize { position: absolute; z-index: 5; top: 0; bottom: 0; width: 8px; cursor: col-resize; touch-action: none; }
  .resize.left { left: calc(-4px - var(--rh-shift, 0px)); }
  .resize.right { right: calc(-4px - var(--rh-shift, 0px)); }
  .resize.top, .resize.bottom { left: 0; right: 0; width: auto; height: 8px; cursor: row-resize; }
  .resize.top { top: -4px; bottom: auto; }
  .resize.bottom { bottom: calc(-4px - var(--rh-shift, 0px)); top: auto; }
  .resize.top:hover, .resize.top:focus-visible, .resize.top.active,
  .resize.bottom:hover, .resize.bottom:focus-visible, .resize.bottom.active {
    background: linear-gradient(to bottom, transparent 3px, var(--accent) 3px, var(--accent) 5px, transparent 5px);
  }
  .resize:hover, .resize:focus-visible, .resize.active {
    background: linear-gradient(to right, transparent 3px, var(--accent) 3px, var(--accent) 5px, transparent 5px);
    outline: none;
  }
  .resize.inline { position: relative; flex: none; top: auto; bottom: auto; left: auto; right: auto; height: 8px; margin: -4px 0; }
</style>
