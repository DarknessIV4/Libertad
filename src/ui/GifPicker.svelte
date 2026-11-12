<script lang="ts">
  import { gifs, searchGifs, type Gif } from '../lib/gifs.svelte.ts';
  import { menu } from '../lib/menu.svelte.ts';
  import { saveImage } from '../lib/banner-actions.ts';

  let { onpick, onbackground, onusercard, onclose }: { onpick: (g: Gif) => void; onbackground: (g: Gif) => void; onusercard: (g: Gif) => void; onclose: () => void } = $props();

  type Tab = 'recent' | 'favs' | 'find';
  let tab = $state<Tab>(gifs.recent.length ? 'recent' : 'find');
  let query = $state('');
  let results = $state<Gif[]>([]);
  let error = $state('');
  let loading = $state(false);
  let root: HTMLDivElement;

  const shown = $derived(tab === 'recent' ? gifs.recent : tab === 'favs' ? gifs.favs : results);

  let page = 0;
  let more = false;
  let busy = false;
  let run = 0;

  // Search shortly after typing stops
  $effect(() => {
    const q = query.trim();
    const mine = ++run;
    page = 0; more = false; busy = false;
    if (!q) { results = []; error = ''; loading = false; return; }
    const t = setTimeout(async () => {
      loading = true; error = '';
      try {
        const r = await searchGifs(q, 0);
        if (mine !== run) return;
        results = r.gifs; more = r.more;
      } catch (e) { if (mine === run) { results = []; error = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : 'Search failed'; } }
      finally { if (mine === run) loading = false; }
    }, 400);
    return () => clearTimeout(t);
  });

  // Near the bottom of the results: the next page, without the GIFs already shown
  async function loadMore() {
    const q = query.trim(), mine = run;
    while (more && !busy && q && mine === run) {
      busy = true;
      try {
        const r = await searchGifs(q, ++page);
        if (mine !== run) return;
        const have = new Set(results.map(g => g.id));
        const fresh = r.gifs.filter(g => !have.has(g.id));
        results = [...results, ...fresh];
        more = r.more;
        if (fresh.length) return;
      } catch { more = false; }
      finally { busy = false; }
    }
  }
  function onscroll(e: Event) {
    const el = e.currentTarget as HTMLElement;
    if (tab === 'find' && el.scrollTop + el.clientHeight > el.scrollHeight - 240) loadMore();
  }

  function onwindow(e: Event) {
    if (e instanceof KeyboardEvent) { if (e.key === 'Escape') onclose(); return; }
    // Clicks on the GIF button itself are handled by the button
    if (!root.contains(e.target as Node) && !(e.target as Element).closest?.('.gif-btn')) onclose();
  }
</script>

<svelte:window onmousedown={onwindow} onkeydown={onwindow} />

<div class="gif-menu" bind:this={root} role="dialog" aria-label="GIFs">
  <input class="q" placeholder="Search all the GIFs" bind:value={query} oninput={() => (tab = 'find')} />
  <div class="tabs">
    <button class="gif-tab" class:on={tab === 'recent'} onclick={() => (tab = 'recent')}>Recent</button>
    <button class="gif-tab" class:on={tab === 'favs'} onclick={() => (tab = 'favs')}>Favourites</button>
    <button class="gif-tab" class:on={tab === 'find'} onclick={() => (tab = 'find')}>Results</button>
    {#if tab === 'recent' && gifs.recent.length}
      <button class="gif-tab clear" onclick={() => gifs.clearRecent()}>Clear Recent</button>
    {/if}
  </div>
  <div class="grid" {onscroll}>
    {#each shown as g (g.id)}
      <div class="tile" role="presentation" oncontextmenu={e => menu.show(e, [
        { label: 'Set as profile background', action: () => onbackground(g) },
        { label: 'Set as user card', action: () => onusercard(g) },
        { label: 'Save', action: () => saveImage(g.url) },
        ...(tab === 'recent' ? [{ label: 'Remove', action: () => gifs.removeRecent(g) }] : []),
        { label: gifs.isFav(g) ? 'Remove from favourites' : 'Add to favourites', action: () => gifs.toggleFav(g) }
      ])}>
        <button class="pick" onclick={() => onpick(g)} aria-label="Send this GIF"><img src={g.preview} alt="" loading="lazy" referrerpolicy="no-referrer" /></button>
        <button class="gif-tab star" class:on={gifs.isFav(g)} title={gifs.isFav(g) ? 'Remove from favourites' : 'Add to favourites'} aria-label="Favourite"
          onclick={() => gifs.toggleFav(g)}>{gifs.isFav(g) ? '★' : '☆'}</button>
      </div>
    {/each}
    {#if !shown.length}
      <p class="note">
        {#if tab === 'find'}{loading ? 'Searching…' : error || (query.trim() ? 'Nothing found' : 'Type to search GIPHY')}
        {:else if tab === 'recent'}GIFs you send show up here.
        {:else}Tap the star on a GIF to keep it here.{/if}
      </p>
    {/if}
  </div>
</div>

<style>
  .gif-menu { position: absolute; right: 16px; bottom: calc(100% + 4px); z-index: 30; width: min(420px, calc(100% - 32px)); height: min(460px, 60vh); display: flex; flex-direction: column; gap: 6px; padding: 8px; background: var(--bg-1); border: 1px solid var(--line-strong); box-shadow: var(--shadow-pop); }
  .tabs { display: flex; gap: 4px; }
  .q { padding: 6px 8px; }
  .clear { margin-left: auto; }
  .gif-tab { padding: 4px 10px; font-size: 13px; background: var(--bg-3); color: var(--text-dim); border: 1px solid var(--line); cursor: pointer; }
  .gif-tab:hover { background: var(--bg-hover); color: var(--text); }
  .gif-tab.on { color: var(--accent-hover); border-color: var(--accent); }
  .grid { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(3, 1fr); grid-auto-rows: 100px; gap: 4px; }
  .tile { position: relative; }
  .pick { display: block; width: 100%; height: 100%; padding: 0; border: 0; background: var(--bg-0); cursor: pointer; }
  .pick img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .star { position: absolute; top: 3px; right: 3px; padding: 0 6px; line-height: 20px; opacity: 0; }
  .tile:hover .star, .star.on { opacity: 1; }
  .note { grid-column: 1 / -1; margin: 12px; color: var(--text-dim); font-size: 13px; text-align: center; }
</style>
