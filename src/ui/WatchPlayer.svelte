<script lang="ts">
  import { tip } from '../lib/tip.ts';
  import { playerKey } from '../lib/player-keys.ts';
  import { watchTogether } from '../lib/watch-together.svelte.ts';
  import { watchFileStream } from '../core/watch-stream.ts';
  import { watchFileStreamState } from '../lib/watch-file-stream.svelte.ts';
  import { sessions } from '../lib/session.svelte.ts';
  import { onMount, onDestroy, untrack } from 'svelte';
  import YouTubePlayer from './YouTubePlayer.svelte';
  import Icon from './Icon.svelte';
  import { files } from '../lib/files.svelte.ts';
  import { IDLE_MS } from '../lib/yt-controls.ts';
  import { desktop } from '../lib/native.ts';
  import { TorrentPlay } from '../lib/torrent-play.svelte.ts';
  import { langLabel } from '../core/subtitles.ts';
  import type { EmbeddedTrack } from '../core/mkv.ts';
  import { store } from '../lib/settings.svelte.ts';
  import { watchMemo } from '../lib/watch-memo.svelte.ts';
  import { menuClosed, menuJustClosed, swallowClick } from '../lib/overlay.ts';
  import { canSaveFrame, saveVideoFrame } from '../lib/save-frame.ts';

  console.log('[WatchPlayer] Component script running');

  // Watch together player container - switches between YouTube and local video based on mode

  // The viewer's own <video>, showing the live stream. The host's player is not here: it belongs to
  // the session (it keeps playing when the host leaves, because it is what the viewers receive)
  // and this screen only shows it, see `adopt`.
  let videoElement = $state<HTMLVideoElement | null>(null);
  let hasVideo = $state(false); // write-only in effect, read in template

  // Prevent infinite loops: when we apply external sync, don't send back to watch-together
