<script lang="ts">
  import { desktop } from '../lib/native.ts';
  import { titlebar } from '../lib/titlebar.svelte.ts';

  // The window's own title bar (Linux and Windows; the system bar is off, see electron/main.ts).
  // It is a panel: it follows the panel transparency, darkness and blur of Settings > Appearance, and where a
  // background picture is set (BgLayers and the start screen) the picture reaches under it. Its buttons are
  // drawn like the app's buttons (colors, transparency, darkness, blur, roundness).
  const tb = desktop?.titleBar;
  let logo = $state(true);
</script>

{#if tb && titlebar.height > 0}
  <div class="titlebar" role="presentation" style:height="{titlebar.height}px">
    <div class="brand">
      {#if logo}<img src="./favicon.svg" alt="" draggable="false" onerror={() => (logo = false)} />{/if}
    </div>
    <div class="title">Libertad</div>
    <div class="ctl">
      <button class="wbtn" aria-label="Minimize" title="Minimize" onclick={() => tb.minimize()}>
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1 5h8" /></svg>
      </button>
      <button class="wbtn" aria-label={titlebar.maximized ? 'Restore' : 'Maximize'} title={titlebar.maximized ? 'Restore' : 'Maximize'} onclick={() => tb.toggleMaximize()}>
        {#if titlebar.maximized}
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M3 3V1.5h5.5V7H7" /><rect x="1.5" y="3" width="5.5" height="5.5" /></svg>
        {:else}
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" /></svg>
        {/if}
      </button>
      <button class="wbtn close" aria-label="Close" title="Close" onclick={() => tb.close()}>
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
      </button>
    </div>
  </div>
{/if}

<style>
  /* Above the app and its menus' neighbours, under pop-up menus, the image viewer and full screen video. The
     dialogs start below it (Modal.svelte), so the buttons stay reachable. */
  .titlebar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 150;
    display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center;
    -webkit-app-region: drag; user-select: none; cursor: default;
    /* The same recipe as the panels' title bars */
    background-color: color-mix(in srgb, var(--bg-1) var(--panel-solid, 100%), transparent);
    background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0)), rgb(0 0 0 / var(--panel-shade, 0)));
    backdrop-filter: blur(var(--panel-blur, 0px));
    border-bottom: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; padding-left: 12px; min-width: 0; }
  .brand img { width: 20px; height: 20px; pointer-events: none; }
  .title { font-size: 13px; font-weight: 600; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 12px; }
  .ctl { justify-self: end; display: flex; align-items: center; gap: 6px; padding-right: 8px; -webkit-app-region: no-drag; }

  /* Drawn like .btn (app.css): same colors and states; the glass and roundness rules below mirror glass.css and rounded.css */
  .wbtn {
    -webkit-app-region: no-drag;
    display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 26px; flex: none;
    background: var(--bg-3); border: 1px solid var(--line-strong); color: var(--text);
    transition: background 120ms var(--ease), border-color 120ms var(--ease), color 120ms var(--ease);
  }
  .wbtn svg { fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; }
  .wbtn:hover { background: var(--bg-hover); border-color: color-mix(in srgb, var(--line), var(--text) 22%); }
  .wbtn:active { background: var(--bg-active); }
  .wbtn.close:hover { background: var(--danger); border-color: var(--danger); color: #fff; }

  :global(:root[data-btn-glass]) .wbtn {
    background-color: color-mix(in srgb, var(--bg-3) var(--btn-solid, 100%), transparent);
    box-shadow: inset 0 0 0 100vmax rgb(0 0 0 / var(--btn-shade, 0));
    backdrop-filter: blur(var(--btn-blur, 0px));
  }
  :global(:root[data-btn-glass]) .wbtn:hover { background-color: color-mix(in srgb, var(--bg-hover) var(--btn-solid, 100%), transparent); }
  :global(:root[data-btn-glass]) .wbtn:active { background-color: color-mix(in srgb, var(--bg-active) var(--btn-solid, 100%), transparent); }
  :global(:root[data-btn-glass]) .wbtn.close:hover { background-color: color-mix(in srgb, var(--danger) var(--btn-solid, 100%), transparent); }
  :global(:root[data-rounded]) .wbtn { border-radius: var(--r-pill) !important; }
</style>
