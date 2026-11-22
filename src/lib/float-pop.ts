// The list of who is watching, shown while the mouse rests on (or keyboard focus is in) the "N watching" label.
// While it is shown, the list is moved to the end of <body> and placed with position: fixed, so no picture, bar or side
// panel around the stage can draw over it or cut it off (inside the stage it was held under them by the stage's own
// stacking layer). Use on the list element, which must be a child of the label it belongs to:
// `<span class="viewers"><span class="pop" use:floatPop>`. The list is hidden (display: none in its CSS) until then.
// It goes back to its own place when it is hidden, so the component can remove it like any other element.

const GAP = 6;
const CLOSE_DELAY = 120;

export function floatPop(node: HTMLElement) {
  const anchor = node.parentElement;
  if (!anchor) return;
  let marker: Comment | null = null; // where the list belongs while it is out in <body>
  let timer: ReturnType<typeof setTimeout> | undefined;

  function lift(): void {
    if (marker) return;
    marker = document.createComment('');
    node.replaceWith(marker);
    document.body.append(node);
  }
  function drop(): void {
    if (!marker) return;
    marker.replaceWith(node);
    marker = null;
    node.style.display = '';
    node.style.left = '';
    node.style.top = '';
  }
  function place(): void {
    const r = anchor!.getBoundingClientRect();
    node.style.left = '0px';
    node.style.top = '0px';
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    // Under the label, or above it when there is no room below
    let top = r.bottom + GAP;
    if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - GAP - h);
    const left = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - w - 4));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }
  function open(): void {
    clearTimeout(timer);
    lift();
    node.style.display = 'flex';
    place();
  }
  function close(): void {
    clearTimeout(timer);
    timer = setTimeout(drop, CLOSE_DELAY);
  }
  // A finger gives pointerenter and then pointerleave at once: touch opens the list by focus instead (the label can be tabbed to)
  const enter = (e: PointerEvent) => { if (e.pointerType !== 'touch') open(); };
  const leave = (e: PointerEvent) => { if (e.pointerType !== 'touch') close(); };
  const focusOut = (e: FocusEvent) => {
    if (e.relatedTarget instanceof Node && (anchor.contains(e.relatedTarget) || node.contains(e.relatedTarget))) return;
    close();
  };

  anchor.addEventListener('pointerenter', enter);
  anchor.addEventListener('pointerleave', leave);
  anchor.addEventListener('focusin', open);
  anchor.addEventListener('focusout', focusOut);
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointerleave', leave);
  return {
    destroy() {
      clearTimeout(timer);
      anchor.removeEventListener('pointerenter', enter);
      anchor.removeEventListener('pointerleave', leave);
      anchor.removeEventListener('focusin', open);
      anchor.removeEventListener('focusout', focusOut);
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', leave);
      drop();
    }
  };
}
