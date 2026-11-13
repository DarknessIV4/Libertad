import { customBg, PANELS, type Slot } from './custom-bg.svelte.ts';
import { store } from './settings.svelte.ts';
import { readThemeColors } from './theme.ts';
import { imageEditor, type BgTarget, type AppScope } from './image-editor.svelte.ts';
import { videoFrame } from './images.ts';
import type { Crop } from './image-edit.ts';
import { canEditGif } from './gif-edit.ts';

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
  // The start screen has a color of its own, apart from the color scheme
  if (scope === 'home') {
    await customBg.clear('home');
    customBg.setHomeColor(color.toLowerCase());
    return;
  }
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
export interface Cropped { file: File; crop?: Crop; target?: BgTarget; appScope?: AppScope }
// opts.target: the editor also asks where it goes (app, login or both, and which part of the app) with a preview of each;
// opts.scope: the part of the app it starts on
export async function cropBackground(file: File, opts: { target?: boolean; scope?: AppScope } = {}): Promise<Cropped | null> {
  const title = 'Crop background';
  const target = !!opts.target, appScope = opts.scope;
  const fallback: Cropped = { file, ...(target && { target: 'app' as BgTarget, appScope: appScope ?? 'whole' }) };
  // Any picture the window can read is cropped as a still; a GIF keeps all of itself
  if (file.type.startsWith('image/') && file.type !== 'image/gif' && !file.type.includes('svg')) {
    const r = await imageEditor.open(file, { effects: false, scopes: false, target, appScope, title });
    return r ? { file: r.file, target: r.target, appScope: r.appScope } : null;
  }
  if (file.type === 'image/gif') {
    // Where this window can edit a GIF, it is edited like a picture (every frame turned, mirrored and cropped) and keeps moving.
    // Elsewhere it is only cropped, and the crop is cut when it is shown.
    if (canEditGif()) {
      const r = await imageEditor.open(file, { effects: false, scopes: false, target, appScope, title });
      return r ? { file: r.file, target: r.target, appScope: r.appScope } : null;
    }
    const r = await imageEditor.open(file, { effects: false, scopes: false, cropOnly: true, target, appScope, title });
    return r ? { file, crop: r.crop, target: r.target, appScope: r.appScope } : null;
  }
  if (file.type.startsWith('video/')) {
    const frame = await videoFrame(file);
    // A video this window cannot show a frame of is used as it is
    if (!frame) return fallback;
    const r = await imageEditor.open(frame, {
      effects: false, scopes: false, cropOnly: true, target, appScope, title,
      note: 'This is a video: it keeps playing, and only the part inside the frame is shown. The preview shows one frame.'
    });
    return r ? { file, crop: r.crop, target: r.target, appScope: r.appScope } : null;
  }
  return fallback;
}

// What the editor's choice of place does: the app (one panel or all), the login screen, or both. Returns what went wrong, or ''.
export async function applyCropped(f: Cropped): Promise<string> {
  const target = f.target ?? 'app';
  if (target === 'login') return applyFile('home', f.file, f.crop);
  if (target === 'both') return (await applyFile('whole', f.file, f.crop)) || applyFile('home', f.file, f.crop);
  return applyFile(f.appScope ?? 'whole', f.file, f.crop);
}

// A picture, GIF or video. Returns what went wrong, or ''.
export async function applyFile(scope: Slot, file: File, crop?: Crop | null): Promise<string> {
  const error = await customBg.setFile(scope, file, crop);
  if (error) return error;
  if (scope === 'home') customBg.setHomeColor(null);
  if (scope === 'whole') {
    // One picture over everything: the panels' own pictures and colors would cut it
    for (const p of PANELS) await customBg.clear(p);
    setPanelColors({});
  }
  return '';
}

// Takes a background away: a panel's own, or for 'whole' every one of them
export async function removeBackground(scope: Slot): Promise<void> {
  if (scope === 'home') {
    await customBg.clear('home');
    customBg.setHomeColor(null);
    return;
  }
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
