<script lang="ts">
  import { tip } from '../lib/tip.ts';
  import Icon from './Icon.svelte';
  import Avatar from './Avatar.svelte';
  import { session, sessions } from '../lib/session.svelte.ts';
  import { ui } from '../lib/ui.svelte.ts';
  import { menu } from '../lib/menu.svelte.ts';
  import { userMenu, openProfile } from '../lib/actions.ts';
  import { voice } from '../lib/audio/voice.svelte.ts';
  import { share } from '../lib/share.svelte.ts';
  import { watchTogether } from '../lib/watch-together.svelte.ts';

  // You and your buttons, under the channel list and on the start screen.
  // inline: you and the buttons side by side in one row (the start screen, which is wide)
  let { inline = false }: { inline?: boolean } = $props();

  const self = $derived(session.self);
  // Without a connection the buttons show the remembered choice, applied at the next connect
  const muted = $derived(self ? self.selfMute : sessions.mute);
  const deafened = $derived(self ? self.selfDeaf : sessions.deaf);

  // One session at a time (a screen, a camera or a watch together, on one server): its button stops it from
  // anywhere, and opening another of the three ends the first when the new one starts.
  const hostingWatch = $derived(watchTogether.isHostWithParty);
  const screenOn = $derived(!!share.stream && share.kind === 'screen');
  const cameraOn = $derived(!!share.stream && share.kind === 'camera');
  const canShare = $derived(session.status === 'connected' && share.supported(sessions.active));
  function toggle(kind: 'screen' | 'camera' | 'watch') {
    if (kind === 'watch' ? hostingWatch : kind === 'screen' ? screenOn : cameraOn) {
      if (kind === 'watch') void watchTogether.end(); else share.stop();
    } else share.start(sessions.active, kind);
  }

  function openQuick(e: MouseEvent, kind: 'input' | 'output') {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ui.quickAudio = { kind, x: r.left + r.width / 2, y: r.top };
  }
  import CrossRoomToggle from './CrossRoomToggle.svelte';
</script>

<footer class="me" class:inline>
    {#if self}
      <button class="profile" title="Your profile" onclick={e => openProfile(self.session, e.currentTarget)}
        oncontextmenu={e => menu.show(e, userMenu(self))}>
        <Avatar name={self.name} size={32} speaking={voice.transmitting} src={session.avatar(self.session)} />
        <span class="who">
          <strong>{self.name}</strong>
          <span>{voice.error ? 'Voice unavailable' : voice.settings.mode === 'ptt' && !self.selfMute ? (voice.pttDown ? 'Talking' : 'Push to talk') : session.channel(self.channelId)?.name || 'Root'}</span>
        </span>
      </button>
    {:else}
      <span class="who offline-who" title="Mute and deafen apply when you connect">
        <strong>{session.status === 'connecting' ? 'Connecting...' : 'Not connected'}</strong>
        <span>{deafened ? 'Deafened' : muted ? 'Muted' : 'Microphone on'}</span>
      </span>
    {/if}
  <div class="tools">
    <button class="icon-btn info" title="Server information" aria-label="Server information"
      disabled={session.status !== 'connected'} onclick={() => (ui.serverInfo = true)}>
      <Icon name="info" size={18} />
    </button>
    <button class="icon-btn" class:on={muted} title={muted ? 'Unmute (right-click for microphone options)' : 'Mute (right-click for microphone options)'}
      aria-label={muted ? 'Unmute' : 'Mute'}
      onclick={() => session.setSelfMute(!muted)} oncontextmenu={e => openQuick(e, 'input')}>
      <Icon name={muted ? 'mic-off' : 'mic'} size={18} />
    </button>
    <button class="icon-btn" class:on={deafened} title={deafened ? 'Undeafen (right-click for output options)' : 'Deafen (right-click for output options)'}
      aria-label={deafened ? 'Undeafen' : 'Deafen'}
      onclick={() => session.setSelfDeaf(!deafened)} oncontextmenu={e => openQuick(e, 'output')}>
      <Icon name={deafened ? 'headphones-off' : 'headphones'} size={18} />
    </button>
    <button use:tip class="icon-btn" class:live={screenOn} disabled={!screenOn && !canShare}
      title={screenOn ? 'Stop sharing your screen' : 'Share your screen or a window'} aria-label={screenOn ? 'Stop sharing your screen' : 'Share your screen or a window'} onclick={() => toggle('screen')}>
      <Icon name="screen" size={18} />
    </button>
    {#if screenOn}<CrossRoomToggle />{/if}
    <button use:tip class="icon-btn" class:live={cameraOn} disabled={!cameraOn && !canShare}
      title={cameraOn ? 'Stop sharing your camera' : 'Share your camera'} aria-label={cameraOn ? 'Stop sharing your camera' : 'Share your camera'} onclick={() => toggle('camera')}>
      <Icon name="camera" size={18} />
    </button>
    {#if cameraOn}<CrossRoomToggle />{/if}
    <button use:tip class="icon-btn" class:live={hostingWatch} disabled={!hostingWatch && !canShare}
      title={hostingWatch ? 'End watch together' : 'Start a watch together'} aria-label={hostingWatch ? 'End watch together' : 'Start a watch together'} onclick={() => toggle('watch')}>
      <Icon name="watch" size={18} />
    </button>
    {#if hostingWatch}<CrossRoomToggle />{/if}
  </div>
</footer>

<style>
  /* You on top, the buttons in one row below, spread over the width */
  .me { flex: none; display: flex; flex-direction: column; gap: 4px; padding: 6px 8px 6px; background-color: var(--glass-0, transparent); background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0.4)), rgb(0 0 0 / var(--panel-shade, 0.4))); backdrop-filter: blur(var(--panel-blur, 10px)); border-top: 1px solid var(--line); }
  .tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; }
  .sep { width: 1px; height: 18px; background: var(--line); }
  /* The buttons and dividers fit the default width (260px) in one row */
  .tools .icon-btn { width: 30px; }
  .me.inline { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding: 6px 16px; }
  .me.inline .profile, .me.inline .offline-who { flex: 0 1 220px; }
  .me.inline .tools { justify-content: flex-start; gap: 2px; }
  .me.inline .sep { margin: 0 6px; }
  .profile { min-width: 0; display: flex; align-items: center; gap: 10px; padding: 4px; text-align: left; transition: background 120ms var(--ease); }
  .profile:hover { background: var(--bg-hover); }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
  .who strong, .who span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who strong { font-weight: 600; }
  .who span { font-size: 12px; color: var(--text-dim); }
  .info, .info:hover { color: var(--warn); }
  .live, .live:hover { color: var(--speaking); }
  .offline-who { padding: 4px 4px 4px 6px; color: var(--text-dim); }
</style>
