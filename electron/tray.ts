import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// State the renderer reports; the tray mirrors it
export interface TrayState {
  icon: string;             // PNG data URL drawn by the renderer
  tooltip: string;
  connected: boolean;
  server: string;
  muted: boolean;
  deafened: boolean;
  mode: 'vad' | 'ptt' | 'continuous';
}

let tray: Tray | null = null;
let state: TrayState | null = null;
let closeToTray = true;
let quitting = false;
const images = new Map<string, Electron.NativeImage>();
let shownIcon = '';
let shownTip = '';
let menuKey = '';
const prefsFile = () => path.join(app.getPath('userData'), 'tray.json');

// `revive` makes the window again when the app let it go to save memory (only asked for when the person wants it back)
export async function setupTray(getWindow: () => BrowserWindow | null, send: (action: string) => void, revive?: () => BrowserWindow | null): Promise<void> {
  try { closeToTray = JSON.parse(await fs.readFile(prefsFile(), 'utf8')).closeToTray !== false; } catch { /* defaults */ }

  const show = () => {
    const win = getWindow() ?? revive?.() ?? null;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const rebuild = () => {
    if (!tray || !state) return;
    const win = getWindow();
    const s = state;
    const menu = Menu.buildFromTemplate([
      // Clicking the icon shows and hides the window. Some Linux desktops never deliver that click, so there the
      // menu offers Show while the window is hidden (it is not in the menu otherwise)
      ...(process.platform === 'linux' && !win?.isVisible()
        ? [{ label: 'Show Libertad', click: show }, { type: 'separator' as const }]
        : []),
      { label: s.connected ? `Connected: ${s.server}` : 'Not connected', enabled: false },
      { label: 'Disconnect', enabled: s.connected, click: () => send('disconnect') },
      { type: 'separator' },
      {
        label: 'Transmit', submenu: [
          { label: 'Voice activity', type: 'radio', checked: s.mode === 'vad', click: () => send('mode:vad') },
          { label: 'Push to talk', type: 'radio', checked: s.mode === 'ptt', click: () => send('mode:ptt') },
          { label: 'Always on', type: 'radio', checked: s.mode === 'continuous', click: () => send('mode:continuous') }
        ]
      },
      { label: 'Settings', click: () => { show(); send('settings'); } },
      { label: 'Mute', type: 'checkbox', checked: s.muted, enabled: s.connected, click: () => send('toggle-mute') },
      { label: 'Deafen', type: 'checkbox', checked: s.deafened, enabled: s.connected, click: () => send('toggle-deafen') },
      { type: 'separator' },
      {
        label: 'Close to tray', type: 'checkbox', checked: closeToTray, click: item => {
          closeToTray = item.checked;
          fs.writeFile(prefsFile(), JSON.stringify({ closeToTray })).catch(() => {});
        }
      },
      { label: 'Quit Libertad', click: () => { quitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    menuKey = [s.connected, s.server, s.muted, s.deafened, s.mode].join('|');
    // Inspection hook for the end-to-end tests (tray menus cannot be clicked by automation)
    (globalThis as any).__libertadTray = {
      state: { ...s, icon: s.icon.slice(0, 22) },
      tooltip: s.tooltip,
      items: menu.items.map(i => ({ label: i.label, checked: i.checked, enabled: i.enabled })),
      click: (label: string) => { const item = menu.items.find(i => i.label === label); item?.click(undefined, getWindow() ?? undefined, getWindow()?.webContents); }
    };
  };

  app.on('before-quit', () => { quitting = true; });

  // Called for every state change from the renderer
  update = (next: TrayState) => {
    state = next;
    // The same picture is decoded once, and the icon, tooltip and menu are only touched when they differ
    let image = images.get(next.icon);
    if (!image) {
      image = nativeImage.createFromDataURL(next.icon);
      if (images.size >= 16) images.clear();
      images.set(next.icon, image);
    }
    const iconChanged = next.icon !== shownIcon;
    const tipChanged = next.tooltip !== shownTip;
    shownIcon = next.icon;
    shownTip = next.tooltip;
    if (!tray) {
      tray = new Tray(image);
      // Click on the icon: hide the window if it is showing, else bring it back
      tray.on('click', () => {
        const win = getWindow();
        if (win && win.isVisible() && !win.isMinimized()) win.hide(); else show();
      });
    } else if (iconChanged) {
      tray.setImage(image);
    }
    if (tipChanged) tray.setToolTip(next.tooltip);
    const key = [next.connected, next.server, next.muted, next.deafened, next.mode].join('|');
    if (key !== menuKey) rebuild();
    else {
      const hook = (globalThis as any).__libertadTray;
      if (hook) { hook.state = { ...next, icon: next.icon.slice(0, 22) }; hook.tooltip = next.tooltip; }
    }
  };

  // Keep the menu right (the Linux Show item follows the window)
  onWindowVisibility = rebuild;
}

export let update: (s: TrayState) => void = () => {};
export let onWindowVisibility: () => void = () => {};

// Closing the window hides it while the tray is there, unless the user quits
export function shouldHideOnClose(): boolean {
  return !!tray && closeToTray && !quitting && process.platform !== 'darwin';
}

// Quits for real, also with the window hidden to the tray
export function quitApp(): void {
  quitting = true;
  app.quit();
}
