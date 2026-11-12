<script lang="ts">
  import { store } from '../lib/settings.svelte.ts';
  import { desktop } from '../lib/native.ts';
  import { SHORTCUTS, comboOf, problemWith, setShortcut, show, shortcutState, type ShortcutId } from '../lib/shortcuts.svelte.ts';

  const s = store.settings;
  const rows = SHORTCUTS.filter(r => !r.desktopOnly || desktop);
  let message = $state('');

  function record(id: ShortcutId) {
    message = '';
    shortcutState.recording = id;
  }
  function stop() { shortcutState.recording = null; }

  // While a row is waiting, every key goes to it (the window's own handling and the dialog are off)
  $effect(() => {
    const id = shortcutState.recording;
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'keydown' || e.repeat) return;
      if (e.key === 'Escape') { stop(); return; }
      const combo = comboOf(e);
      if (!combo) return; // only modifiers so far
      const why = problemWith(combo, id);
      if (why) { message = why; return; }
      setShortcut(id, combo);
      message = '';
      stop();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  });
</script>

<h3>Keyboard shortcuts</h3>
<p class="help">Click a shortcut, then press the keys you want. Press Escape to cancel.</p>
<ul class="keys">
  {#each rows as r (r.id)}
    {@const combo = s.shortcuts[r.id]}
    {@const waiting = shortcutState.recording === r.id}
    <li>
      <span class="name">{r.label}</span>
      <button class="btn key" class:waiting onclick={() => (waiting ? stop() : record(r.id))}
        aria-label="{r.label} shortcut: {combo ? show(combo) : 'not set'}. Click to change">
        {waiting ? 'Press the keys...' : combo ? show(combo) : 'Not set'}
      </button>
      <button class="btn" disabled={!combo} onclick={() => { setShortcut(r.id, null); message = ''; }} aria-label="Remove the {r.label} shortcut" title="Remove">Clear</button>
      {#if desktop && s.shortcutsGlobal && shortcutState.refused.includes(r.id)}
        <span class="warn">Another program is using these keys, so it only works while Libertad is in front.</span>
      {/if}
    </li>
  {/each}
</ul>
{#if message}<p class="problem" role="alert">{message}</p>{/if}
<p class="help">Full screen and Pop-out act on the picture shown on the stage; while one is in full screen, the shortcut leaves it.</p>
{#if desktop}
  <label class="check"><input type="checkbox" bind:checked={s.shortcutsGlobal} onchange={() => store.saveSettings()} /> Also work when Libertad is in the background</label>
  <p class="help">The keys then belong to Libertad on the whole computer, so other programs no longer get them.</p>
  {#if s.shortcutsGlobal && shortcutState.wayland}
    <p class="help">This desktop uses Wayland, which decides for itself whether an app may listen for keys in the background, and may not offer it. The shortcuts always work while Libertad is in front.</p>
  {/if}
{/if}

<style>
  .keys { list-style: none; margin: 8px 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .keys li { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .name { width: 140px; flex: none; }
  .key { min-width: 190px; text-align: left; font-variant-numeric: tabular-nums; }
  .key.waiting { border-color: var(--accent); color: var(--accent); }
  .problem, .warn { color: var(--danger); font-size: 12px; margin: 4px 0; }
  h3 { margin: 18px 0 4px; }
</style>
