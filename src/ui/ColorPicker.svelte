<script lang="ts">
  import { untrack } from 'svelte';
  import { colorPicker } from '../lib/colorpicker.svelte.ts';

  // A square for saturation and brightness, a bar for the hue, a hex field and Apply
  let h = $state(0);   // 0 to 360
  let s = $state(0);   // 0 to 1
  let v = $state(1);   // 0 to 1
  let hexText = $state('');
  let area = $state<HTMLDivElement>();

  const rgb = (hh: number, ss: number, vv: number): [number, number, number] => {
    const f = (n: number) => { const k = (n + hh / 60) % 6; return vv - vv * ss * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5), f(3), f(1)].map(x => Math.round(x * 255)) as [number, number, number];
  };
  const toHex = (hh: number, ss: number, vv: number) => '#' + rgb(hh, ss, vv).map(x => x.toString(16).padStart(2, '0')).join('');
  function fromHex(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let hh = 0;
    if (d) hh = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [hh * 60, max ? d / max : 0, max];
  }

  const hex = $derived(toHex(h, s, v));
  const initial = $derived(colorPicker.state?.initial ?? '#000000');

  // Starts on the color given
  $effect(() => {
    const st = colorPicker.state;
    if (!st) return;
    untrack(() => {
      const start = /^#[0-9a-f]{6}$/i.test(st.initial) ? st.initial.toLowerCase() : '#000000';
      [h, s, v] = fromHex(start);
      hexText = start;
    });
  });

  function changed() {
    hexText = toHex(h, s, v);
    colorPicker.state?.onpreview?.(hexText);
  }

  function pick(e: PointerEvent) {
    if (!area) return;
    const r = area.getBoundingClientRect();
    s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    changed();
  }
  function down(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pick(e);
  }
  function move(e: PointerEvent) {
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) pick(e);
  }
  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') s = Math.max(0, s - step);
    else if (e.key === 'ArrowRight') s = Math.min(1, s + step);
    else if (e.key === 'ArrowUp') v = Math.min(1, v + step);
    else if (e.key === 'ArrowDown') v = Math.max(0, v - step);
    else return;
    e.preventDefault();
    changed();
  }

  function typed(e: Event) {
    let t = (e.currentTarget as HTMLInputElement).value.trim().toLowerCase();
    hexText = t;
    if (!t.startsWith('#')) t = '#' + t;
    if (/^#[0-9a-f]{3}$/.test(t)) t = '#' + [...t.slice(1)].map(c => c + c).join('');
    if (/^#[0-9a-f]{6}$/.test(t)) {
      [h, s, v] = fromHex(t);
      colorPicker.state?.onpreview?.(t);
    }
  }
  function hexDone() { hexText = hex; }

  function apply() { colorPicker.close(hex); }
  function cancel() { colorPicker.close(null); }

  // Escape closes only the picker, not the window it was opened from
  function onkeydown(e: KeyboardEvent) {
    if (!colorPicker.state || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

{#if colorPicker.state}
  <div class="catcher" data-colorpicker role="presentation" onmousedown={cancel}></div>
  <div class="cp pop" data-colorpicker role="dialog" aria-modal="true" aria-label="Pick a color">
    <div class="sv" bind:this={area} role="slider" tabindex="0" aria-label="Saturation and brightness"
      aria-valuetext="{Math.round(s * 100)}% saturation, {Math.round(v * 100)}% brightness"
      aria-valuenow={Math.round(v * 100)} aria-valuemin="0" aria-valuemax="100"
      style:background-color="hsl({h} 100% 50%)" onpointerdown={down} onpointermove={move} onkeydown={key}>
      <span class="knob" style:left="{s * 100}%" style:top="{(1 - v) * 100}%" style:background={hex}></span>
    </div>
    <input class="hue" type="range" min="0" max="360" step="1" value={h} aria-label="Hue"
      oninput={e => { h = Number(e.currentTarget.value); changed(); }} />
    <div class="row">
      <span class="swatches" aria-hidden="true">
        <span class="swatch" style:background={initial} title="Current"></span><span class="swatch" style:background={hex} title="New"></span>
      </span>
      <input class="hex" type="text" value={hexText} maxlength="7" spellcheck="false" aria-label="Hex value"
        oninput={typed} onblur={hexDone} onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }} />
      <button class="btn primary apply" onclick={apply}>Apply</button>
    </div>
  </div>
{/if}

<style>
  .catcher { position: fixed; inset: 0; z-index: 399; background: rgb(0 0 0 / 0.35); }
  .cp {
    position: fixed; z-index: 400; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 272px; padding: 12px;
    display: flex; flex-direction: column; gap: 12px;
    background: var(--bg-1); border: 1px solid var(--line-strong); box-shadow: var(--shadow-pop); color: var(--text);
  }
  .sv {
    position: relative; height: 160px; cursor: crosshair; touch-action: none; user-select: none;
    background-image: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent);
    outline-offset: 2px;
  }
  .knob { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px rgb(0 0 0 / 0.6); pointer-events: none; }
  .hue {
    width: 100%; height: 12px; padding: 0; border: 0; margin: 0; appearance: none; -webkit-appearance: none; cursor: pointer;
    background: linear-gradient(to right, #f00, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00);
  }
  .hue::-webkit-slider-thumb { -webkit-appearance: none; width: 8px; height: 20px; background: #fff; border: 1px solid rgb(0 0 0 / 0.6); }
  .row { display: flex; align-items: center; gap: 8px; }
  .swatches { display: flex; flex: none; border: 1px solid var(--line); }
  .swatch { width: 20px; height: 28px; }
  .hex { flex: 1; min-width: 0; width: 0; font-family: var(--mono); font-size: 13px; }
  .apply { flex: none; }
</style>
