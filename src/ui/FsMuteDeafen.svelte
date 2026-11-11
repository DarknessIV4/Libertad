<script lang="ts">
  import { tip } from '../lib/tip.ts';
  import Icon from './Icon.svelte';
  import { session, sessions } from '../lib/session.svelte.ts';

  // Mute and deafen, for the buttons over a picture in full screen (the channel list with the usual
  // ones is out of sight then). They sit left of the other buttons and show and hide with them.
  // dark: a dark backing like the buttons of the picture's own corner; the YouTube bar has its own shade.
  let { dark = true }: { dark?: boolean } = $props();

  const self = $derived(session.self);
  const muted = $derived(self ? self.selfMute : sessions.mute);
  const deafened = $derived(self ? self.selfDeaf : sessions.deaf);
</script>

<button use:tip class="ibtn" class:dark class:on={muted} onclick={() => session.setSelfMute(!muted)}
  aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted} title={muted ? 'Unmute' : 'Mute'}>
  <Icon name={muted ? 'mic-off' : 'mic'} size={20} />
</button>
<button use:tip class="ibtn" class:dark class:on={deafened} onclick={() => session.setSelfDeaf(!deafened)}
  aria-label={deafened ? 'Undeafen' : 'Deafen'} aria-pressed={deafened} title={deafened ? 'Undeafen' : 'Deafen'}>
  <Icon name={deafened ? 'headphones-off' : 'headphones'} size={20} />
</button>

<style>
  .ibtn { display: flex; align-items: center; justify-content: center; padding: 5px; border: none; border-radius: 6px; background: transparent; color: #fff; cursor: pointer; }
  .ibtn.dark { background: rgba(0, 0, 0, 0.55); }
  .ibtn:hover, .ibtn:focus-visible { background: rgba(255, 255, 255, 0.25); }
  .ibtn.on { color: #f03; }
</style>
