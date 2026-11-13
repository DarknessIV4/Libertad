// Menus over a picture (quality, captions, speed, subtitles...) are overlays: whatever is done on
// them stays on them. The picture below never plays, pauses or goes full screen because of it.
//
// A click on an item closes its menu, so the second click of a double click lands on the picture.
// `menuClosed` notes the moment a menu went away, and the picture ignores clicks for a short while after.
let closedAt = 0;
const AFTER_MS = 500;

export function menuClosed(): void {
  closedAt = Date.now();
}

// True just after a menu closed: a click or double click on the picture now belongs to that menu
export function menuJustClosed(): boolean {
  return Date.now() - closedAt < AFTER_MS;
}

const OWN = 'button, input, select, textarea, a, label, [role="button"], [role="menuitemradio"]';

// A press outside an open menu closes it (the caller does that). The click that follows on the
// picture only closes the menu: it does not also play or pause. A click on a button or a field
// still works as usual.
export function swallowClick(e: Event, win: Window = window): void {
  menuClosed();
  const target = e.target as Element | null;
  if (target?.closest?.(OWN)) return;
  const stop = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
  win.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => win.removeEventListener('click', stop, true), 1000);
}
