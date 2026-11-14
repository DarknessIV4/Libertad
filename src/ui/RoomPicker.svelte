<script lang="ts">
  import Modal from './Modal.svelte';
  import { sessions } from '../lib/session.svelte.ts';
  import { defaultRooms, roomsOf } from '../lib/default-room.svelte.ts';

  // Asked when connecting to a server that has several rooms (see default-room.svelte.ts)
  let { serverId, onclose }: { serverId: string; onclose: () => void } = $props();

  const s = $derived(sessions.byServer(serverId));
  const rooms = $derived(s ? roomsOf(s).filter(r => r.channel.canEnter) : []);
  let remember = $state(false);

  // While this is open you are muted and deafened (default-room.svelte.ts). However it closes, back to what you chose:
  // your own mute and deafen, or deafened still if another server has your voice.
  function restore() {
    if (!s || !s.client || s.status !== 'connected') return;
    s.applyOwnState(sessions.mute, sessions.voiceId === serverId ? sessions.deaf : true);
  }
  $effect(() => () => restore());

  function enter(id: number, name: string) {
    if (!s) return;
    if (remember) defaultRooms.set(serverId, { id, name: name || 'Root' });
    s.joinChannel(id);
    onclose();
  }
</script>

<Modal title="Which room?" {onclose} width={380}>
  <p class="msg">Where do you want to go on {s?.server?.label || 'this server'}?</p>
  <ul class="rooms">
    {#each rooms as r (r.channel.id)}
      <li style:padding-left="{r.depth * 14}px">
        <button class="btn room" onclick={() => enter(r.channel.id, r.channel.name)}>{r.channel.name || 'Root'}</button>
      </li>
    {/each}
  </ul>
  <label class="check"><input type="checkbox" bind:checked={remember} /> Set this room as default for me</label>
  {#snippet footer()}
    <button class="btn" onclick={onclose}>Cancel</button>
  {/snippet}
</Modal>

<style>
  .msg { margin: 0 0 10px; color: var(--text-dim); }
  .rooms { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; }
  .room { width: 100%; justify-content: flex-start; text-align: left; }
  .check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
</style>
