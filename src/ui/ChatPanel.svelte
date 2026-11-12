<script lang="ts">
  import Icon from './Icon.svelte';
  import ChatLog from './ChatLog.svelte';
  import Composer from './Composer.svelte';
  import ResizeHandle from './ResizeHandle.svelte';
  import { session } from '../lib/session.svelte.ts';
  import { chatDock, isChatEmpty } from '../lib/chat-dock.svelte.ts';
  import { menu } from '../lib/menu.svelte.ts';
  import { customBackgroundItems } from '../lib/custom-bg-menu.ts';

  // The chat docked on the right, where the member list normally is
  const isDm = $derived(session.view.startsWith('dm:'));
  const isText = $derived(!isDm && session.isText(Number(session.view.slice(3))));
  const title = $derived(session.status === 'connected' ? session.viewTitle() : 'Libertad');
  const maxW = () => Math.max(280, Math.min(900, Math.round(window.innerWidth * 0.6)));
</script>

<aside class="cpanel" aria-label="Chat" style:width="{chatDock.width}px" onpointerdown={e => chatDock.pointerDown(e)}
  oncontextmenu={e => { if (isChatEmpty(e.target)) menu.show(e, customBackgroundItems('right', [{ label: 'Clear Chat', danger: true, action: () => session.clearChat() }])); }}>
  <ResizeHandle bind:width={chatDock.width} edge="left" min={280} max={maxW} initial={380} storageKey="libertad.chatPanelWidth" label="Resize chat" />
  <header class="cheader">
    <Icon name={isDm ? 'message' : 'hash'} size={20} />
    <h1>{title}</h1>
    <span class="grow"></span>
    <button class="icon-btn" onclick={() => chatDock.set('middle')} title="Move the chat back to the middle" aria-label="Move the chat back to the middle"><Icon name="back" /></button>
  </header>
  <div class="logbox">
    <ChatLog key={session.view}>
      {#snippet empty()}
        <div class="empty">
          <h2>{isDm ? `Direct messages with ${title}` : `Welcome to #${title}`}</h2>
          <p>{isDm ? 'Messages here are only visible to the two of you.' : isText ? 'A text channel: everyone on this server who uses Libertad can read and write here, from any channel.' : 'Messages go to everyone in this channel. Drop files here to share them.'}</p>
        </div>
      {/snippet}
    </ChatLog>
  </div>
  {#if session.status === 'connected'}
    <Composer target={session.view} placeholder={`Message ${isDm ? '@' : '#'}${title}`} />
  {/if}
</aside>

<style>
  .cpanel { --rh-shift: 2.5px; position: relative; max-width: 100%; height: 100%; flex: none; display: flex; flex-direction: column; min-height: 0; background: var(--panel-right, var(--bg-2)); border-left: 5px solid transparent; }
  .cpanel::before { content: ''; position: absolute; left: -5px; top: 0; bottom: 0; width: 5px; background: var(--panel-divider, rgb(0 0 0 / 0.4)); backdrop-filter: blur(var(--panel-blur, 10px)); pointer-events: none; }
  .logbox { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  header { height: var(--header-h); flex: none; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 16px; border-bottom: 1px solid var(--line); color: var(--text-faint); background-color: color-mix(in srgb, var(--panel-right, var(--bg-2)) var(--panel-solid, 100%), transparent); background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0.4)), rgb(0 0 0 / var(--panel-shade, 0.4))); backdrop-filter: blur(var(--panel-blur, 10px)); }
  h1 { flex: 0 1 auto; min-width: 0; font-size: 15px; font-weight: 650; margin: 0; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .grow { flex: 1; align-self: stretch; }
  .empty { padding: 28px 16px 8px; }
  .empty h2 { margin: 0 0 6px; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
  .empty p { margin: 0; color: var(--text-dim); }
</style>
