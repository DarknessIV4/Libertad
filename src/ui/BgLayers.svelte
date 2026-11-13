<script lang="ts">
  import { tick } from 'svelte';
  import CustomBg from './CustomBg.svelte';
  import { customBg, PANELS, type Panel } from '../lib/custom-bg.svelte.ts';
  import { titlebar } from '../lib/titlebar.svelte.ts';

  // The backgrounds, behind the panels (which turn see-through where one shows). The whole background is
  // one picture over the box that the left panel, the middle and the right panel make together, so each
  // panel shows its part of it; a panel's own picture covers it there. Placed from where the panels are.
  // present: which panels are on screen; watch: changes whenever they may have moved.
  let { present, watch }: { present: Record<Panel, boolean>; watch: string } = $props();

  type Box = { left: number; top: number; width: number; height: number };
  const SEL: Record<Panel, string> = { left: '.sidebar', middle: 'section.chat', right: 'aside.panel, aside.cpanel' };

  let root = $state<HTMLDivElement>();
  let boxes = $state<Record<Panel, Box | null>>({ left: null, middle: null, right: null });
  // Watches the host and the panels (a new observation reports once, so only new ones are added)
  let ro: ResizeObserver | undefined;
  const watched = new Set<Element>();

  function measure() {
    const host = root?.parentElement;
    if (!root || !host) return;
    const base = root.getBoundingClientRect();
    const next: Record<Panel, Box | null> = { left: null, middle: null, right: null };
    ro ??= new ResizeObserver(() => measure());
    const now = new Set<Element>([host]);
    for (const p of PANELS) {
      const el = present[p] ? host.querySelector(SEL[p]) : null;
      if (!el) continue;
      now.add(el);
      let r = el.getBoundingClientRect();
      // The server bar is see-through too, so the left part of the background reaches under it
      const rail = p === 'left' ? host.querySelector('nav.rail') : null;
      if (rail) {
        now.add(rail);
        const q = rail.getBoundingClientRect();
        const left = Math.min(r.left, q.left), top = Math.min(r.top, q.top);
        r = new DOMRect(left, top, Math.max(r.right, q.right) - left, Math.max(r.bottom, q.bottom) - top);
      }
      // The title bar sits above the panels: each panel's picture (and so the whole background) reaches up under the
      // part of the bar over it
      const gap = titlebar.height > 0 ? Math.max(0, r.top - base.top) : 0;
      next[p] = { left: r.left - base.left, top: r.top - base.top - gap, width: r.width, height: r.height + gap };
    }
    for (const el of watched) if (!now.has(el)) { ro.unobserve(el); watched.delete(el); }
    for (const el of now) if (!watched.has(el)) { ro.observe(el); watched.add(el); }
    boxes = next;
  }

  $effect(() => {
    void watch; void present.left; void present.middle; void present.right; void titlebar.height;
    // After the layout has settled
    tick().then(() => requestAnimationFrame(measure));
  });
  $effect(() => () => { ro?.disconnect(); watched.clear(); });

  const union = $derived.by(() => {
    const list = PANELS.map(p => boxes[p]).filter((b): b is Box => !!b);
    if (!list.length) return null;
    const left = Math.min(...list.map(b => b.left)), top = Math.min(...list.map(b => b.top));
    const right = Math.max(...list.map(b => b.left + b.width)), bottom = Math.max(...list.map(b => b.top + b.height));
    return { left, top, width: right - left, height: bottom - top };
  });
  const place = (b: Box) => `left:${b.left}px; top:${b.top}px; width:${b.width}px; height:${b.height}px`;
</script>

<svelte:window onresize={measure} />

<div class="layers" bind:this={root} aria-hidden="true">
  {#if customBg.has('whole') && union}<div class="lay" style={place(union)}><CustomBg slot="whole" /></div>{/if}
  {#each PANELS as p (p)}
    {#if customBg.has(p) && boxes[p]}<div class="lay" style={place(boxes[p]!)}><CustomBg slot={p} /></div>{/if}
  {/each}
</div>

<style>
  .layers { position: absolute; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
  .lay { position: absolute; overflow: hidden; }
</style>
