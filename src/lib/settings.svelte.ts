import { load, loadList, save } from './storage.ts';
import { cleanColors, CUSTOM_DEFAULTS, isHex, type CustomColors } from './theme.ts';

function cleanPanelColors(raw: unknown): Settings['panelColors'] {
  const out: Settings['panelColors'] = {};
  if (raw && typeof raw === 'object') for (const k of ['left', 'middle', 'right'] as const) {
    const v = (raw as Record<string, unknown>)[k];
    if (isHex(v)) out[k] = v.toLowerCase();
  }
  return out;
}

export interface SavedServer {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  password: string;
  identityId?: string; // certificate to connect with; the default identity when unset
  icon?: string;       // custom rail icon, a small square data: image
}

export interface Settings {
  embedHosts: string[];    // hosts whose media links render inline
  sendThumbnails: boolean; // a preview picture with sent pictures and videos (all that other clients see)
  uploadLimit: number;     // fastest we send files, Mbit/s; 0: unlimited
  autoDownload: number;    // fetch announced files up to this many MB by themselves; 0: never
  bannerMaxMbit: number;   // fetch other people's banners shared over WebRTC up to this many Mbit; 0: never
  compact: boolean;
  youtube: 'off' | 'click' | 'thumbnail'; // YouTube links: plain, click-to-play card, card with thumbnail
  // Link previews: fetched by this computer (reveals IP to the linked site), or none
  linkPreviews: 'direct' | 'off';
  theme: ThemeId;
  customColors: CustomColors; // the colors of the "custom" scheme, each one freely chosen
  // A color chosen for a panel on its own (left: channels, middle: chat, right: members or chat); only in the custom scheme
  panelColors: Partial<Record<'left' | 'middle' | 'right', string>>;
  publicListUrl: string;  // where the public server list comes from
  // standard: the channel tree, chat and members side by side. rooms: one screen at a time, made for phones.
  interface: 'standard' | 'rooms';
  rounded: boolean;       // rounded corners on menus, windows, server icons and cards
  roundness: number;      // how round, 0 to 200 percent (only used while rounded is on)
  // See-through surfaces (Settings > Appearance): each of windows and menus, buttons and the bars and title
  // panels has how see-through it is (0 to 100 percent), and while it is, how dark and how blurred
  glassSync: boolean;           // changing one slider changes the same slider of the other two
  windowTransparency: number;
  windowDarkness: number;       // 0 to 95 percent
  windowBlurPx: number;         // 0 to 40 pixels
  buttonTransparency: number;
  buttonDarkness: number;
  buttonBlurPx: number;
  panelTransparency: number;
  panelDarkness: number;
  panelBlurPx: number;
  shareBitrate: number;   // upper limit of our stream's bitrate, Mbit/s
  shareHeight: number;    // largest picture height of our stream, in pixels (never above what the source has)
  shareFps: number;       // frame rate of our stream
  shareMode: 'fps' | 'quality'; // when the connection is tight: keep the frame rate (smooth) or the sharpness
  autoCameras: boolean;   // show other people's cameras as they come on
  shareCrossRoom: boolean; // what you host (a screen, a camera, a Watch Together) can be watched from other rooms; off: only from yours
  shareDynamicFps: boolean; // a screen share that shows nothing new is sent at 1 frame per second until something moves
  shareVolume: number;    // volume of streams we watch, 0 to 1
  relayServer: string;    // a Libertad web proxy whose STUN and relay to use for screen sharing
  stunServer: string;     // helps screen sharing connect through routers; empty contacts nobody
  shareNoticeSeen: boolean; // the note that screen sharing reveals IP addresses was confirmed
  hints: boolean;         // tooltips (title attributes) when resting the pointer on buttons
  connectOnStart: boolean; // at app start, connect to the server and channel you were last in
  subtitleLang: string;   // Torrent Together: the subtitle language to start with ('' = the system's languages, 'off' = none)
  subtitleSize: number;   // Torrent Together: subtitle text size, percent of the normal size
  subtitleX: number;      // Torrent Together: where the subtitles sit, 0 to 1 across the picture (their middle)
  subtitleY: number;      // ... and 0 to 1 down the picture (their bottom edge)
  subtitleOpacity: number; // Torrent Together: how solid the subtitles are, percent
  subtitleBg: boolean;     // Torrent Together: a dark box behind the subtitles
  subtitleBgOpacity: number; // Torrent Together: how dark that box is, percent
  shortcuts: Record<string, string>; // keyboard shortcuts by action id (see lib/shortcuts.svelte.ts), like "Ctrl+Shift+M"
  shortcutsGlobal: boolean;  // desktop app: they also work while Libertad is in the background
}

