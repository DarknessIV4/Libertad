<script lang="ts">
  import { store, THEMES, type ThemeId } from '../lib/settings.svelte.ts';
  import { colorPicker } from '../lib/colorpicker.svelte.ts';
  import { CUSTOM_GROUPS, CUSTOM_KEYS, CUSTOM_DEFAULTS, customStyle, isHex, type CustomKey } from '../lib/theme.ts';
  import { customBg, type Slot } from '../lib/custom-bg.svelte.ts';
  import { applyColor, applyFile, cropBackground, removeBackground, panelColor } from '../lib/custom-bg-actions.ts';
  import { pickFile } from '../lib/pick.ts';

  const INTERFACES: { id: 'standard' | 'rooms'; name: string; note: string }[] = [
    { id: 'standard', name: 'Standard', note: 'Channel tree, chat and members side by side' },
    { id: 'rooms', name: 'Rooms', note: 'One screen at a time, made for phones. New and not complete yet' }
  ];
  function choose(id: 'standard' | 'rooms') {
    store.settings.interface = id;
    store.saveSettings();
  }

  function pick(id: ThemeId) {
    store.settings.theme = id;
    store.saveSettings();
  }

  // ─── Custom colors ───
  const colors = $derived(store.settings.customColors);

  // Shown live while choosing; kept with Apply, put back otherwise
  async function editColor(key: CustomKey) {
    const before = colors[key];
    const c = await colorPicker.open(before, v => { store.settings.customColors[key] = v; });
    if (c) setColor(key, c); else store.settings.customColors[key] = before;
  }

  function setColor(key: CustomKey, value: string) {
    if (!isHex(value)) return;
    store.settings.customColors[key] = value.toLowerCase();
    store.saveSettings();
  }

  // Hex field: applied once it is a complete color, restored on leaving it if it is not
  function hexInput(key: CustomKey, e: Event) {
    let v = (e.currentTarget as HTMLInputElement).value.trim();
    if (v && !v.startsWith('#')) v = '#' + v;
    setColor(key, v);
  }
  function hexDone(key: CustomKey, e: Event) {
    (e.currentTarget as HTMLInputElement).value = colors[key];
  }

  // Copy the colors of a built-in scheme into the custom one, to adjust from there
  let startFrom = $state('');
  function copyFrom(id: string) {
    startFrom = '';
    if (!id) return;
    const probe = document.createElement('div');
    probe.setAttribute('data-theme-preview', id);
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const next = { ...store.settings.customColors };
    for (const k of CUSTOM_KEYS) {
      const v = cs.getPropertyValue(`--${k}`).trim();
      if (isHex(v)) next[k] = v.toLowerCase();
    }
    probe.remove();
    store.settings.customColors = next;
    store.saveSettings();
  }

  // ─── Background: pictures, GIFs, videos and colors, for the whole space or for each panel ───
  const BG_ROWS: { scope: Slot; label: string; note: string }[] = [
    { scope: 'whole', label: 'Whole space', note: 'One background over the channel list, the middle and the right panel' },
    { scope: 'left', label: 'Left panel', note: 'Channel list' },
    { scope: 'middle', label: 'Middle', note: 'Chat and user cards' },
    { scope: 'right', label: 'Right panel', note: 'Members, or the chat when it sits there' }
  ];
  let bgError = $state('');

  async function bgColor(scope: Slot) {
    const start = scope === 'whole' ? (panelColor('middle') ?? colors['bg-2']) : (panelColor(scope) ?? colors[scope === 'middle' ? 'bg-2' : 'bg-1']);
    const c = await colorPicker.open(start);
    if (c) { bgError = ''; await applyColor(scope, c); }
  }
  async function bgFile(scope: Slot, accept: string) {
    const picked = await pickFile(accept);
    const f = picked && await cropBackground(picked);
    if (f) bgError = await applyFile(scope, f.file, f.crop);
  }
  // What a row has now
  function bgStatus(scope: Slot): string {
    const e = customBg.slots[scope];
    if (e.kind === 'image') return 'Picture';
    if (e.kind === 'video') return 'Video or GIF';
    if (scope === 'whole') return 'None';
    if (panelColor(scope)) return 'Color';
    return customBg.has('whole') ? 'Part of the whole background' : 'Color scheme';
  }
  const bgHasAny = (scope: Slot) => customBg.has(scope) || (scope !== 'whole' && !!panelColor(scope));

  // ─── See-through windows, buttons and panels ───
  type GlassGroup = 'window' | 'button' | 'panel';
  const GLASS: { id: GlassGroup; label: string }[] = [
    { id: 'window', label: 'Windows and menus' },
    { id: 'button', label: 'Buttons' },
    { id: 'panel', label: 'Panels' }
  ];
  const glass = (g: GlassGroup, kind: 'Transparency' | 'Darkness' | 'BlurPx'): number => (store.settings as unknown as Record<string, number>)[g + kind];
  // With Sync on, the same slider of all three moves together
  function setGlass(g: GlassGroup, kind: 'Transparency' | 'Darkness' | 'BlurPx', v: number) {
    const rec = store.settings as unknown as Record<string, number>;
    for (const x of store.settings.glassSync ? GLASS.map(y => y.id) : [g]) rec[x + kind] = v;
    store.saveSettings();
  }

  function resetCustom() {
    store.settings.customColors = { ...CUSTOM_DEFAULTS };
    store.saveSettings();
  }
