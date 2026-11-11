// Keyboard shortcuts the person assigns in Settings, Accessibility. A shortcut is kept as text in the
// form Electron uses for accelerators ("Ctrl+Shift+M", "F9"), so the same text serves the window's own
// key handling and, in the desktop app, the system-wide registration (works with mumh5 in the background).
import { desktop } from './native.ts';
import { store } from './settings.svelte.ts';
import { session, sessions } from './session.svelte.ts';

export type ShortcutId = 'mute' | 'deafen' | 'disconnect' | 'fullscreen' | 'popout' | 'quit';

export const SHORTCUTS: { id: ShortcutId; label: string; desktopOnly?: boolean }[] = [
  { id: 'mute', label: 'Mute' },
  { id: 'deafen', label: 'Deafen' },
  { id: 'disconnect', label: 'Disconnect' },
  { id: 'fullscreen', label: 'Full screen' },
  { id: 'popout', label: 'Pop-out' },
  { id: 'quit', label: 'Quit the app', desktopOnly: true }
];

// ─── Key combinations as text ────────────────────────────────────────────────

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS']);
const NAMED: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  PrintScreen: 'PrintScreen', ScrollLock: 'ScrollLock', Pause: 'Pause', MediaPlayPause: 'MediaPlayPause'
};

// The key itself, by its place on the keyboard (so Shift or another layout does not change it)
function keyName(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(c)) return c;
  if (/^Numpad\d$/.test(c)) return `num${c.slice(6)}`;
  return NAMED[c] ?? null;
}

// null while only modifiers are held (or a key we have no name for)
export function comboOf(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = keyName(e);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(key);
  return parts.join('+');
}

export const show = (combo: string) => combo.split('+').join(' + ');

// A letter, digit or punctuation key alone (or with Shift) would be typed into the chat instead
const TYPED = /^([A-Z0-9]|[-=[\]\\;',./`]|Space|Enter|Tab|Backspace|Delete|num.+)$/;
// What copy, paste and the like need
const RESERVED = new Set(['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Meta+C', 'Meta+V', 'Meta+X', 'Meta+A', 'Meta+Z']);

// Why a combination can not be used for `id`, or '' when it can
export function problemWith(combo: string, id: ShortcutId): string {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const modified = parts.some(p => p === 'Ctrl' || p === 'Alt' || p === 'Meta');
  if (TYPED.test(key) && !modified) return 'Add Ctrl, Alt or the Windows/Command key, or the key would be typed into the chat.';
  if (RESERVED.has(combo)) return `${show(combo)} is needed for copying and pasting.`;
  const other = SHORTCUTS.find(s => s.id !== id && store.settings.shortcuts[s.id] === combo);
  if (other) return `${show(combo)} already does "${other.label}".`;
  return '';
}

export function setShortcut(id: ShortcutId, combo: string | null): void {
  const next = { ...store.settings.shortcuts };
  if (combo) next[id] = combo; else delete next[id];
  store.settings.shortcuts = next;
  store.saveSettings();
}

// ─── State shared with the settings page ─────────────────────────────────────

class ShortcutState {
  // The action being given a new key combination: the window's own handling is off meanwhile
  recording = $state<ShortcutId | null>(null);
  // Actions whose system-wide registration the system refused (another program has the keys)
  refused = $state<string[]>([]);
  // Wayland: the desktop itself decides whether an app may listen for keys in the background
  wayland = $state(false);
}
export const shortcutState = new ShortcutState();

// ─── Doing what a shortcut says ──────────────────────────────────────────────

// The window and the system-wide registration can both report one press: it counts once
const lastRun = new Map<string, number>();

export function runShortcut(id: string): void {
  const now = performance.now();
  if (now - (lastRun.get(id) ?? -1e9) < 250) return;
  lastRun.set(id, now);
  // Voice runs on one server (maybe not the one on screen), like the tray's menu
  const target = sessions.voiceSession ?? sessions.active;
  const self = target.self;
  switch (id) {
    case 'mute': if (self) target.setSelfMute(!self.selfMute); else sessions.mute = !sessions.mute; break;
    case 'deafen': if (self) target.setSelfDeaf(!self.selfDeaf); else sessions.deaf = !sessions.deaf; break;
    case 'disconnect': if (target.server) sessions.close(target.server.id); break;
    // The picture on the stage (see VoiceStage.svelte) knows which one is meant
    case 'fullscreen': case 'popout': window.dispatchEvent(new CustomEvent('mumh5-shortcut', { detail: id })); break;
    case 'quit': if (desktop) void desktop.system.quit(); break;
  }
}

const isId = (id: string): id is ShortcutId => SHORTCUTS.some(s => s.id === id);

export function startShortcuts(): void {
  // In the window: while it has the focus
  window.addEventListener('keydown', e => {
    if (e.repeat || shortcutState.recording) return;
    const combo = comboOf(e);
    if (!combo) return;
    const hit = SHORTCUTS.find(s => store.settings.shortcuts[s.id] === combo && (!s.desktopOnly || desktop));
    if (!hit) return;
    // With Ctrl, Alt or the Windows key held a shortcut works in a text box too; a bare key (F9) never types anything
    e.preventDefault();
    runShortcut(hit.id);
  }, true);

  const api = desktop;
  if (!api) return;
  // Across the system: the desktop app registers the list again each time it changes
  $effect.root(() => {
    $effect(() => {
      const on = store.settings.shortcutsGlobal;
      const list = on
        ? SHORTCUTS.filter(s => store.settings.shortcuts[s.id])
            .map(s => ({ id: s.id, accelerator: store.settings.shortcuts[s.id].replace(/\bMeta\b/, 'Super') }))
        : [];
      api.shortcuts.setGlobal(list).then(r => {
        shortcutState.refused = r.failed;
        shortcutState.wayland = r.wayland;
      }, () => {});
    });
  });
  api.onTrayAction(action => {
    if (action.startsWith('shortcut:')) {
      const id = action.slice(9);
      if (isId(id)) runShortcut(id);
    }
  });
}