export type ThemeId = 'dark' | 'light' | 'midnight' | 'contrast' | 'abyss' | 'win95-light' | 'win95-dark' | 'custom';

export const THEMES: { id: ThemeId; name: string; note: string; light: boolean }[] = [
  { id: 'dark', name: 'Dark', note: 'The default', light: false },
  { id: 'light', name: 'Light', note: 'For bright rooms', light: true },
  { id: 'midnight', name: 'Midnight', note: 'True black, red accents', light: false },
  { id: 'contrast', name: 'High contrast', note: 'Black and white, strong lines', light: false },
  { id: 'abyss', name: 'Abyss', note: 'Blue-black, turquoise accents', light: false },
  { id: 'win95-light', name: 'Windows 95 Light', note: 'Start me up', light: true },
  { id: 'win95-dark', name: 'Windows 95 Dark', note: 'Start me up, after dark', light: false }
];

// A saved scheme that no longer exists: Windows 95 became Windows 95 Light, the removed ones become Dark
const KNOWN: string[] = [...THEMES.map(t => t.id), 'custom'];
export function normalizeTheme(id: unknown): ThemeId {
  if (id === 'win95') return 'win95-light';
  return typeof id === 'string' && KNOWN.includes(id) ? id as ThemeId : 'dark';
}

const defaults: Settings = {
  embedHosts: [],
  sendThumbnails: true,
  uploadLimit: 0,
  autoDownload: 20,
  bannerMaxMbit: 64,
  compact: false,
  youtube: 'off',
  linkPreviews: 'off',
  theme: 'dark',
  customColors: { ...CUSTOM_DEFAULTS },
  panelColors: {},
  publicListUrl: 'https://publist.mumble.info/v1/list?version=1.5.0',
  interface: 'standard',
  rounded: false,
  roundness: 50,
  glassSync: false,
  windowTransparency: 0,
  windowDarkness: 40,
  windowBlurPx: 10,
  buttonTransparency: 0,
  buttonDarkness: 40,
  buttonBlurPx: 10,
  panelTransparency: 100,
  panelDarkness: 40,
  panelBlurPx: 10,
  shareBitrate: 4,
  shareHeight: 1080,
  shareFps: 30,
  shareMode: 'quality',
  autoCameras: true,
  shareCrossRoom: true,
  shareDynamicFps: true,
  shareVolume: 1,
  relayServer: '',
  stunServer: '',
  shareNoticeSeen: false,
  hints: false,
  connectOnStart: false,
  subtitleLang: '',
  subtitleSize: 100,
  subtitleX: 0.5,
  subtitleY: 0.92,
  subtitleOpacity: 100,
  subtitleBg: true,
  subtitleBgOpacity: 65,
  shortcuts: {},
  shortcutsGlobal: false
};

// The see-through settings as numbers in range. Older settings had a Transparent panels checkbox with
// Darker and Blurred checkboxes: off meant solid, and a dark or blur checkbox off meant none of it.
function glassFix(s: Settings): Partial<Settings> {
  const old = s as unknown as { panelClear?: boolean; panelDark?: boolean; panelBlur?: boolean };
  const num = (v: unknown, max: number, d: number) => Math.min(max, Math.max(0, Math.round(Number(v ?? d)) || 0));
  const migrate = s.panelTransparency === undefined;
  return {
    glassSync: !!s.glassSync,
    windowTransparency: num(s.windowTransparency, 100, 0), windowDarkness: num(s.windowDarkness, 95, 40), windowBlurPx: num(s.windowBlurPx, 40, 10),
    buttonTransparency: num(s.buttonTransparency, 100, 0), buttonDarkness: num(s.buttonDarkness, 95, 40), buttonBlurPx: num(s.buttonBlurPx, 40, 10),
    panelTransparency: num(migrate ? (old.panelClear === false ? 0 : 100) : s.panelTransparency, 100, 100),
    panelDarkness: migrate && old.panelDark === false ? 0 : num(s.panelDarkness, 95, 40),
    panelBlurPx: migrate && old.panelBlur === false ? 0 : num(s.panelBlurPx, 40, 10)
  };
}

