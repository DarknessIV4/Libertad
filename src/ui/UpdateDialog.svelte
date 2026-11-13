<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from './Modal.svelte';
  import { desktop } from '../lib/native.ts';
  import { formatBytes } from '../lib/html.ts';

  // The start-up update question, in the app's own windows and buttons (so it follows Settings > Appearance).
  // electron/updater.ts sends the update it found; Yes downloads it with a progress bar, No closes this.
  type Info = { current: string; latest: string; kind: 'appimage' | 'windows' | 'manual' };
  let info = $state<Info | null>(null);
  let step = $state<'ask' | 'busy' | 'done' | 'error'>('ask');
  let done = $state(0);
  let total = $state(0);
  let error = $state('');

  onMount(() => {
    const offAvailable = desktop?.update.onAvailable(i => { info = i; step = 'ask'; done = 0; total = i.size ?? 0; error = ''; });
    const offProgress = desktop?.update.onProgress((d, t) => { done = d; total = t; });
    return () => { offAvailable?.(); offProgress?.(); };
  });

  const percent = $derived(total ? Math.min(100, Math.round(done / total * 100)) : 0);

  function close() { if (step !== 'busy') info = null; }

  async function yes() {
    if (!info) return;
    const kind = info.kind;
    step = 'busy'; done = 0; error = '';
    try {
      await desktop!.update.install();
      if (kind === 'manual') info = null;
      else step = 'done';
    } catch (e) {
      error = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      step = 'error';
    }
  }
</script>

{#if info}
  <Modal title={step === 'error' ? 'Update failed' : 'Update available'} onclose={close} width={420}>
    {#if step === 'error'}
      <p class="msg">{error}</p>
    {:else}
      <p class="msg">Libertad {info.latest} is available (you have {info.current}).</p>
      {#if step === 'ask'}
        <p class="detail">{info.kind === 'manual' ? 'Open the download page?' : 'Download and update now?'}</p>
      {:else}
        <div class="bar" class:unknown={step === 'busy' && !total} role="progressbar" aria-label="Download progress"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow={step === 'done' ? 100 : total ? percent : undefined}>
          <span style:width="{step === 'done' ? 100 : percent}%"></span>
        </div>
        <p class="detail">
          {#if step === 'done'}
            {info.kind === 'windows' ? 'The installer is open; follow it to finish.' : 'Updated. Restarting...'}
          {:else if total}
            Downloading... {percent}% ({formatBytes(done)} of {formatBytes(total)})
          {:else}
            Downloading...
          {/if}
        </p>
      {/if}
    {/if}
    {#snippet footer()}
      {#if step === 'ask'}
        <button class="btn" onclick={close}>No</button>
        <!-- svelte-ignore a11y_autofocus -->
        <button class="btn primary" onclick={yes} autofocus>Yes</button>
      {:else if step === 'error'}
        <button class="btn" onclick={close}>Close</button>
      {:else if step === 'busy'}
        <button class="btn primary" disabled>Downloading...</button>
      {/if}
    {/snippet}
  </Modal>
{/if}

<style>
  .msg { margin: 0 0 6px; }
  .detail { margin: 10px 0 0; color: var(--text-dim); font-size: 13px; }
  /* The track and the fill follow the roundness setting and the accent color */
  .bar { height: 8px; margin-top: 14px; background: var(--bg-3); border-radius: var(--r-pill, 0px); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent); border-radius: inherit; transition: width 120ms; }
  .bar.unknown span { width: 40% !important; animation: slide 1.1s ease-in-out infinite alternate; }
  @keyframes slide { from { transform: translateX(0); } to { transform: translateX(150%); } }
</style>
