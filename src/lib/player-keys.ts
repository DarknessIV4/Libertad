// Keyboard shortcuts of the watch-together players: Space plays and pauses, Left and Right seek by 5 seconds
export const SEEK_STEP_MS = 5000;

export function playerKey(e: KeyboardEvent, o: { toggle: () => void; seekBy: (ms: number) => void }): void {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const isSpace = e.key === ' ' || e.code === 'Space';
  if (!isSpace && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const t = e.target;
  if (t instanceof Element) {
    // Typing, and sliders (which use the arrows themselves), keep their keys
    if (t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    // A focused button or link already reacts to Space
    if (isSpace && t.closest('button, a[href], summary')) return;
  }
  e.preventDefault();
  if (isSpace) { if (!e.repeat) o.toggle(); }
  else o.seekBy(e.key === 'ArrowRight' ? SEEK_STEP_MS : -SEEK_STEP_MS);
}
