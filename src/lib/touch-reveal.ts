// Touch screens have no hover, so the controls over a picture (quality, volume, play/pause bar, full screen, ...) are
// shown by a tap instead. The first tap on a picture whose controls are hidden only shows them, for two seconds, and does
// nothing else (a tap on a YouTube video does not pause it). A paused picture shows its controls all the time. While they are shown, a tap works as usual: on the picture
// it plays or pauses, on a control it does what the control does, and every touch keeps them there two seconds more.
//
// The picture gets the class "touch-on" while its controls are to be shown; the components that draw the controls
// show them under that class (next to their own mouse rules). The mouse is not touched by any of this.
const SHOW_MS = 2100; // a little over the 2 s the controls hide themselves after (IDLE_MS in yt-controls.ts), so they never disagree

// A second line of defence for the play / pause handlers: true for a moment after a touch that only showed the controls.
// Whatever happens to the click that follows, it must not play or pause.
let noToggleUntil = 0;
export const touchOnlyRevealed = (): boolean => Date.now() < noToggleUntil;

export function touchReveal(node: HTMLElement) {
  let timer: number | undefined;
  let eat: ((e: Event) => void) | null = null;
  // While playing, only the tap's own two seconds count. A paused picture keeps its controls on (the players' "held" class), so they
  // are shown already and a tap then plays it
  const shown = () => node.classList.contains('touch-on') || !!node.querySelector('.watch-player.held, .youtube-container.held');
  const hide = () => node.classList.remove('touch-on');
  const keep = () => {
    node.classList.add('touch-on');
    clearTimeout(timer);
    timer = window.setTimeout(hide, SHOW_MS);
  };
  const stopEating = () => {
    if (eat) { node.removeEventListener('click', eat, true); eat = null; }
  };

  function down(e: PointerEvent) {
    if (e.pointerType !== 'touch') return;
    if (shown()) { keep(); return; }
    noToggleUntil = Date.now() + 900;
    keep();
    // The click that follows this tap belongs to nobody: it only showed the controls
    stopEating();
    const handler = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); stopEating(); };
    eat = handler;
    node.addEventListener('click', handler, true);
    setTimeout(() => { if (eat === handler) stopEating(); }, 800);
  }
  // Dragging a slider or holding a button keeps the controls there
  function active(e: PointerEvent) {
    if (e.pointerType === 'touch' && shown()) keep();
  }

  node.addEventListener('pointerdown', down, true);
  node.addEventListener('pointermove', active, true);
  node.addEventListener('pointerup', active, true);
  node.addEventListener('pointercancel', stopEating, true);
  return {
    destroy() {
      clearTimeout(timer);
      stopEating();
      node.removeEventListener('pointerdown', down, true);
      node.removeEventListener('pointermove', active, true);
      node.removeEventListener('pointerup', active, true);
      node.removeEventListener('pointercancel', stopEating, true);
      hide();
    }
  };
}
