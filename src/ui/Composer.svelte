<script lang="ts">
  import Icon from './Icon.svelte';
  import FormatToolbar from './FormatToolbar.svelte';
  import GifPicker from './GifPicker.svelte';
  import { gifs, type Gif } from '../lib/gifs.svelte.ts';
  import { session } from '../lib/session.svelte.ts';
  import { ui } from '../lib/ui.svelte.ts';
  import { toMumbleHtml } from '../lib/html.ts';
  import { matchBotCommands, type BotCommand } from '../lib/bot-commands.ts';
  import { store } from '../lib/settings.svelte.ts';

  // target: the chat this composer sends to ("ch:<id>" or "dm:<session>")
  let { target, placeholder, autofocus = true }: { target: string; placeholder: string; autofocus?: boolean } = $props();

  let input: HTMLDivElement;
  let picker: HTMLInputElement;
  let imagePicker: HTMLInputElement;
  let empty = $state(true);
  let gifOpen = $state(false);

  // A GIF goes out as a link; the chat shows it as the picture
  function sendGif(g: Gif) {
    if (!session.sendHtml(`<a href="${g.url}">${g.url}</a>`, target)) return;
    gifs.used(g);
    gifOpen = false;
    input.focus();
  }
  // The formatting toolbar is opt-in and remembered
  let formatting = $state(loadFormatting());
  const disabled = $derived(session.status !== 'connected');
  const preparing = $derived(session.preparing.filter(u => u.key === target));

  function loadFormatting(): boolean {
    try { return localStorage.getItem('libertad.formatBar') === '1'; } catch { return false; }
  }
  function toggleFormatting() {
    formatting = !formatting;
    try { localStorage.setItem('libertad.formatBar', formatting ? '1' : '0'); } catch { /* storage unavailable */ }
    input.focus();
  }

  // Command list: shown while the message is just "!" and the start of a command name
  let typed = $state<string | null>(null);
  let picked = $state(0);
  let dismissed = $state(false);
  const matches = $derived(typed === null ? [] : matchBotCommands(typed));
  const cmdOpen = $derived(!disabled && !dismissed && typed !== null && matches.length > 0);

  // Mention list: shown while the word before the cursor starts with "@" (@name, or @all for everybody)
  interface Who { name: string; shown: string; hint: string }
  let mentionQ = $state<string | null>(null);
  const people = $derived.by((): Who[] => {
    if (mentionQ === null) return [];
    const q = mentionQ.toLowerCase();
    const me = session.self?.session;
    const all: Who[] = [{ name: 'all', shown: 'all', hint: 'Everybody' }];
    for (const u of session.allUsers()) {
      if (u.session === me) continue;
      const nick = store.displayName(u);
      all.push({ name: u.name, shown: u.name, hint: nick !== u.name ? `Your name for them: ${nick}` : '' });
    }
    const rank = (w: Who) => {
      const hay = [w.name, w.hint.replace(/^Your name for them: /, '')].map(x => x.toLowerCase());
      if (hay.some(h => h.startsWith(q))) return 0;
      if (hay.some(h => h.includes(q))) return 1;
      return 2;
    };
    return all.filter(w => rank(w) < 2).sort((a, b) => rank(a) - rank(b)).slice(0, 8);
  });
  const mentionOpen = $derived(!disabled && !dismissed && !cmdOpen && mentionQ !== null && people.length > 0);
  const menuOpen = $derived(cmdOpen || mentionOpen);

  // The "@word" that ends at the cursor, with where it starts
  function mentionAtCursor(): { query: string; node: Text; at: number; end: number } | null {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (!sel || !sel.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE || !input.contains(node)) return null;
    const end = sel.anchorOffset;
    const m = /(^|\s)@([^\s@]*)$/.exec((node as Text).data.slice(0, end));
    return m ? { query: m[2], node: node as Text, at: end - m[2].length - 1, end } : null;
  }

  const sync = () => {
    empty = !input.textContent?.trim() && !input.querySelector('img');
    const text = input.textContent ?? '';
    const next = /^![^\s]*$/.test(text) ? text.slice(1) : null;
    const at = next === null ? mentionAtCursor() : null;
    const nextMention = at ? at.query : null;
    if (next !== typed || nextMention !== mentionQ) picked = 0;
    if (next === null && nextMention === null) dismissed = false;
    typed = next;
    mentionQ = nextMention;
  };

  function completeMention(w: Who) {
    const at = mentionAtCursor();
    if (!at) return;
    const range = document.createRange();
    range.setStart(at.node, at.at);
    range.setEnd(at.node, at.end);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    exec('insertText', `@${w.name} `);
  }

  const nameOf = (c: BotCommand) => `!${c.names[0]}`;
  function complete(c: BotCommand) {
    input.textContent = `${nameOf(c)} `;
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    input.focus();
    sync();
  }

  function exec(cmd: string, arg?: string) {
    input.focus();
    document.execCommand(cmd, false, arg);
    sync();
  }

  function submit() {
    const html = input.innerHTML;
    // Plain text goes out the usual way; anything formatted as sanitized XHTML
    const formatted = !!input.querySelector('b, strong, i, em, u, s, strike, span[style], font, ul, ol, a, img');
    const ok = formatted
      ? session.sendHtml(toMumbleHtml(html, { linkify: true }), target)
      : session.sendText(input.innerText, target);
    if (!ok) return;
    input.innerHTML = '';
    sync();
  }

  function onkeydown(e: KeyboardEvent) {
    if (menuOpen && !e.isComposing) {
      const n = cmdOpen ? matches.length : people.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); picked = (picked + 1) % n; scrollToPicked(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); picked = (picked - 1 + n) % n; scrollToPicked(); return; }
      if (e.key === 'Escape') { e.preventDefault(); dismissed = true; return; }
      // Tab always completes; Enter completes unless what is typed already is a full command name
      const full = cmdOpen
        ? matches.some(c => c.names.some(nm => nm === typed!.toLowerCase()))
        : people.some(w => w.name.toLowerCase() === mentionQ!.toLowerCase());
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !full)) {
        e.preventDefault();
        if (cmdOpen) complete(matches[Math.min(picked, n - 1)]);
        else completeMention(people[Math.min(picked, n - 1)]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      if (e.shiftKey) exec('insertLineBreak');
      else submit();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const cmd = ({ b: 'bold', i: 'italic', u: 'underline' } as Record<string, string>)[e.key.toLowerCase()];
      if (cmd) { e.preventDefault(); exec(cmd); }
    }
  }

  let list: HTMLUListElement | undefined = $state();
  function scrollToPicked() {
    queueMicrotask(() => list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  }

  function onpaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])];
    e.preventDefault();
    if (files.length) return session.sendFiles(files, target);
    const html = e.clipboardData?.getData('text/html');
    if (html && formatting) exec('insertHTML', toMumbleHtml(html));
    else exec('insertText', e.clipboardData?.getData('text/plain') ?? '');
  }

  // window.prompt does not exist in Electron; the app's dialog, then restore the selection
  function link() {
    const sel = window.getSelection();
    const range = sel && sel.rangeCount && input.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    ui.prompt = {
      title: 'Insert link', label: 'Address (https://...)', confirm: 'Insert link', initial: 'https://',
      onsubmit: raw => {
        const url = raw.trim();
        if (!/^https?:\/\/\S+$/i.test(url)) return;
        input.focus();
        if (range) { sel!.removeAllRanges(); sel!.addRange(range); }
        if (range && !range.collapsed) exec('createLink', url);
        else exec('insertHTML', `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>`);
      }
    };
  }

  $effect(() => {
    void target;
    if (autofocus && !disabled && matchMedia('(pointer: fine)').matches) input.focus();
  });
