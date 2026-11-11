import { customBg, PANELS, type Panel, type Slot } from './custom-bg.svelte.ts';
import { applyColor, applyFile, removeBackground, panelColor } from './custom-bg-actions.ts';
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
  const f = await pickFile(accept);
  if (!f) return;
  askScope(panel, async scope => {
    const error = await applyFile(scope, f);
    if (error) ui.prompt = { title: 'Custom background', label: '', confirm: 'OK', input: 'none', text: error, onsubmit: () => {} };
  });
}

// The entries for right-clicking free space in a panel. Only for this computer, nothing is shared.
export function customBackgroundItems(panel: Panel): MenuItem[] {
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
