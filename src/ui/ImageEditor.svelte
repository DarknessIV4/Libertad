<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { imageEditor, type EditScope, type BgTarget, type AppScope } from '../lib/image-editor.svelte.ts';
  import { FULL, FILL, CARD_WIDTH, isUnchanged, renderCrop, renderFile, rotatedSize, type Crop, type EditParams } from '../lib/image-edit.ts';
  import { canEditGif, renderGif } from '../lib/gif-edit.ts';

  // Step 1: crop (drag the frame), turn 0 to 360 degrees and, for a banner, darken and blur.
  // Step 2 (when asked): where the picture goes on the profile card.
  const req = $derived(imageEditor.state);

  const STAGE_H = 300;
  const MARGIN = 14;
  const MIN_PX = 28;
  // The profile card as it really is: 320 wide, the banner 128 high
  const CARD_H = 410, BANNER_H = 128;

  // Where the picture goes on the profile card (asked in the editor when EditOptions.scopes is on); none until chosen
  let scope = $state<EditScope | null>(null);
  // App background or login background (EditOptions.target)
  let bgTarget = $state<BgTarget | null>(null);
  let appPanel = $state<AppScope>('whole');
  // The canvases of the previews (one, or two for both)
  let tc = $state<Record<number, HTMLCanvasElement | undefined>>({});
  let failed = $state(false);
  let busy = $state(false);
  // How far along a GIF is (0 to 1) while its frames are made, and what went wrong with one
  let progress = $state(0);
  let gifError = $state('');

  let rotation = $state(0);
  let flipH = $state(false);
  let flipV = $state(false);
  let darkness = $state(0);
  let blur = $state(0);
  let crop = $state<Crop>({ ...FULL });

  let bmp: ImageBitmap | null = null;
  // The picture cut down for the preview, so sliders stay quick with a large picture
  let proxy = $state<HTMLCanvasElement | null>(null);
  let stageW = $state(480);
  let canvas = $state<HTMLCanvasElement>();
  // The profile card shown beside the crop (see EditOptions.preview): the picture is drawn on this
  let pcanvas = $state<HTMLCanvasElement>();

  // A new request starts over
  $effect(() => {
    const r = req;
    untrack(() => {
      bmp?.close();
      bmp = null;
      proxy = null;
      scope = r?.preview ?? null;
      bgTarget = r?.target ? 'app' : null;
      appPanel = r?.appScope ?? 'whole';
      failed = false;
      busy = false;
      progress = 0;
      gifError = '';
      rotation = 0; flipH = false; flipV = false; darkness = 0; blur = 0;
      crop = { ...FULL };
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

  const params = $derived<EditParams>({ rotation, flipH, flipV, crop, darkness: req?.effects ? darkness : 0, blur: req?.effects ? blur : 0 });

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
    void params.rotation; void flipH; void flipV; void params.darkness; void params.blur; void params.crop.x; void params.crop.y; void params.crop.w; void params.crop.h;
    void proxy; void stageW; void pcanvas; void scope; void tc[0]; void tc[1]; void bgTarget; void appPanel;
    if (!queued) queued = requestAnimationFrame(() => { queued = 0; draw(); });
  });
  $effect(() => () => { if (queued) cancelAnimationFrame(queued); });

  function draw() {
    const c = canvas, p = proxy;
    if (!c || !p) return;
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
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
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
    drawPreview(p);
    drawTarget(p);
  }

  // The crop as the card would show it: it fills the banner, the space under it or the whole card, cut to fit
  function drawPreview(p: HTMLCanvasElement) {
    const pc = pcanvas, sc = scope;
    if (!pc || !sc) return;
    const h = sc === 'banner' ? BANNER_H : sc === 'under' ? CARD_H - BANNER_H : CARD_H;
    const dpr = window.devicePixelRatio || 1;
    pc.width = Math.round(CARD_WIDTH * dpr);
    pc.height = Math.round(h * dpr);
    const ctx = pc.getContext('2d')!;
    const box = rotatedSize(p.width, p.height, rotation);
    const cw = Math.max(1, crop.w * box.w), ch = Math.max(1, crop.h * box.h);
    // The size it is shown at: as small as fills the area
    const s = Math.max(CARD_WIDTH / cw, h / ch);
    const dw = cw * s, dh = ch * s;
    const k = Math.min(1, 2400 / Math.max(dw, dh));
    const out = renderCrop({ source: p, width: p.width, height: p.height }, params, Math.max(1, Math.round(dw * dpr * k)), Math.max(1, Math.round(dh * dpr * k)));
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(out, (CARD_WIDTH - dw) / 2 * dpr, (h - dh) / 2 * dpr, dw * dpr, dh * dpr);
  }

  // The crop as the app or the login screen would show it: it fills the window (or the one panel), cut to fit
  const TGT_W = 320, TGT_H = 180;
  type Preview = { kind: 'app' | 'login'; scope: AppScope };
  const previews = $derived.by((): Preview[] => bgTarget === 'both' ? [{ kind: 'app', scope: 'whole' }, { kind: 'login', scope: 'whole' }]
    : bgTarget === 'login' ? [{ kind: 'login', scope: 'whole' }] : bgTarget === 'app' ? [{ kind: 'app', scope: appPanel }] : []);
  // The panels of the mock-up, as fractions of the width (the same as in the markup below)
  const REGION: Record<AppScope, [number, number]> = { whole: [0, 1], left: [0, 0.22], middle: [0.22, 0.76], right: [0.76, 1] };
  function drawTarget(p: HTMLCanvasElement) {
    previews.forEach((pv, i) => {
      const bc = tc[i];
      if (!bc) return;
      const dpr = window.devicePixelRatio || 1;
      bc.width = Math.round(TGT_W * dpr);
      bc.height = Math.round(TGT_H * dpr);
      const ctx = bc.getContext('2d')!;
      ctx.fillStyle = '#16171a';
      ctx.fillRect(0, 0, bc.width, bc.height);
      const [a, b] = pv.kind === 'app' ? REGION[pv.scope] : REGION.whole;
      const rx = a * TGT_W, rw = (b - a) * TGT_W;
      const box = rotatedSize(p.width, p.height, rotation);
      const cw = Math.max(1, crop.w * box.w), ch = Math.max(1, crop.h * box.h);
      const s = Math.max(rw / cw, TGT_H / ch);
      const dw = cw * s, dh = ch * s;
      const out = renderCrop({ source: p, width: p.width, height: p.height }, params, Math.max(1, Math.round(dw * dpr)), Math.max(1, Math.round(dh * dpr)));
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx * dpr, 0, rw * dpr, TGT_H * dpr);
      ctx.clip();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(out, (rx + (rw - dw) / 2) * dpr, (TGT_H - dh) / 2 * dpr, dw * dpr, dh * dpr);
      ctx.restore();
    });
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
    rotation = 0; flipH = false; flipV = false; darkness = 0; blur = 0;
    crop = req?.square ? squareCrop() : { ...FULL };
  }
  const isGif = $derived(req?.file.type === 'image/gif');
  const changed = $derived(!isUnchanged({ rotation, flipH, flipV, crop, darkness: req?.effects ? darkness : 0, blur: req?.effects ? blur : 0 }));

  // ─── Done ───
  async function done() {
    const r = req;
    if (!r || !bmp || busy) return;
    // The picture is shown cropped later (a GIF or a video): nothing is made here
    if (r.cropOnly) { imageEditor.close({ file: r.file, crop: { ...crop }, ...(bgTarget && { target: bgTarget, appScope: appPanel }) }); return; }
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
      imageEditor.close({ file, ...(scope && { scope }), ...(bgTarget && { target: bgTarget, appScope: appPanel }) });
    } finally {
      busy = false;
    }
  }

  function close() { imageEditor.close(null); }
  // The places on the profile card the picture can go
  const SCOPES: { id: EditScope; label: string }[] = [
    { id: 'banner', label: 'Banner' },
    { id: 'under', label: 'Lower half' },
    { id: 'whole', label: 'Whole card' }
  ];
  // Where to ask (in the editor) and where the card is shown
  const asks = $derived(!!req?.scopes && !req?.cropOnly);
