<script lang="ts">
  import { chatDock } from '../lib/chat-dock.svelte.ts';
  import { session } from '../lib/session.svelte.ts';

  // Shown while the chat is being dragged: where it would land, and a small copy of it at the pointer
  const drag = $derived(chatDock.drag);
  const title = $derived(session.status === 'connected' ? session.viewTitle() : 'Chat');
  // Where the chat would land: over the member list for the right (or over the docked chat when it is
  // already there), over the middle for the middle
  const zone = $derived.by(() => {
    if (!drag) return null;
    if (drag.target === 'right') {
      const r = document.querySelector('aside.panel, aside.cpanel')?.getBoundingClientRect();
      if (r) return { left: r.left, top: r.top, width: r.width, height: r.height, label: 'Chat goes here, the member list is hidden' };
      const mid = document.querySelector('.chat')?.getBoundingClientRect();
      if (!mid) return null;
      return { left: window.innerWidth - chatDock.width, top: mid.top, width: chatDock.width, height: mid.height, label: 'Chat goes here, the member list is hidden' };
    }
    const mid = document.querySelector('.chat')?.getBoundingClientRect();
    return mid ? { left: mid.left, top: mid.top, width: mid.width, height: mid.height, label: 'Chat goes back to the middle' } : null;
  });
</script>

{#if drag && zone}
  <div class="zone" class:on={true} style="left:{zone.left}px; top:{zone.top}px; width:{zone.width}px; height:{zone.height}px"><span>{zone.label}</span></div>
  <div class="ghost" style="left:{drag.x + 14}px; top:{drag.y + 14}px">#{title}</div>
{/if}

<style>
  .zone { position: fixed; z-index: 300; pointer-events: none; display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px;
    border: 2px dashed var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--text); font-weight: 600; font-size: 14px; }
  .ghost { position: fixed; z-index: 301; pointer-events: none; width: 200px; height: 110px; padding: 8px 10px; box-sizing: border-box; font-weight: 650; font-size: 13px;
    background: var(--bg-2); color: var(--text); border: 1px solid var(--accent); box-shadow: var(--shadow-pop); opacity: 0.85; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
