// A hover label for icon buttons: appears after the pointer has rested on the button for 400 ms,
// at the button, above everything (also over a picture in full screen). Use with `use:tip`.
// It takes the text from the button's title (which it then keeps off the button, so the browser's own
// slower tooltip does not show as well) or, without one, its aria-label. Mouse and pen only.

const DELAY = 400;
let el: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let owner: HTMLElement | null = null;

function hide(): void {
  clearTimeout(timer);
  el?.remove();
  el = null;
  owner = null;
}

function show(node: HTMLElement, text: string): void {
  if (!node.isConnected) return;
  el?.remove();
  const tip = document.createElement('div');
  tip.setAttribute('role', 'tooltip');
  tip.textContent = text;
  Object.assign(tip.style, {
    position: 'fixed', left: '0px', top: '0px', zIndex: '2147483647', pointerEvents: 'none', maxWidth: '280px',
    padding: '5px 9px', borderRadius: '6px', font: '12px/1.35 system-ui, sans-serif', color: '#fff', background: 'rgba(18, 18, 20, 0.96)',
    border: '1px solid rgba(255, 255, 255, 0.14)', boxShadow: '0 4px 14px rgba(0, 0, 0, 0.5)', opacity: '0', transition: 'opacity 100ms'
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.append(tip);
  const r = node.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight, gap = 8;
  // Below the button, or above it when there is no room (the bar along the bottom of a window)
  let top = r.bottom + gap;
  if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - gap - h);
  const left = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), window.innerWidth - w - 4);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.style.opacity = '1';
  el = tip;
  owner = node;
}

export function tip(node: HTMLElement) {
  function enter(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    const t = node.getAttribute('title');
    if (t) { node.dataset.tip = t; node.removeAttribute('title'); }
    const text = node.dataset.tip || node.getAttribute('aria-label');
    if (!text) return;
    hide();
    timer = setTimeout(() => show(node, text), DELAY);
  }
  const leave = () => { if (owner === node || !el) hide(); };
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointerleave', leave);
  node.addEventListener('pointerdown', hide);
  node.addEventListener('blur', leave);
  return {
    destroy() {
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', leave);
      node.removeEventListener('pointerdown', hide);
      node.removeEventListener('blur', leave);
      if (owner === node) hide();
    }
  };
}
