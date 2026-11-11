<script lang="ts">
  import { playerKey } from '../lib/player-keys.ts';
  import { watchTogether } from '../lib/watch-together.svelte.ts';
  import { YtTracker, YT_UNSTARTED, YT_CUED, YT_PAUSED } from '../core/yt-tracker.ts';
  import { onMount, onDestroy, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { desktop } from '../lib/native.ts';
  import { spotState, spotAction } from '../lib/spot-state.svelte.ts';
  import { youtubeHost } from '../lib/youtube-account.svelte.ts';
  import { RATES, rateLabel, qualityLabel, IDLE_MS, DEFAULT_QUALITIES } from '../lib/yt-controls.ts';

  // YouTube iframe player for watch together (mode 1).
  // The embed is driven through the same postMessage protocol YouTube's own iframe API uses, because
  // their script cannot be loaded here. The one thing that makes the embed talk back is the
  // "listening" handshake: without it the player accepts commands but never reports anything, so
  // the position and state (and what the user does in the player) are unknown.
  //
  // What the player is doing, and which of its reports are the user rather than an echo of a
  // command of ours, is kept in YtTracker. Units: getCurrentTime() is in seconds like YouTube's own
  // API; seekTo() takes milliseconds.

  const YT_ORIGINS = new Set(['https://www.youtube-nocookie.com', 'https://www.youtube.com']);
  const WIDGET_ID = 1;
  // No answer from the embed after this long: carry on from what we commanded
  const BLIND_AFTER_MS = 4000;
  // The session plays but the player has not started for this long: load it again (a few times)
  const STALL_RELOAD_MS = 10000;
  const MAX_RELOADS = 2;

  const tracker = new YtTracker();
  const log = (...args: unknown[]) => console.log('[yt]', ...args);

  let iframeElement = $state<HTMLIFrameElement | null>(null);
  let src = $state('');
  let currentVideoId: string | null = null;

  // Connection
  let loaded = false;     // the iframe document has loaded
  let connected = false;  // the embed has answered the handshake
  let blind = false;      // it never did; we go by our own commands
  let handshakeTimer: number | null = null;
  let watchdogTimer: number | null = null;
  let barTimer: number | null = null;
  let stalledSince = 0;
  let reloads = 0;
  // Where the address makes the player begin. Whenever the frame loads, that is where it is, however
  // far the session has gone since (a frame that is moved, as in pop-out, loads its address again).
  let srcStartMs = 0;

  const isReady = () => loaded && (connected || blind);

  // Our own bar: position and length in ms, whether the session plays, and a drag in progress
  let pos = $state(0);
  let duration = $state(0);
  let playingNow = $state(false);
  let dragTo = $state<number | null>(null);
  const shown = $derived(Math.min(dragTo ?? pos, duration || dragTo || pos));
  const pct = $derived(duration ? Math.min(100, (shown / duration) * 100) : 0);
  const clock = (ms: number) => {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, sec2 = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec2).padStart(2, '0')}` : `${m}:${String(sec2).padStart(2, '0')}`;
  };
  const toggle = () => { if (playingNow) watchTogether.pause(); else watchTogether.play(); };
  // Left and right arrow: 5 seconds back or forward, from where the shared position is now
  const seekBy = (ms: number) => {
    const to = Math.max(0, Math.min(duration || Infinity, watchTogether.sharedPosition() + ms));
    watchTogether.seek(to);
    pos = to;
  };

  // The picture is shown through a fixed-geometry frame that is scaled down to fit, so the embed always
  // lays itself out the way it does at full screen (at other sizes the picture came out shifted).
  // Its width never drops below FRAME_MIN, its height is FRAME_RATIO of that: the extra over 16:9 is
  // what pushes YouTube's title bar and bottom strip, drawn at the frame's edges, out of view.
  const FRAME_MIN = 1600;
  let stageW = $state(0);
  const frameW = $derived(Math.max(FRAME_MIN, Math.ceil(stageW)));
  // The picture is not always 16:9 (square, portrait, ultrawide). The player fits it into the frame
  // by width only when the frame is taller than the picture is, so the frame's height follows the
  // picture's shape: picture height plus the same margin above and below.
  let aspect = $state(16 / 9);
  let aspectKnown = $state(false);
  let aspectTimer: number | null = null;
  const frameH = $derived(frameW / aspect + frameW / 8);
  // The picture is shown right away as 16:9 and reshaped when its size is known (desktop app only)
  function measureAspect(tries = 4) {
    if (aspectKnown || typeof desktop?.youtubeVideoSize !== 'function') return;
    try {
      desktop.youtubeVideoSize().then(size => {
        if (size && size.width > 0 && size.height > 0) {
          aspect = Math.min(3, Math.max(0.4, size.width / size.height));
          aspectKnown = true;
        } else if (tries > 1) {
          aspectTimer = window.setTimeout(() => measureAspect(tries - 1), 1500);
        }
      }).catch(() => { /* stays 16:9 */ });
    } catch { /* stays 16:9 */ }
  }

  // Volume is this person's own (not shared): 0..1, kept between sessions
  const VOL_KEY = 'mumh5.ytVolume';
  let volume = $state((() => {
    try { const v = Number(localStorage.getItem(VOL_KEY)); if (localStorage.getItem(VOL_KEY) !== null && v >= 0 && v <= 1) return v; } catch { /* storage unavailable */ }
    return 1;
  })());
  let lastVolume = 1;
  function applyVolume() {
    command('setVolume', [Math.round(volume * 100)]);
    command(volume === 0 ? 'mute' : 'unMute');
  }
  function setVolume(v: number) {
    volume = Math.min(1, Math.max(0, v));
    if (volume > 0) lastVolume = volume;
    try { localStorage.setItem(VOL_KEY, String(volume)); } catch { /* storage unavailable */ }
    applyVolume();
  }
  const toggleMute = () => setVolume(volume === 0 ? (lastVolume || 1) : 0);

  // Speed, captions and quality: also this person's own. A new frame (reload, pop-out) starts over at
  // the player's defaults, so what was chosen is applied again once it answers.
  let rate = $state(1);
  let captions = $state(false);
  // Kept between sessions: the player keeps a quality chosen in its menu too, so the two stay the same
  const QUALITY_KEY = 'mumh5.ytQuality';
  let quality = $state((() => {
    try { return localStorage.getItem(QUALITY_KEY) || 'auto'; } catch { return 'auto'; }
  })());
  let qualities = $state<string[]>(DEFAULT_QUALITIES);
  // The speed is shared: the menu asks the session (watchTogether.setRate), which tells everybody
  // and, through reconcile, comes back here as setRate for the player itself
  function applyRate() {
    tracker.setRate(rate);
    command('setPlaybackRate', [rate]);
    // Inside the frame (desktop app) the player takes it from its own API, the video element or its menu
    rateConfirmed = false;
    if (typeof desktop?.youtubeRate === 'function') {
      try {
        desktop.youtubeRate(rate)
          .then(r => {
            log('rate', rate, '->', r.method, r.rate ?? '', r.error ?? '');
            if (r.method !== 'none') rateConfirmed = true;
          })
          .catch(err => console.warn('[yt] setting the speed failed:', err));
      } catch (err) { console.warn('[yt] setting the speed failed:', err); }
    } else {
      console.warn('[yt] this build has no way into the player\'s frame: restart the app so the main process and preload are the new ones');
    }
    // A speed the player will not take would tear the sync apart (everybody else's clock runs fast,
    // this one does not): if it still is not running at it a few seconds on, go back to normal for everybody
    if (rateCheck !== null) clearTimeout(rateCheck);
    if (rate !== 1) rateCheck = window.setTimeout(checkRate, 3500);
  }
  let rateConfirmed = false;
  let rateCheck: number | null = null;
  let reportedRate: number | null = null; // what the embed says it plays at
  function checkRate() {
    rateCheck = null;
    if (rate === 1 || rate !== watchTogether.sharedRate()) return;
    const took = rateConfirmed || (reportedRate !== null && Math.abs(reportedRate - rate) < 0.01);
    if (took) return;
    console.warn('[yt] the player is not playing at', rate + 'x (it reports', reportedRate ?? 'nothing', '); back to normal speed for everybody');
    watchTogether.setRate(1);
  }
  function setRate(r: number) { if (r === rate) return; rate = r; applyRate(); }
  function applyCaptions() {
    if (captions) {
      command('loadModule', ['captions']);
      command('setOption', ['captions', 'reload', true]);
    } else {
      command('unloadModule', ['captions']);
    }
  }
  function setCaptions(on: boolean) { captions = on; applyCaptions(); }
  // The player turns captions on by itself (its own saved preference) whenever it starts, pauses,
  // resumes or seeks, so the icon's setting is put back right after each of those, and an "off" is
  // also repeated quietly every second
  let captionTimers: number[] = [];
  function enforceCaptions() {
    if (!loaded) return;
    sendRaw({ event: 'command', func: captions ? 'loadModule' : 'unloadModule', args: ['captions'], id: WIDGET_ID, channel: 'widget' });
  }
  function enforceCaptionsSoon() {
    captionTimers.forEach(clearTimeout);
    enforceCaptions();
    captionTimers = [250, 1000, 2500].map(ms => window.setTimeout(enforceCaptions, ms));
  }
  // In the desktop app the choice is made inside the player's frame (its API, or its own settings menu
  // when that does not take). Elsewhere the page can only ask by message, which YouTube treats as a
  // suggestion and may ignore.
  function applyQuality() {
    if (typeof desktop?.youtubeQuality === 'function') {
      try {
        desktop.youtubeQuality(quality)
          .then(r => log('quality', quality, '->', r.method, r.quality ?? '', r.error ?? ''))
          .catch(err => console.warn('[yt] setting the quality failed:', err));
        return;
      } catch (err) { console.warn('[yt] setting the quality failed:', err); }
    }
    const q = quality === 'auto' ? 'default' : quality;
    command('setPlaybackQualityRange', [q, q]);
    command('setPlaybackQuality', [q]);
  }
  function setQuality(q: string) {
    quality = q;
    try { localStorage.setItem(QUALITY_KEY, q); } catch { /* storage unavailable */ }
    applyQuality();
  }

  // The overlay is there while the mouse moves, and goes IDLE_MS after it stopped
  let active = $state(false);
  let menu = $state<'quality' | 'speed' | null>(null);
  let idleTimer: number | null = null;
  function wake() {
    active = true;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = window.setTimeout(sleep, IDLE_MS);
  }
  function sleep() {
    // An open menu, or a slider being dragged, keeps it
    if (menu || dragTo !== null) { idleTimer = window.setTimeout(sleep, IDLE_MS); return; }
    active = false;
    idleTimer = null;
  }
  function leave() {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    active = false;
    menu = null;
  }
  const toggleMenu = (m: 'quality' | 'speed') => { menu = menu === m ? null : m; };
  // A click on the picture closes an open menu first, otherwise it plays or pauses
  const clickPicture = () => { if (menu) menu = null; else toggle(); };

  function buildSrc(id: string, startMs: number, playing: boolean, nonce = 0): string {
    // controls=0 removes YouTube's own chrome (title, volume, captions, settings, fullscreen, the
    // bottom strip); the play/pause button, time and seek bar are drawn by this component instead
    const p = new URLSearchParams({
      autoplay: playing ? '1' : '0', enablejsapi: '1', playsinline: '1', rel: '0',
      controls: '0', fs: '0', disablekb: '1', iv_load_policy: '3', cc_load_policy: '0', modestbranding: '1'
    });
    if (startMs >= 1000) p.set('start', String(Math.floor(startMs / 1000)));
    const origin = window.location.origin;
    if (origin.startsWith('http')) p.set('origin', origin);
    // Makes a reload a different address, so the frame really loads again
    if (nonce) p.set('reload', String(nonce));
    return `${youtubeHost()}/embed/${id}?${p}`;
  }

  function sendRaw(msg: object) {
    const w = iframeElement?.contentWindow;
    if (!w) return;
    // To the address the frame really has (it depends on the account when it was loaded)
    let target = 'https://www.youtube-nocookie.com';
    try { target = new URL(iframeElement!.src).origin; } catch { /* the default */ }
    try { w.postMessage(JSON.stringify(msg), target); } catch { /* not ready yet */ }
  }

  function command(func: string, args: unknown[] = []) {
    if (!loaded) return;
    log('command', func, ...args);
    sendRaw({ event: 'command', func, args, id: WIDGET_ID, channel: 'widget' });
  }

  // What watch together drives
  const playerAPI = {
    play() { if (tracker.play()) command('playVideo'); },
    pause() { if (tracker.pause()) command('pauseVideo'); },
    seekTo(ms: number) {
      tracker.seek(ms);
      command('seekTo', [ms / 1000, true]);
      enforceCaptionsSoon();
    },
    getCurrentTime: () => tracker.position(),
    getPlayerState: () => tracker.effectiveState(),
    ready: isReady,
    getDurationMs: () => duration,
    getVolume: () => volume,
    setVolume,
    getRate: () => rate,
    setRate,
    getCaptions: () => captions,
    setCaptions,
    getQuality: () => quality,
    setQuality,
    getQualities: () => qualities,
    getAspect: () => aspect,
    prepareMove() {
      if (!currentVideoId) return null;
      const where = watchTogether.expectedPlayback();
      const posMs = connected && rate === 1 ? Math.round(tracker.position() * 1000) : where.positionMs;
      srcStartMs = posMs;
      return buildSrc(currentVideoId, posMs, where.playing);
    },
    // The frame's inline style is whatever the pop-out left on it (its own size for that window).
    // Back in the stage it gets the size and scale of the stage as it is now.
    refitFrame() {
      if (!iframeElement) return;
      iframeElement.style.cssText = `width: ${frameW}px; height: ${frameH}px; transform: translate(-50%, -50%) scale(${(stageW || FRAME_MIN) / frameW});`;
    },
  };

  // A new video (playlist), or the first one: build the address. The very first one starts where
  // the session is now, so someone joining or coming back does not begin at 0:00.
  $effect(() => {
    const id = watchTogether.currentVideo?.id ?? null;
    untrack(() => {
      if (!id || id === currentVideoId) return;
      const first = currentVideoId === null;
      currentVideoId = id;
      const now = watchTogether.expectedPlayback();
      const startMs = first ? now.positionMs : 0;
      resetConnection();
      duration = 0;
      qualities = DEFAULT_QUALITIES;
      aspect = 16 / 9;
      aspectKnown = false;
      reloads = 0;
      srcStartMs = startMs;
      src = buildSrc(id, startMs, now.playing);
    });
  });

  function resetConnection() {
    stopHandshake();
    loaded = false;
    connected = false;
    blind = false;
    stalledSince = 0;
    tracker.reset();
  }

  function stopHandshake() {
    if (handshakeTimer !== null) { clearInterval(handshakeTimer); handshakeTimer = null; }
  }

  // Say "listening" until the embed answers
  function startHandshake() {
    stopHandshake();
    const began = Date.now();
    const tick = () => {
      if (connected) { stopHandshake(); return; }
      sendRaw({ event: 'listening', id: WIDGET_ID, channel: 'widget' });
      if (!blind && Date.now() - began > BLIND_AFTER_MS) {
        blind = true;
        tracker.blind = true;
        log('the embed never answered; going by our own commands');
        becameReady();
      }
      if (Date.now() - began > 30000) stopHandshake();
    };
    tick();
    handshakeTimer = window.setInterval(tick, 250);
  }

  function onFrameLoad() {
    // The iframe also loads again when it is moved (pop-out, pop-in): start the handshake again
    connected = false;
    blind = false;
    loaded = true;
    // The player begins at the address's start again, wherever the session is: once it answers,
    // the session's reconcile finds the difference and seeks (our seek's echo is not the user)
    tracker.begin(Math.floor(srcStartMs / 1000));
    startHandshake();
  }

  function becameReady() {
    measureAspect();
    applyVolume();
    if (rate !== 1) { applyRate(); window.setTimeout(() => { if (rate !== 1) applyRate(); }, 2500); }
    applyCaptions();
    enforceCaptionsSoon();
    if (quality !== 'auto') applyQuality();
    watchTogether.syncPlayer();
  }

  function handleMessage(event: MessageEvent) {
    if (!YT_ORIGINS.has(event.origin)) return;
    if (!iframeElement || event.source !== iframeElement.contentWindow) return;
    let data: any = event.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return; }
    }
    if (!data || typeof data !== 'object') return;

    const d = data.info && typeof data.info === 'object' ? data.info.duration : undefined;
    if (typeof d === 'number' && d > 0 && Number.isFinite(d)) duration = Math.round(d * 1000);

    if (data.info && typeof data.info === 'object' && typeof data.info.playbackRate === 'number') reportedRate = data.info.playbackRate;
    if (data.info && typeof data.info === 'object' && Array.isArray(data.info.availableQualityLevels)) {
      const q = data.info.availableQualityLevels.filter((x: unknown) => typeof x === 'string' && x !== 'auto' && x !== 'unknown');
      if (q.length) qualities = q;
    }

    switch (data.event) {
      case 'initialDelivery':
      case 'onReady':
      case 'infoDelivery':
      case 'onStateChange': {
        if (!connected) {
          connected = true;
          blind = false;
          tracker.blind = false;
          stopHandshake();
          log('connected');
          // Ask for state changes too (the periodic deliveries carry the state as well)
          command('addEventListener', ['onReady']);
          command('addEventListener', ['onStateChange']);
          command('addEventListener', ['onError']);
          // Whatever the player starts doing by itself (autoplay) is not a user action
          if (watchTogether.expectedPlayback().playing) tracker.expectAutoplay();
          if (data.info && typeof data.info === 'object') sample(data.info);
          becameReady();
          return;
        }
        if (data.event === 'onStateChange') {
          if (typeof data.info === 'number') sample({ playerState: data.info });
        } else if (data.info && typeof data.info === 'object') {
          sample(data.info);
        }
        break;
      }
      case 'onError':
        // 2 bad request, 5 html5 error, 100 not found, 101/150 embedding not allowed, 153 no referrer
        console.warn('[yt] the player reported an error:', data.info);
        break;
    }
  }

  // The player reported its position and/or state
  function sample(info: { currentTime?: number; playerState?: number }) {
    const before = tracker.reported;
    const act = tracker.sample(info, watchTogether.isWatching);
    if (tracker.reported !== before) { log('state', before, '->', tracker.reported); enforceCaptionsSoon(); }
    // The user pressed play or pause in the player, or dragged the position
    if (act.playing !== undefined) {
      log('user', act.playing ? 'play' : 'pause');
      if (act.playing) watchTogether.play(); else watchTogether.pause();
    }
    if (act.seekMs !== undefined) {
      log('user seek', act.seekMs);
      watchTogether.seek(act.seekMs);
    }
  }

  // The session plays but the player never gets going (it does not start, or sits paused although
  // it was told to play over and over): load it again, where the session is now
  function watchdog() {
    if (!captions && (connected || blind)) enforceCaptions();
    if (!connected || blind || !currentVideoId) return;
    const now = Date.now();
    const st = tracker.effectiveState(now);
    const stuck = watchTogether.isWatching && watchTogether.expectedPlayback().playing
      && (st === YT_UNSTARTED || st === YT_CUED || st === YT_PAUSED);
    if (!stuck) { stalledSince = 0; return; }
    if (!stalledSince) stalledSince = now;
    if (now - stalledSince < STALL_RELOAD_MS || reloads >= MAX_RELOADS) return;
    reloads++;
    console.warn('[yt] the player has not started for', Math.round((now - stalledSince) / 1000), 's; loading it again, attempt', reloads);
    const where = watchTogether.expectedPlayback();
    resetConnection();
    srcStartMs = where.positionMs;
    src = buildSrc(currentVideoId, where.positionMs, where.playing, reloads);
  }

  onMount(() => {
    console.log('[YouTubePlayer] Mounted - video ID:', watchTogether.currentVideo?.id);
    watchTogether.setYoutubePlayer(playerAPI);
    window.addEventListener('message', handleMessage);
    watchdogTimer = window.setInterval(watchdog, 1000);
    const tick = () => {
      pos = watchTogether.sharedPosition();
      playingNow = watchTogether.sharedPlaying();
    };
    tick();
    barTimer = window.setInterval(tick, 200);
  });

  onDestroy(() => {
    console.log('[YouTubePlayer] Destroyed');
    stopHandshake();
    if (watchdogTimer !== null) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (barTimer !== null) { clearInterval(barTimer); barTimer = null; }
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    captionTimers.forEach(clearTimeout);
    if (aspectTimer !== null) { clearTimeout(aspectTimer); aspectTimer = null; }
    if (rateCheck !== null) { clearTimeout(rateCheck); rateCheck = null; }
    window.removeEventListener('message', handleMessage);
    if (watchTogether.youtubePlayer === playerAPI) watchTogether.setYoutubePlayer(null);
  });
</script>

<svelte:window onkeydown={e => { if (src) playerKey(e, { toggle, seekBy }); }} />

{#if src}
  <div class="youtube-container" class:active role="presentation"
    onpointermove={wake} onpointerdown={wake} onpointerleave={leave}>
    <div class="yt-stage" bind:clientWidth={stageW} style="--aspect: {aspect};">
      <iframe
        bind:this={iframeElement}
        {src}
        title="YouTube video player"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        class="youtube-iframe"
      style="width: {frameW}px; height: {frameH}px; transform: translate(-50%, -50%) scale({(stageW || FRAME_MIN) / frameW});"
        onload={onFrameLoad}
      ></iframe>
    </div>
    <!-- Covers the frame: YouTube's hover overlays (title, "More videos", ...) never get to show, and a click plays or pauses -->
    <button class="shield" onclick={clickPicture} aria-label={playingNow ? 'Pause' : 'Play'}>
      <span class="big"><Icon name={playingNow ? 'pause' : 'play'} size={36} /></span>
    </button>
    <div class="top">
      <div class="menu-wrap">
        <button class="ibtn" class:on={menu === 'quality'} onclick={() => toggleMenu('quality')} aria-label="Quality" title="Quality"><Icon name="settings" size={20} /></button>
        {#if menu === 'quality'}
          <div class="menu" role="menu">
            {#each ['auto', ...qualities] as q (q)}
              <button class="item" class:on={quality === q} role="menuitemradio" aria-checked={quality === q} onclick={() => { setQuality(q); menu = null; }}>{qualityLabel(q)}</button>
            {/each}
          </div>
        {/if}
      </div>
      <button class="ibtn" class:on={captions} onclick={() => setCaptions(!captions)} aria-label="Captions" aria-pressed={captions} title="Captions"><Icon name="captions" size={20} /></button>
      <div class="menu-wrap">
        <button class="ibtn" class:on={menu === 'speed' || rate !== 1} onclick={() => toggleMenu('speed')} aria-label="Playback speed" title="Playback speed"><Icon name="speed" size={20} /></button>
        {#if menu === 'speed'}
          <div class="menu" role="menu">
            {#each RATES as r (r)}
              <button class="item" class:on={rate === r} role="menuitemradio" aria-checked={rate === r} onclick={() => { watchTogether.setRate(r); menu = null; }}>{rateLabel(r)}</button>
            {/each}
          </div>
        {/if}
      </div>
      {#if spotState.fullscreen}
        <!-- Full screen: the spotlight's own bar is hidden, so its pop-out and full screen buttons are here -->
        <button class="ibtn" class:on={spotState.poppedOut} onclick={() => spotAction('popout')} aria-label="Pop out" title="Pop out"><Icon name="popout" size={20} /></button>
        <button class="ibtn" onclick={() => spotAction('fullscreen')} aria-label="Exit full screen" title="Exit full screen"><Icon name="expand" size={20} /></button>
      {/if}
    </div>
    <div class="bar">
      <span class="time">{clock(shown)}{#if duration}<span class="sep">/</span><span class="total">{clock(duration)}</span>{/if}</span>
      <div class="row">
        <input class="seek" type="range" min="0" max={duration || 1} step="1000" disabled={!duration}
          value={Math.min(shown, duration || 1)} style="--pct: {pct}%" aria-label="Seek"
          oninput={e => { dragTo = Number(e.currentTarget.value); }}
          onchange={e => { const to = Number(e.currentTarget.value); watchTogether.seek(to); pos = to; dragTo = null; e.currentTarget.blur(); }} />
        <button class="mute" onclick={toggleMute} aria-label={volume === 0 ? 'Unmute' : 'Mute'}>
          <Icon name={volume === 0 ? 'volume-off' : 'volume'} size={18} />
        </button>
        <input class="vol" type="range" min="0" max="1" step="0.05" value={volume} style="--pct: {volume * 100}%" aria-label="Volume"
          oninput={e => setVolume(Number(e.currentTarget.value))} onchange={e => e.currentTarget.blur()} />
      </div>
    </div>
  </div>
{:else}
  <div class="loading">
    <p>Loading video...</p>
  </div>
{/if}

<style>
  .youtube-container {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    flex: 1;
    min-height: 0;
    background: #000;
    overflow: hidden;
    container-type: size;
  }

  /* The picture's own 16:9 box, as large as fits. YouTube draws its title bar, "More videos" strip and
     buttons at the edges of the frame, on top of the picture and in every paused/seeking/hover state,
     which no URL option turns off. The frame is made taller than this box and the extra is clipped,
     so those edges fall outside what is shown while the picture stays whole. */
  .yt-stage {
    position: relative;
    flex: none;
    width: min(100cqw, 100cqh * var(--aspect, 1.7778));
    aspect-ratio: var(--aspect, 1.7778);
    overflow: hidden;
  }

  .youtube-iframe {
    position: absolute;
    left: 50%;
    top: 50%;
    transform-origin: center;
    border: none;
    display: block;
  }

  .shield {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    color: #fff;
  }
  .big {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.55);
    opacity: 0;
    transition: opacity 0.15s;
    pointer-events: none;
  }
  .youtube-container.active .big { opacity: 1; }
  .youtube-container:not(.active) .shield { cursor: none; }

  /* Time above the seek bar, the bar itself just above the bottom edge */
  .bar {
    pointer-events: auto;
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 22px 14px 7px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: #fff;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.65));
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 2;
  }
  .youtube-container:not(.active) .bar, .youtube-container:not(.active) .top { pointer-events: none; }
  .youtube-container.active .bar, .youtube-container.active .top { opacity: 1; }

  .top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    padding: 8px 12px 26px;
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    color: #fff;
    background: linear-gradient(rgba(0, 0, 0, 0.65), transparent);
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 3;
  }
  .menu-wrap { position: relative; }
  .ibtn { display: flex; align-items: center; justify-content: center; background: transparent; border: none; padding: 5px; border-radius: 6px; color: #fff; cursor: pointer; }
  .ibtn:hover, .ibtn:focus-visible { background: rgba(255, 255, 255, 0.2); }
  .ibtn.on { color: #f03; }
  .menu { position: absolute; top: 100%; right: 0; margin-top: 4px; min-width: 110px; padding: 4px; display: flex; flex-direction: column; border-radius: 8px; background: rgba(20, 20, 20, 0.95); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5); }
  .item { text-align: left; padding: 6px 10px; border: none; border-radius: 5px; background: transparent; color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .item:hover, .item:focus-visible { background: rgba(255, 255, 255, 0.15); }
  .item.on { color: #f03; font-weight: 600; }
  .time { font-size: 12px; font-variant-numeric: tabular-nums; text-shadow: 0 0 3px #000; }
  .sep { margin: 0 7px; opacity: 0.7; }
  .total { opacity: 0.7; }
  .row { display: flex; align-items: center; gap: 10px; }
  .mute { display: flex; align-items: center; justify-content: center; background: transparent; border: none; padding: 3px; border-radius: 6px; color: #fff; cursor: pointer; flex: none; }
  .mute:hover, .mute:focus-visible { background: rgba(255, 255, 255, 0.2); }
  .vol { width: 90px; flex: none; }
  .seek { flex: 1; min-width: 0; }
  .seek, .vol {
    -webkit-appearance: none;
    appearance: none;
    height: 14px;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }
  .seek:disabled { cursor: default; }
  .seek::-webkit-slider-runnable-track, .vol::-webkit-slider-runnable-track {
    height: 3px;
    border-radius: 2px;
    background: linear-gradient(to right, #f03 var(--pct), rgba(255, 255, 255, 0.35) var(--pct));
  }
  .seek::-webkit-slider-thumb, .vol::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4.5px;
    border-radius: 50%;
    border: none;
    background: #f03;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--fg-dim);
  }
</style>
