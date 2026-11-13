<script lang="ts">
  import { tip } from '../lib/tip.ts';
  import Icon from '../ui/Icon.svelte';
  import { session, sessions } from '../lib/session.svelte.ts';
  import { ui } from '../lib/ui.svelte.ts';
  import { share } from '../lib/share.svelte.ts';
  import { watchTogether } from '../lib/watch-together.svelte.ts';
  import CrossRoomToggle from '../ui/CrossRoomToggle.svelte';

  // Mute, deafen and share. large: the voice screen's row of big buttons with labels.
  let { large = false }: { large?: boolean } = $props();

  const self = $derived(session.self);
  // Without a connection the buttons show the remembered choice, applied at the next connect
  const muted = $derived(self ? self.selfMute : sessions.mute);
  const deafened = $derived(self ? self.selfDeaf : sessions.deaf);
  // Hosting a watch together session (also while you have left it, until it is ended) counts as sharing: the button ends it
  const hostingWatch = $derived(watchTogether.isHostWithParty);
  const screenOn = $derived(!!share.stream && share.kind === 'screen');
  const cameraOn = $derived(!!share.stream && share.kind === 'camera');
  const canShare = $derived(session.status === 'connected' && share.supported(sessions.active));

  function quick(e: MouseEvent, kind: 'input' | 'output') {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ui.quickAudio = { kind, x: r.left + r.width / 2, y: r.top };
  }
</script>

<div class="controls" class:large>
  <button class:on={muted} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute (hold or right-click for microphone options)' : 'Mute (hold or right-click for microphone options)'}
    onclick={() => session.setSelfMute(!muted)} oncontextmenu={e => quick(e, 'input')}>
    <Icon name={muted ? 'mic-off' : 'mic'} size={large ? 24 : 20} />
    {#if large}<span>{muted ? 'Muted' : 'Mute'}</span>{/if}
  </button>
  <button class:on={deafened} aria-label={deafened ? 'Undeafen' : 'Deafen'} title={deafened ? 'Undeafen (hold or right-click for output options)' : 'Deafen (hold or right-click for output options)'}
    onclick={() => session.setSelfDeaf(!deafened)} oncontextmenu={e => quick(e, 'output')}>
    <Icon name={deafened ? 'headphones-off' : 'headphones'} size={large ? 24 : 20} />
    {#if large}<span>{deafened ? 'Deafened' : 'Deafen'}</span>{/if}
  </button>
  {#if large}
    <button use:tip class:live={screenOn} disabled={!screenOn && !canShare} aria-label={screenOn ? 'Stop sharing your screen' : 'Share your screen'}
      title={screenOn ? 'Stop sharing your screen' : 'Share your screen or a window'}
      onclick={() => (screenOn ? share.stop() : share.start(sessions.active, 'screen'))}>
      <Icon name="screen" size={24} /><span>{screenOn ? 'Stop screen' : 'Screen'}</span>
    </button>
    {#if screenOn}<CrossRoomToggle large />{/if}
    <button use:tip class:live={cameraOn} disabled={!cameraOn && !canShare} aria-label={cameraOn ? 'Stop sharing your camera' : 'Share your camera'}
      title={cameraOn ? 'Stop sharing your camera' : 'Share your camera'}
      onclick={() => (cameraOn ? share.stop() : share.start(sessions.active, 'camera'))}>
      <Icon name="camera" size={24} /><span>{cameraOn ? 'Stop camera' : 'Camera'}</span>
    </button>
    {#if cameraOn}<CrossRoomToggle large />{/if}
    <button use:tip class:live={hostingWatch} disabled={!hostingWatch && !canShare} aria-label={hostingWatch ? 'End watch together' : 'Start a watch together'}
      title={hostingWatch ? 'End watch together' : 'Start a watch together'}
      onclick={() => (hostingWatch ? watchTogether.end() : share.start(sessions.active, 'watch'))}>
      <Icon name="watch" size={24} /><span>{hostingWatch ? 'End watch' : 'Watch'}</span>
    </button>
    {#if hostingWatch}<CrossRoomToggle large />{/if}
  {/if}
</div>

<style>
  .controls { display: flex; gap: 4px; }
  button { width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; color: var(--text); background: var(--bg-3); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button.on { background: var(--danger); color: #fff; }
  button.live { background: var(--speaking); color: var(--bg-0); }
  .large { gap: 10px; justify-content: center; }
  .large button { width: 96px; height: 72px; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; }
</style>
