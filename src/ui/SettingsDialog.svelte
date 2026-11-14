<script lang="ts">
  import Modal from './Modal.svelte';
  import VoiceSettings from './VoiceSettings.svelte';
  import IdentityList from './IdentityList.svelte';
  import AppearanceSettings from './AppearanceSettings.svelte';
  import SoundSettings from './SoundSettings.svelte';
  import ShortcutSettings from './ShortcutSettings.svelte';
  import { store } from '../lib/settings.svelte.ts';
  import { native, desktop } from '../lib/native.ts';
  import { youtubeAccount as yt } from '../lib/youtube-account.svelte.ts';
  import YouTubeSignIn from './YouTubeSignIn.svelte';
  import { previewMode } from '../lib/preview.ts';
  import { files } from '../lib/files.svelte.ts';
  import { formatBytes } from '../lib/html.ts';
  import { SHARE_BITRATES } from '../lib/share.svelte.ts';

  let { onclose, tab: initialTab = 'voice' }: { onclose: () => void; tab?: 'voice' | 'sounds' | 'appearance' | 'accessibility' | 'files' | 'system' | 'identities' } = $props();

  // svelte-ignore state_referenced_locally
  // The same steps as the stream bitrate, then no limit at all
  const UPLOAD_LIMITS = [...SHARE_BITRATES, 0];
  const uploadLabel = $derived(Number(store.settings.uploadLimit) > 0 ? `${store.settings.uploadLimit} Mbit/s` : 'Unlimited');
  let tab = $state<'voice' | 'sounds' | 'appearance' | 'accessibility' | 'files' | 'system' | 'identities'>(initialTab);
  const s = store.settings;
  let embedHosts = $state(s.embedHosts.join('\n'));

  // Public STUN servers to pick from; anything else is typed in
  const STUN_PRESETS = [
    { name: 'Google', url: 'stun.l.google.com:19302' },
    { name: 'Cloudflare', url: 'stun.cloudflare.com:3478' }
  ];
  let stunCustom = $state(!!s.stunServer && !STUN_PRESETS.some(p => p.url === s.stunServer));
  const stunChoice = $derived(stunCustom ? 'custom' : s.stunServer);
  function chooseStun(value: string) {
    stunCustom = value === 'custom';
    // Keep what was typed when switching to "another server"
    if (!stunCustom) s.stunServer = value;
    else if (STUN_PRESETS.some(p => p.url === s.stunServer)) s.stunServer = '';
    store.saveSettings();
  }
  // Changes apply right away
  function saveFiles() {
    s.embedHosts = embedHosts.split(/[\s,]+/).map(h => h.trim()).filter(Boolean);
    store.saveSettings();
  }
  // System (desktop app): what Chromium reads at start-up, so changes need a restart
  let hwAccel = $state(true);
  let hwStarted = $state(true);
  let hwError = $state('');
  let autoUpdate = $state(true);
  let updBusy = $state(false);
  let updMsg = $state('');
  async function setAutoUpdate() {
    try { await desktop!.system.setAutoUpdate(autoUpdate); }
    catch (e) { autoUpdate = !autoUpdate; updMsg = `Could not save: ${(e as Error).message}`; }
  }
  async function updateNow() {
    updBusy = true; updMsg = 'Checking for updates...';
    const off = desktop!.update.onProgress((done, total) => { updMsg = total ? `Downloading... ${Math.round(done / total * 100)}%` : 'Downloading...'; });
    try {
      const u = await desktop!.update.check();
      if (!u.available) { updMsg = `Libertad ${u.current} is up to date.`; return; }
      updMsg = `Found ${u.latest}. Downloading...`;
      await desktop!.update.install();
      updMsg = u.kind === 'windows' ? 'The installer is open; follow it to finish.' : u.kind === 'manual' ? 'Opened the download page.' : 'Updated. Restarting...';
    } catch (e) { updMsg = `Update failed: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`; }
    finally { off(); updBusy = false; }
  }
  let startup = $state(false);
  let startupError = $state('');
  $effect(() => { if (tab === 'system') yt.refresh(); });
  $effect(() => {
    if (tab === 'system' && desktop) desktop.system.get().then(i => { hwAccel = hwStarted = i.hardwareAcceleration; autoUpdate = i.autoUpdate; startup = i.launchOnStartup; }).catch(() => {});
  });
  async function setStartup() {
    startupError = '';
    try { await desktop!.system.setLaunchOnStartup(startup); }
    catch (e) { startup = !startup; startupError = `Could not save: ${(e as Error).message}`; }
  }
  async function setHwAccel() {
    hwError = '';
    try { await desktop!.system.setHardwareAcceleration(hwAccel); }
    catch (e) { hwAccel = !hwAccel; hwError = `Could not save: ${(e as Error).message}`; }
  }
  // How much the kept files take, once the tab is open
  $effect(() => { if (tab === 'files') files.measure(); });

  type Tab = 'voice' | 'sounds' | 'appearance' | 'accessibility' | 'files' | 'system' | 'identities';
  const tabs: { id: Tab; label: string }[] = [
    { id: 'voice', label: 'Voice' },
    { id: 'sounds', label: 'Sounds' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'accessibility', label: 'Accessibility' },
    { id: 'files', label: 'Chat and files' },
    ...(desktop ? [{ id: 'system' as Tab, label: 'System' }] : []),
    ...(native ? [{ id: 'identities' as Tab, label: 'Identities' }] : [])
  ];
