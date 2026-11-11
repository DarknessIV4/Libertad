// Color schemes: the fixed ones live in themes.css; "custom" is built from the user's own colors,
// written onto the root element as CSS variables.

export const CUSTOM_KEYS = [
  'rail', 'bg-0', 'bg-1', 'bg-2', 'bg-3', 'bg-hover', 'bg-active', 'line',
  'text', 'text-dim', 'text-faint',
  'accent', 'accent-hover', 'accent-text',
  'speaking', 'danger', 'warn', 'link'
] as const;
export type CustomKey = typeof CUSTOM_KEYS[number];
export type CustomColors = Record<CustomKey, string>;

export const CUSTOM_GROUPS: { title: string; items: { key: CustomKey; label: string }[] }[] = [
  { title: 'Backgrounds', items: [
    { key: 'rail', label: 'Server bar' },
    { key: 'bg-0', label: 'Window edges' },
    { key: 'bg-1', label: 'Side panels and bars' },
    { key: 'bg-2', label: 'Chat area' },
    { key: 'bg-3', label: 'Inputs and cards' },
    { key: 'bg-hover', label: 'Hovered items' },
    { key: 'bg-active', label: 'Pressed items' },
    { key: 'line', label: 'Borders and dividers' }
  ] },
  { title: 'Text', items: [
    { key: 'text', label: 'Text' },
    { key: 'text-dim', label: 'Secondary text' },
    { key: 'text-faint', label: 'Faint text' },
    { key: 'link', label: 'Links' }
  ] },
  { title: 'Accent', items: [
    { key: 'accent', label: 'Accent' },
    { key: 'accent-hover', label: 'Accent, hovered' },
    { key: 'accent-text', label: 'Text on accent' }
  ] },
  { title: 'Status', items: [
    { key: 'speaking', label: 'Speaking' },
    { key: 'danger', label: 'Danger and muted' },
    { key: 'warn', label: 'Warnings' }
  ] }
];

// The same values as Dark, the starting point of a new custom scheme
export const CUSTOM_DEFAULTS: CustomColors = {
  'rail': '#0e0f11', 'bg-0': '#0e0f11', 'bg-1': '#141518', 'bg-2': '#1a1b1f', 'bg-3': '#222429',
  'bg-hover': '#27292e', 'bg-active': '#2f3238', 'line': '#2a2c32',
  'text': '#e6e7ea', 'text-dim': '#a0a3ab', 'text-faint': '#6c6f78',
  'accent': '#7c6cff', 'accent-hover': '#8f81ff', 'accent-text': '#ffffff',
  'speaking': '#3bd16f', 'danger': '#f0504a', 'warn': '#e8b23c', 'link': '#6fb3ff'
};

const HEX = /^#[0-9a-f]{6}$/i;
export function isHex(v: unknown): v is string { return typeof v === 'string' && HEX.test(v); }

// Keep only valid colors; anything missing falls back to the default
export function cleanColors(raw: unknown): CustomColors {
  const out = { ...CUSTOM_DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const k of CUSTOM_KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      if (isHex(v)) out[k] = v.toLowerCase();
    }
  }
  return out;
}

// Light backgrounds get light native controls (scroll bars, form widgets)
function isLight(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.4;
}

export function applyCustom(el: HTMLElement, colors: CustomColors) {
  for (const k of CUSTOM_KEYS) el.style.setProperty(`--${k}`, colors[k]);
  el.style.setProperty('color-scheme', isLight(colors['bg-2']) ? 'light' : 'dark');
}

export function clearCustom(el: HTMLElement) {
  for (const k of CUSTOM_KEYS) el.style.removeProperty(`--${k}`);
  el.style.removeProperty('color-scheme');
}

// Inline style for a swatch (the miniature in Settings) so it shows the custom colors
export function customStyle(colors: CustomColors): string {
  return CUSTOM_KEYS.map(k => `--${k}:${colors[k]}`).join(';');
}

// The colors a color scheme has right now, read from the page (for starting a custom scheme from the one in use)
export function readThemeColors(id: string): Partial<CustomColors> {
  const probe = document.createElement('div');
  probe.setAttribute('data-theme-preview', id);
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out: Partial<CustomColors> = {};
  for (const k of CUSTOM_KEYS) {
    const v = cs.getPropertyValue(`--${k}`).trim();
    if (isHex(v)) out[k] = v.toLowerCase();
  }
  probe.remove();
  return out;
}
