// Zoom for a picture (a screen, a camera, a watch together player): Ctrl + mouse wheel zooms in
// and out around the pointer, dragging moves the zoomed picture, the small button on top (or
// zooming all the way out) puts it back. The picture itself is moved by CSS (see `.zoomed` in
// VoiceStage.svelte), this only keeps the numbers: --zs (scale), --zx and --zy (shift).
const MIN = 1, MAX = 6;
// Where a press on these is theirs, not the start of a drag (the shield over YouTube's frame is a button, but it is the picture)
const OWN = 'button:not(.shield), input, select, textarea, a, [role="dialog"], [role="menu"], .controls, .cues, .bar, .top';

export function zoomable(node: HTMLElement) {
  let s = 1, x = 0, y = 0;
  let chip: HTMLButtonElement | null = null;

  // The picture: the page's video, or YouTube's stage. Its layout size (before any zoom) limits the shift
  const target = () => node.querySelector<HTMLElement>('video, .yt-stage');

  function apply() {
    const el = target();
    if (el) {
      // The picture never leaves the panel: no more shift than what the zoomed picture overhangs by
      const maxX = Math.max(0, (s * el.offsetWidth - node.clientWidth) / 2);
      const maxY = Math.max(0, (s * el.offsetHeight - node.clientHeight) / 2);
      x = Math.max(-maxX, Math.min(maxX, x));
      y = Math.max(-maxY, Math.min(maxY, y));
    }
    if (s <= MIN + 0.001) { s = 1; x = 0; y = 0; }
    node.style.setProperty('--zs', String(s));
    node.style.setProperty('--zx', `${x}px`);
    node.style.setProperty('--zy', `${y}px`);
    node.classList.toggle('zoomed', s > 1);
    showChip();
  }

  function showChip() {
    if (s <= 1) { chip?.remove(); chip = null; return; }
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.setAttribute('aria-label', 'Reset zoom');
      chip.title = 'Reset zoom';
      chip.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:20;padding:3px 10px;border:none;border-radius:999px;'
        + 'background:rgba(0,0,0,0.65);color:#fff;font-size:12px;font-variant-numeric:tabular-nums;cursor:pointer;';
      chip.addEventListener('click', e => { e.stopPropagation(); s = 1; apply(); });
      chip.addEventListener('dblclick', e => e.stopPropagation());
      node.appendChild(chip);
    }
    chip.textContent = `${Math.round(s * 100)}% · reset`;
  }

  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = node.getBoundingClientRect();
    // The pointer, measured from the middle of the panel (the picture is scaled around its middle)
    const qx = e.clientX - (r.left + r.width / 2), qy = e.clientY - (r.top + r.height / 2);
    // Pixels, lines or pages: wheel up is in, wheel down is out
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const next = Math.max(MIN, Math.min(MAX, s * Math.exp(-dy * 0.0015)));
    if (next === s) return;
    // The point under the pointer stays under it
    x = qx - (next / s) * (qx - x);
    y = qy - (next / s) * (qy - y);
    s = next;
    apply();
  }

  // Dragging a zoomed picture. A click without moving is left alone (it still plays and pauses).
  let drag: { id: number; px: number; py: number; x0: number; y0: number; moved: boolean } | null = null;
  let swallow = false;
  function onDown(e: PointerEvent) {
    if (s <= 1 || e.button !== 0 || (e.target as Element).closest(OWN)) return;
    drag = { id: e.pointerId, px: e.clientX, py: e.clientY, x0: x, y0: y, moved: false };
  }
  function onMove(e: PointerEvent) {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.px, e.clientY - d.py) < 4) return;
      d.moved = true;
      try { node.setPointerCapture(d.id); } catch { /* the pointer is gone */ }
      node.style.cursor = 'grabbing';
    }
    x = d.x0 + e.clientX - d.px;
    y = d.y0 + e.clientY - d.py;
    apply();
  }
  function onUp(e: PointerEvent) {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    node.style.cursor = '';
    if (node.hasPointerCapture(d.id)) node.releasePointerCapture(d.id);
    // The click that ends a drag is not a click on the picture
    if (d.moved) { swallow = true; setTimeout(() => { swallow = false; }, 0); }
  }
  function onClick(e: MouseEvent) {
    if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault(); }
  }
  // The window changed size (full screen, a resize): keep the picture inside the panel
  const ro = new ResizeObserver(() => { if (s > 1) apply(); });
  ro.observe(node);

  node.addEventListener('wheel', onWheel, { passive: false });
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onUp);
  node.addEventListener('click', onClick, true);
  return {
    destroy() {
      ro.disconnect();
      chip?.remove();
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      node.removeEventListener('click', onClick, true);
    }
  };
}
