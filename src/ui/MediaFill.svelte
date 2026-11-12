<script lang="ts">
  // A picture, GIF or video that fills its parent (a banner, a card background). paused: a GIF shows its first
  // frame and a video stops.
  import { stills } from '../lib/still.svelte.ts';
  import { isVideoMime, type BannerView } from '../core/banner.ts';

  let { view, paused = false, crop = null, class: cls = '' }: { view: BannerView | null; paused?: boolean; crop?: string | null; class?: string } = $props();

  let video = $state<HTMLVideoElement>();
  $effect(() => { if (video) { if (paused) video.pause(); else void video.play().catch(() => {}); } });
  const image = $derived(view?.kind === 'image' && !isVideoMime(view.mime) ? (paused ? stills.of(view) : view.src) : null);
</script>

{#if view?.kind === 'image'}
  {#if isVideoMime(view.mime)}
    <video bind:this={video} class={cls} src={view.src} autoplay loop muted playsinline disablepictureinpicture draggable="false" aria-hidden="true"></video>
  {:else if image}
    <img class={cls} src={image} style:object-view-box={crop ?? undefined} alt="" draggable="false" />
  {/if}
{/if}

<style>
  img, video { width: 100%; height: 100%; object-fit: cover; object-position: center; display: block; pointer-events: none; }
</style>
