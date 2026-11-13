<script lang="ts">
  import { tip } from '../lib/tip.ts';
  import Icon from './Icon.svelte';
  import { store } from '../lib/settings.svelte.ts';
  import { sessions } from '../lib/session.svelte.ts';
  import { share } from '../lib/share.svelte.ts';
  import { watchTogether } from '../lib/watch-together.svelte.ts';

  // Cross-Room Watching, switchable while you share or host (the sharing dialog is not reachable then).
  // Lit: other rooms can watch. Off: only your own room; anybody outside is sent out at once.
  // large: the voice screen's big labelled button.
  let { large = false }: { large?: boolean } = $props();

  const on = $derived(store.settings.shareCrossRoom !== false);
  const label = $derived(on ? 'Cross-Room Watching is on: other rooms can watch. Click to allow only your room.' : 'Cross-Room Watching is off: only your room can watch. Click to allow other rooms.');

  function toggle() {
    store.settings.shareCrossRoom = !on;
    store.saveSettings();
    share.applyCrossRoom();
    for (const s of sessions.list) watchTogether.applyCrossRoom(s);
  }
</script>

<button use:tip class={large ? 'big' : 'icon-btn'} class:live={on} title={label} aria-label="Cross-Room Watching" aria-pressed={on} onclick={toggle}>
  <Icon name="globe" size={large ? 24 : 18} />
  {#if large}<span>{on ? 'Rooms: all' : 'Rooms: mine'}</span>{/if}
</button>

<style>
  button { display: flex; align-items: center; justify-content: center; color: var(--text); }
  .icon-btn { width: 30px; height: 30px; border-radius: 6px; }
  .icon-btn:hover { background: var(--bg-active); }
  .icon-btn.live { color: var(--speaking); }
  .big { width: 96px; height: 72px; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; background: var(--bg-3); }
  .big:hover { background: var(--bg-active); }
  .big.live { background: var(--speaking); color: var(--bg-0); }
</style>