// (Removed - watchTogether now handles echo suppression)

  // The host's player is shown as it is; everyone else plays the live stream the host sends
  const liveStream = $derived.by<MediaStream | null>(() => {
    if (watchTogether.mode !== 2 || !watchTogether.party || watchTogether.isHost) return null;
    const w = watchFileStreamState.watchersOf(sessions.active).find(x => x.session === watchTogether.party!.hostSession);
    return w?.stream ?? null;
  });

  let needsUnmute = $state(false);

  // Torrent together: everybody plays the torrent in their own player, kept in step by the shared state
  const tp = new TorrentPlay();
  let tVideo = $state<HTMLVideoElement | null>(null);
  let localDuration = $state(0);
  let subsOpen = $state(false);
  // The voice menu; one of the two menus is open at a time
  let voiceOpen = $state(false);
  // The playback speed menu; the speed itself is shared by everybody in the party
  let speedOpen = $state(false);
  let rate = $state(1);
  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const rateLabel = (r: number) => `${r}x`;
  const pickRate = (r: number) => { watchTogether.setRate(r); rate = r; speedOpen = false; };
  let subFile = $state<HTMLInputElement>();
  let subQuery = $state('');
  // The size menu shows up after a subtitle was picked
  let subAdjust = $state(false);
  let playerH = $state(0);
  const SIZE_MIN = 50, SIZE_MAX = 300, SIZE_STEP = 10;
  const subSize = $derived(Math.max(SIZE_MIN, Math.min(SIZE_MAX, store.settings.subtitleSize || 100)));
  // 4.5% of the picture's height is 100%, so the text grows with the window and in full screen
  const subPx = $derived(Math.max(10, Math.round(playerH * 0.045 * subSize / 100)));
  const subOpacity = $derived(Math.max(20, Math.min(100, store.settings.subtitleOpacity ?? 100)));
  const subBgOpacity = $derived(Math.max(0, Math.min(100, store.settings.subtitleBgOpacity ?? 65)));
  const clamp01 = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  function setSubSize(v: number) {
    store.settings.subtitleSize = clamp01(Math.round(v), SIZE_MIN, SIZE_MAX);
    store.saveSettings();
  }
  function setSubOpacity(v: number) {
    store.settings.subtitleOpacity = clamp01(Math.round(v), 20, 100);
    store.saveSettings();
  }
  function setSubBgOpacity(v: number) {
    store.settings.subtitleBgOpacity = clamp01(Math.round(v), 0, 100);
    store.saveSettings();
  }
  function toggleSubBg() {
    store.settings.subtitleBg = !store.settings.subtitleBg;
    store.saveSettings();
  }
  function resetSubLook() {
    store.settings.subtitleOpacity = 100;
    store.settings.subtitleBg = true;
    store.settings.subtitleBgOpacity = 65;
    store.settings.subtitleSize = 100;
    store.settings.subtitleX = 0.5;
    store.settings.subtitleY = 0.92;
    store.saveSettings();
  }
  // How a track inside the video file is listed: its language, its title when it has one, and a number to tell
  // untitled ones of the same language apart
  function embeddedLabel(t: EmbeddedTrack, i: number): string {
    const base = langLabel(t.lang);
    const named = t.name && t.name.toLowerCase() !== base.toLowerCase() ? ` - ${t.name}` : '';
    const n = tp.embedded.slice(0, i).filter(o => o.lang === t.lang && !o.name).length + 1;
    return `${base}${named}${!t.name && n > 1 ? ` #${n}` : ''}${t.forced ? ' (forced)' : ''}`;
  }
  // The menus are overlays: nothing done on them reaches the picture below (a double click on an
  // item does not go full screen), and a press anywhere else closes them
  const stop = (e: Event) => e.stopPropagation();
  const anyOpen = $derived(subsOpen || voiceOpen || speedOpen);
  $effect(() => {
    if (!anyOpen) return;
    // Closing, by an item or from outside, is noted: the second click of a double click is not the picture's
    return () => menuClosed();
  });
  function outside(e: PointerEvent) {
    if (!anyOpen) return;
    if ((e.target as Element | null)?.closest?.('.subs, button[aria-expanded]')) return;
    subsOpen = voiceOpen = speedOpen = false;
    swallowClick(e);
  }
  function pickSub(id: string) {
    // Picking the one that is already on opens and closes its menu
    if (id !== 'off' && tp.chosen === id) { subAdjust = !subAdjust; return; }
    subAdjust = id !== 'off';
    void tp.choose(id);
  }

  // Holding the subtitles and dragging moves them; a click without moving still pauses and plays
  let subEl = $state<HTMLDivElement | null>(null);
  let subDrag = $state<{ dx: number; dy: number; x0: number; y0: number; moved: boolean } | null>(null);
  function subDown(e: PointerEvent) {
    if (e.button !== 0 || !subEl) return;
    const box = subEl.getBoundingClientRect();
    // How far the pointer is from the subtitles' anchor (middle, bottom edge), so they do not jump
    subDrag = { dx: e.clientX - (box.left + box.width / 2), dy: e.clientY - box.bottom, x0: e.clientX, y0: e.clientY, moved: false };
    subEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function subMove(e: PointerEvent) {
    const d = subDrag;
    const host = subEl?.parentElement;
    if (!d || !host) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
    d.moved = true;
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    store.settings.subtitleX = clamp01((e.clientX - d.dx - r.left) / r.width, 0.05, 0.95);
    store.settings.subtitleY = clamp01((e.clientY - d.dy - r.top) / r.height, 0.08, 1);
  }
  function subUp(e: PointerEvent) {
    const d = subDrag;
    subDrag = null;
    if (subEl?.hasPointerCapture(e.pointerId)) subEl.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.moved) store.saveSettings();
    else if (tp.status === 'ready') toggle();
  }
  const torrentKey = $derived(watchTogether.mode === 3 && watchTogether.isWatching && watchTogether.torrent
    ? `${watchTogether.torrent.infoHash}:${watchTogether.torrent.fileIdx}:${watchTogether.party?.currentIndex ?? 0}` : '');
  // More than one link was queued: there is a next one after this
  const hasNext = $derived(watchTogether.mode === 3 && watchTogether.hasNextTorrent);
  // The video played to its end (the Next button then shows in the middle of the picture)
  let tEnded = $state(false);
  const goNext = () => { void watchTogether.nextTorrent(); };
  // Once this link is fully downloaded, the next one starts downloading by itself
  const prefetched = new Set<string>();
  $effect(() => {
    if (!watchTogether.isWatching) prefetched.clear();
    if (watchTogether.mode !== 3 || tp.status !== 'ready' || (tp.stats?.progress ?? 0) < 1) return;
    const next = watchTogether.torrentQueue[(watchTogether.party?.currentIndex ?? 0) + 1];
    if (!next) return;
    const key = `${next.infoHash}:${next.fileIdx}`;
    if (prefetched.has(key)) return;
    prefetched.add(key);
    void desktop?.torrent?.play({ magnet: next.magnet, fileIdx: next.fileIdx }).catch(() => {});
  });
  $effect(() => {
    const video = tVideo;
    if (!torrentKey || !video) return;
    const meta = untrack(() => watchTogether.torrent);
    if (!meta) return;
    tEnded = false;
    // The memo is this person's own: it is set when they start watching, as host or as a joiner
    watchMemo.record(meta.fileName || meta.name);
    const onEnded = () => { tEnded = true; };
    const onAgain = () => { tEnded = false; };
    video.addEventListener('ended', onEnded);
    video.addEventListener('playing', onAgain);
    video.addEventListener('seeked', onAgain);
    untrack(() => { void tp.start(meta, video, () => { watchTogether.setVideoElement(video); watchTogether.syncPlayer(); }); });
    return () => {
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('playing', onAgain);
      video.removeEventListener('seeked', onAgain);
      tEnded = false;
      // The party stops listening to this player before it is emptied, so unloading it is nobody's gesture
      if (watchTogether.localVideo === video) watchTogether.setVideoElement(null);
      tp.stop();
      subsOpen = false;
      voiceOpen = false;
      speedOpen = false;
      subAdjust = false;
      localDuration = 0;
    };
  });
  const speed = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB/s` : `${Math.round(n / 1024)} kB/s`;

  // A viewer's player shows a live picture, so it has no seek bar of its own. These controls
  // ask the host's player, the same way everybody's gestures always did.
  const viewing = $derived(watchTogether.mode === 2 && !watchTogether.isHost && !!watchTogether.party && hasVideo);
  // The same bar for the host, whose gestures go through the shared state just the same
  const barShown = $derived(watchTogether.mode === 3
    ? !!watchTogether.party && tp.status === 'ready'
    : watchTogether.mode === 2 && !!watchTogether.party && (watchTogether.isHost ? !!watchTogether.hostVideo : hasVideo));
  // The player whose sound the volume controls: the host's own, or the viewer's live one (a torrent is everybody's own)
  const target = $derived(watchTogether.mode === 3 ? tVideo : watchTogether.isHost ? watchTogether.hostVideo : videoElement);
  let pos = $state(0);
  let playingNow = $state(false);
  let dragTo = $state<number | null>(null);
  let volume = $state(1);
  let hostDuration = $state(0);
  const duration = $derived(watchTogether.mode === 3 ? localDuration : watchTogether.isHost ? hostDuration : watchTogether.durationMs);
  $effect(() => {
    if (!barShown) return;
    const tick = () => {
      pos = watchTogether.sharedPosition();
      playingNow = watchTogether.sharedPlaying();
      rate = watchTogether.sharedRate();
      const d = watchTogether.hostVideo?.duration;
      hostDuration = watchTogether.isHost && d && Number.isFinite(d) ? Math.round(d * 1000) : 0;
      const td = tVideo?.duration;
      localDuration = watchTogether.mode === 3 && td && Number.isFinite(td) ? Math.round(td * 1000) : 0;
    };
    tick();
    const timer = setInterval(tick, 200);
    return () => clearInterval(timer);
  });
  const toggle = () => { if (playingNow) watchTogether.pause(); else watchTogether.play(); };
  // Left and right arrow: 5 seconds back or forward, from where the shared position is now
  const seekBy = (ms: number) => {
    const max = duration || Infinity;
    const to = Math.max(0, Math.min(max, watchTogether.sharedPosition() + ms));
    watchTogether.seek(to);
    pos = to;
  };

  // The bar is there while the mouse moves, and goes IDLE_MS after it stopped (or when it leaves)
  let active = $state(false);
  let idleTimer: number | null = null;
  function wake() {
    active = true;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = window.setTimeout(sleep, IDLE_MS);
  }
  function sleep() {
    // A slider being dragged keeps it
    if (dragTo !== null) { idleTimer = window.setTimeout(sleep, IDLE_MS); return; }
    active = false;
    idleTimer = null;
  }
  function leave() {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    active = false;
  }
  const clock = (ms: number) => {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  function setVolume(v: number) {
    volume = v;
    if (target) { target.volume = v; target.muted = v === 0; }
    if (v > 0) needsUnmute = false;
  }
  // The host's player may have been muted while they were away; show what it really is
  $effect(() => {
    const el = target;
    if (el) untrack(() => { volume = el.muted ? 0 : el.volume; });
  });

  // Download the whole file the host plays, through the file transfer (asks where to save it)
  const share = $derived(watchTogether.party?.fileShare ?? null);
  const dl = $derived(share ? files.transfers[share.i] : undefined);
  const dlBusy = $derived(dl?.state === 'finding' || dl?.state === 'loading');
  const dlPct = $derived(share && dl?.state === 'loading' ? Math.min(99, Math.floor(dl.got / share.s * 100)) : 0);
  let wantSave = false;
  $effect(() => { const m = share; if (m) untrack(() => files.check(m)); });
  // A file kept in memory (small, or no save dialog on this browser) is saved with a link
  function saveLink(url: string, name: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  }
  $effect(() => {
    if (wantSave && share && dl?.state === 'ready') {
      wantSave = false;
      if (dl.url) saveLink(dl.url, share.n);
    }
  });
  function download() {
    if (!share || !watchTogether.party) return;
    if (dlBusy) return files.cancel(share.i);
    if (dl?.state === 'ready') {
      if (dl.url) saveLink(dl.url, share.n);
      else if (dl.saved) files.reveal(share.i);
      return;
    }
    wantSave = true;
    files.download(sessions.active, share, watchTogether.party.hostSession, true);
  }

  // Saves the frame on screen as a PNG, where this person picks. Nothing is sent to the others.
  let frameBusy = $state(false);
  async function saveFrame() {
    if (frameBusy) return;
    frameBusy = true;
    try { await saveVideoFrame(tVideo); } finally { frameBusy = false; }
  }

  // Viewer: show the stream as soon as the first track arrives
  $effect(() => {
    const video = videoElement;
    const stream = liveStream;
    if (!video || !stream) return;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      hasVideo = true;
    }
    const start = () => {
      video.play().catch(() => {
        // Autoplay with sound was refused: play muted and offer to unmute
        video.muted = true;
        needsUnmute = true;
        video.play().catch(() => {});
      });
    };
    start();
    stream.addEventListener('addtrack', start);
    return () => stream.removeEventListener('addtrack', start);
  });

  function unmute() {
    if (videoElement) videoElement.muted = false;
    needsUnmute = false;
  }

  onMount(() => {
    console.log('[WatchPlayer] Mounted - mode:', watchTogether.mode, 'isWatching:', watchTogether.isWatching);
  });

  // Show the host's player here, and hand it back (still playing) when this screen goes away
  function adopt(node: HTMLElement, _player: HTMLVideoElement | null) {
    let release = watchTogether.mountHostVideo(node);
    return {
      update() { release(); release = watchTogether.mountHostVideo(node); },
      destroy() { release(); }
    };
  }

  // Clean up when watch-together ends
  $effect(() => {
    if (!watchTogether.isWatching && videoElement) {
      console.log('[WatchPlayer] Watch together ended - stopping video');
      videoElement.pause();
      videoElement.srcObject = null;
      videoElement.removeAttribute('src');
      videoElement.load();
      needsUnmute = false;
      hasVideo = false;
    }
  });

  onDestroy(() => {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    console.log('[WatchPlayer] Destroyed');
    if (videoElement) {
      videoElement.pause();
    }
    hasVideo = false;
  });
</script>

<svelte:window onpointerdowncapture={outside}
  onkeydown={e => { if (e.key === 'Escape' && anyOpen) { subsOpen = voiceOpen = speedOpen = false; return; } if (barShown) playerKey(e, { toggle, seekBy }); }} />

{#snippet look()}
  <div class="look" role="group" aria-label="Subtitle size">
    <div class="row">
      <span>Size</span>
      <button class="ctl" onclick={() => setSubSize(subSize - SIZE_STEP)} disabled={subSize <= SIZE_MIN} aria-label="Smaller subtitles">-</button>
      <span class="val">{subSize}%</span>
      <button class="ctl" onclick={() => setSubSize(subSize + SIZE_STEP)} disabled={subSize >= SIZE_MAX} aria-label="Larger subtitles">+</button>
    </div>
    <input type="range" min={SIZE_MIN} max={SIZE_MAX} step="5" value={subSize} aria-label="Subtitle size"
      oninput={e => setSubSize(Number(e.currentTarget.value))} onchange={e => e.currentTarget.blur()} />
    <div class="row">
      <span>Opacity</span>
      <span class="val">{subOpacity}%</span>
    </div>
    <input type="range" min="20" max="100" step="5" value={subOpacity} aria-label="Subtitle opacity"
      oninput={e => setSubOpacity(Number(e.currentTarget.value))} onchange={e => e.currentTarget.blur()} />
    <label class="row check">
      <input type="checkbox" checked={store.settings.subtitleBg} onchange={toggleSubBg} />
      <span>Background</span>
    </label>
    {#if store.settings.subtitleBg}
      <div class="row">
        <span>Background opacity</span>
        <span class="val">{subBgOpacity}%</span>
      </div>
      <input type="range" min="0" max="100" step="5" value={subBgOpacity} aria-label="Subtitle background opacity"
        oninput={e => setSubBgOpacity(Number(e.currentTarget.value))} onchange={e => e.currentTarget.blur()} />
    {/if}
    <p class="tip">Hold the subtitles on the video and drag them to move them.</p>
    <button class="opt" onclick={resetSubLook}>Reset size and place</button>
  </div>
{/snippet}

{#snippet speedMenu()}
  {#if speedOpen}
    <div class="subs speeds" role="dialog" aria-label="Playback speed" ondblclick={stop}>
      {#each RATES as r (r)}
        <button class="opt" class:sel={rate === r} aria-pressed={rate === r} onclick={() => pickRate(r)}>{r === 1 ? 'Normal' : rateLabel(r)}</button>
      {/each}
      <p class="note">Changes the speed for everybody watching.</p>
    </div>
  {/if}
{/snippet}

{#snippet bar()}
  <div class="controls" role="presentation" ondblclick={stop}>
    <button use:tip class="ctl" onclick={toggle} aria-label={playingNow ? 'Pause' : 'Play'} title={playingNow ? 'Pause' : 'Play'}>
      <Icon name={playingNow ? 'pause' : 'play'} size={20} />
    </button>
    <span class="time">{clock(dragTo ?? pos)}{duration ? ` / ${clock(duration)}` : ''}</span>
    <input class="seek" type="range" min="0" max={duration || 1} step="1000" disabled={!duration}
      value={Math.min(dragTo ?? pos, duration || 1)} aria-label="Seek"
      oninput={e => { dragTo = Number(e.currentTarget.value); }}
      onchange={e => { const to = Number(e.currentTarget.value); watchTogether.seek(to); pos = to; dragTo = null; e.currentTarget.blur(); }} />
    <button use:tip class="ctl" onclick={() => setVolume(volume === 0 || needsUnmute ? 1 : 0)} aria-label="Mute" title="Mute">
      <Icon name={volume === 0 ? 'volume-off' : 'volume'} size={18} />
    </button>
    <input class="vol" type="range" min="0" max="1" step="0.05" value={volume} aria-label="Volume"
      oninput={e => setVolume(Number(e.currentTarget.value))} onchange={e => e.currentTarget.blur()} />
    {#if watchTogether.mode === 3 && hasNext}
      <button use:tip class="ctl" onclick={goNext} aria-label="Next link" title="Next link">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5l10 7-10 7V5zM18 5h2v14h-2V5z" /></svg>
      </button>
    {/if}
    {#if watchTogether.mode === 3}
      <button use:tip class="ctl" class:on={tp.chosen !== 'off'} onclick={() => { subsOpen = !subsOpen; voiceOpen = false; speedOpen = false; }} aria-label="Subtitles" aria-expanded={subsOpen}
        title={tp.chosen === 'off' ? 'Subtitles' : 'Subtitles are on'}>
        <Icon name="captions" size={18} />
      </button>
      <button use:tip class="ctl" onclick={() => { voiceOpen = !voiceOpen; subsOpen = false; speedOpen = false; }} aria-label="Voice" aria-expanded={voiceOpen}
        title={tp.audio.find(a => a.on)?.label ? `Voice: ${tp.audio.find(a => a.on)?.label}` : 'Voice'}>
        <Icon name="voiceover" size={18} />
      </button>
      <button use:tip class="ctl speed" class:on={rate !== 1} onclick={() => { speedOpen = !speedOpen; subsOpen = false; voiceOpen = false; }} aria-label="Playback speed" aria-expanded={speedOpen}
        title={`Playback speed: ${rateLabel(rate)} (for everybody)`}>
        <Icon name="speed" size={18} />{#if rate !== 1}<span class="pct">{rateLabel(rate)}</span>{/if}
      </button>
      <button use:tip class="ctl" onclick={saveFrame} disabled={frameBusy} aria-label="Save this frame" title="Save this frame as a picture">
        <Icon name="download" size={18} />
      </button>
    {/if}
    {#if watchTogether.mode === 2}
      <button use:tip class="ctl speed" class:on={rate !== 1} onclick={() => { speedOpen = !speedOpen; subsOpen = false; voiceOpen = false; }} aria-label="Playback speed" aria-expanded={speedOpen}
        title={`Playback speed: ${rateLabel(rate)} (for everybody)`}>
        <Icon name="speed" size={18} />{#if rate !== 1}<span class="pct">{rateLabel(rate)}</span>{/if}
      </button>
    {/if}
    {#if share && !watchTogether.isHost}
      <button use:tip class="ctl dl" onclick={download} aria-label={dlBusy ? 'Stop downloading' : 'Download the video'}
        title={dlBusy ? `Downloading ${dlPct}% (click to stop)` : dl?.state === 'ready' ? (dl.saved ? `Saved as ${dl.saved}` : 'Save the video') : dl?.state === 'failed' ? `${dl.error} (click to try again)` : `Download the whole video (${share.n})`}>
        {#if dlBusy}<span class="pct">{dlPct}%</span>{/if}
        <Icon name={dlBusy ? 'x' : 'download'} size={18} />
      </button>
    {/if}
    <!-- Streamed from the host: the frame on screen, last, at the bottom right -->
    {#if watchTogether.mode === 2 && canSaveFrame()}
      <button use:tip class="ctl" onclick={() => saveVideoFrame(target, watchTogether.sharedPosition() / 1000)} aria-label="Save this frame" title="Save this frame as a picture">
        <Icon name="download" size={18} />
      </button>
    {/if}
  </div>
{/snippet}

{#if watchTogether.isWatching}
  <div class="watch-player" class:active bind:clientHeight={playerH} role="presentation" onpointermove={wake} onpointerdown={wake} onpointerleave={leave}>
    {#if watchTogether.mode === 1}
      <!-- YouTube player -->
      <YouTubePlayer />
    {:else if watchTogether.mode === 3}
      <!-- Torrent together: a player of one's own, fed by the torrent this computer downloads -->
      {#if !desktop?.torrent}
        <div class="loading"><p>Torrent Together needs the Libertad desktop app. The others can watch; this browser can not download torrents.</p></div>
      {:else}
        <video bind:this={tVideo} class="local-video" crossorigin="anonymous" playsinline preload="auto"
          onclick={() => { if (tp.status === 'ready' && !menuJustClosed()) toggle(); }}></video>
        {#if tp.status === 'failed'}
          <div class="loading"><p style="color: var(--danger);">{tp.error}</p></div>
        {:else if tp.status !== 'ready'}
          <div class="loading">
            <div class="spinner"></div>
            <p>Finding people who share this torrent...</p>
            {#if tp.stats}<p class="sub">{tp.stats.peers} {tp.stats.peers === 1 ? 'peer' : 'peers'}{tp.stats.ready ? `, ${speed(tp.stats.down)}` : ''}</p>{/if}
            {#if tp.converting}<p class="sub">Converting {tp.converting} so it can be played. The first seconds take a while.</p>{/if}
          </div>
        {:else}
          {#if tp.buffering && !tEnded}
            <div class="buffer"><div class="spinner small"></div></div>
          {/if}
          {#if tEnded && hasNext}
            <button use:tip class="next-big" onclick={goNext} aria-label="Next link" title="Next link">
              <svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5l10 7-10 7V5zM18 5h2v14h-2V5z" /></svg>
              <span>Next</span>
            </button>
          {/if}
          {#if tp.stats}
            <span class="chip" aria-live="off">{speed(tp.stats.down)} · {tp.stats.peers} {tp.stats.peers === 1 ? 'peer' : 'peers'} · {Math.floor(tp.stats.progress * 100)}%{tp.converting ? ' · converted' : ''}</span>
          {/if}
          {#if !playingNow && pos < 1000}
            <p class="hint">{watchTogether.isHost ? 'Press play when everybody has joined' : 'Waiting for the host to press play'}</p>
          {/if}
          {#if tp.shown}
            <div class="cues" class:dragging={subDrag?.moved} class:nobg={!store.settings.subtitleBg} bind:this={subEl} role="presentation" title="Hold and drag to move the subtitles"
              style="left: {store.settings.subtitleX * 100}%; top: {store.settings.subtitleY * 100}%; font-size: {subPx}px; opacity: {subOpacity / 100};{store.settings.subtitleBg ? ` background: rgba(0, 0, 0, ${subBgOpacity / 100});` : ''}"
              onpointerdown={subDown} onpointermove={subMove} onpointerup={subUp} onpointercancel={subUp}>{@html tp.shown}</div>
          {/if}
          {#if subsOpen}
            <div class="subs" role="dialog" aria-label="Subtitles" ondblclick={stop}>
              <button class="opt" class:sel={tp.chosen === 'off'} onclick={() => pickSub('off')}>Off</button>
              {#each tp.embedded as t, i (t.number)}
                {@const id = `emb:${t.number}`}
                <button class="opt" class:sel={tp.chosen === id} aria-expanded={tp.chosen === id ? subAdjust : undefined} onclick={() => pickSub(id)}>
                  {embeddedLabel(t, i)}<span class="src">(Embedded)</span>
                </button>
                {#if tp.chosen === id && subAdjust}{@render look()}{/if}
              {/each}
              {#each tp.subs as s, i (s.id)}
                {@const n = tp.subs.slice(0, i).filter(o => o.lang === s.lang).length + 1}
                <button class="opt" class:sel={tp.chosen === s.id} aria-expanded={tp.chosen === s.id ? subAdjust : undefined} onclick={() => pickSub(s.id)}>
                  {langLabel(s.lang)}{n > 1 ? ` #${n}` : ''}{#if s.source}<span class="src">({s.source})</span>{/if}
                </button>
                {#if tp.chosen === s.id && subAdjust}{@render look()}{/if}
              {/each}
              {#if tp.chosen.startsWith('emb:') && tp.scan.state === 'running'}<p class="note" aria-live="polite">Reading the subtitles from the video... {Math.round(tp.scan.progress * 100)}%</p>{/if}
              {#if tp.subsState === 'searching'}<p class="note">Looking for subtitles...</p>
              {:else if !tp.subs.length && !tp.embedded.length}<p class="note">No subtitles were found for this video. Try its English title or IMDb id below.</p>{/if}
              {#if tp.subError}<p class="note err">{tp.subError}</p>{/if}
              <form class="find" onsubmit={e => { e.preventDefault(); void tp.search(subQuery); }}>
                <input bind:value={subQuery} placeholder="Title or IMDb id (tt...)" aria-label="Search subtitles by title or IMDb id" maxlength="200" />
                <button class="opt" type="submit" disabled={!subQuery.trim() || tp.subsState === 'searching'}>Search</button>
              </form>
              <button class="opt" class:sel={tp.chosen === 'file'} onclick={() => { subAdjust = true; subFile?.click(); }}>From a file...{#if tp.chosen === 'file'}<span class="src">(File)</span>{/if}</button>
              {#if tp.chosen === 'file' && subAdjust}{@render look()}{/if}
              <input bind:this={subFile} type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" hidden
                onchange={e => { const f = e.currentTarget.files?.[0]; if (f) void tp.loadFile(f); e.currentTarget.value = ''; }} />
              <div class="delay">
                <span>Delay</span>
                <button class="ctl" onclick={() => tp.setDelay(tp.delayMs - 500)} aria-label="Show subtitles 0.5 seconds earlier">-</button>
                <span class="val">{(tp.delayMs / 1000).toFixed(1)} s</span>
                <button class="ctl" onclick={() => tp.setDelay(tp.delayMs + 500)} aria-label="Show subtitles 0.5 seconds later">+</button>
              </div>
            </div>
          {/if}
          {#if voiceOpen}
            <div class="subs" role="dialog" aria-label="Voice" ondblclick={stop}>
              {#each tp.audio as a (a.index)}
                <button class="opt" class:sel={a.on} aria-pressed={a.on} onclick={() => tp.setAudio(a.index)}>
                  {a.label}{#if a.detail}<span class="src">({a.detail})</span>{/if}
                </button>
              {/each}
              {#if tp.audio.length < 2}<p class="note">This video has only one voice.</p>{/if}
            </div>
          {/if}
          {@render speedMenu()}
          {@render bar()}
        {/if}
      {/if}
    {:else if watchTogether.mode === 2}
      <!-- File streaming: the host sees their own player, viewers the live stream -->
      {#if watchTogether.isHost}
        <div class="host-slot" role="presentation" use:adopt={watchTogether.hostVideo} onclick={() => { if (!menuJustClosed()) toggle(); }}></div>
        {#if barShown}{@render speedMenu()}{@render bar()}{/if}
      {:else}
        <video
          bind:this={videoElement}
          class="local-video"
          playsinline
          preload="auto"
          onclick={() => { if (viewing && !menuJustClosed()) toggle(); }}
        >
          <track kind="captions" />
        </video>
      {/if}
      {#if watchTogether.mode === 2 && !watchTogether.isHost && watchTogether.party}
        {@const watchers = watchFileStreamState.watchersOf(sessions.active)}
        {@const hostSession = watchTogether.party.hostSession}
        {@const watcher = watchers.find(w => w.session === hostSession)}
        {#if !hasVideo}
          {#if watcher && watcher.state === 'failed'}
            <div class="loading">
              <p style="color: var(--danger);">Stream failed</p>
            </div>
          {:else}
            <div class="loading">
              <div class="spinner"></div>
              <p>Connecting to the host's stream...</p>
            </div>
          {/if}
        {:else}
          {#if needsUnmute}
            <button class="unmute" onclick={unmute}>Click to turn the sound on</button>
          {/if}
          {@render speedMenu()}
          {@render bar()}
        {/if}
      {/if}
    {/if}
  </div>
{/if}

<style>
  .watch-player {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 200px;
    background: #000;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: stretch;
  }

  .host-slot {
    width: 100%;
    height: 100%;
    display: flex;
  }

  .local-video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .loading {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    color: var(--text);
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--line);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .controls {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 18px 12px 8px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.75));
    color: #fff;
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 5;
  }
  .watch-player.active .controls { opacity: 1; }
  .watch-player:not(.active) .controls { pointer-events: none; }
  .watch-player:not(.active) { cursor: none; }
  .ctl {
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    padding: 4px;
    border-radius: 6px;
    color: inherit;
    cursor: pointer;
  }
  .ctl:hover, .ctl:focus-visible { background: rgba(255, 255, 255, 0.2); }
  .time { font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* The seek bar takes the room that is left, so the volume and the download button sit right after it */
  .seek { flex: 1; min-width: 0; }
  .vol { width: 80px; }
  .dl { gap: 6px; }
  .pct { font-size: 12px; font-variant-numeric: tabular-nums; }

  .spinner.small { width: 28px; height: 28px; border-width: 2px; }
  .buffer { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  .loading .sub { font-size: 12px; font-variant-numeric: tabular-nums; }
  .chip {
    position: absolute; top: 8px; left: 8px; z-index: 5; padding: 3px 8px; border-radius: 6px;
    background: rgba(0, 0, 0, 0.55); color: #fff; font-size: 11px; font-variant-numeric: tabular-nums;
    opacity: 0; transition: opacity 0.15s; pointer-events: none;
  }
  .watch-player.active .chip { opacity: 1; }
  .hint {
    position: absolute; left: 0; right: 0; bottom: 64px; text-align: center; margin: 0; z-index: 4;
    color: #fff; font-size: 13px; text-shadow: 0 1px 3px #000; pointer-events: none;
  }
  .ctl.on { color: var(--accent); }
  .next-big {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 3;
    display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 28px;
    color: #fff; background: rgba(0, 0, 0, 0.7); border: 1px solid rgba(255, 255, 255, 0.35); font-weight: 600;
  }
  .next-big:hover, .next-big:focus-visible { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .subs {
    position: absolute; right: 12px; bottom: 52px; z-index: 6; width: 240px; max-height: 60%; overflow-y: auto;
    display: flex; flex-direction: column; padding: 6px; border-radius: 8px;
    background: rgba(20, 20, 24, 0.96); border: 1px solid var(--line); color: #fff;
  }
  .subs .opt {
    text-align: left; padding: 6px 8px; border: none; border-radius: 6px; background: transparent; color: inherit;
    cursor: pointer; font-size: 13px;
  }
  .subs .opt:hover, .subs .opt:focus-visible { background: rgba(255, 255, 255, 0.15); }
  .subs .opt.sel { color: var(--accent); font-weight: 600; }
  /* Where a subtitle came from, under its name */
  .subs .opt .src { display: block; font-size: 11px; font-weight: 400; opacity: 0.65; }
  .subs .find { display: flex; gap: 4px; padding: 4px 2px; }
  .subs .find input { flex: 1; min-width: 0; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--line); background: rgba(255, 255, 255, 0.08); color: inherit; font-size: 12px; }
  .subs .find .opt { padding: 4px 8px; }
  .subs.speeds { width: 150px; }
  .subs .note { margin: 4px 8px; font-size: 12px; opacity: 0.8; }
  .subs .note.err { color: var(--danger); opacity: 1; }
  .subs .delay { display: flex; align-items: center; gap: 6px; padding: 6px 8px 2px; font-size: 12px; }
  .subs .delay .val { min-width: 48px; text-align: center; font-variant-numeric: tabular-nums; }
  /* The subtitles are drawn by the page (not by the video) so they can be sized and moved */
  .cues {
    position: absolute; z-index: 3; transform: translate(-50%, -100%); width: max-content; max-width: 90%;
    padding: 0.1em 0.4em; border-radius: 0.2em; text-align: center; line-height: 1.3; white-space: normal;
    background: rgba(0, 0, 0, 0.65); color: #fff; text-shadow: 0 1px 2px #000;
    cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
  }
  .cues.nobg { background: transparent; text-shadow: 0 0 3px #000, 0 0 3px #000, 0 1px 4px #000, 1px 1px 2px #000, -1px -1px 2px #000; }
  .cues.dragging { cursor: grabbing; outline: 1px dashed rgba(255, 255, 255, 0.6); }
  .subs .look { display: flex; flex-direction: column; gap: 4px; margin: 2px 4px 6px 12px; padding: 6px 8px; border-radius: 6px; background: rgba(255, 255, 255, 0.08); }
  .subs .look .row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .subs .look .row.check { cursor: pointer; }
  .subs .look .row .val { flex: 1; text-align: center; font-variant-numeric: tabular-nums; }
  .subs .look .ctl:disabled { opacity: 0.4; cursor: default; }
  .subs .look input[type='range'] { width: 100%; }
  .subs .look .tip { margin: 0; font-size: 11px; opacity: 0.7; }
  .subs .look .opt { text-align: center; font-size: 12px; background: rgba(255, 255, 255, 0.1); }

  .unmute {
    position: absolute;
    top: 8px;
    left: 8px;
    padding: 6px 12px;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-text);
    cursor: pointer;
    z-index: 5;
  }

  .loading p {
    margin: 0;
    font-size: 14px;
    color: var(--text-dim);
  }
</style>