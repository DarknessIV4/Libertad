// What the YouTube player offers its overlays (the one in the main window and the pop-out's), and the
// choices they show. The values are local to this person: none of it is shared with the session.

export interface YtControls {
  getDurationMs: () => number;
  getVolume: () => number;
  setVolume: (v: number) => void;
  getRate: () => number;
  setRate: (rate: number) => void;
  getCaptions: () => boolean;
  setCaptions: (on: boolean) => void;
  getQuality: () => string;
  setQuality: (q: string) => void;
  getQualities: () => string[];
  // The address the frame should load when it is moved to another window: where the video is now, and
  // whether it plays (a moved frame loads its address again, so it begins there instead of at the start)
  prepareMove: () => string | null;
  // Writes the frame's size and scale for the stage it is in now (after it came back from a pop-out)
  refitFrame?: () => void;
  // Width over height of the picture (16:9 until it is known); the frame is shaped after it
  getAspect: () => number;
}

// The overlay hides when the mouse has not moved for this long
export const IDLE_MS = 2000;

export const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export const rateLabel = (r: number) => (r === 1 ? 'Normal' : `${r}x`);

const QUALITY_LABELS: Record<string, string> = {
  highres: '4320p', hd2880: '2880p', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p', hd720: '720p',
  large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Auto'
};
export const qualityLabel = (q: string) => QUALITY_LABELS[q] ?? q;
// Offered until the player says which ones the video has
export const DEFAULT_QUALITIES = ['hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
