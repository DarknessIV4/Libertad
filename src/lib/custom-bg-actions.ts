import { customBg, PANELS, type Slot } from './custom-bg.svelte.ts';
import { store } from './settings.svelte.ts';
import { readThemeColors } from './theme.ts';
import { imageEditor, EDITABLE } from './image-editor.svelte.ts';
import { videoFrame } from './images.ts';
import type { Crop } from './image-edit.ts';

// What choosing a background does, shared by the right-click menu and Settings. A scope is 'whole' (the
// left panel, the middle and the right panel as one) or one panel on its own.

// A color is a color of the custom scheme: from any other scheme this switches to the custom one, which
// starts from the colors that were in use, so nothing else changes
export function ensureCustom(): void {
  if (store.settings.theme === 'custom') return;
  store.settings.customColors = { ...store.settings.customColors, ...readThemeColors(store.settings.theme) };
  store.settings.theme = 'custom';
  store.saveSettings();
}

export const panelColor = (panel: 'left' | 'middle' | 'right'): string | null =>
  store.settings.theme === 'custom' ? store.settings.panelColors?.[panel] ?? null : null;

function setPanelColors(next: typeof store.settings.panelColors): void {
  store.settings.panelColors = next;
  store.saveSettings();
}

export async function applyColor(scope: Slot, color: string): Promise<void> {
  ensureCustom();
  const c = color.toLowerCase();
  const next = { ...store.settings.panelColors };
  if (scope === 'whole') {
    // One color over everything: no picture is left over it
    for (const p of PANELS) { next[p] = c; await customBg.clear(p); }
    await customBg.clear('whole');
  } else {
    next[scope] = c;
    await customBg.clear(scope);
  }
  setPanelColors(next);
}

// A picture, GIF or video is offered for cropping first (darkness and blur come later, from the sliders every
// background has). A picture is cut and turned there. A GIF or video is not made again: it keeps all of itself
// and the part to show comes back as `crop`, cut when it is drawn (a video is cropped on a picture of one frame).
// Null: the person closed the editor.
export async function cropBackground(file: File): Promise<{ file: File; crop?: Crop } | null> {
  const title = 'Crop background';
  if (EDITABLE.test(file.type)) {
    const r = await imageEditor.open(file, { effects: false, scopes: false, title });
    return r ? { file: r.file } : null;
  }
  if (file.type === 'image/gif') {
    const r = await imageEditor.open(file, { effects: false, scopes: false, cropOnly: true, title });
    return r ? { file, crop: r.crop } : null;
  }
  if (file.type.startsWith('video/')) {
    const frame = await videoFrame(file);
    // A video this window cannot show a frame of is used as it is
    if (!frame) return { file };
    const r = await imageEditor.open(frame, {
      effects: false, scopes: false, cropOnly: true, title,
      note: 'This is a video: it keeps playing, and only the part inside the frame is shown. The preview shows one frame.'
    });
    return r ? { file, crop: r.crop } : null;
  }
  return { file };
}

// A picture, GIF or video. Returns what went wrong, or ''.
export async function applyFile(scope: Slot, file: File, crop?: Crop | null): Promise<string> {
  const error = await customBg.setFile(scope, file, crop);
  if (error) return error;
  if (scope === 'whole') {
    // One picture over everything: the panels' own pictures and colors would cut it
    for (const p of PANELS) await customBg.clear(p);
    setPanelColors({});
  }
  return '';
}

// Takes a background away: a panel's own, or for 'whole' every one of them
export async function removeBackground(scope: Slot): Promise<void> {
  if (scope === 'whole') {
    for (const p of PANELS) await customBg.clear(p);
    await customBg.clear('whole');
    setPanelColors({});
  } else {
    await customBg.clear(scope);
    const next = { ...store.settings.panelColors };
    delete next[scope];
    setPanelColors(next);
  }
}
