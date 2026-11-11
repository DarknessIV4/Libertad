import { load, save } from './storage.ts';

// Where the chat sits: in the middle under the user cards (the default), or docked on the right where
// the member list is, which hides the member list and gives the whole middle to the user cards.
// The person moves it by pressing on an empty spot of the chat and dragging it to the other side.
export type DockSide = 'middle' | 'right';

// Only the chat's empty places start a drag, never a message, text, button or the message box
const EMPTY = '.chat, .logbox, .wrap, .list, .end, .empty, .cpanel, .cheader, .cheader .grow, .msg, .gutter, .content, .system';
// Whether a click landed on the chat's empty space (not on a message, text or a control)
export const isChatEmpty = (t: EventTarget | null): boolean => t instanceof Element && t.matches(EMPTY);
// Letting go further right than this docks the chat on the right, anywhere left of it puts it in the middle
const SPLIT = 0.65;

class ChatDock {
  side = $state<DockSide>(load<{ side: string }>('mumh5.chatDock', { side: 'middle' }).side === 'right' ? 'right' : 'middle');
  // Width of the docked chat, set by dragging its edge
  width = $state(Math.max(280, Number(localStorage.getItem('mumh5.chatPanelWidth')) || 380));
  // Only where the window has room for a side panel
  enabled = false;
  // While dragging: the pointer, and where the chat would land
  drag = $state<{ x: number; y: number; target: DockSide } | null>(null);

  set(side: DockSide): void {
    this.side = side;
    save('mumh5.chatDock', { side });
  }

  pointerDown(e: PointerEvent): void {
    if (!this.enabled || e.button !== 0 || e.pointerType === 'touch' || this.drag) return;
    const t = e.target;
    if (!(t instanceof Element) || !t.matches(EMPTY)) return;
    // The scrollbar of the message list is not empty space
    const r = t.getBoundingClientRect();
    if (t.clientWidth && t.clientWidth < r.width - 2 && e.clientX - r.left >= t.clientWidth) return;

    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const spot = (ev: PointerEvent) => ({ x: ev.clientX, y: ev.clientY, target: (ev.clientX > window.innerWidth * SPLIT ? 'right' : 'middle') as DockSide });
    const stop = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      this.drag = null;
    };
    const move = (ev: PointerEvent) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
        moved = true;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
        getSelection()?.removeAllRanges();
      }
      ev.preventDefault();
      this.drag = spot(ev);
    };
    const up = (ev: PointerEvent) => {
      const target = spot(ev).target;
      stop();
      if (!moved) return;
      // The click that ends a drag is not a click on anything
      const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      if (target !== this.side) this.set(target);
    };
    const cancel = () => stop();
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') stop(); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
  }
}

export const chatDock = new ChatDock();
