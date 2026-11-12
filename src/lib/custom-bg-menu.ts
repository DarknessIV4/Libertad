import { customBg, PANELS, type Panel, type Slot } from './custom-bg.svelte.ts';
import { applyColor, applyFile, cropBackground, removeBackground, panelColor } from './custom-bg-actions.ts';
import { menu, type MenuItem } from './menu.svelte.ts';
import { ui } from './ui.svelte.ts';
import { pickColor, pickFile } from './pick.ts';

// After a color or file is chosen: this panel only, or the whole background (one picture over all three panels)
function askScope(panel: Panel, apply: (scope: Slot) => void | Promise<void>): void {
  menu.showAt(menu.last.x, menu.last.y, [
    { header: true, label: 'Apply to' },
    { label: 'This panel only', action: () => void apply(panel) },
    { label: 'Whole background', action: () => void apply('whole') }
  ]);
}

async function chooseFile(panel: Panel, accept: string): Promise<void> {
  const picked = await pickFile(accept);
  if (!picked) return;
  // Offered for cropping first
  const f = await cropBackground(picked);
  if (!f) return;
  askScope(panel, async scope => {
    const error = await applyFile(scope, f.file, f.crop);
    if (error) ui.prompt = { title: 'Custom background', label: '', confirm: 'OK', input: 'none', text: error, onsubmit: () => {} };
  });
}

// The entries for right-clicking free space in a panel. Only for this computer, nothing is shared.
export function customBackgroundItems(panel: Panel, extra: MenuItem[] = []): MenuItem[] {
  const items: MenuItem[] = [{
    label: 'Choose Custom Background',
    action: () => menu.showAt(menu.last.x, menu.last.y, [
      { header: true, label: 'Custom background' },
      { label: 'Color...', action: async () => {
        const c = await pickColor(panelColor(panel) ?? '#26282d');
        if (c) askScope(panel, scope => applyColor(scope, c));
      } },
      { label: 'Image...', action: () => chooseFile(panel, 'image/png,image/jpeg,image/webp') },
      { label: 'Video / GIF...', action: () => chooseFile(panel, 'video/*,image/gif') }
    ])
  }];
  items.push(...extra);
  // A picture, GIF or video can be darkened and blurred: the one this panel shows
  const eff = customBg.effective(panel);
  if (eff) {
    const e = customBg.slots[eff];
    items.push(
      { label: 'Darkness', slider: { value: e.darkness, min: 0, max: 95, step: 1, reset: 0, format: v => `${Math.round(v)}%`, oninput: v => customBg.setDarkness(eff, v) } },
      { label: 'Blur', slider: { value: e.blur, min: 0, max: 40, step: 1, reset: 0, format: v => `${Math.round(v)} px`, oninput: v => customBg.setBlur(eff, v) } }
    );
  }
  if (customBg.any || PANELS.some(p => panelColor(p))) items.push({ label: 'Remove custom background', danger: true, action: () => void removeBackground('whole') });
  return items;
}

// The entries for right-clicking free space on the start screen (before entering a server): a color, picture, GIF
// or video of its own, cropped after it is chosen. Only for this computer, nothing is shared.
export function homeBackgroundItems(): MenuItem[] {
  const fail = (error: string) => { ui.prompt = { title: 'Custom background', label: '', confirm: 'OK', input: 'none', text: error, onsubmit: () => {} }; };
  const file = async (accept: string) => {
    const picked = await pickFile(accept);
    if (!picked) return;
    const f = await cropBackground(picked);
    if (!f) return;
    const error = await applyFile('home', f.file, f.crop);
    if (error) fail(error);
  };
  const items: MenuItem[] = [{
    label: 'Choose Custom Background',
    action: () => menu.showAt(menu.last.x, menu.last.y, [
      { header: true, label: 'Custom background' },
      { label: 'Color...', action: async () => {
        const c = await pickColor(customBg.homeColor ?? '#26282d');
        if (c) await applyColor('home', c);
      } },
      { label: 'Image...', action: () => file('image/png,image/jpeg,image/webp') },
      { label: 'Video / GIF...', action: () => file('video/*,image/gif') }
    ])
  }];
  if (customBg.has('home')) {
    const e = customBg.slots.home;
    items.push(
      { label: 'Darkness', slider: { value: e.darkness, min: 0, max: 95, step: 1, reset: 0, format: v => `${Math.round(v)}%`, oninput: v => customBg.setDarkness('home', v) } },
      { label: 'Blur', slider: { value: e.blur, min: 0, max: 40, step: 1, reset: 0, format: v => `${Math.round(v)} px`, oninput: v => customBg.setBlur('home', v) } }
    );
  }
  if (customBg.has('home') || customBg.homeColor) items.push({ label: 'Remove custom background', danger: true, action: () => void removeBackground('home') });
  return items;
}
