<script lang="ts">
  import Icon from './Icon.svelte';
  import { watchTogether } from '../lib/watch-together.svelte.ts';
  import { session } from '../lib/session.svelte.ts';
  import { ui } from '../lib/ui.svelte.ts';
  import { menu } from '../lib/menu.svelte.ts';
  import { store } from '../lib/settings.svelte.ts';

  // Control bar for watch together - shows at the bottom of the video when a watch party is active (YouTube mode with playlist)
  let { always = false }: { always?: boolean } = $props();

  const party = $derived(watchTogether.party);
  const isWatching = $derived(watchTogether.isWatching);
  const hasActiveParty = $derived(watchTogether.hasActiveParty);
  const isHost = $derived(watchTogether.isHost);
  const mode = $derived(watchTogether.mode);
  const meta = $derived(watchTogether.meta);
  const playlist = $derived(watchTogether.playlist);
  const currentIndex = $derived(watchTogether.currentIndex);
  const currentVideo = $derived(watchTogether.currentVideo);

  let showControls = $state(true);
  let showPlaylist = $state(false);

  function skipPrevious() {
    if (mode === 1 && currentIndex > 0) {
      watchTogether.skipPrevious();
    }
  }

  function skipNext() {
    if (mode === 1 && currentIndex < playlist.length - 1) {
      watchTogether.skipNext();
    }
  }

  function playVideo(index: number) {
    watchTogether.setCurrentIndex(index);
    showPlaylist = false;
  }

  function openPlaylist() {
    showPlaylist = !showPlaylist;
  }

  function formatTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  }
</script>

{#if isWatching && mode === 1 && playlist.length > 1}
<div class="watch-bar" onmouseenter={() => (showControls = true)} onmouseleave={() => (showControls = false)}>
  <div class="left">
    <span class="title">{currentVideo?.title || meta?.title || 'Watch Together'}</span>
    <button class="icon-btn playlist-toggle" onclick={openPlaylist} aria-label={showPlaylist ? 'Close playlist' : 'Open playlist'} title={showPlaylist ? 'Close playlist' : 'Open playlist'}>
      <Icon name="menu" size={18} />
    </button>
  </div>

  <div class="right">
    <div class="controls">
      {#if currentIndex > 0}
      <button class="icon-btn" onclick={skipPrevious} aria-label="Previous video" title="Previous video">
        <Icon name="skip-previous" size={18} />
      </button>
      {/if}

      <button class="icon-btn play-pause" onclick={() => watchTogether.play()} aria-label={watchTogether.playing ? 'Pause' : 'Play'} title={watchTogether.playing ? 'Pause' : 'Play'}>
        <Icon name={watchTogether.playing ? 'pause' : 'play'} size={20} />
      </button>

      {#if currentIndex < playlist.length - 1}
      <button class="icon-btn" onclick={skipNext} aria-label="Next video" title="Next video">
        <Icon name="skip-next" size={18} />
      </button>
      {/if}
    </div>
  </div>

  {#if showPlaylist && playlist.length > 0}
  <div class="playlist-panel">
    <div class="playlist-header">
      <span>Playlist ({playlist.length})</span>
      <button class="icon-btn" onclick={openPlaylist} aria-label="Close playlist">
        <Icon name="x" size={16} />
      </button>
    </div>
    <ul class="playlist">
      {#each playlist as video, i (video.id)}
      <li class:current={i === currentIndex} class:playing={i === currentIndex && watchTogether.playing}>
        <button class="playlist-item" onclick={() => playVideo(i)} aria-label="Play {video.title}">
          <span class="index">{i + 1}</span>
          <span class="video-title">{video.title}</span>
          {#if i === currentIndex && watchTogether.playing}
          <Icon name="pause" size={14} />
          {:else if i === currentIndex}
          <Icon name="play" size={14} />
          {/if}
        </button>
      </li>
      {/each}
    </ul>
  </div>
  {/if}
</div>
{/if}

<style>
  .watch-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    background: var(--bg-1);
    border-top: 1px solid var(--border);
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 10;
  }
  .left {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }
  .title {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
    color: var(--text);
    font-weight: 500;
  }
  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    padding: 6px;
    border-radius: 6px;
    color: var(--text-dim);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    flex-shrink: 0;
  }
  .icon-btn:hover, .icon-btn:focus-visible {
    background: var(--bg-2);
    color: var(--text);
  }
  .playlist-toggle:hover, .playlist-toggle:focus-visible {
    background: var(--accent);
    color: var(--accent-text);
  }
  .play-pause {
    background: var(--accent);
    color: var(--accent-text);
    width: 36px;
    height: 36px;
    border-radius: 18px;
    padding: 0;
  }
  .play-pause:hover, .play-pause:focus-visible {
    filter: brightness(1.1);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .playlist-panel {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    max-height: 300px;
    overflow-y: auto;
    z-index: 20;
    margin-bottom: 4px;
  }
  .playlist-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .playlist {
    list-style: none;
    margin: 0;
    padding: 4px 0;
  }
  .playlist-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
    font-size: 12px;
  }
  .playlist-item:hover {
    background: var(--bg-2);
  }
  .playlist li.current .playlist-item {
    background: var(--accent-bg);
  }
  .playlist li.current.playing .playlist-item {
    background: var(--accent);
    color: var(--accent-text);
  }
  .playlist li.current .playlist-item .index,
  .playlist li.current.playing .playlist-item .index {
    color: inherit;
    opacity: 0.8;
  }
  .index {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>