</script>

<h3>Color scheme</h3>
<div class="themes" role="radiogroup" aria-label="Color scheme">
  {#each THEMES as t (t.id)}
    <button role="radio" aria-checked={store.settings.theme === t.id} class:active={store.settings.theme === t.id}
      onclick={() => pick(t.id)} aria-label={t.name}>
      <!-- A miniature of the app in that theme -->
      <span class="mini" data-theme-preview={t.id} aria-hidden="true">
        <span class="m-rail"><span></span><span></span></span>
        <span class="m-side"><i></i><i class="sel"></i><i></i></span>
        <span class="m-chat">
          <span class="m-head"></span>
          <i class="a"></i><i></i><i class="short"></i>
          <span class="m-box"></span>
        </span>
      </span>
      <span class="name">{t.name}</span>
      <span class="note">{t.note}</span>
    </button>
  {/each}
  <button role="radio" aria-checked={store.settings.theme === 'custom'} class:active={store.settings.theme === 'custom'}
    onclick={() => pick('custom')} aria-label="Custom">
    <span class="mini" style={customStyle(colors)} aria-hidden="true">
      <span class="m-rail"><span></span><span></span></span>
        <span class="m-side"><i></i><i class="sel"></i><i></i></span>
        <span class="m-chat">
          <span class="m-head"></span>
          <i class="a"></i><i></i><i class="short"></i>
          <span class="m-box"></span>
        </span>
    </span>
    <span class="name">Custom</span>
    <span class="note">Choose every color yourself</span>
  </button>
</div>

{#if store.settings.theme === 'custom'}
  <div class="custom">
    <div class="custom-bar">
      <label class="from">
        <span>Start from</span>
        <select value={startFrom} onchange={(e) => copyFrom(e.currentTarget.value)} aria-label="Copy the colors of a color scheme">
          <option value="">Choose a scheme…</option>
          {#each THEMES as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
        </select>
      </label>
      <button class="reset" onclick={resetCustom}>Reset to Dark</button>
    </div>
    {#each CUSTOM_GROUPS as g (g.title)}
      <h4>{g.title}</h4>
      <div class="colors">
        {#each g.items as c (c.key)}
          <div class="color">
            <button class="pick" style:background={colors[c.key]} aria-label="{c.label}: change color" title="Change color" onclick={() => editColor(c.key)}></button>
            <span class="label">{c.label}</span>
            <input type="text" class="hex" value={colors[c.key]} maxlength="7" spellcheck="false" aria-label="{c.label}, hex value"
              oninput={(e) => hexInput(c.key, e)} onblur={(e) => hexDone(c.key, e)} />
          </div>
        {/each}
      </div>
    {/each}

    <h4>Background</h4>
    <p class="help">A color, picture, GIF or video behind the app, for the whole space or for each panel on its own. Kept on this computer only. A picture always fills its area, and can be darkened and blurred.</p>
    <div class="bgbox">
      {#each BG_ROWS as r (r.scope)}
        {@const e = customBg.slots[r.scope]}
        <div class="bgrow">
          <div class="bghead">
            <span class="bgname">{r.label}<small>{r.note}</small></span>
            <span class="bgstatus">
              {#if r.scope !== 'whole' && panelColor(r.scope) && !customBg.has(r.scope)}<i class="sw" style:background={panelColor(r.scope)}></i>{/if}{bgStatus(r.scope)}
            </span>
          </div>
          <div class="bgbtns">
            <button onclick={() => bgColor(r.scope)}>Color…</button>
            <button onclick={() => bgFile(r.scope, 'image/png,image/jpeg,image/webp')}>Image…</button>
            <button onclick={() => bgFile(r.scope, 'video/*,image/gif')}>Video / GIF…</button>
            <button class="rm" disabled={!bgHasAny(r.scope) && !(r.scope === 'whole' && customBg.any)} onclick={() => removeBackground(r.scope)}>Remove</button>
          </div>
          {#if e.kind !== 'none'}
            <div class="bgsliders">
              <label>Darkness
                <input type="range" min="0" max="95" step="1" value={e.darkness} oninput={ev => customBg.setDarkness(r.scope, Number(ev.currentTarget.value))} ondblclick={() => customBg.setDarkness(r.scope, 0)} />
                <output>{e.darkness}%</output>
              </label>
              <label>Blur
                <input type="range" min="0" max="40" step="1" value={e.blur} oninput={ev => customBg.setBlur(r.scope, Number(ev.currentTarget.value))} ondblclick={() => customBg.setBlur(r.scope, 0)} />
                <output>{e.blur} px</output>
              </label>
            </div>
          {/if}
        </div>
      {/each}
      {#if bgError}<p class="bgerror">{bgError}</p>{/if}
    </div>
  </div>
{/if}

<h3 class="gap">Interface</h3>
<div class="themes" role="radiogroup" aria-label="Interface">
  {#each INTERFACES as f (f.id)}
    {@const on = (store.settings.interface ?? 'standard') === f.id}
    <button role="radio" aria-checked={on} class:active={on} onclick={() => choose(f.id)} aria-label={f.name}>
      <span class="mini face {f.id}" aria-hidden="true">
        {#if f.id === 'standard'}
          <span class="m-rail"><span></span><span></span></span>
          <span class="m-side"><i></i><i class="sel"></i><i></i></span>
          <span class="m-chat"><span class="m-head"></span><i class="a"></i><i></i><span class="m-box"></span></span>
        {:else}
          <span class="m-col">
            <span class="m-chat"><span class="m-head"></span><i class="a"></i><i></i><i class="short"></i></span>
            <span class="m-tabs"><i class="sel"></i><i></i><i></i><i></i></span>
          </span>
        {/if}
      </span>
      <span class="name">{f.name}</span>
      <span class="note">{f.note}</span>
    </button>
  {/each}
</div>

<h4 class="gap">Transparency</h4>
<p class="help">How much the background shows through windows and menus, buttons, and the bars and title panels. At 0% a surface is solid.</p>
<label class="check">
  <input type="checkbox" checked={store.settings.glassSync} onchange={e => { store.settings.glassSync = e.currentTarget.checked; store.saveSettings(); }} />
  Sync
</label>
<p class="help">Changing one slider changes the same slider in the other two.</p>
{#each GLASS as g (g.id)}
  <div class="round-row">
    <label for="g-{g.id}-t">{g.label}</label>
    <input id="g-{g.id}-t" type="range" min="0" max="100" step="1" value={glass(g.id, 'Transparency')}
      oninput={e => setGlass(g.id, 'Transparency', Number(e.currentTarget.value))} />
    <output for="g-{g.id}-t">{glass(g.id, 'Transparency')}%</output>
  </div>
  {#if glass(g.id, 'Transparency') > 0}
    <div class="round-row sub">
      <label for="g-{g.id}-d">Darkness</label>
      <input id="g-{g.id}-d" type="range" min="0" max="95" step="1" value={glass(g.id, 'Darkness')}
        oninput={e => setGlass(g.id, 'Darkness', Number(e.currentTarget.value))} />
      <output for="g-{g.id}-d">{glass(g.id, 'Darkness')}%</output>
    </div>
    <div class="round-row sub">
      <label for="g-{g.id}-b">Blurriness</label>
      <input id="g-{g.id}-b" type="range" min="0" max="40" step="1" value={glass(g.id, 'BlurPx')}
        oninput={e => setGlass(g.id, 'BlurPx', Number(e.currentTarget.value))} />
      <output for="g-{g.id}-b">{glass(g.id, 'BlurPx')} px</output>
    </div>
  {/if}
{/each}

<label class="check rounded">
  <input type="checkbox" checked={store.settings.rounded} onchange={e => { store.settings.rounded = e.currentTarget.checked; store.saveSettings(); }} />
  Rounded edges
</label>
<p class="help">Rounds menus, windows, server icons and user cards. Applies to both interfaces.</p>
{#if store.settings.rounded}
  <div class="round-row">
    <label for="a-round">Roundness</label>
    <input id="a-round" type="range" min="0" max="200" step="1" value={store.settings.roundness}
      oninput={e => { store.settings.roundness = Number(e.currentTarget.value); store.saveSettings(); }} />
    <output for="a-round">{store.settings.roundness}%</output>
  </div>
{/if}

<style>
  .gap { margin-top: 22px; }
  .rounded { margin-top: 16px; }
  .round-row { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
  .round-row label { margin: 0; flex: none; min-width: 120px; }
  .round-row.sub { padding-left: 16px; }
  .round-row.sub label { min-width: 104px; }
  .round-row input { flex: 1; min-width: 0; }
  .round-row output { width: 44px; text-align: right; font-size: 14px; font-variant-numeric: tabular-nums; color: var(--text-dim); }
  .help { margin: 6px 0 0; font-size: 13px; color: var(--text-dim); }
  .m-col { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .m-col .m-chat { flex: 1; }
  h3 { margin: 8px 0 0; font-size: 15px; font-weight: 650; }
  .themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; margin-top: 10px; }
  .themes > button { display: flex; flex-direction: column; gap: 2px; padding: 8px; text-align: left; border: 1px solid var(--line); background: var(--bg-0); }
  .themes > button.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .name { font-weight: 600; margin-top: 6px; }
  .note { font-size: 12px; color: var(--text-dim); }
  .mini { display: flex; height: 84px; overflow: hidden; border: 1px solid var(--line); font-family: var(--font); }
  .m-rail { width: 16%; background: var(--rail, var(--bg-0)); display: flex; flex-direction: column; align-items: center; gap: 4px; padding-top: 5px; }
  .m-rail span { width: 60%; aspect-ratio: 1; background: var(--accent); }
  .m-rail span + span { background: var(--bg-3); }
  .m-side { width: 30%; background: var(--bg-1); display: flex; flex-direction: column; gap: 5px; padding: 8px 5px; }
  .m-side i { height: 5px; background: var(--text-faint); width: 70%; }
  .m-side i.sel { background: var(--accent); width: 85%; }
  .m-chat { flex: 1; background: var(--bg-2); display: flex; flex-direction: column; gap: 5px; padding: 0 6px 6px; }
  .m-head { height: 10px; margin: 0 -6px 2px; background: var(--bg-1); border-bottom: 1px solid var(--line); }
  [data-theme-preview^="win95"] .m-head { background: var(--w-title); }
  .m-chat i { height: 4px; background: var(--text-dim); width: 80%; }
  .m-chat i.a { background: var(--accent); width: 35%; }
  .m-chat i.short { width: 55%; }
  .face.rooms .m-col { flex: 1; display: flex; flex-direction: column; }
  .m-tabs { flex: none; height: 12px; display: flex; gap: 6px; align-items: center; justify-content: center; background: var(--bg-0); border-top: 1px solid var(--line); }
  .m-tabs i { width: 10px; height: 4px; background: var(--text-faint); }
  .m-tabs i.sel { background: var(--accent); }
  .custom { margin-top: 14px; padding: 12px; border: 1px solid var(--line); background: var(--bg-0); }
  .custom h4 { margin: 14px 0 0; font-size: 13px; font-weight: 650; color: var(--text-dim); }
  .custom-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
  .from { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .reset { padding: 0 14px; border: 1px solid var(--line); color: var(--text-dim); }
  .colors { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px 14px; margin-top: 8px; }
  .color { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .color .label { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pick { width: 34px; height: 28px; padding: 0; border: 1px solid var(--line); background: transparent; cursor: pointer; flex: none; }
  .hex { width: 84px; flex: none; font-family: var(--mono); font-size: 13px; }
  .bgbox { margin-top: 8px; display: flex; flex-direction: column; border: 1px solid var(--line); background: var(--bg-1); }
  .bgrow { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .bgrow + .bgrow { border-top: 1px solid var(--line); }
  .bghead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .bgname { font-size: 14px; font-weight: 600; display: flex; flex-direction: column; min-width: 0; }
  .bgname small { font-weight: 400; font-size: 12px; color: var(--text-dim); }
  .bgstatus { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-dim); }
  .sw { display: inline-block; width: 14px; height: 14px; border: 1px solid var(--line); }
  .bgbtns { display: flex; flex-wrap: wrap; gap: 6px; }
  .bgbtns button { padding: 4px 12px; border: 1px solid var(--line); background: var(--bg-3); color: var(--text); }
  .bgbtns button:hover:not(:disabled) { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .bgbtns button:disabled { opacity: 0.45; }
  .bgsliders { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 6px 16px; }
  .bgsliders label { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 13px; color: var(--text-dim); }
  .bgsliders input { flex: 1; min-width: 0; padding: 0; border: 0; background: transparent; accent-color: var(--accent); }
  .bgsliders output { width: 44px; text-align: right; font-variant-numeric: tabular-nums; }
  .bgerror { margin: 0; padding: 8px 12px; font-size: 13px; color: var(--danger); border-top: 1px solid var(--line); }
  .m-box { margin-top: auto; height: 10px; background: var(--bg-3); border: 1px solid var(--line); }
</style>
