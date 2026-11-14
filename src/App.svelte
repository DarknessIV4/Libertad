<script lang="ts">
  import ServerRail from './ui/ServerRail.svelte';
  import { applyCustom, clearCustom, cleanColors } from './lib/theme.ts';
  import Sidebar from './ui/Sidebar.svelte';
  import Chat from './ui/Chat.svelte';
  import RightPanel from './ui/RightPanel.svelte';
  import ConnectDialog from './ui/ConnectDialog.svelte';
  import SettingsDialog from './ui/SettingsDialog.svelte';
  import CertDialog from './ui/CertDialog.svelte';
  import CertViewer from './ui/CertViewer.svelte';
  import PromptDialog from './ui/PromptDialog.svelte';
  import UpdateDialog from './ui/UpdateDialog.svelte';
  import RoomPicker from './ui/RoomPicker.svelte';
  import TitleBar from './ui/TitleBar.svelte';
  import { titlebar } from './lib/titlebar.svelte.ts';
  import { roles } from './lib/roles.svelte.ts';
  import { deafenFor } from './lib/deafen-for.svelte.ts';
  import ContextMenu from './ui/ContextMenu.svelte';
  import ColorPicker from './ui/ColorPicker.svelte';
  import ImageEditor from './ui/ImageEditor.svelte';
  import IdentityWizard from './ui/IdentityWizard.svelte';
  import QuickAudio from './ui/QuickAudio.svelte';
  import UserInfoDialog from './ui/UserInfoDialog.svelte';
  import ChannelDialog from './ui/ChannelDialog.svelte';
  import PublicServers from './ui/PublicServers.svelte';
  import ServerInfoDialog from './ui/ServerInfoDialog.svelte';
  import ImageViewer from './ui/ImageViewer.svelte';
  import ShareDialog from './ui/ShareDialog.svelte';
  import ProfileCard from './ui/ProfileCard.svelte';
  import ChatPanel from './ui/ChatPanel.svelte';
  import ChatDragOverlay from './ui/ChatDragOverlay.svelte';
  import { chatDock } from './lib/chat-dock.svelte.ts';
  import BgLayers from './ui/BgLayers.svelte';
  import CustomBg from './ui/CustomBg.svelte';
  import { customBg, PANELS } from './lib/custom-bg.svelte.ts';
  import { isHex } from './lib/theme.ts';
  import Home from './ui/Home.svelte';
  import { share } from './lib/share.svelte.ts';
  import Shell from './ui2/Shell.svelte';
  import { identities } from './lib/identities.svelte.ts';
  import { session, sessions } from './lib/session.svelte.ts';
  import { ui } from './lib/ui.svelte.ts';
  import { store, type SavedServer } from './lib/settings.svelte.ts';
  import { onMount } from 'svelte';

  // Connect on start: once per launch, back to the server and channel you were last in
  onMount(() => { if (store.settings.connectOnStart) sessions.restoreLast(); });

  let width = $state(window.innerWidth);
  // wide: rail + sidebar + chat + panel; medium: panel as an overlay; narrow: everything but chat in drawers
  const layout = $derived(width >= 1100 ? 'wide' : width >= 760 ? 'medium' : 'narrow');

  // The member panel sits inline on wide windows, otherwise it overlays
  const panelInline = $derived(layout === 'wide');

  let navOpen = $state(false);
  let editing = $state<{ server: SavedServer | null } | null>(null);

  // Not connected to the server shown: the start screen with the saved servers takes the window
  const home = $derived(session.status === 'idle');

  // The chat dragged to the right: it takes the member list's place and the user cards take the middle
  const chatRight = $derived(chatDock.side === 'right' && panelInline && session.status === 'connected');
  $effect(() => { chatDock.enabled = panelInline && session.status === 'connected' && !home; });
  const showPanel = $derived(ui.panelOpen && session.status === 'connected');
  // Panels that are on screen, for the backgrounds that sit behind them
  const present = $derived({ left: layout !== 'narrow', middle: true, right: panelInline && (chatRight || showPanel) });
  const colored = (k: 'left' | 'middle' | 'right') => store.settings.theme === 'custom' && isHex(store.settings.panelColors?.[k]);
  // Panels that turn see-through because a picture shows behind them (their own, or the whole background
  // unless they have a color of their own)
  const seeThrough = $derived(home ? '' : PANELS.filter(k => present[k] && (customBg.has(k) || (customBg.has('whole') && !colored(k)))).join(' '));

  // Color scheme on the root element; dark is the stylesheet default
  $effect(() => {
    const t = store.settings.theme;
    const root = document.documentElement;
    if (t && t !== 'dark') root.dataset.theme = t;
    else delete root.dataset.theme;
    // The custom scheme is the user's own colors, set as variables on the root
    if (t === 'custom') applyCustom(root, cleanColors($state.snapshot(store.settings.customColors)));
    else clearCustom(root);
  });

  // Room for the window's own title bar at the top (0 without it); the layout, the backgrounds and the dialogs read it
  $effect(() => { document.documentElement.style.setProperty('--titlebar-h', `${titlebar.height}px`); });

  // The Admin role: the SuperUser reads who is in the group once per server; everyone else checks the note kept on
  // this computer against what the server says they may do
  const superOf = $derived(session.status === 'connected' && roles.isSuper(session) ? (session.server?.id ?? null) : null);
  $effect(() => { if (superOf) void roles.refresh(session); });
  $effect(() => { void session.tick; if (session.status === 'connected') roles.verify(session); });

  // "Deafen for me": who hears your voice follows who is in your channel (and leaves with the connection)
  $effect(() => { deafenFor.sync(); });

  // Rounded edges: a flag and a 0 to 1 factor on the root element, which themes.css turns into radii
  $effect(() => {
    const root = document.documentElement;
    if (store.settings.rounded) {
      root.dataset.rounded = '';
      root.style.setProperty('--round', String(Math.min(200, Math.max(0, Number(store.settings.roundness) || 0)) / 100));
    } else {
      delete root.dataset.rounded;
      root.style.removeProperty('--round');
    }
  });

  // Windows and menus, buttons, and the bars and title panels: see-through, darkened, blurred (Settings > Appearance).
  // Each is a share of solid color (100 minus the transparency), a black shade and a blur, as variables on the root;
  // glass.css and the panels read them. At 0 percent transparency nothing is changed, so darkness and blur do not count.
  $effect(() => {
    const root = document.documentElement, st = root.style, s = store.settings;
    const n = (v: unknown, max: number) => Math.min(max, Math.max(0, Number(v) || 0));
    const set = (key: 'window' | 'button' | 'panel', t: number, d: number, b: number) => {
      st.setProperty(`--${key === 'panel' ? 'panel' : key === 'button' ? 'btn' : 'win'}-solid`, `${100 - t}%`);
      st.setProperty(`--${key === 'panel' ? 'panel' : key === 'button' ? 'btn' : 'win'}-shade`, String(t > 0 ? d / 100 : 0));
      st.setProperty(`--${key === 'panel' ? 'panel' : key === 'button' ? 'btn' : 'win'}-blur`, `${t > 0 ? b : 0}px`);
    };
    const pt = n(s.panelTransparency, 100), bt = n(s.buttonTransparency, 100), wt = n(s.windowTransparency, 100);
    set('panel', pt, n(s.panelDarkness, 95), n(s.panelBlurPx, 40));
    set('button', bt, n(s.buttonDarkness, 95), n(s.buttonBlurPx, 40));
    set('window', wt, n(s.windowDarkness, 95), n(s.windowBlurPx, 40));
    st.setProperty('--glass-0', `color-mix(in srgb, var(--bg-0) ${100 - pt}%, transparent)`);
    st.setProperty('--glass-1', `color-mix(in srgb, var(--bg-1) ${100 - pt}%, transparent)`);
    st.setProperty('--panel-divider', pt > 0 ? `rgb(0 0 0 / ${n(s.panelDarkness, 95) / 100})` : 'var(--line)');
    root.toggleAttribute('data-btn-glass', bt > 0);
    root.toggleAttribute('data-win-glass', wt > 0);
  });

  // A color chosen for one panel (custom scheme only)
  $effect(() => {
    const root = document.documentElement;
    const custom = store.settings.theme === 'custom';
    for (const k of PANELS) {
      const v = store.settings.panelColors?.[k];
      if (custom && isHex(v)) root.style.setProperty(`--panel-${k}`, v);
      else root.style.removeProperty(`--panel-${k}`);
    }
  });

  // The panel starts open only where it sits inline
  let lastLayout = '';
  $effect(() => {
    if (layout === lastLayout) return;
    ui.panelOpen = panelInline;
    lastLayout = layout;
  });
  // On phones one drawer at a time
  $effect(() => { if (layout === 'narrow' && ui.panelOpen) navOpen = false; });
  // Opening a chat from anywhere (a profile card, a menu) shows it
  $effect(() => { void session.view; navOpen = false; });

  function togglePanel() {
    if (!ui.panelOpen) ui.panelOpen = true;
    else if (session.panel.kind !== 'members') session.closePanel();
    else ui.panelOpen = false;
  }

  // Images in rendered text (messages, descriptions, the quick preview) and image embeds open
  // large on click. Not in editors, link preview cards or the YouTube card.
  function imageClick(e: MouseEvent) {
    if (e.button !== 0 || !(e.target instanceof HTMLImageElement)) return;
    const img = e.target;
    if (!img.closest('.html, .embed') || img.closest('[contenteditable], .rich, .card, .yt, .poster')) return;
    e.preventDefault();
    e.stopPropagation();
    ui.image = img.currentSrc || img.src;
  }

  const closeOverlays = () => {
    navOpen = false;
    if (!panelInline) ui.panelOpen = false;
  };
