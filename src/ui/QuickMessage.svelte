<script lang="ts">
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import FormatToolbar from './FormatToolbar.svelte';
  import GifPicker from './GifPicker.svelte';
  import { gifs, gifFile, type Gif } from '../lib/gifs.svelte.ts';
  import { useAsProfileBackground } from '../lib/banner-actions.ts';
  import { quickMessage } from '../lib/quick-message.ts';
  import { makeInlineImage } from '../lib/images.ts';
  import { toMumbleHtml, textToHtml } from '../lib/html.ts';
  import { ui } from '../lib/ui.svelte.ts';
  import type { SavedServer } from '../lib/settings.svelte.ts';

  // The chat bar for a server you are not on: text, formatting, pictures and GIFs to the main channel
  let { server, onclose }: { server: SavedServer; onclose: () => void } = $props();

  let input: HTMLDivElement;
  let imagePicker: HTMLInputElement;
  let empty = $state(true);
  let sending = $state(false);
  let error = $state('');
  let gifOpen = $state(false);
  let formatting = $state(loadFormatting());

  function loadFormatting(): boolean {
    try { return localStorage.getItem('libertad.formatBar') === '1'; } catch { return false; }
  }
  function toggleFormatting() {
    formatting = !formatting;
    try { localStorage.setItem('libertad.formatBar', formatting ? '1' : '0'); } catch { /* storage unavailable */ }
    input.focus();
  }

  const sync = () => { empty = !input.textContent?.trim() && !input.querySelector('img'); };
  function exec(cmd: string, arg?: string) {
    input.focus();
    document.execCommand(cmd, false, arg);
    sync();
  }

  async function deliver(html: string): Promise<boolean> {
    sending = true;
    error = '';
    try {
      await quickMessage($state.snapshot(server) as SavedServer, html);
      return true;
    } catch (e) {
      error = (e as Error).message;
      sending = false;
      return false;
    }
  }

  async function submit() {
    if (empty || sending) return;
    // Plain text goes out the usual way; anything formatted as sanitized XHTML
    const formatted = !!input.querySelector('b, strong, i, em, u, s, strike, span[style], font, ul, ol, a, img');
    const html = formatted ? toMumbleHtml(input.innerHTML, { linkify: true }) : textToHtml(input.innerText.trim());
    if (await deliver(html)) onclose();
  }

  // A GIF goes out as a link at once; the chat shows it as the picture
  async function sendGif(g: Gif) {
    gifOpen = false;
    if (await deliver(`<a href="${g.url}">${g.url}</a>`)) { gifs.used(g); onclose(); }
  }
  async function gifAsBackground(g: Gif) {
    gifOpen = false;
    let problem = '';
    try { problem = await useAsProfileBackground(await gifFile(g)); }
    catch { problem = 'This GIF could not be downloaded.'; }
    if (problem) ui.prompt = { title: 'Profile background', label: problem, confirm: 'OK', input: 'none', onsubmit: () => {} };
  }

  // A picture goes into the message as it is typed, scaled to fit the usual server limit
  async function addImages(list: File[]) {
    for (const file of list) {
      const uri = await makeInlineImage(file, 120000);
      if (uri) exec('insertHTML', `<img src="${uri}"/>`);
      else error = `${file.name} could not be added as a picture.`;
    }
  }

  function onkeydown(e: KeyboardEvent) {
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

  function onpaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])];
    e.preventDefault();
    if (files.length) return void addImages(files);
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
</script>

<Modal title="Message {server.label}" {onclose} width={560}>
  <p class="hint">Goes to the main channel. You do not join voice.</p>
  <div class="frame">
    {#if formatting}
      <FormatToolbar {exec} onlink={link} onimage={() => imagePicker.click()} />
    {/if}
    <div class="box">
      <input bind:this={imagePicker} type="file" accept="image/*" multiple hidden
        onchange={() => { addImages([...(imagePicker.files ?? [])]); imagePicker.value = ''; }} />
      <!-- svelte-ignore a11y_autofocus -->
      <div class="input" class:blank={empty} bind:this={input} contenteditable={!sending} autofocus
        role="textbox" aria-multiline="true" aria-label="Message" tabindex="0" data-placeholder="Write a message"
        oninput={sync} onkeyup={sync} onmouseup={sync} {onkeydown} {onpaste}></div>
      <button class="icon-btn gif-btn" title="GIFs" aria-label="GIFs" aria-expanded={gifOpen} disabled={sending}
        onmousedown={e => e.preventDefault()} onclick={() => (gifOpen = !gifOpen)}><Icon name="gif" /></button>
      <button class="icon-btn fmt" class:on={formatting} title="Text formatting" aria-label="Text formatting" aria-pressed={formatting}
        disabled={sending} onmousedown={e => e.preventDefault()} onclick={toggleFormatting}>Aa</button>
    </div>
  </div>
  {#if gifOpen}
    <div class="gifs"><GifPicker onpick={sendGif} onbackground={gifAsBackground} onclose={() => (gifOpen = false)} /></div>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
  {#snippet footer()}
    <button class="btn" onclick={onclose}>Cancel</button>
    <button class="btn primary" disabled={sending || empty} onclick={submit}>{sending ? 'Sending...' : 'Send'}</button>
  {/snippet}
</Modal>

<style>
  .hint { margin: 0 0 10px; color: var(--text-dim); }
  .frame { display: flex; flex-direction: column; background: var(--bg-3); border: 1px solid var(--line-strong); transition: border-color 120ms var(--ease); }
  .frame:focus-within { border-color: color-mix(in srgb, var(--accent) 55%, var(--line-strong)); }
  .frame :global(.toolbar) { background: transparent; padding: 4px 8px; }
  .box { min-height: 46px; display: flex; align-items: center; gap: 2px; padding: 0 6px; }
  .input { position: relative; flex: 1; min-width: 0; padding: 12px 6px; max-height: 200px; overflow-y: auto; font-size: var(--fs-chat); line-height: 1.4; outline: none; overflow-wrap: anywhere; white-space: pre-wrap; }
  .input.blank::before { content: attr(data-placeholder); position: absolute; left: 6px; top: 12px; color: var(--text-faint); pointer-events: none; }
  .input :global(img) { max-height: 120px; }
  .input :global(ul), .input :global(ol) { margin: 0; padding-left: 20px; }
  .fmt { font-weight: 700; font-size: 13px; }
  .fmt.on { color: var(--accent-hover); }
  /* The GIF menu opens under the field instead of floating over the dialog */
  .gifs { margin-top: 8px; }
  .gifs :global(.gif-menu) { position: static; width: 100%; height: min(320px, 40vh); box-shadow: none; }
  .error { margin: 10px 0 0; color: var(--danger); }
</style>
