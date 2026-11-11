<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from './Modal.svelte';
  import { imageEditor, type EditScope } from '../lib/image-editor.svelte.ts';
  import { FULL, FILL, isUnchanged, renderCrop, renderFile, rotatedSize, type Crop, type EditParams } from '../lib/image-edit.ts';
  import { canEditGif, renderGif } from '../lib/gif-edit.ts';

  // Step 1: crop (drag the frame), turn 0 to 360 degrees and, for a banner, darken and blur.
  // Step 2 (when asked): where the picture goes on the profile card.
  const req = $derived(imageEditor.state);

  const STAGE_H = 300;
  const MARGIN = 14;
  const MIN_PX = 28;

  let step = $state<'edit' | 'scope'>('edit');
  let failed = $state(false);
  let busy = $state(false);
  // How far along a GIF is (0 to 1) while its frames are made, and what went wrong with one
  let progress = $state(0);
  let gifError = $state('');

  let rotation = $state(0);
  let darkness = $state(0);
  let blur = $state(0);
  let crop = $state<Crop>({ ...FULL });

  let bmp: ImageBitmap | null = null;
  // The picture cut down for the preview, so sliders stay quick with a large picture
  let proxy = $state<HTMLCanvasElement | null>(null);
  let stageW = $state(480);
  let canvas = $state<HTMLCanvasElement>();
  let result = $state<File | null>(null);
  let resultUrl = $state('');

  // A new request starts over
  $effect(() => {
    const r = req;
    untrack(() => {
      bmp?.close();
      bmp = null;
      proxy = null;
      step = 'edit';
      failed = false;
      busy = false;
      progress = 0;
      gifError = '';
      rotation = 0; darkness = 0; blur = 0;
      crop = { ...FULL };
      dropResult();
    });
    if (!r) return;
    let gone = false;
    createImageBitmap(r.file).then(b => {
      if (gone) { b.close(); return; }
      bmp = b;
      const k = Math.min(1, 1400 / Math.max(b.width, b.height));
      const p = document.createElement('canvas');
      p.width = Math.max(1, Math.round(b.width * k));
      p.height = Math.max(1, Math.round(b.height * k));
      const cx = p.getContext('2d')!;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(b, 0, 0, p.width, p.height);
      proxy = p;
    }).catch(() => { if (!gone) failed = true; });
    return () => { gone = true; };
  });

  function dropResult() {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = '';
    result = null;
  }

  // The biggest square in the middle of the turned picture (a profile picture keeps its frame square)
  function squareCrop(): Crop {
    if (!bmp) return { ...FULL };
    const box = rotatedSize(bmp.width, bmp.height, rotation);
    const side = Math.min(box.w, box.h);
    const w = side / box.w, h = side / box.h;
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }
  // Starts square once the picture is there, and again whenever it is turned
  $effect(() => {
    void rotation; void proxy;
    if (!proxy || !untrack(() => req?.square)) return;
    untrack(() => { crop = squareCrop(); });
  });

  const params = $derived<EditParams>({ rotation, crop, darkness: req?.effects ? darkness : 0, blur: req?.effects ? blur : 0 });

  // Where the turned picture sits on the stage
  const disp = $derived.by(() => {
    if (!proxy) return { x: 0, y: 0, w: 1, h: 1 };
    const box = rotatedSize(proxy.width, proxy.height, rotation);
    const f = Math.min((stageW - MARGIN * 2) / box.w, (STAGE_H - MARGIN * 2) / box.h);
    const w = box.w * f, h = box.h * f;
    return { x: (stageW - w) / 2, y: (STAGE_H - h) / 2, w, h };
  });
  const frame = $derived({ x: disp.x + crop.x * disp.w, y: disp.y + crop.y * disp.h, w: crop.w * disp.w, h: crop.h * disp.h });

  // Drawn again when anything changes, at most once a frame
  let queued = 0;
  $effect(() => {
    void params.rotation; void params.darkness; void params.blur; void params.crop.x; void params.crop.y; void params.crop.w; void params.crop.h;
    void proxy; void stageW; void step;
    if (!queued) queued = requestAnimationFrame(() => { queued = 0; draw(); });
  });
  $effect(() => () => { if (queued) cancelAnimationFrame(queued); });

  function draw() {
    const c = canvas, p = proxy;
    if (!c || !p || step !== 'edit') return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(stageW * dpr);
    c.height = Math.round(STAGE_H * dpr);
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0d0e10';
    ctx.fillRect(0, 0, stageW, STAGE_H);
    // The whole turned picture, as it is
    ctx.save();
    ctx.fillStyle = FILL;
    ctx.fillRect(disp.x, disp.y, disp.w, disp.h);
    ctx.translate(stageW / 2, STAGE_H / 2);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.imageSmoothingQuality = 'high';
    const f = disp.w / rotatedSize(p.width, p.height, rotation).w;
    ctx.drawImage(p, -p.width * f / 2, -p.height * f / 2, p.width * f, p.height * f);
    ctx.restore();
    // Dimmed outside the frame
    ctx.fillStyle = 'rgb(0 0 0 / 0.62)';
    ctx.beginPath();
    ctx.rect(0, 0, stageW, STAGE_H);
    ctx.rect(frame.x, frame.y, frame.w, frame.h);
    ctx.fill('evenodd');
    // Inside the frame: what will be made, with the darkness and blur
    const w = Math.max(1, Math.round(frame.w * dpr)), h = Math.max(1, Math.round(frame.h * dpr));
    ctx.drawImage(renderCrop({ source: p, width: p.width, height: p.height }, params, w, h), frame.x, frame.y, frame.w, frame.h);
  }

  // ─── The frame: drag it or its edges ───
  type Grab = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
  let grab: { kind: Grab; px: number; py: number; start: Crop } | null = null;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  function down(e: PointerEvent, kind: Grab) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    grab = { kind, px: e.clientX, py: e.clientY, start: { ...crop } };
  }
  function move(e: PointerEvent) {
    if (!grab) return;
    const dx = (e.clientX - grab.px) / disp.w, dy = (e.clientY - grab.py) / disp.h;
    const minW = Math.min(1, MIN_PX / disp.w), minH = Math.min(1, MIN_PX / disp.h);
    const s = grab.start;
    let { x, y, w, h } = s;
    if (grab.kind === 'move') {
      x = clamp(s.x + dx, 0, 1 - s.w);
      y = clamp(s.y + dy, 0, 1 - s.h);
    } else {
      const k = grab.kind;
      if (k.includes('w')) { x = clamp(s.x + dx, 0, s.x + s.w - minW); w = s.x + s.w - x; }
      if (k.includes('e')) { w = clamp(s.w + dx, minW, 1 - s.x); }
      if (k.includes('n')) { y = clamp(s.y + dy, 0, s.y + s.h - minH); h = s.y + s.h - y; }
      if (k.includes('s')) { h = clamp(s.h + dy, minH, 1 - s.y); }
      if (req?.square) {
        // The frame stays square: the corner or edge opposite the one held stays where it is
        let side = k.length === 2 ? Math.max(w * disp.w, h * disp.h) : (k === 'e' || k === 'w' ? w * disp.w : h * disp.h);
        const ax = k.includes('w') ? s.x + s.w : k.includes('e') ? s.x : s.x + s.w / 2;
        const ay = k.includes('n') ? s.y + s.h : k.includes('s') ? s.y : s.y + s.h / 2;
        const room = (a: number, lo: boolean, hi: boolean, size: number) => (lo ? a : hi ? 1 - a : 2 * Math.min(a, 1 - a)) * size;
        side = Math.max(MIN_PX, Math.min(side, room(ax, k.includes('w'), k.includes('e'), disp.w), room(ay, k.includes('n'), k.includes('s'), disp.h)));
        w = side / disp.w; h = side / disp.h;
        x = k.includes('w') ? ax - w : k.includes('e') ? ax : ax - w / 2;
        y = k.includes('n') ? ay - h : k.includes('s') ? ay : ay - h / 2;
      }
    }
    crop = { x, y, w, h };
  }
  function up() { grab = null; }

  const HANDLES: Grab[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  function reset() {
    gifError = '';
    rotation = 0; darkness = 0; blur = 0;
    crop = req?.square ? squareCrop() : { ...FULL };
  }
  const isGif = $derived(req?.file.type === 'image/gif');
  const changed = $derived(!isUnchanged({ rotation, crop, darkness: req?.effects ? darkness : 0, blur: req?.effects ? blur : 0 }));

  // ─── Done ───
  async function done() {
    const r = req;
    if (!r || !bmp || busy) return;
    // The picture is shown cropped later (a GIF or a video): nothing is made here
    if (r.cropOnly) { imageEditor.close({ file: r.file, crop: { ...crop } }); return; }
    busy = true;
    gifError = '';
    progress = 0;
    try {
      // Nothing changed: the picture itself, with whatever it had (transparency, its quality, a GIF's movement).
      // A GIF that was changed is made frame by frame, so it keeps moving; one with size limits is always made again.
      let file: File | null;
      if (isGif) {
        if (!changed && !(r.gif && canEditGif())) file = r.file;
        else {
          file = await renderGif(r.file, params, p => (progress = p), r.gif);
          if (!file) { gifError = 'This GIF could not be edited. Press Reset and Done to use it as it is.'; return; }
        }
      } else file = changed ? await renderFile(bmp, params, r.effects ? 1280 : 2560) : r.file;
      if (!file) { failed = true; return; }
      if (!r.scopes) { imageEditor.close({ file }); return; }
      dropResult();
      result = file;
      resultUrl = URL.createObjectURL(file);
      step = 'scope';
    } finally {
      busy = false;
    }
  }

  function choose(scope: EditScope) {
    if (result) imageEditor.close({ file: result, scope });
  }
  function close() { imageEditor.close(null); }
  $effect(() => () => dropResult());

  const SCOPES: { id: EditScope; label: string; note: string }[] = [
    { id: 'banner', label: 'Banner only', note: 'Just the strip at the top of your card' },
    { id: 'under', label: 'Under the banner', note: 'The whole space below the banner, behind your details' },
    { id: 'whole', label: 'Whole profile card', note: 'Behind the banner and everything under it' }
  ];
</script>

{#if req}
  {#if step === 'edit'}
    <Modal title={req.title ?? (req.effects ? 'Edit picture' : 'Crop picture')} onclose={close} width={540}>
      {#if failed}
        <p class="err">This file could not be read as a picture.</p>
      {:else}
        <p class="help">Drag the frame or its edges to crop. Leave the frame as it is to keep the whole picture.</p>
        {#if req.note}<p class="help">{req.note}</p>{/if}
        {#if isGif}
          <p class="help">{req.cropOnly
            ? 'This is a GIF: it keeps moving, and only the part inside the frame is shown. The preview shows its first frame.'
            : canEditGif()
              ? 'This is a GIF: the crop, turning, darkness and blur are applied to every frame, and it keeps moving. The preview shows its first frame.'
              : 'This is a GIF, and this browser cannot edit one. Leave everything as it is to keep it moving.'}</p>
        {/if}
        <div class="stage" bind:clientWidth={stageW} style:height="{STAGE_H}px">
          <canvas bind:this={canvas} style:width="{stageW}px" style:height="{STAGE_H}px"></canvas>
          {#if proxy}
            <div class="frame" role="group" aria-label="Crop frame" style:left="{frame.x}px" style:top="{frame.y}px" style:width="{frame.w}px" style:height="{frame.h}px"
              onpointerdown={e => down(e, 'move')} onpointermove={move} onpointerup={up} onpointercancel={up}>
              {#each HANDLES as h (h)}
                <span class="h {h}" role="presentation" onpointerdown={e => down(e, h)} onpointermove={move} onpointerup={up} onpointercancel={up}></span>
              {/each}
            </div>
          {:else}
            <span class="loading">Loading...</span>
          {/if}
        </div>

        <div class="sliders">
          {#if !req.cropOnly}
            <label for="ie-rot">Rotation
              <input id="ie-rot" type="range" min="0" max="360" step="1" bind:value={rotation} ondblclick={() => (rotation = 0)} />
              <output>{rotation}°</output>
            </label>
          {/if}
          {#if req.effects}
            <label for="ie-dark">Darkness
              <input id="ie-dark" type="range" min="0" max="95" step="1" bind:value={darkness} ondblclick={() => (darkness = 0)} />
              <output>{darkness}%</output>
            </label>
            <label for="ie-blur">Blurriness
              <input id="ie-blur" type="range" min="0" max="40" step="1" bind:value={blur} ondblclick={() => (blur = 0)} />
              <output>{blur} px</output>
            </label>
          {/if}
        </div>
        {#if gifError}<p class="err">{gifError}</p>{/if}
      {/if}
      {#snippet footer()}
        {#if !failed}<button class="btn reset" disabled={!changed} onclick={reset}>Reset</button>{/if}
        <button class="btn" onclick={close}>Cancel</button>
        {#if !failed}<button class="btn primary" disabled={!proxy || busy} onclick={done}>{busy ? (isGif && progress > 0 ? `Working... ${Math.round(progress * 100)}%` : 'Working...') : 'Done'}</button>{/if}
      {/snippet}
    </Modal>
  {:else}
    <Modal title="Use this picture as" onclose={close} width={540}>
      <div class="scopes" role="group" aria-label="Where to use the picture">
        {#each SCOPES as s (s.id)}
          <button class="scope" onclick={() => choose(s.id)}>
            <!-- A small card, with the picture where it will show -->
            <span class="mini" aria-hidden="true" style:background-image={s.id === 'whole' ? `url("${resultUrl}")` : undefined}>
              <span class="m-banner" class:clear={s.id === 'whole'} style:background-image={s.id === 'banner' ? `url("${resultUrl}")` : undefined}></span>
              <span class="m-body" class:clear={s.id === 'whole'} style:background-image={s.id === 'under' ? `url("${resultUrl}")` : undefined}>
                <i class="m-pic"></i><i class="m-line"></i><i class="m-line short"></i>
              </span>
            </span>
            <span class="txt"><b>{s.label}</b><small>{s.note}</small></span>
          </button>
        {/each}
      </div>
      {#snippet footer()}
        <button class="btn" onclick={() => (step = 'edit')}>Back</button>
        <button class="btn" onclick={close}>Cancel</button>
      {/snippet}
    </Modal>
  {/if}
{/if}

<style>
  .help { margin: 0 0 10px; font-size: 13px; color: var(--text-dim); }
  .err { margin: 12px 0; color: var(--danger); }
  .stage { position: relative; width: 100%; background: #0d0e10; border: 1px solid var(--line); overflow: hidden; touch-action: none; user-select: none; }
  canvas { display: block; }
  .loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-size: 13px; }
  .frame { position: absolute; box-sizing: border-box; border: 1px solid #fff; cursor: move; touch-action: none;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.5);
    background-image: linear-gradient(rgb(255 255 255 / 0.35), rgb(255 255 255 / 0.35)), linear-gradient(rgb(255 255 255 / 0.35), rgb(255 255 255 / 0.35)),
      linear-gradient(rgb(255 255 255 / 0.35), rgb(255 255 255 / 0.35)), linear-gradient(rgb(255 255 255 / 0.35), rgb(255 255 255 / 0.35));
    background-size: 1px 100%, 1px 100%, 100% 1px, 100% 1px;
    background-position: 33.33% 0, 66.66% 0, 0 33.33%, 0 66.66%;
    background-repeat: no-repeat; }
  .h { position: absolute; width: 12px; height: 12px; background: #fff; border: 1px solid rgb(0 0 0 / 0.6); box-sizing: border-box; touch-action: none; }
  .h.nw { left: -6px; top: -6px; cursor: nwse-resize; }
  .h.n { left: calc(50% - 6px); top: -6px; cursor: ns-resize; }
  .h.ne { right: -6px; top: -6px; cursor: nesw-resize; }
  .h.e { right: -6px; top: calc(50% - 6px); cursor: ew-resize; }
  .h.se { right: -6px; bottom: -6px; cursor: nwse-resize; }
  .h.s { left: calc(50% - 6px); bottom: -6px; cursor: ns-resize; }
  .h.sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
  .h.w { left: -6px; top: calc(50% - 6px); cursor: ew-resize; }
  .sliders { margin-top: 14px; }
  .sliders label { display: grid; grid-template-columns: 92px 1fr 56px; align-items: center; gap: 12px; margin: 8px 0 0; font-size: 13px; font-weight: 600; color: var(--text-dim); }
  .sliders output { text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; color: var(--text); }
  .sliders input[type=range] { width: 100%; min-width: 0; }
  .reset { margin-right: auto; }

  .scopes { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .scope { display: flex; align-items: center; gap: 14px; width: 100%; padding: 10px; text-align: left; color: var(--text);
    background: var(--bg-2, var(--bg-3)); border: 1px solid var(--line-strong); }
  .scope:hover, .scope:focus-visible { border-color: var(--accent); outline: none; background: var(--bg-hover); }
  .txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .txt b { font-size: 14px; }
  .txt small { font-size: 12px; color: var(--text-dim); }
  /* A card in miniature: banner on top, body below, the picture where it applies */
  .mini { position: relative; flex: none; display: flex; flex-direction: column; width: 72px; height: 92px; background: var(--bg-1) center / cover; border: 1px solid var(--line-strong); overflow: hidden; }
  .m-banner { flex: none; height: 30px; background: var(--bg-3); background-size: cover; background-position: center; }
  .m-body { position: relative; flex: 1; background: var(--bg-1); background-size: cover; background-position: center; padding: 18px 6px 0; }
  .m-body.clear, .m-banner.clear { background: transparent; }
  .m-pic { position: absolute; left: 6px; top: -9px; width: 18px; height: 18px; background: var(--bg-1); border: 2px solid var(--bg-1); box-shadow: inset 0 0 0 20px var(--text-faint); }
  .m-line { display: block; height: 4px; margin-top: 4px; background: var(--text-faint); opacity: 0.8; }
  .m-line.short { width: 60%; }
</style>