</script>

<svelte:window bind:innerWidth={width} onclickcapture={imageClick} />

{#snippet rail()}
  <ServerRail onadd={() => (editing = { server: null })} onedit={s => (editing = { server: s })} onbrowse={() => (ui.publicServers = true)}
    onsettings={() => (ui.settingsOpen = true)} />
{/snippet}
{#snippet chat()}
  <Chat showMenu={layout === 'narrow'} onmenu={() => (navOpen = true)} onpanel={togglePanel} docked={chatRight && !home} />
{/snippet}

<TitleBar />
{#if store.settings.interface === 'rooms'}
<div class="framed"><Shell onadd={() => (editing = { server: null })} onedit={s => (editing = { server: s })} onbrowse={() => (ui.publicServers = true)} /></div>
{:else}
<div class="app {layout}" class:home data-wb={seeThrough} data-hb={home && (customBg.has('home') || customBg.homeColor) ? '' : undefined}>
  {#if home && (customBg.has('home') || customBg.homeColor)}
    <div class="homebg" aria-hidden="true" style:background-color={customBg.homeColor ?? undefined}>{#if customBg.has('home')}<CustomBg slot="home" />{/if}</div>
  {/if}
  {#if !home && customBg.any}<BgLayers {present} watch="{layout}{chatRight}{ui.panelOpen}{chatDock.width}{session.status}" />{/if}
  {#if home}
    {@render rail()}
    <Home onadd={() => (editing = { server: null })} onedit={s => (editing = { server: s })} onbrowse={() => (ui.publicServers = true)} />
  {:else}
    {#if layout !== 'narrow' || navOpen}
      <div class="nav" class:drawer={layout === 'narrow'}>
        {@render rail()}
        <Sidebar resizable={layout !== 'narrow'} onnavigate={() => { if (layout === 'narrow') navOpen = false; }} />
      </div>
      {#if layout === 'narrow'}<button class="scrim" aria-label="Close" onclick={() => (navOpen = false)}></button>{/if}
    {/if}
    {@render chat()}
  {/if}

  {#if chatRight && !home}
    <ChatPanel />
  {:else if showPanel}
    {#if panelInline}
      <RightPanel onnavigate={() => {}} onclose={() => (ui.panelOpen = false)} />
    {:else}
      <button class="scrim" aria-label="Close" onclick={() => (ui.panelOpen = false)}></button>
      <div class="panel-drawer"><RightPanel onnavigate={closeOverlays} onclose={() => (ui.panelOpen = false)} /></div>
    {/if}
  {/if}
</div>
{/if}

{#if editing}<ConnectDialog server={editing.server} onclose={() => (editing = null)} />{/if}
{#if ui.addServer}<ConnectDialog server={null} prefill={ui.addServer} onclose={() => (ui.addServer = null)} />{/if}
{#if ui.publicServers}<PublicServers onclose={() => (ui.publicServers = false)} />{/if}
{#if ui.serverInfo && session.status === 'connected'}<ServerInfoDialog onclose={() => (ui.serverInfo = false)} />{/if}
{#if ui.settingsOpen}<SettingsDialog tab={ui.settingsTab} onclose={() => { ui.settingsOpen = false; ui.settingsTab = 'voice'; }} />{/if}
{#if ui.quickAudio}<QuickAudio />{/if}
{#if ui.userInfo != null && session.status === 'connected'}
  {#key ui.userInfo}<UserInfoDialog target={ui.userInfo} onclose={() => (ui.userInfo = null)} />{/key}
{/if}
{#if session.certPrompt}<CertDialog />{/if}
{#if ui.cert}<CertViewer {...ui.cert} onclose={() => (ui.cert = null)} />{/if}
{#if identities.loaded && !identities.setupDone}<IdentityWizard mode="setup" onclose={() => {}} />
{:else if ui.wizard}<IdentityWizard mode={ui.wizard} onclose={() => (ui.wizard = null)} />{/if}
{#if ui.channelDialog && session.status === 'connected'}
  {#key ui.channelDialog}<ChannelDialog {...ui.channelDialog} onclose={() => (ui.channelDialog = null)} />{/key}
{/if}
{#if share.dialog}<ShareDialog onclose={() => (share.dialog = null)} />{/if}
{#if ui.roomPicker}<RoomPicker serverId={ui.roomPicker.serverId} onclose={() => (ui.roomPicker = null)} />{/if}
{#if ui.prompt}<PromptDialog {...ui.prompt} onclose={() => { const p = ui.prompt; ui.prompt = null; p?.oncancel?.(); }} />{/if}
<UpdateDialog />
<ProfileCard />
<ChatDragOverlay />
<ImageViewer />
<ContextMenu />
<ColorPicker />
<ImageEditor />

<style>
  /* clip, not only hidden: a hidden box can still be scrolled by the browser (to show a focused message box), which left the panels shifted up */
  .app { position: relative; height: 100%; display: flex; overflow: hidden; overflow: clip; isolation: isolate; padding-top: var(--titlebar-h, 0px); }
  /* The Rooms interface: the same room at the top for the title bar */
  .framed { height: 100%; padding-top: var(--titlebar-h, 0px); background: var(--bg-1); }
  /* Where a picture shows behind a panel, the panel lets it through */
  .app[data-wb~='left'] :global(.sidebar), .app[data-wb~='middle'] :global(section.chat),
  .app[data-wb~='right'] :global(aside.panel), .app[data-wb~='right'] :global(aside.cpanel) { background: transparent; }
  /* The start screen's own background, behind the server bar and the list; they let it through */
  .homebg { position: absolute; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
  .app[data-hb] :global(.home) { background: transparent; }
  .nav { display: flex; flex: none; min-height: 0; }
  .nav.drawer { position: absolute; z-index: 20; top: var(--titlebar-h, 0px); bottom: 0; left: 0; max-width: calc(100% - 48px); box-shadow: 8px 0 32px rgb(0 0 0 / 0.4); }
  .nav.drawer :global(.sidebar) { width: min(260px, calc(100vw - 68px - 48px)); }
  .scrim { position: absolute; inset: 0; z-index: 15; background: rgb(0 0 0 / 0.5); }
  .panel-drawer { position: absolute; z-index: 20; top: var(--titlebar-h, 0px); right: 0; bottom: 0; max-width: calc(100% - 48px); display: flex; box-shadow: -8px 0 32px rgb(0 0 0 / 0.4); }
</style>
