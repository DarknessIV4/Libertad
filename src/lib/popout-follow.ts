// A window dragged out of the app keeps going under the pointer until the button is let go.
// In the desktop app the main process moves the windows by the system's own cursor (the position the page's pointer events
// report outside the page is not reliable); this only tells it when to start and stop. The drag that started in the app holds
// the pointer (pointer capture), so its pointerup still arrives past the border of the app. A window that opens under the pointer
// can take the capture away on some systems, so the pop-out's own page listens too, and ends it when a button is no longer down.
// In a browser (no desktop app) the windows are moved from the pointer events' screen position.
import { desktop } from './native.ts';

export type Follower = { name: string; w: Window; dx: number; dy: number };

// done(inside): called once, when the drag ends; inside is true when it was let go over the app's own window (they go back in)
export function followPointer(source: HTMLElement, pointerId: number, windows: Follower[], done?: (inside: boolean) => void): () => void {
  let over = false;
  let last: { x: number; y: number } | null = null;
  const native = !!desktop?.followPopouts;
  if (native) {
    try { desktop!.followPopouts(windows.map(({ name, dx, dy }) => ({ name, dx, dy }))); } catch (err) { console.warn('[popout] follow failed', err); }
  }
  const put = (e: PointerEvent) => {
    last = { x: e.screenX, y: e.screenY };
    if (native) return;
    for (const f of windows) {
      if (f.w.closed) continue;
      const left = Math.round(e.screenX - f.dx), top = Math.round(e.screenY - f.dy);
      if (desktop?.movePopout) desktop.movePopout(f.name, left, top);
      else { try { f.w.moveTo(left, top); } catch { /* the browser does not let this window move */ } }
    }
  };
  // A drag area (-webkit-app-region) takes the pointer away from the page, so the pop-out would never hear the button come up
  // over it: while it follows, it has none
  const started = Date.now();
  let idle = 0;
  // Where the pointer last was in the app's own page (it keeps the pointer while the button is down, also past the border of the app):
  // the page itself knows whether that was over the app, whatever the window reports about where it is on the screen
  let lastInApp: { x: number; y: number } | null = null;
  const track = (e: PointerEvent) => { lastInApp = { x: e.clientX, y: e.clientY }; };
  source.addEventListener('pointermove', track as EventListener);
  const move = (e: PointerEvent) => {
    // No button down, and not just the first events of a window that opened under the pointer: the button was let go
    if (e.buttons === 0) { if (Date.now() - started > 150 && ++idle >= 2) { stop(); return; } } else idle = 0;
    put(e);
  };
  const end = () => stop();
  const docs: Document[] = [];
  for (const f of windows) { try { if (!f.w.closed) docs.push(f.w.document); } catch { /* not reachable */ } }
  const listen = (t: EventTarget) => {
    t.addEventListener('pointermove', move as EventListener);
    t.addEventListener('pointerover', move as EventListener);
    t.addEventListener('pointerup', end);
    t.addEventListener('pointercancel', end);
  };
  const unlisten = (t: EventTarget) => {
    t.removeEventListener('pointermove', move as EventListener);
    t.removeEventListener('pointerover', move as EventListener);
    t.removeEventListener('pointerup', end);
    t.removeEventListener('pointercancel', end);
  };
  const styles: HTMLElement[] = [];
  for (const d of docs) {
    try {
      const st = d.createElement('style');
      st.textContent = '* { -webkit-app-region: no-drag !important; }';
      d.head.appendChild(st);
      styles.push(st);
    } catch { /* not reachable */ }
  }
  listen(source);
  for (const d of docs) listen(d);
  // The window being closed (popped back in) ends it too
  const watch = setInterval(() => { if (windows.every(f => f.w.closed)) stop(); }, 250);
  function stop() {
    if (over) return;
    over = true;
    clearInterval(watch);
    unlisten(source);
    source.removeEventListener('pointermove', track as EventListener);
    for (const d of docs) { try { unlisten(d); } catch { /* the page is gone */ } }
    for (const st of styles) { try { st.remove(); } catch { /* the page is gone */ } }
    try { source.releasePointerCapture(pointerId); } catch { /* already released */ }
    const closed = windows.every(f => f.w.closed);
    if (native) {
      let ask: Promise<boolean>;
      try { ask = desktop!.endPopoutFollow(); } catch { ask = Promise.resolve(false); }
      const seen = lastInApp as { x: number; y: number } | null;
      // Only a drag that started in the app's own page can say this: the position of a drag that started in a pop-out window (the call
      // bar's own) is in that window's page, which says nothing about the app
      const page = source.ownerDocument.defaultView === window && !!seen && seen.x >= 0 && seen.y >= 0 && seen.x < window.innerWidth && seen.y < window.innerHeight;
      ask.then(inside => inside, () => false).then(main => {
        const inside = (main || page) && !closed;
        console.log(`[popout] follow end: pointer last seen in the page at ${seen ? `${Math.round(seen.x)},${Math.round(seen.y)}` : 'nowhere'} (${page ? 'over the app' : 'not over the app'}), the window check says ${main ? 'over the app' : 'not over the app'} -> ${inside ? 'back in' : 'stays out'}`);
        done?.(inside);
      });
    } else {
      // In a browser: the last pointer position against this window's place on the screen
      const inside = !!last && !closed && last.x >= window.screenX && last.x < window.screenX + window.outerWidth && last.y >= window.screenY && last.y < window.screenY + window.outerHeight;
      done?.(inside);
    }
  }
  return stop;
}

// A pop-out window that the desktop moved (its title bar, or the call bar's own drag area) and left over the app's window goes back in.
// The desktop's move gives the page nothing while it lasts; the pointer coming back into the pop-out with no button down is the end
// of it. Put this on the pop-out after its page is written (writing the page removes listeners that came before).
export function dockOnDrop(w: Window, name: string, dock: () => void): () => void {
  let busy = false;
  let last: { x: number; y: number } | null = null;
  const onMove = (e: PointerEvent) => {
    if (e.buttons !== 0 || busy) return;
    busy = true;
    const done = () => { setTimeout(() => { busy = false; }, 150); };
    if (desktop?.popoutDropCheck) {
      desktop.popoutDropCheck(name).then(inside => { if (inside) dock(); }, () => {}).then(done);
      return;
    }
    // In a browser: the pop-out has moved when its place on the screen changed, and the pointer is over the app's window
    const at = { x: w.screenX, y: w.screenY };
    const moved = !!last && (last.x !== at.x || last.y !== at.y);
    last = at;
    if (moved && e.screenX >= window.screenX && e.screenX < window.screenX + window.outerWidth && e.screenY >= window.screenY && e.screenY < window.screenY + window.outerHeight) dock();
    done();
  };
  let d: Document | null = null;
  try { d = w.document; d.addEventListener('pointermove', onMove as EventListener); } catch { /* not reachable */ }
  return () => { try { d?.removeEventListener('pointermove', onMove as EventListener); } catch { /* the page is gone */ } };
}

// Tells the desktop app where the pointer is in the page, now and then, so it knows where the window really is on the screen
// (what the window reports about itself can be out of date). Returns the function that stops it.
export function trackAppPointer(): () => void {
  if (!desktop?.appPointer) return () => {};
  let at = 0;
  const send = (e: PointerEvent) => {
    const now = Date.now();
    if (now - at < 80) return;
    at = now;
    desktop!.appPointer(e.clientX, e.clientY);
  };
  window.addEventListener('pointermove', send, true);
  window.addEventListener('pointerdown', send, true);
  return () => { window.removeEventListener('pointermove', send, true); window.removeEventListener('pointerdown', send, true); };
}
