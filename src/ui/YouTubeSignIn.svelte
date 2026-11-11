<script lang="ts">
  import Modal from './Modal.svelte';
  import { desktop } from '../lib/native.ts';
  import { youtubeAccount as yt } from '../lib/youtube-account.svelte.ts';

  type Way = 'browser' | 'paste' | 'window';
  let way = $state<Way>('browser');
  let pasted = $state('');
  let folder = $state('');
  let waiting = $state(false);
  let help = $state<'extension' | 'manual'>('extension');

  const ways: { id: Way; label: string }[] = [
    { id: 'browser', label: 'Your browser' },
    { id: 'paste', label: 'Paste cookies' },
    { id: 'window', label: 'In-app window' }
  ];

  $effect(() => { desktop?.youtube.companionFolder().then(p => (folder = p)).catch(() => {}); });

  async function startBrowser() {
    waiting = true;
    await yt.signInBrowser();
    waiting = false;
  }
  function close() {
    if (waiting) yt.cancelBrowser();
    yt.dialog = false;
  }
</script>

<Modal title="Sign in to YouTube" onclose={close} width={600}>
  <p class="help">Google does not let apps like this one show its sign-in page, so the sign-in is done somewhere Google accepts, and mumh5 keeps the result. It stays signed in until you sign out.</p>

  <div class="ways" role="tablist">
    {#each ways as w (w.id)}
      <button role="tab" aria-selected={way === w.id} class:active={way === w.id} onclick={() => { way = w.id; yt.error = ''; }} disabled={yt.busy}>{w.label}</button>
    {/each}
  </div>

  {#if way === 'browser'}
    <p>Sign in with the browser you already use (Chrome, Edge, Brave, Firefox, ...). A small extension, <b>mumh5 companion</b>, hands the YouTube sign-in to this app.</p>
    <ol>
      <li><b>Once:</b> install the extension. It is a folder: in Chrome or Edge open <code>chrome://extensions</code>, turn on <b>Developer mode</b>, press <b>Load unpacked</b> and choose the folder. In Firefox use <code>about:debugging#/runtime/this-firefox</code> and <b>Load Temporary Add-on</b>.
        <div class="folder"><code>{folder || '...'}</code> <button class="btn" onclick={() => desktop?.youtube.openCompanionFolder()}>Open folder</button></div></li>
      <li>Press the button below. Your browser opens a page from this app: sign in to YouTube there, then press <b>Send my YouTube sign-in to mumh5</b>.</li>
    </ol>
    <p class="help">The page lives on <code>127.0.0.1</code> (this computer only), works once and closes after 10 minutes. The extension only reads cookies when you press that button and only sends them to this app.</p>
    {#if waiting}<p class="help">Waiting for the browser...</p>{/if}
  {:else if way === 'paste'}
    <p>Copy your YouTube cookies from a browser where you are signed in, and paste them here.</p>
    <p class="site">Take them from <b>https://www.youtube.com</b> (open it while signed in). Treat them like a password.</p>
    <div class="sub" role="tablist">
      <button role="tab" aria-selected={help === 'extension'} class:active={help === 'extension'} onclick={() => (help = 'extension')}>Cookie-Editor extension</button>
      <button role="tab" aria-selected={help === 'manual'} class:active={help === 'manual'} onclick={() => (help = 'manual')}>Manually (DevTools)</button>
    </div>
    {#if help === 'extension'}
      <ol>
        <li>Install <b>Cookie-Editor</b> from your browser's extension store (Chrome Web Store, Firefox Add-ons, Edge Add-ons).</li>
        <li>Open <b>youtube.com</b>, signed in, and click the Cookie-Editor icon.</li>
        <li>Press <b>Export</b>, then <b>JSON</b>. It copies the cookies.</li>
        <li>Paste them below.</li>
      </ol>
    {:else}
      <ol>
        <li>Open <b>youtube.com</b>, signed in, and press <kbd>F12</kbd> (DevTools).</li>
        <li>Open the <b>Network</b> tab, press <kbd>F5</kbd>, and click any request to <code>www.youtube.com</code> (the first one in the list).</li>
        <li>Under <b>Request Headers</b> find <b>Cookie</b>, and copy its whole value (right-click, <b>Copy value</b>).</li>
        <li>Paste it below. (Alternatively, in the <b>Application</b> tab (Firefox: <b>Storage</b>) open <b>Cookies</b>, click one, select all rows with <kbd>Ctrl</kbd>+<kbd>A</kbd> and copy.)</li>
      </ol>
    {/if}
    <textarea bind:value={pasted} rows="5" spellcheck="false" placeholder="Paste the cookies here" disabled={yt.busy}></textarea>
  {:else}
    <p>The app opens its own sign-in window and asks Google as if it were Firefox. <b>Experimental:</b> Google may still say "this browser or app may not be secure". If it does, use one of the other ways.</p>
  {/if}

  {#if yt.error}<p class="help warn">{yt.error}</p>{/if}

  {#snippet footer()}
    {#if way === 'browser'}
      {#if waiting}
        <button class="btn" onclick={() => yt.cancelBrowser()}>Cancel</button>
      {:else}
        <button class="btn" onclick={close}>Close</button>
        <button class="btn primary" onclick={startBrowser} disabled={yt.busy}>Open my browser</button>
      {/if}
    {:else if way === 'paste'}
      <button class="btn" onclick={close}>Close</button>
      <button class="btn primary" onclick={() => yt.importCookies(pasted).then(ok => { if (ok) pasted = ''; })} disabled={yt.busy || !pasted.trim()}>{yt.busy ? 'Importing...' : 'Sign in with these cookies'}</button>
    {:else}
      <button class="btn" onclick={close}>Close</button>
      <button class="btn primary" onclick={() => yt.signInWindow()} disabled={yt.busy}>{yt.busy ? 'Waiting for the window...' : 'Open the sign-in window'}</button>
    {/if}
  {/snippet}
</Modal>

<style>
  p { margin: 10px 0 0; }
  .help { font-size: 13px; color: var(--text-dim); }
  .help.warn { color: var(--warn); }
  .site { padding: 8px 10px; background: var(--bg-0); border: 1px solid var(--line); }
  ol { margin: 10px 0 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
  code, kbd { font-family: var(--mono); font-size: 12.5px; background: var(--bg-3); padding: 1px 5px; overflow-wrap: anywhere; }
  .folder { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .folder code { flex: 1; min-width: 0; }
  .ways, .sub { display: flex; gap: 2px; margin: 14px 0 4px; border-bottom: 1px solid var(--line); }
  .sub { margin-top: 10px; }
  .ways button, .sub button { padding: 8px 12px; color: var(--text-dim); font-weight: 500; background: none; border: 0; cursor: pointer; }
  .ways button:hover:not(:disabled), .sub button:hover { color: var(--text); }
  .ways button.active, .sub button.active { color: var(--text); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
  textarea { width: 100%; margin-top: 10px; resize: vertical; font-family: var(--mono); font-size: 12px; }
</style>