class SettingsStore {
  settings = $state<Settings>(this.fix(load('libertad.settings', defaults)));

  private fix(s: Settings): Settings {
    return { ...s, theme: normalizeTheme(s.theme), customColors: cleanColors(s.customColors), panelColors: cleanPanelColors(s.panelColors), bannerMaxMbit: Math.min(1000, Math.max(0, Number(s.bannerMaxMbit) || 0)), roundness: Math.min(200, Math.max(0, Math.round(Number(s.roundness)) || 0)), ...glassFix(s) };
  }
  servers = $state<SavedServer[]>(loadList('libertad.servers'));
  // Pinned sha256 fingerprints of server certificates, keyed by host:port (trust on first use)
  pins = $state<Record<string, string>>(load('libertad.pins', {}));
  // Username to suggest when connecting with an identity, keyed by identity id
  identityNames = $state<Record<string, string>>(load('libertad.identityNames', {}));
  // Local nicknames for other users, only visible to us; keyed by certificate hash (or name)
  nicknames = $state<Record<string, string>>(load('libertad.nicknames', {}));

  setIdentityName(id: string, name: string) {
    if (name.trim()) this.identityNames[id] = name.trim();
    else delete this.identityNames[id];
    save('libertad.identityNames', $state.snapshot(this.identityNames));
  }

  saveSettings() { save('libertad.settings', $state.snapshot(this.settings)); }

  // The server and channel you were last in (serverId '' until there is one); kept whether or not
  // "connect on start" is on, so turning it on has something to go back to
  lastChannel = $state<{ serverId: string; channelId: number; name: string }>(load('libertad.lastChannel', { serverId: '', channelId: 0, name: '' }));
  rememberChannel(serverId: string, channelId: number, name: string) {
    const l = this.lastChannel;
    if (l.serverId === serverId && l.channelId === channelId && l.name === name) return;
    this.lastChannel = { serverId, channelId, name };
    save('libertad.lastChannel', $state.snapshot(this.lastChannel));
  }

  upsertServer(s: SavedServer) {
    const i = this.servers.findIndex(x => x.id === s.id);
    if (i === -1) this.servers.push(s);
    else this.servers[i] = s;
    save('libertad.servers', $state.snapshot(this.servers));
  }

  // Reorder the server list (drag and drop in the rail)
  moveServer(id: string, toIndex: number) {
    const from = this.servers.findIndex(s => s.id === id);
    if (from < 0) return;
    const list = [...this.servers];
    const [item] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, item);
    this.servers = list;
    save('libertad.servers', $state.snapshot(this.servers));
  }

  setServerIcon(id: string, icon: string | undefined) {
    const s = this.servers.find(x => x.id === id);
    if (!s) return;
    if (icon) s.icon = icon;
    else delete s.icon;
    save('libertad.servers', $state.snapshot(this.servers));
  }

  removeServer(id: string) {
    this.servers = this.servers.filter(s => s.id !== id);
    save('libertad.servers', $state.snapshot(this.servers));
  }

  setNickname(key: string, nick: string) {
    if (nick.trim()) this.nicknames[key] = nick.trim();
    else delete this.nicknames[key];
    save('libertad.nicknames', $state.snapshot(this.nicknames));
  }

  // Name to show for a user: our local nickname, else their name
  displayName(u: { hash: string; name: string }): string {
    return this.nicknames[u.hash || `name:${u.name}`] ?? u.name;
  }

  pin(hostPort: string, fingerprint: string) {
    this.pins[hostPort] = fingerprint;
    save('libertad.pins', $state.snapshot(this.pins));
  }

  // Hosts whose media links are embedded, as the user listed them.
  // Other links stay plain links, so opening a chat never pings arbitrary servers.
  get trustedHosts(): string[] {
    return this.settings.embedHosts.map(h => h.trim().toLowerCase()).filter(Boolean);
  }
}

export const store = new SettingsStore();