</script>

<div class="composer">
  <!-- The input handles the keys (arrows, Tab, Enter); the rows are for the mouse -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  {#if cmdOpen}
    <ul class="cmds" role="listbox" aria-label="Commands" bind:this={list}>
      {#each matches as c, i (c.names[0])}
        {#if i === 0 || matches[i - 1].group !== c.group}<li class="cmd-group" role="presentation">{c.group}</li>{/if}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li role="option" aria-selected={i === picked} class="cmd" class:on={i === picked}
          onmousedown={e => e.preventDefault()} onmouseenter={() => (picked = i)} onclick={() => complete(c)}>
          <span class="cmd-name">{c.names.map(n => `!${n}`).join(' or ')}{#if c.args}<span class="cmd-args"> {c.args}</span>{/if}</span>
          <span class="cmd-desc">{c.desc}</span>
        </li>
      {/each}
    </ul>
  {:else if mentionOpen}
    <ul class="cmds" role="listbox" aria-label="Mention someone" bind:this={list}>
      <li class="cmd-group" role="presentation">Mention</li>
      {#each people as w, i (w.name)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li role="option" aria-selected={i === picked} class="cmd" class:on={i === picked}
          onmousedown={e => e.preventDefault()} onmouseenter={() => (picked = i)} onclick={() => completeMention(w)}>
          <span class="cmd-name">@{w.shown}</span>
          {#if w.hint}<span class="cmd-desc">{w.hint}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if preparing.length}
    <ul class="preparing">
      {#each preparing as u (u.id)}
        <li title="Reading the file before it is announced">
          <Icon name="file" size={16} />
          <span class="name">{u.name}</span>
          <span class="bar"><span style:width="{u.progress * 100}%"></span></span>
        </li>
      {/each}
    </ul>
  {/if}
  {#if gifOpen}<GifPicker onpick={sendGif} onclose={() => (gifOpen = false)} />{/if}
  <div class="frame">
    {#if formatting}
      <FormatToolbar {exec} onlink={link} onimage={() => imagePicker.click()} />
    {/if}
    <div class="box">
      <button class="icon-btn" title="Send a file" {disabled} onclick={() => picker.click()}><Icon name="paperclip" /></button>
      <input bind:this={picker} type="file" multiple hidden
        onchange={() => { session.sendFiles([...(picker.files ?? [])], target); picker.value = ''; }} />
      <input bind:this={imagePicker} type="file" accept="image/*" hidden
        onchange={() => { session.sendFiles([...(imagePicker.files ?? [])], target); imagePicker.value = ''; }} />
      <div class="input" class:blank={empty} bind:this={input} contenteditable={!disabled}
        role="textbox" aria-multiline="true" aria-label="Message" tabindex="0" data-placeholder={placeholder}
        oninput={sync} onkeyup={sync} onmouseup={sync} {onkeydown} {onpaste}></div>
      <button class="icon-btn gif-btn" title="GIFs" aria-label="GIFs" aria-expanded={gifOpen} {disabled}
        onmousedown={e => e.preventDefault()} onclick={() => (gifOpen = !gifOpen)}><Icon name="gif" /></button>
      <button class="icon-btn fmt" class:on={formatting} title="Text formatting" aria-label="Text formatting" aria-pressed={formatting}
        {disabled} onmousedown={e => e.preventDefault()} onclick={toggleFormatting}>Aa</button>
      <button class="icon-btn send" title="Send" disabled={disabled || empty} onclick={submit}><Icon name="send" size={18} /></button>
    </div>
  </div>
</div>

<style>
  /* A framed field set in from the edges; grows for longer messages */
  .composer { position: relative; flex: none; display: flex; flex-direction: column; justify-content: flex-end; padding: 0 16px 16px; }
  .frame { display: flex; flex-direction: column; /* The message box is a panel: panel transparency, darkness and blur */ background-color: color-mix(in srgb, var(--bg-3) var(--panel-solid, 100%), transparent); background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0)), rgb(0 0 0 / var(--panel-shade, 0))); backdrop-filter: blur(var(--panel-blur, 0px)); border: 1px solid var(--line-strong); transition: border-color 120ms var(--ease); }
  .frame:focus-within { border-color: color-mix(in srgb, var(--accent) 55%, var(--line-strong)); }
  /* The formatting row is part of the same field: same background, its buttons over the paperclip and send */
  .composer .frame :global(.toolbar) { background: transparent; padding: 4px 8px; border-bottom-color: var(--line); }
  .composer .frame :global(.tool:hover:not(:disabled)), .composer .frame :global(.tool.on) { background: var(--bg-active); }
  .box { min-height: 46px; display: flex; align-items: center; gap: 2px; padding: 0 6px; }
  .input { position: relative; flex: 1; min-width: 0; padding: 12px 6px; max-height: 200px; overflow-y: auto; font-size: var(--fs-chat); line-height: 1.4; outline: none; overflow-wrap: anywhere; white-space: pre-wrap; }
  .input.blank::before { content: attr(data-placeholder); position: absolute; left: 6px; top: 12px; color: var(--text-faint); pointer-events: none; }
  .input :global(img) { max-height: 120px; }
  .input :global(ul), .input :global(ol) { margin: 0; padding-left: 20px; }
  .input[contenteditable='false'] { color: var(--text-faint); }
  /* The command list opens upward from the field */
  .cmds { position: absolute; left: 16px; right: 16px; bottom: calc(100% + 4px); z-index: 30; margin: 0; padding: 4px 0; list-style: none; max-height: min(340px, 50vh); overflow-y: auto; background: var(--bg-2); border: 1px solid var(--line-strong); box-shadow: 0 -8px 24px rgb(0 0 0 / 0.35); }
  .cmd-group { padding: 6px 12px 2px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); }
  .cmd { display: flex; flex-direction: column; gap: 1px; padding: 5px 12px; cursor: pointer; }
  .cmd.on { background: var(--bg-active); }
  .cmd-name { font-size: 13px; font-weight: 650; color: var(--text); overflow-wrap: anywhere; }
  .cmd-args { font-weight: 400; color: var(--text-dim); }
  .cmd-desc { font-size: 12px; color: var(--text-dim); }
  .fmt { font-weight: 700; font-size: 13px; }
  .fmt.on { color: var(--accent-hover); }
  .send:not(:disabled) { color: var(--accent-hover); }
  .preparing { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .preparing li { display: flex; align-items: center; gap: 8px; background: var(--bg-1); border: 1px solid var(--line); padding: 6px 10px; font-size: 13px; }
  .name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { flex: 1; height: 4px; background: var(--bg-3); }
  .bar span { display: block; height: 100%; background: var(--accent); transition: width 120ms; }
</style>
