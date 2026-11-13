<script lang="ts">
  import { tip } from '../lib/tip.ts';
  import Icon from './Icon.svelte';
  import { store } from '../lib/settings.svelte.ts';

  // The volume of the streams you watch (one setting for all of them), in the bottom right corner of a
  // picture, in the app as well as in full screen. Invisible until the mouse is over it, like the buttons in the top right
  // (the padding is part of what the mouse has to be over: a hit area a little larger than the controls).
  const volume = $derived(store.settings.shareVolume);
  let last = 1;
  $effect(() => { if (volume > 0) last = volume; });

  const set = (v: number) => { store.settings.shareVolume = v; };
  const save = () => store.saveSettings();
  const toggleMute = () => { set(volume === 0 ? (last || 1) : 0); save(); };
</script>

<div class="corner" role="presentation" ondblclick={e => e.stopPropagation()} oncontextmenu={e => e.stopPropagation()}>
  <button use:tip class="mute" onclick={toggleMute} aria-label={volume === 0 ? 'Unmute' : 'Mute'} title={volume === 0 ? 'Unmute' : 'Mute'}>
    <Icon name={volume === 0 ? 'volume-off' : 'volume'} size={18} />
  </button>
  <input class="vol" type="range" min="0" max="1" step="0.05" value={volume} style="--pct: {volume * 100}%" aria-label="Volume"
    oninput={e => set(Number(e.currentTarget.value))} onchange={e => { save(); e.currentTarget.blur(); }} />
</div>

<style>
  .corner { position: absolute; right: 0; bottom: 0; z-index: 4; display: flex; align-items: center; gap: 10px; padding: 22px 14px 12px 28px;
    color: #fff; background: linear-gradient(to top left, rgba(0, 0, 0, 0.65), transparent 70%); opacity: 0; transition: opacity 150ms; }
  .corner:hover, .corner:has(:focus-visible) { opacity: 1; }
  .mute { display: flex; align-items: center; justify-content: center; background: transparent; border: none; padding: 3px; border-radius: 6px; color: #fff; cursor: pointer; flex: none; }
  .mute:hover, .mute:focus-visible { background: rgba(255, 255, 255, 0.2); }
  .vol { width: 90px; flex: none; -webkit-appearance: none; appearance: none; height: 14px; margin: 0; background: transparent; cursor: pointer; }
  .vol::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: linear-gradient(to right, #f03 var(--pct), rgba(255, 255, 255, 0.35) var(--pct)); }
  .vol::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; margin-top: -4.5px; border-radius: 50%; border: none; background: #f03; }
</style>