</script>

{#if req}
    <Modal title={req.title ?? (req.effects ? 'Edit picture' : 'Crop picture')} onclose={close} width={asks || req.preview || req.target ? 930 : 540}>
      {#if failed}
        <p class="err">This file could not be read as a picture.</p>
      {:else}
        <div class="split">
        <div class="main">
        {#if !asks}<p class="help">Drag the frame or its edges to crop. Leave the frame as it is to keep the whole picture.</p>{/if}
        {#if req.note}<p class="help">{req.note}</p>{/if}
        {#if isGif}
          <p class="help">{req.cropOnly
            ? 'This is a GIF: it keeps moving, and only the part inside the frame is shown. The preview shows its first frame.'
            : canEditGif()
              ? 'This is a GIF: the crop, turning, darkness and blur are applied to every frame, and it keeps moving. The preview shows its first frame.'
              : 'This is a GIF, and this browser cannot edit one. Leave everything as it is to keep it moving.'}</p>
        {/if}
        {#if asks}
          <div class="where" role="radiogroup" aria-label="Where to use the picture">
            {#each SCOPES as sc (sc.id)}
              <button class="btn" class:on={scope === sc.id} role="radio" aria-checked={scope === sc.id} onclick={() => (scope = sc.id)}>{sc.label}</button>
            {/each}
          </div>
        {/if}
        {#if req.target}
          <div class="where" role="radiogroup" aria-label="Where to use the picture">
            {#each [['app', 'App background'], ['login', 'Login background'], ['both', 'Both']] as [id, label] (id)}
              <button class="btn" class:on={bgTarget === id} role="radio" aria-checked={bgTarget === id} onclick={() => (bgTarget = id as BgTarget)}>{label}</button>
            {/each}
          </div>
          {#if bgTarget === 'app'}
            <div class="where sub" role="radiogroup" aria-label="Which part of the app">
              {#each [['left', 'Left'], ['middle', 'Middle'], ['right', 'Right'], ['whole', 'All']] as [id, label] (id)}
                <button class="btn" class:on={appPanel === id} role="radio" aria-checked={appPanel === id} onclick={() => (appPanel = id as AppScope)}>{label}</button>
              {/each}
            </div>
          {/if}
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
            <div class="flips">
              <button class="btn icon" class:on={flipH} title="Mirror horizontally" aria-label="Mirror horizontally" aria-pressed={flipH} onclick={() => (flipH = !flipH)}><Icon name="flip-h" size={18} /></button>
              <button class="btn icon" class:on={flipV} title="Mirror vertically" aria-label="Mirror vertically" aria-pressed={flipV} onclick={() => (flipV = !flipV)}><Icon name="flip-v" size={18} /></button>
            </div>
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
        </div>
        {#if req.target && bgTarget}
          <div class="side">
            {#each previews as pv, i (pv.kind)}
              <p class="help">{pv.kind === 'login' ? 'Login background' : pv.scope === 'whole' ? 'App background' : `App background, ${pv.scope} panel`}: how it will look</p>
              <div class="tcard" aria-hidden="true" style:width="{TGT_W}px" style:height="{TGT_H}px">
                <canvas bind:this={tc[i]} style:width="{TGT_W}px" style:height="{TGT_H}px"></canvas>
                {#if pv.kind === 'app'}
                  <div class="tapp">
                    <div class="tpanel left"><i></i><i></i><i></i><i></i></div>
                    <div class="tpanel mid"><i class="wide"></i><i></i><i class="wide"></i><i></i><span class="tbar"></span></div>
                    <div class="tpanel right"><i></i><i></i><i></i></div>
                  </div>
                {:else}
                  <div class="tlogin">
                    <div class="lrail"><b></b><b class="plus"></b><b class="globe"></b><b class="end"></b></div>
                    <div class="lhead"><i class="title"></i><i class="sub"></i></div>
                    <div class="lpills"><i class="p1"></i><i class="p2"></i><i class="p3"></i></div>
                    <div class="lcard"><b></b><span><i class="n"></i><i class="u"></i><i class="o"></i></span><em></em></div>
                    <div class="lbar"><span><i class="n"></i><i class="u"></i></span><b></b><b></b><b></b><b></b></div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        {#if asks || req.preview}
          <div class="side">
            <p class="help">{scope === 'banner' ? 'Banner' : scope === 'under' ? 'Lower half' : scope === 'whole' ? 'Whole profile card' : 'Choose where it goes'}{scope ? ': how it will look' : ' to see how it looks'}</p>
            <div class="pcard" class:over={scope && scope !== 'banner'} aria-hidden="true" style:height="{CARD_H}px">
              {#if scope}
                <canvas bind:this={pcanvas} class="pfill" style:top="{scope === 'under' ? BANNER_H : 0}px" style:width="{CARD_WIDTH}px" style:height="{scope === 'banner' ? BANNER_H : scope === 'under' ? CARD_H - BANNER_H : CARD_H}px"></canvas>
              {/if}
              <div class="pbanner" style:height="{BANNER_H}px"></div>
              <i class="ppic"></i>
              <div class="pbody">
                <i class="pl name"></i><i class="pl sub"></i>
                <div class="pbox"><i class="pl"></i><i class="pl short"></i><i class="pl"></i></div>
                <div class="pbtns"><i></i><i></i></div>
              </div>
            </div>
          </div>
        {/if}
        </div>
      {/if}
      {#snippet footer()}
        {#if !failed}<button class="btn reset" disabled={!changed} onclick={reset}>Reset</button>{/if}
        <button class="btn" onclick={close}>Cancel</button>
        {#if !failed}<button class="btn primary" disabled={!proxy || busy || (asks && !scope)} onclick={done}>{busy ? (isGif && progress > 0 ? `Working... ${Math.round(progress * 100)}%` : 'Working...') : 'Done'}</button>{/if}
      {/snippet}
    </Modal>
{/if}

<style>
  /* The crop on the left, the card it will be on to the right (below it when the window is narrow) */
  .split { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
  .main { flex: 1 1 440px; min-width: 0; }
  .side { flex: none; width: 320px; max-width: 100%; }
  .pcard { position: relative; width: 320px; max-width: 100%; box-sizing: border-box; overflow: hidden; background: var(--bg-1); border: 1px solid var(--line-strong); }
  .pfill { position: absolute; left: 0; max-width: none; }
  .pbanner { position: relative; }
  .ppic { position: absolute; left: 14px; top: 20px; width: 88px; height: 88px; box-sizing: border-box; background: var(--text-faint); border: 4px solid var(--bg-1); }
  .pbody { position: relative; padding: 52px 16px 16px; }
  .pl { display: block; height: 8px; margin-top: 8px; background: var(--text-faint); opacity: 0.7; }
  .pl.name { width: 100px; height: 14px; margin-top: 0; opacity: 0.9; }
  .pl.sub { width: 70px; }
  .pl.short { width: 55%; }
  .pbox { margin-top: 18px; padding: 10px 12px 14px; height: 110px; box-sizing: border-box; background: rgb(0 0 0 / 0.28); }
  .pbtns { display: flex; gap: 8px; margin-top: 16px; }
  .pbtns i { display: block; width: 90px; height: 28px; background: var(--bg-3); }
  .pcard.over .pbtns i { background: rgb(0 0 0 / 0.35); }
  .tcard { position: relative; max-width: 100%; overflow: hidden; background: var(--bg-1); border: 1px solid var(--line-strong); box-sizing: content-box; }
  .tcard canvas { position: absolute; inset: 0; }
  .tapp { position: absolute; inset: 0; display: flex; }
  .tpanel { position: relative; box-sizing: border-box; padding: 10px 8px; background: rgb(0 0 0 / 0.38); }
  .tpanel.left { width: 22%; } .tpanel.right { width: 24%; } .tpanel.mid { flex: 1; background: rgb(0 0 0 / 0.22); margin: 0 1px; }
  .tpanel i { display: block; height: 6px; margin-bottom: 8px; width: 70%; background: var(--text-faint); opacity: 0.7; }
  .tpanel i.wide { width: 90%; }
  .tbar { position: absolute; left: 8px; right: 8px; bottom: 8px; height: 16px; background: rgb(0 0 0 / 0.4); }
  .tlogin { position: absolute; inset: 0; }
  .tlogin i, .tlogin b, .tlogin em { display: block; background: var(--text-faint); opacity: 0.75; }
  .lrail { position: absolute; left: 2.5%; top: 4%; bottom: 4%; width: 5%; background: rgb(0 0 0 / 0.45); border-radius: 6px; display: flex; flex-direction: column; align-items: center; gap: 6px; padding-top: 6px; box-sizing: border-box; }
  .lrail b { width: 8px; height: 8px; border-radius: 50%; }
  .lrail b.plus, .lrail b.globe { background: #3fbf6a; opacity: 0.8; }
  .lrail b.end { margin-top: auto; margin-bottom: 6px; border-radius: 1px; height: 6px; }
  .lhead { position: absolute; left: 11%; top: 8%; }
  .lhead .title { width: 36px; height: 8px; margin-bottom: 5px; opacity: 0.95; }
  .lhead .sub { width: 44px; height: 4px; }
  .lpills { position: absolute; left: 11%; top: 24%; display: flex; gap: 5px; }
  .lpills i { height: 11px; border-radius: 6px; background: rgb(0 0 0 / 0.45); opacity: 1; }
  .lpills .p1 { width: 30px; border: 1px solid #e0463e; } .lpills .p2 { width: 44px; } .lpills .p3 { width: 36px; }
  .lcard { position: absolute; left: 11%; top: 38%; width: 40%; height: 22%; background: rgb(0 0 0 / 0.5); border-radius: 8px; display: flex; align-items: center; gap: 6px; padding: 0 8px; box-sizing: border-box; }
  .lcard b { width: 16px; height: 16px; border-radius: 50%; flex: none; background: rgb(0 0 0 / 0.55); opacity: 1; }
  .lcard span { flex: 1; } .lcard span i { height: 4px; margin-bottom: 3px; } .lcard .n { width: 40px; opacity: 0.95; } .lcard .u { width: 50px; opacity: 0.4; } .lcard .o { width: 36px; background: #3fbf6a; }
  .lcard em { width: 20px; height: 10px; border-radius: 5px; border: 1px solid #e0463e; background: transparent; opacity: 1; }
  .lbar { position: absolute; left: 9%; right: 1.5%; bottom: 3%; height: 12%; background: rgb(0 0 0 / 0.5); border-radius: 8px; display: flex; align-items: center; gap: 8px; padding: 0 10px; box-sizing: border-box; }
  .lbar span { margin-right: auto; } .lbar span i { height: 4px; margin: 2px 0; } .lbar .n { width: 36px; } .lbar .u { width: 28px; opacity: 0.45; }
  .lbar b { width: 7px; height: 7px; border-radius: 50%; }
  .where.sub { margin-top: -4px; }
  .where { display: flex; gap: 8px; margin: 0 0 12px; }
  .where .btn { flex: 1; }
  .where .btn.on { border-color: var(--accent); color: var(--accent); }
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
  .flips { display: flex; gap: 8px; }
  .flips .btn { display: inline-flex; align-items: center; justify-content: center; padding: 6px 10px; }
  .flips .btn.on { border-color: var(--accent); color: var(--accent); }
  .sliders label { display: grid; grid-template-columns: 92px 1fr 56px; align-items: center; gap: 12px; margin: 8px 0 0; font-size: 13px; font-weight: 600; color: var(--text-dim); }
  .sliders output { text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; color: var(--text); }
  .sliders input[type=range] { width: 100%; min-width: 0; }
  .reset { margin-right: auto; }

</style>
