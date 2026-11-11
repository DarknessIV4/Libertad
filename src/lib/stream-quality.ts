// A viewer can cap the stream he receives, for himself only: the sender then sends him less (the
// sender's own limits stay the upper bound). 0 means no cap of his own.
export interface ViewerCap { fps: number; height: number }

export const NO_CAP: ViewerCap = { fps: 0, height: 0 };
export const CAP_FPS = [0, 15, 30, 60];
export const CAP_HEIGHTS = [0, 360, 480, 720, 1080, 1440];
export const capFpsLabel = (v: number) => (v ? `${v} fps` : 'Auto');
export const capHeightLabel = (v: number) => (v ? `${v}p` : 'Auto');
export const isCapped = (c: ViewerCap | undefined) => !!c && (c.fps > 0 || c.height > 0);

// What arrives from another computer is a request, not a fact: only sensible numbers are taken
export function cleanCap(v: unknown): ViewerCap {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const num = (x: unknown, max: number) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.min(max, Math.round(x)) : 0);
  return { fps: num(o.fps, 240), height: num(o.height, 4320) };
}
export function parseCap(text: string | undefined): ViewerCap {
  try { return cleanCap(JSON.parse(text ?? '{}')); } catch { return NO_CAP; }
}

// What the sender does for one viewer, given its own settings and what the source has
export const capFps = (own: number, cap: ViewerCap | undefined) => (cap?.fps ? Math.min(own, cap.fps) : own);
export const capScale = (sourceHeight: number, ownHeight: number, cap: ViewerCap | undefined) =>
  Math.max(1, sourceHeight / ownHeight, cap?.height ? sourceHeight / cap.height : 1);
