// The app's picture editor (ui/ImageEditor.svelte): crop, turn, and for a banner darken and blur, then
// say where the picture goes. Used after a picture is chosen for the profile banner, a profile picture or a background.
import type { Crop } from './image-edit.ts';
import type { GifOptions } from './gif-edit.ts';

// Where an edited picture goes on a profile card: the banner, the space under it, or all of it
export type EditScope = 'banner' | 'under' | 'whole';

export interface EditOptions {
  // Darkness and blur sliders (a background has its own, set after it is chosen)
  effects: boolean;
  // Ask where the picture goes once it is done
  scopes: boolean;
  title?: string;
  // A line of advice shown above the picture
  note?: string;
  // Show a profile card beside the crop, with the picture where it would go: the banner, the space under it or the whole card
  preview?: EditScope;
  // The frame stays square (a profile picture)
  square?: boolean;
  // Only the crop is asked for: the picture comes back as it was, with the part to show. For a GIF or a
  // video (given as a picture of one of its frames), which are cropped when they are shown.
  cropOnly?: boolean;
  // For a GIF that is made again: how big it may get (always made again with this, even when unchanged)
  gif?: GifOptions;
}
export interface EditResult {
  // The picture as it was when nothing was changed, else the edited one
  file: File;
  scope?: EditScope;
  // With cropOnly: the part to show (0 to 1 of the picture)
  crop?: Crop;
}
interface Request extends EditOptions {
  file: File;
  resolve: (r: EditResult | null) => void;
}

class ImageEditorStore {
  state = $state.raw<Request | null>(null);

  // What the person made of the picture, or null when they closed it
  open(file: File, opts: EditOptions): Promise<EditResult | null> {
    this.state?.resolve(null);
    return new Promise(resolve => { this.state = { ...opts, file, resolve }; });
  }

  close(result: EditResult | null): void {
    const s = this.state;
    this.state = null;
    s?.resolve(result);
  }
}

export const imageEditor = new ImageEditorStore();

// Pictures the editor can work on as a still. A GIF would lose its movement there, so callers that
// only crop a still (app backgrounds) use a GIF as it is.
export const EDITABLE = /^image\/(png|jpeg|webp)$/;

// Pictures and GIFs: the editor keeps a GIF moving by editing every frame (lib/gif-edit.ts)
export const EDITABLE_OR_GIF = /^image\/(png|jpeg|webp|gif)$/;