</script>

<Modal title="Settings" onclose={() => { saveFiles(); onclose(); }} width={880}>
  <div class="layout">
  <div class="tabs" role="tablist">
    {#each tabs as t (t.id)}
      <button role="tab" aria-selected={tab === t.id} class:active={tab === t.id} onclick={() => (tab = t.id)}>{t.label}</button>
    {/each}
  </div>

  <div class="pane" role="tabpanel">
  {#if tab === 'voice'}
    <VoiceSettings />
    <h3>Screen sharing</h3>
    <label for="s-stun">STUN server</label>
    <select id="s-stun" value={stunChoice} onchange={e => chooseStun(e.currentTarget.value)}>
      <option value="">None (same network only)</option>
      {#each STUN_PRESETS as p (p.url)}<option value={p.url}>{p.name} ({p.url})</option>{/each}
      <option value="custom">Another server...</option>
    </select>
    {#if stunChoice === 'custom'}
      <input class="stun-custom" bind:value={s.stunServer} onchange={() => store.saveSettings()} placeholder="stun.example.com:3478" autocomplete="off" aria-label="STUN server address" />
    {/if}
    <label for="s-relay">Relay <span class="opt">(optional)</span></label>
    <input id="s-relay" bind:value={s.relayServer} onchange={() => { s.relayServer = s.relayServer.trim(); store.saveSettings(); }}
      placeholder="https://voice.example.com" autocomplete="off" />
    <p class="help">The address of a Libertad relay server. When a direct connection is not possible (mobile data, strict company networks), the stream goes through that server instead, by itself. Its operator sees your IP address and carries the stream, but cannot watch it.</p>
    <p class="help">Screen sharing connects you directly to the people watching. Across the internet both sides need a STUN server to find a route; it learns your IP address but never sees the stream. With none, no outside server is contacted and streams only work on the same network. Networks that block direct connections, like many mobile ones, need more than STUN.</p>
  {:else if tab === 'sounds'}
    <SoundSettings />
  {:else if tab === 'appearance'}
    <AppearanceSettings />
  {:else if tab === 'accessibility'}
    <label class="check"><input type="checkbox" bind:checked={s.hints} onchange={() => store.saveSettings()} /> Show hints when the pointer rests on buttons and icons</label>
    <p class="help">Hints are the small labels that appear on hover. Screen readers get the names either way.</p>
    <ShortcutSettings />
  {:else if tab === 'files'}
    <p class="help">Files go directly from computer to computer to other Libertad users, over an encrypted WebRTC connection, and use the same STUN and relay servers as screen sharing. If no direct connection is possible, the Mumble server carries the file instead, about 12 MB a minute from each person who has it on a server with default limits. Regular Mumble users see the name and the preview picture. Small pictures go inline for everyone.</p>
    <label for="s-auto">Download files by themselves up to</label>
    <select id="s-auto" value={String(s.autoDownload)} onchange={e => { s.autoDownload = Number(e.currentTarget.value); saveFiles(); }}>
      <option value="0">Never, only when clicked</option>
      <option value="5">5 MB</option>
      <option value="20">20 MB</option>
      <option value="100">100 MB</option>
      <option value="500">500 MB</option>
    </select>
    <p class="help">Files of 256 MB and up always wait for a click, then ask where to save. They are written straight to that place and not kept in the app, so they take space only once.</p>
    <label for="s-banner">Largest profile picture, banner or card to fetch from other people (Mbit)</label>
    <input id="s-banner" type="number" min="0" max="1000" step="1" value={s.bannerMaxMbit}
      onchange={e => { const v = Math.min(1000, Math.max(0, Math.round(Number(e.currentTarget.value)) || 0)); s.bannerMaxMbit = v; e.currentTarget.value = String(v); saveFiles(); }} />
    <p class="help">Avatars, banners and cards (pictures, GIFs and videos) are shared directly from the other person's computer over WebRTC, and are fetched when you see them, as long as they are no larger than this. 8 Mbit is 1 MB. Enter 0 to never fetch them; you then see plain colors and letters.</p>
    <label class="check"><input type="checkbox" bind:checked={s.sendThumbnails} onchange={saveFiles} /> Send a preview picture with pictures and videos</label>
    <div class="row kept">
      <p class="help">Files under 256 MB that you sent or received are kept on this computer, up to 100 GB, so others can get them from you later. {files.usage != null ? `In use: ${formatBytes(files.usage)}.` : ''}</p>
      <button class="btn" disabled={!files.usage} onclick={() => files.clear()}>Delete kept files</button>
    </div>

    <label for="s-upload">Upload speed limit: {uploadLabel}</label>
    <input id="s-upload" type="range" min="0" max={UPLOAD_LIMITS.length - 1} step="1" value={UPLOAD_LIMITS.indexOf(Number(s.uploadLimit) || 0)}
      oninput={e => { s.uploadLimit = UPLOAD_LIMITS[Number(e.currentTarget.value)]; saveFiles(); }} />
    <p class="help">The most this computer sends of files, all downloads by others added together. It does not limit your downloads, voice or screen sharing.</p>

    <h3>Embeds</h3>
    <label for="s-embed">Also show media inline from these hosts</label>
    <textarea id="s-embed" bind:value={embedHosts} onchange={saveFiles} rows="3" placeholder="one host per line, e.g. i.example.com"></textarea>
    <p class="help">Links from other hosts stay plain links, so opening a chat never contacts servers you did not choose.</p>
    <label for="s-lp">Link previews</label>
    <select id="s-lp" value={previewMode()} onchange={e => { s.linkPreviews = e.currentTarget.value as typeof s.linkPreviews; saveFiles(); }}>
      <option value="direct" disabled={!desktop}>Fetched by this computer (linked sites see your IP){desktop ? '' : ' - needs the desktop app'}</option>
      <option value="off">Off</option>
    </select>
    <label for="s-yt">YouTube links</label>
    <select id="s-yt" bind:value={s.youtube} onchange={saveFiles}>
      <option value="off">Plain links</option>
      <option value="click">Player card, loads from YouTube when clicked</option>
      <option value="thumbnail">Player card with thumbnail (loads the thumbnail from YouTube)</option>
    </select>
  {:else if tab === 'system'}
    {#if desktop}
      <div class="row kept">
        <label class="check first"><input type="checkbox" bind:checked={autoUpdate} onchange={setAutoUpdate} /> Auto update</label>
        <button class="btn" disabled={updBusy} onclick={updateNow}>Update</button>
      </div>
      <p class="help">Checks GitHub when Libertad starts (it compares the release file's checksum with yours) and asks before downloading it. The Update button checks and installs right away.</p>
      {#if updMsg}<p class="help">{updMsg}</p>{/if}
    {/if}
    <label class="check"><input type="checkbox" bind:checked={hwAccel} onchange={setHwAccel} /> Use hardware acceleration</label>
    <p class="help">Lets the graphics card draw the app, encode and decode shared screens, and convert videos for Torrent Together (HEVC, Blu-ray, DTS), which takes load off the processor. Turn it off if the picture flickers, tears or streams glitch.</p>
    {#if hwAccel !== hwStarted}
      <div class="row kept">
        <p class="help">Restart Libertad to apply this.</p>
        <button class="btn primary" onclick={() => desktop!.system.relaunch()}>Restart now</button>
      </div>
    {/if}
    {#if hwError}<p class="help warn">{hwError}</p>{/if}
    {#if desktop}
      <label class="check"><input type="checkbox" bind:checked={startup} onchange={setStartup} /> Run on system startup</label>
      <p class="help">Starts Libertad when you sign in to your computer.</p>
      {#if startupError}<p class="help warn">{startupError}</p>{/if}
    {/if}
    <label class="check"><input type="checkbox" bind:checked={store.settings.connectOnStart} onchange={() => store.saveSettings()} /> Connect to the last channel on app startup</label>
    <p class="help">When Libertad opens, it connects to the server you were last on and joins the channel you were last in.</p>
    {#if desktop}
      <h3>Accounts</h3>
      <div class="row kept">
        <p class="help">{yt.signedIn ? 'Signed in to YouTube.' : 'Not signed in to YouTube.'} Signing in helps when YouTube asks the player to confirm it is not a bot. It applies to the next video you play.</p>
        {#if yt.signedIn}
          <button class="btn" onclick={() => yt.signOut()} disabled={yt.busy}>Sign out</button>
        {:else}
          <button class="btn primary" onclick={() => yt.signIn()} disabled={yt.busy}>Sign in to YouTube</button>
        {/if}
      </div>
      <label class="check"><input type="checkbox" checked={yt.noHistory} onchange={e => yt.setNoHistory(e.currentTarget.checked)} /> Don't sync history with YouTube</label>
      <p class="help">Videos watched here are not added to your YouTube watch history. This works by not sending the reports that YouTube's player makes, so it can stop working if YouTube changes them.</p>
      {#if yt.error && !yt.dialog}<p class="help warn">{yt.error}</p>{/if}
      {#if yt.dialog}<YouTubeSignIn />{/if}
    {/if}
  {:else}
    <p class="help">Servers recognize you by your certificate. The default is used unless a server is set to another one.</p>
    <IdentityList />
  {/if}
  </div>
  </div>

  {#snippet footer()}
    <button class="btn primary" onclick={() => { saveFiles(); onclose(); }}>Done</button>
  {/snippet}
</Modal>

<style>
  /* Sections listed on the left, the open one beside them; a row of tabs on narrow windows */
  /* A steady size, so the dialog does not jump between sections */
  .layout { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 28px; align-items: start; min-height: min(600px, calc(100vh - 190px)); }
  .tabs { position: sticky; top: 0; display: flex; flex-direction: column; gap: 2px; padding-top: 6px; }
  .tabs button { padding: 7px 10px; text-align: left; color: var(--text-dim); font-weight: 500; white-space: nowrap; transition: background 120ms var(--ease), color 120ms var(--ease); }
  .tabs button:hover { background: var(--bg-hover); color: var(--text); }
  .tabs button.active { background: var(--bg-active); color: var(--text); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
  .pane { min-width: 0; }
  @media (max-width: 760px) {
    .layout { grid-template-columns: minmax(0, 1fr); gap: 0; }
    .tabs { position: static; flex-direction: row; overflow-x: auto; margin: 8px 0 4px; padding-top: 0; border-bottom: 1px solid var(--line); }
    .tabs button { padding: 8px 12px; }
    .tabs button:hover { background: none; }
    .tabs button.active { background: none; box-shadow: inset 0 -2px 0 var(--accent); }
  }
  h3 { margin: 24px 0 0; font-size: 15px; font-weight: 650; }
  .stun-custom { margin-top: 6px; }
  .opt { text-transform: none; font-weight: 400; letter-spacing: 0; color: var(--text-faint); }
  .help { margin: 10px 0 0; font-size: 13px; color: var(--text-dim); }
  .row { display: flex; align-items: flex-end; gap: 8px; }
  .row.kept { align-items: center; margin-top: 10px; }
  .row.kept .help { flex: 1; margin: 0; }
  .check { display: flex; align-items: center; gap: 8px; text-transform: none; font-weight: 400; letter-spacing: 0; font-size: 14px; color: var(--text); margin-top: 14px; }
  select:disabled, input:disabled { opacity: 0.5; }
  textarea { resize: vertical; }
</style>
