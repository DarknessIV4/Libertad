<script lang="ts">
  import { customBg, type Slot } from '../lib/custom-bg.svelte.ts';
  // One picture, GIF or video filling the box it is in (cropped when the shapes differ), with the
  // darkness and blur chosen for it
  let { slot }: { slot: Slot } = $props();
  const e = $derived(customBg.slots[slot]);
</script>

{#if e.kind !== 'none' && e.url}
  <div class="bg" aria-hidden="true">
    {#if e.kind === 'image'}
      <img src={e.url} alt="" draggable="false" style:filter={e.blur ? `blur(${e.blur}px)` : undefined} />
    {:else}
      <video src={e.url} autoplay loop muted playsinline disablepictureinpicture style:filter={e.blur ? `blur(${e.blur}px)` : undefined}></video>
    {/if}
    {#if e.darkness > 0}<div class="shade" style:opacity={e.darkness / 100}></div>{/if}
  </div>
{/if}

<style>
  .bg { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
  .shade { position: absolute; inset: 0; background: #000; }
  img, video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; }
</style>
