// A color or a file from the person, outside of any dialog (used by the menus)
import { colorPicker } from './colorpicker.svelte.ts';

let fileEl: HTMLInputElement | null = null;

function hidden(type: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  el.tabIndex = -1;
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(el);
  return el;
}

// The color chosen with Apply, or null (see colorpicker.svelte.ts)
export const pickColor = (initial: string): Promise<string | null> => colorPicker.open(initial);

export function pickFile(accept: string): Promise<File | null> {
  const el = fileEl ??= hidden('file');
  return new Promise(resolve => {
    el.accept = accept;
    el.value = '';
    el.onchange = () => resolve(el.files?.[0] ?? null);
    el.oncancel = () => resolve(null);
    el.click();
  });
}
