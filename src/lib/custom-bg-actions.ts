import { customBg, PANELS, type Slot } from './custom-bg.svelte.ts';
import { store } from './settings.svelte.ts';
import { readThemeColors } from './theme.ts';

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

// A picture, GIF or video. Returns what went wrong, or ''.
export async function applyFile(scope: Slot, file: File): Promise<string> {
  const error = await customBg.setFile(scope, file);
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
