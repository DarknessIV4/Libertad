<script lang="ts">
  import Icon from './Icon.svelte';
  import ChatLog from './ChatLog.svelte';
  import Composer from './Composer.svelte';
  import VoiceStage from './VoiceStage.svelte';
  import { session } from '../lib/session.svelte.ts';
  import { chatDock, isChatEmpty } from '../lib/chat-dock.svelte.ts';
  import { menu } from '../lib/menu.svelte.ts';
  import { customBackgroundItems } from '../lib/custom-bg-menu.ts';

  // docked: the chat sits on the right (see ChatPanel); this is then the user cards alone, filling the middle
  let { onmenu, onpanel, showMenu, docked = false }: { onmenu: () => void; onpanel: () => void; showMenu: boolean; docked?: boolean } = $props();

  const isDm = $derived(session.view.startsWith('dm:'));
  const isText = $derived(!isDm && session.isText(Number(session.view.slice(3))));
  const title = $derived(session.status === 'connected' ? session.viewTitle() : 'Libertad');
  const topic = $derived.by(() => {
    if (isDm || session.status !== 'connected') return '';
    return (session.channel(Number(session.view.slice(3)))?.description ?? '').replace(/<[^>]*>/g, ' ').trim();
  });
</script>

<section class="chat" aria-label="Chat" onpointerdown={e => { if (!docked) chatDock.pointerDown(e); }}
  oncontextmenu={e => { if (!docked && isChatEmpty(e.target)) menu.show(e, customBackgroundItems('middle', [{ label: 'Clear Chat', danger: true, action: () => session.clearChat() }])); }}>
  <!-- The chat's name goes with the chat when it is docked on the right -->
  {#if !docked}
  <header class="cheader">
    {#if showMenu}<button class="icon-btn" onclick={onmenu} aria-label="Open channels"><Icon name="menu" /></button>{/if}
    <Icon name={isDm ? 'message' : 'hash'} size={20} />
    <h1>{title}</h1>
    {#if topic}<span class="topic" title={topic}>{topic}</span>{/if}
    <span class="grow"></span>
    {#if !docked}<button class="icon-btn" onclick={onpanel} title="Members"><Icon name="users" /></button>{/if}
  </header>
  {/if}

  {#if session.status === 'connected'}<VoiceStage fill={docked} />{/if}

  {#if !docked}
  <div class="logbox">
  <ChatLog key={session.view}>
    {#snippet empty()}
      <div class="empty">
        {#if session.status === 'connected'}
          <h2>{isDm ? `Direct messages with ${title}` : `Welcome to #${title}`}</h2>
          <p>{isDm ? 'Messages here are only visible to the two of you.' : isText ? 'A text channel: everyone on this server who uses Libertad can read and write here, from any channel. Other Mumble clients do not see these messages.' : 'Messages go to everyone in this channel. Drop files here to share them.'}</p>
        {:else}
          <h2>Connecting...</h2>
        {/if}
      </div>
    {/snippet}
  </ChatLog>
  </div>

  {#if session.status === 'connected'}
    <Composer target={session.view} placeholder={`Message ${isDm ? '@' : '#'}${title}`} />
  {/if}
  {/if}
</section>

<style>
  .logbox { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .chat { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--panel-middle, var(--bg-2)); border-left: 5px solid transparent; }
  .chat::before { content: ''; position: absolute; left: -5px; top: 0; bottom: 0; width: 5px; background: var(--panel-divider, rgb(0 0 0 / 0.4)); backdrop-filter: blur(var(--panel-blur, 10px)); pointer-events: none; }
  header { height: var(--header-h); flex: none; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 16px; border-bottom: 1px solid var(--line); color: var(--text-faint); background-color: color-mix(in srgb, var(--panel-middle, var(--bg-2)) var(--panel-solid, 100%), transparent); background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0.4)), rgb(0 0 0 / var(--panel-shade, 0.4))); backdrop-filter: blur(var(--panel-blur, 10px)); }
  h1 { flex: 0 1 auto; max-width: 60%; font-size: 15px; font-weight: 650; margin: 0; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .topic { flex: 1 1 0; font-size: 13px; color: var(--text-dim); padding-left: 12px; margin-left: 4px; border-left: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .grow { flex: 1; }
  .topic + .grow { flex: 0; }
  /* On phones the channel name matters more than its description */
  @media (max-width: 600px) { .topic { display: none; } h1 { max-width: none; } .topic + .grow { flex: 1; } }
  .empty { padding: 40px 20px 8px; max-width: 640px; }
  .empty h2 { margin: 0 0 6px; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
  .empty p { margin: 0; color: var(--text-dim); }
</style>
