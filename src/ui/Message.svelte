<script lang="ts">
  import Avatar from './Avatar.svelte';
  import YouTubeEmbed from './YouTubeEmbed.svelte';
  import LinkPreview from './LinkPreview.svelte';
  import FileCard from './FileCard.svelte';
  import { store } from '../lib/settings.svelte.ts';
  import { session } from '../lib/session.svelte.ts';
  import { menu, type MenuItem } from '../lib/menu.svelte.ts';
  import { ui } from '../lib/ui.svelte.ts';
  import { userMenu, openProfile } from '../lib/actions.ts';
  import type { ChatEntry } from '../lib/session.svelte.ts';
  import { markMentions } from '../lib/mentions.ts';
  import { useUrlAsProfileBackground, useUrlAsUserCard, saveImage } from '../lib/banner-actions.ts';

  let { entry, grouped }: { entry: ChatEntry; grouped: boolean } = $props();

  const time = $derived(new Date(entry.time));

  // @Name in the text: blue and glowing, and a click on it opens that person's card
  const body = $derived(entry.kind === 'text' && entry.html.includes('@')
    ? markMentions(entry.html, session.allUsers().map(u => ({ name: u.name, session: u.session })))
    : entry.html);
  function tagClick(e: Event) {
    const tag = (e.target as Element).closest?.('.mtag[data-session]');
    if (!tag) return;
    const id = Number(tag.getAttribute('data-session'));
    if (session.user(id)) { e.preventDefault(); openProfile(id, tag); }
  }
  function tagKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') tagClick(e);
  }

  // The author while still online: a click opens their card, right-click their menu
  const authorId = $derived(entry.self ? session.self?.session : entry.authorSession);
  function authorMenu(e: MouseEvent) {
    const u = authorId != null ? session.user(authorId) : undefined;
    if (u) menu.show(e, userMenu(u));
  }
  // Right-click on your own message in a text channel: edit (text only) and delete, for everybody
  function messageMenu(e: MouseEvent) {
    if (e.defaultPrevented || entry.kind !== 'text' || !session.ownMessage(entry)) return;
    const text = session.editableText(entry);
    const items: MenuItem[] = [];
    if (text !== null) items.push({ label: 'Edit', action: () => (ui.prompt = {
      title: 'Edit message', label: 'Everybody sees the new text', confirm: 'Save', initial: text,
      onsubmit: v => session.editMessage(entry, v)
    }) });
    // Right-click on a picture or GIF: the same background choices as on other people's messages, above Delete
    const src = (e.target as Element | null)?.closest?.('.embed img')?.getAttribute('src');
    if (src) items.push(
      { label: 'Set as profile background', action: () => void useUrlAsProfileBackground(src) },
      { label: 'Set as user card', action: () => void useUrlAsUserCard(src) },
      { label: 'Save', action: () => saveImage(src) }
    );
    items.push({ label: 'Delete', danger: true, action: () => (ui.prompt = {
      title: 'Delete message?', label: '', confirm: 'Delete', danger: true, input: 'none',
      text: 'It is removed for everybody in the channel.', onsubmit: () => session.deleteMessage(entry)
    }) });
    menu.show(e, items);
  }
  function authorCard(e: MouseEvent) {
    if (authorId != null && session.user(authorId)) openProfile(authorId, e.currentTarget as Element);
  }
  // Full date and time, shown at the right edge while the pointer is on the message
  const full = $derived(time.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }));
  const hhmm = $derived(time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  // Next to the name: the time for today, "Yesterday" or the date before that
  const when = $derived.by(() => {
    const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const ago = Math.round((day(new Date()) - day(time)) / 86400000);
    if (ago === 0) return hhmm;
    if (ago === 1) return `Yesterday ${hhmm}`;
    return time.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  });
</script>

{#if entry.kind === 'system'}
  <div class="system">
    <span class="mark" aria-hidden="true"></span>
    <div class="html">{@html entry.html} <span class="time">{hhmm}</span></div>
  </div>
{:else}
  <article class="msg" class:grouped class:mention={entry.mention} oncontextmenu={messageMenu}>
    <time class="stamp" datetime={time.toISOString()}>{full}</time>
    <div class="gutter">
      {#if !grouped}<button class="face" tabindex="-1" aria-hidden="true" onclick={authorCard} oncontextmenu={authorMenu}><Avatar name={entry.author} size={40} src={session.avatar(authorId)} /></button>{/if}
    </div>
    <div class="content">
      {#if !grouped}
        <header>
          <button class="author" onclick={authorCard} oncontextmenu={authorMenu}><strong class:self={entry.self}>{entry.author}</strong></button>
          <time datetime={time.toISOString()} title={full}>{when}</time>
        </header>
      {/if}
      {#if body}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="html" onclick={tagClick} onkeydown={tagKey}>{@html body}</div>
      {/if}
      {#each entry.embeds as m (m.url)}
        {#if m.kind === 'file'}
          <div class="embed"><FileCard meta={m.file!} poster={m.poster ?? ''} author={entry.self ? null : entry.authorSession} /></div>
        {:else if m.kind === 'link'}
          <div class="embed"><LinkPreview url={m.url} /></div>
        {:else if m.kind === 'youtube'}
          {#if store.settings.youtube !== 'off'}<div class="embed"><YouTubeEmbed videoId={m.videoId!} start={m.start} url={m.url} /></div>{/if}
        {:else}
        <div class="embed">
          {#if m.kind === 'image'}
            <a href={m.url} target="_blank" rel="noopener noreferrer"><img src={m.url} alt={m.name} loading="lazy" /></a>
          {:else if m.kind === 'video'}
            <video src={m.url} controls preload="metadata"><track kind="captions" /></video>
          {:else}
            <audio src={m.url} controls preload="metadata"></audio>
          {/if}
        </div>
        {/if}
      {/each}
    </div>
  </article>
{/if}

<style>
  .msg { position: relative; display: flex; gap: 14px; padding: 3px 16px; margin-top: 14px; font-size: var(--fs-chat); line-height: 1.5; }
  /* Over the end of the line, with its own background so it stays readable on long messages */
  .stamp { position: absolute; top: 2px; right: 12px; padding: 1px 7px; line-height: 18px; background: var(--bg-1); border: 1px solid var(--line-strong); box-shadow: var(--shadow-pop); visibility: hidden; pointer-events: none; }
  .msg:hover .stamp { visibility: visible; }
  .msg.grouped { margin-top: 0; padding-top: 1px; padding-bottom: 1px; }
  /* A message that mentions you: a blue tint and a glowing bar on its left edge */
  .msg.mention { --mention: #4aa8ff; background: linear-gradient(90deg, rgb(74 168 255 / 0.14), rgb(74 168 255 / 0.04)); box-shadow: inset 3px 0 0 var(--mention), inset 14px 0 18px -12px rgb(74 168 255 / 0.55); }
  /* @Name inside any message: blue with a soft glow; the ones that open a card show a hand */
  .html :global(.mtag) { color: #5db2ff; font-weight: 600; padding: 0 3px; border-radius: 4px; background: rgb(74 168 255 / 0.16); text-shadow: 0 0 8px rgb(74 168 255 / 0.9), 0 0 16px rgb(74 168 255 / 0.5); box-shadow: 0 0 10px rgb(74 168 255 / 0.35); }
  .html :global(.mtag[data-session]) { cursor: pointer; }
  .html :global(.mtag[data-session]:hover), .html :global(.mtag:focus-visible) { background: rgb(74 168 255 / 0.28); outline: none; text-shadow: 0 0 10px rgb(120 195 255), 0 0 20px rgb(74 168 255 / 0.8); }
  .msg:hover { background: color-mix(in srgb, var(--text) 3%, transparent); }
  .gutter { width: 40px; flex: none; display: flex; justify-content: center; padding-top: 2px; }
  .content { flex: 1; min-width: 0; }
  header { display: flex; align-items: baseline; gap: 8px; line-height: 1.35; margin-bottom: 1px; }
  header strong { font-weight: 600; }
  .author:hover strong { text-decoration: underline; }
  .face { display: flex; }
  header strong.self { color: var(--accent-hover); }
  time, .time { font-size: 12px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .stamp { font-size: 11px; color: var(--text-dim); }
  .html { overflow-wrap: anywhere; user-select: text; }
  .html :global(p) { margin: 0; }
  .html :global(img) { max-width: min(520px, 100%); max-height: 360px; display: block; margin-top: 4px; border: 1px solid var(--line); }
  .html :global(pre), .html :global(code) { font-family: var(--mono); font-size: 13px; background: var(--bg-0); padding: 1px 4px; }
  .html :global(pre) { padding: 8px 10px; overflow-x: auto; }
  .html :global(blockquote) { margin: 4px 0; padding-left: 10px; border-left: 3px solid var(--line); color: var(--text-dim); }
  .embed { margin-top: 6px; max-width: min(520px, 100%); }
  .embed img, .embed video { display: block; max-width: 100%; max-height: 360px; background: var(--bg-0); border: 1px solid var(--line); }
  .embed audio { width: 100%; }
  /* The link is exactly as big as the picture, so a click beside it does not open it */
  .embed a, .html :global(a:has(> img)) { display: block; width: fit-content; max-width: 100%; }
  .system { display: flex; gap: 14px; padding: 4px 16px; margin-top: 10px; color: var(--text-dim); font-size: 13px; }
  .system .mark { width: 40px; flex: none; display: flex; justify-content: center; padding-top: 7px; }
  .system .mark::before { content: ''; width: 6px; height: 6px; background: var(--text-faint); }
  .system .time { margin-left: 6px; }
  .system .html { flex: 1; min-width: 0; }
</style>
