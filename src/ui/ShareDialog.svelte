<script lang="ts">
  import { onDestroy } from 'svelte';
  import Modal from './Modal.svelte';
  import { share, cameraConstraints, shareSettings, SHARE_BITRATES, SHARE_HEIGHTS, SHARE_FPS, SHARE_MODES, type ShareMode, type ShareKind } from '../lib/share.svelte.ts';
  import { watchTogether, type WatchMode } from '../lib/watch-together.svelte.ts';
  import { desktop, torrentError, type ScreenSource } from '../lib/native.ts';
  import type { TitleResult, FoundTorrent } from '../core/search.ts';
  import type { YoutubeResult } from '../core/youtube-search.ts';
  import { parseEpisode, episodesFrom, isVideoName, MAX_LINKS, MAX_QUEUE, type TorrentInfo, type TorrentMeta } from '../core/torrent-meta.ts';
  import { store } from '../lib/settings.svelte.ts';
  import { ui } from '../lib/ui.svelte.ts';
  import { native } from '../lib/native.ts';

  // Everything is chosen here, with a preview, before anything is sent: what to show, which
  // sound goes with it and the quality. In a browser, and on Wayland, the system's own dialog
  // picks the screen or window.
  let { onclose }: { onclose: () => void } = $props();
  const target = share.dialog!;

  let info = $state<{ portal: boolean; audio: 'pipewire' | 'loopback' | 'browser' | 'none'; micLabel: string }>({ portal: true, audio: desktop ? 'none' : 'browser', micLabel: '' });
  // What to show: the screen (or a window), or a camera, or watch together
  // Phones have no screen capture in the browser; there the camera is the only choice
  const canScreen = !!navigator.mediaDevices?.getDisplayMedia;
  type DialogKind = ShareKind | 'watch';
  let kind = $state<DialogKind>('screen');
  let cameras = $state<MediaDeviceInfo[]>([]);
  let camera = $state('');
  let sources = $state<ScreenSource[]>([]);
  let selected = $state('');
  let preview = $state.raw<MediaStream | null>(null);
  let apps = $state<string[]>([]);
  // '' none, 'all' everything, 'app:<name>' one program
  let audio = $state('');
  let browserAudio = $state(false);
  let busy = $state(false);
  let error = $state('');
  let handedOver = false;
  let video = $state<HTMLVideoElement>();
  $effect(() => { if (video) video.srcObject = preview; });

  const fps = () => shareSettings().fps;

  // The four stream choices, each a slider over the offered values
  const modeIds = Object.keys(SHARE_MODES) as ShareMode[];
  const set = () => store.saveSettings();
  const q = $derived(shareSettings());

  // Watch together state
  let watchMode = $state<WatchMode>(1);
  let youtubeUrl = $state('');
  let youtubeVideoId = $state('');
  let watchFile = $state<File | null>(null);
  let watchFileError = $state('');
  let watchTitle = $state('');
  let watchFilePreview = $state<string | null>(null);

  // Torrent together: up to MAX_LINKS links, played one after the other. Each is what was pasted, what it
  // turned out to be, and which of its files is played.
  interface Online { episode: number; torrent: TorrentMeta }
  interface TorrentSlot {
    input: string; info: TorrentInfo | null; file: number; count: number;
    // The next episodes found online (when the torrent has no more of them inside), what was not found, and how the search went
    online: Online[]; missing: number[]; searching: boolean; searchNote: string;
    // The file a search result named inside its torrent (a season pack), used once the torrent is looked up
    hint: number | null;
  }
  const newSlot = (): TorrentSlot => ({ input: '', info: null, file: 0, count: 1, online: [], missing: [], searching: false, searchNote: '', hint: null });
  const resetOnline = (slot: TorrentSlot) => { slot.online = []; slot.missing = []; slot.searchNote = ''; };
  let slots = $state<TorrentSlot[]>([newSlot()]);
  let torrentBusy = $state(false);
  const fmtSize = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`;
  const filled = $derived(slots.filter(x => x.input.trim()));
  const canAddLink = $derived(slots.length < MAX_LINKS && !!slots[slots.length - 1].input.trim());
  const needsLookup = $derived(filled.some(x => !x.info));

  // The episodes of one link: the chosen file and the ones after it that look like later episodes of the same
  // season (a season pack), and how many of them were asked for
  const episodesOf = (slot: TorrentSlot) => (slot.info ? episodesFrom(slot.info.files, slot.file) : []);
  const queuedBy = (slot: TorrentSlot) => (!slot.info ? 1 : slot.online.length ? 1 + slot.online.length : Math.max(1, Math.min(slot.count, episodesOf(slot).length)));
  const queuedTotal = $derived(filled.reduce((n, x) => n + queuedBy(x), 0));
  const maxCount = (slot: TorrentSlot) => Math.max(1, Math.min(episodesOf(slot).length, MAX_QUEUE - (queuedTotal - queuedBy(slot))));
  // Episodes that are not inside this torrent can be looked up online, when the file name says which episode it is
  const canSearchOnline = (slot: TorrentSlot) => {
    const f = slot.info?.files.find(y => y.index === slot.file);
    return !!f && !!desktop?.torrent.findEpisodes && episodesOf(slot).length <= 1 && parseEpisode(f.name) !== null;
  };
  const maxOnline = (slot: TorrentSlot) => Math.max(1, MAX_QUEUE - (queuedTotal - queuedBy(slot)));
  function setOnlineCount(slot: TorrentSlot, n: number) {
    slot.count = Math.max(1, Math.min(maxOnline(slot), Math.round(n) || 1));
    resetOnline(slot);
  }
  async function searchOnline(slot: TorrentSlot) {
    const api = desktop?.torrent;
    const f = slot.info?.files.find(y => y.index === slot.file);
    if (!api || !f || slot.searching || slot.count < 2) return;
    slot.searching = true;
    resetOnline(slot);
    try {
      const r = await api.findEpisodes(f.name, slot.count - 1);
      slot.online = r.episodes;
      slot.missing = r.missing;
      if (!r.episodes.length) slot.searchNote = `No later episodes of ${r.show || 'this show'} were found online.`;
      else if (r.missing.length) slot.searchNote = `Found ${r.episodes.length} of ${slot.count - 1} (${r.show}). Episode ${Math.min(...r.missing)} could not be found, so the queue stops before it.`;
      else slot.searchNote = `Found all ${r.episodes.length} (${r.show}).`;
    } catch (e) {
      slot.searchNote = torrentError(e);
    } finally {
      slot.searching = false;
    }
  }
  const setCount = (slot: TorrentSlot, n: number) => { slot.count = Math.max(1, Math.min(maxCount(slot), Math.round(n) || 1)); };
  const baseName = (path: string) => path.split('/').pop() ?? path;

  // Search: a title is looked up (films, series, anime), then the torrents of every Torrentio provider for it. Picking one
  // fills a link, which is looked up like a pasted one.
  const canSearch = !!desktop?.torrent?.searchTitles;
  let sQuery = $state('');
  let sTitles = $state<TitleResult[] | null>(null);
  let sTitle = $state<TitleResult | null>(null);
  let sSeason = $state(1);
  let sEpisode = $state(1);
  let sFound = $state<FoundTorrent[] | null>(null);
  let sProvider = $state('');
  let sBusy = $state(false);
  let sError = $state('');
  let sRun = 0; // an answer that arrives after a newer search was started is dropped
  const sProviders = $derived([...new Set((sFound ?? []).map(f => f.provider).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
  // Sorting the list: Quality, Size or Peers. A first click sorts high to low, the next on the same button flips it.
  type SortKey = 'quality' | 'size' | 'peers';
  let sSort = $state<SortKey | null>(null);
  let sDesc = $state(true);
  function toggleSort(k: SortKey) {
    if (sSort === k) sDesc = !sDesc;
    else { sSort = k; sDesc = true; }
  }
  // "2160p", "4k HDR", "1080p" -> a number to compare; nothing said sorts as 0
  function qualityRank(q: string): number {
    const l = q.toLowerCase();
    let n = 0;
    const p = /(\d{3,4})\s*p/.exec(l);
    if (/\b8k\b/.test(l)) n = 4320;
    else if (/\b(4k|uhd)\b/.test(l)) n = 2160;
    else if (p) n = Number(p[1]);
    else if (/\b(cam|ts|telesync)\b/.test(l)) n = 1;
    if (n && /hdr|dolby|\bdv\b/.test(l)) n += 0.5;
    return n;
  }
  const sortValue = (f: FoundTorrent, k: SortKey) => k === 'quality' ? qualityRank(f.quality) : k === 'size' ? f.size : f.seeders;
  const sShown = $derived.by(() => {
    const list = (sFound ?? []).filter(f => !sProvider || f.provider === sProvider);
    const k = sSort;
    if (!k) return list;
    return [...list].sort((a, b) => (sortValue(a, k) - sortValue(b, k)) * (sDesc ? -1 : 1));
  });

  async function searchTitles() {
    const api = desktop?.torrent;
    const q = sQuery.trim();
    if (!api || !q || sBusy) return;
    const run = ++sRun;
    sBusy = true; sError = ''; sTitle = null; sFound = null; sTitles = null;
    try {
      const r = await api.searchTitles(q);
      if (run === sRun) { sTitles = r; if (!r.length) sError = `Nothing found for "${q}".`; }
    } catch (e) {
      if (run === sRun) sError = torrentError(e);
    } finally {
      if (run === sRun) sBusy = false;
    }
  }
  async function findTorrents() {
    const api = desktop?.torrent;
    if (!api || !sTitle || sBusy) return;
    const run = ++sRun;
    sBusy = true; sError = ''; sFound = null; sProvider = '';
    try {
      // A plain copy: the page's reactive object cannot cross the bridge to the main process
      const r = await api.searchTorrents({ source: sTitle.source, id: sTitle.id, type: sTitle.type }, Number(sSeason) || 0, Number(sEpisode) || 1);
      if (run === sRun) { sFound = r; if (!r.length) sError = 'No torrents were found for this one in any provider.'; }
    } catch (e) {
      if (run === sRun) sError = torrentError(e);
    } finally {
      if (run === sRun) sBusy = false;
    }
  }
  function pickTitle(t: TitleResult) {
    sTitle = t; sFound = null; sError = ''; sSeason = 1; sEpisode = 1;
    // A film has nothing more to choose
    if (t.type === 'movie') void findTorrents();
  }
  function backToTitles() { sRun++; sBusy = false; sTitle = null; sFound = null; sError = ''; }
  // The chosen torrent goes into the first empty link (a new one when all are filled) and is looked up
  function useFound(f: FoundTorrent) {
    let slot = slots.find(x => !x.input.trim());
    if (!slot) {
      if (slots.length >= MAX_LINKS) { error = `Up to ${MAX_LINKS} links can be queued`; return; }
      slots.push(newSlot());
      slot = slots[slots.length - 1];
    }
    error = '';
    slot.input = f.torrent.magnet;
    slot.info = null;
    slot.hint = f.torrent.fileIdx;
    void lookUpTorrents();
    clearSearch();
  }
  // The search is done once a torrent is chosen: the link below carries on from here
  function clearSearch() {
    sRun++;
    sBusy = false; sQuery = ''; sTitles = null; sTitle = null; sFound = null; sProvider = ''; sError = '';
  }
  const fmtCount = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  // Looks up every link that has not been looked up yet
  async function lookUpTorrents() {
    const api = desktop?.torrent;
    if (!api || torrentBusy) return;
    const todo = slots.map((slot, i) => ({ slot, i })).filter(x => x.slot.input.trim() && !x.slot.info);
    if (!todo.length) return;
    torrentBusy = true;
    error = '';
    const results = await Promise.allSettled(todo.map(x => api.inspect(x.slot.input)));
    results.forEach((r, n) => {
      const { slot, i } = todo[n];
      if (r.status === 'fulfilled') { slot.info = r.value; slot.file = slot.hint !== null && r.value.files.some(f => f.index === slot.hint) ? slot.hint : r.value.defaultIndex; slot.hint = null; slot.count = 1; resetOnline(slot); }
      else if (!error) error = `${slots.length > 1 ? `Link ${i + 1}: ` : ''}${torrentError(r.reason)}`;
    });
    torrentBusy = false;
  }

  // A .torrent file from this computer goes into the first empty link (a new one when all are filled)
  async function lookUpTorrentFile() {
    const api = desktop?.torrent;
    if (!api || torrentBusy) return;
    torrentBusy = true;
    error = '';
    try {
      const info = await api.openFile();
      if (!info) return;
      let slot = slots.find(x => !x.input.trim());
      if (!slot) {
        if (slots.length >= MAX_LINKS) throw new Error(`Up to ${MAX_LINKS} links can be queued`);
        slot = newSlot();
        slots.push(slot);
        slot = slots[slots.length - 1];
      }
      slot.input = info.magnet;
      slot.info = info;
      slot.file = info.defaultIndex;
      slot.count = 1;
    } catch (e) {
      error = torrentError(e);
    } finally {
      torrentBusy = false;
    }
  }

  // A torrent that was looked up and is not going to be played is let go (unless another link uses it too)
  function releaseTorrent(info: TorrentInfo | null, keep: TorrentSlot | null) {
    if (!info || handedOver) return;
    if (slots.some(x => x !== keep && x.info?.infoHash === info.infoHash)) return;
    void desktop?.torrent.stop(info.infoHash).catch(() => {});
  }
  function editLink(slot: TorrentSlot) {
    releaseTorrent(slot.info, slot);
    slot.info = null;
    slot.hint = null;
    resetOnline(slot);
  }
  function removeLink(i: number) {
    const [gone] = slots.splice(i, 1);
    releaseTorrent(gone.info, null);
  }
  onDestroy(() => {
    if (handedOver) return;
    for (const hash of new Set(slots.flatMap(x => (x.info ? [x.info.infoHash] : [])))) void desktop?.torrent.stop(hash).catch(() => {});
  });

  // Check if watch together is ready to start
  const watchReady = $derived(
    watchMode === 1 ? !!youtubeVideoId : watchMode === 2 ? !!watchFile : filled.length > 0 && !needsLookup
  );

  let listing = $state(false);
  async function loadSources() {
    if (!desktop) return;
    listing = true;
    try {
      sources = (await desktop.screenSources(false)).sources;
    } finally {
      listing = false;
    }
    // Pictures follow when they are ready
    const pictures = new Map((await desktop.screenSources(true)).sources.map(s => [s.id, s.thumbnail]));
    sources = sources.map(s => ({ ...s, thumbnail: pictures.get(s.id) ?? s.thumbnail }));
  }
  const loadApps = async () => { if (desktop && info.audio === 'pipewire') apps = await desktop.shareAudioApps(); };

  if (desktop) {
    desktop.shareInfo().then(async i => {
      info = i;
      loadApps();
      if (!i.portal) await loadSources();
    });
  }

  function dropPreview() {
    preview?.getTracks().forEach(t => t.stop());
    preview = null;
  }

  // Ask for the screen with the chosen frame rate; some capture back-ends (PipeWire portals, certain
  // Chromium builds) refuse a request that carries one ("Invalid capture constraints"), so a second
  // request goes out without it and the rate is applied to the track afterwards. A refusal by the
  // person is final. The Electron handler hands out the picked source once, so it is picked again.
  async function capture(sound: boolean, pick?: () => void): Promise<MediaStream> {
    const ask = (video: MediaTrackConstraints | boolean) => { pick?.(); return navigator.mediaDevices.getDisplayMedia({ video, audio: sound }); };
    let stream: MediaStream;
    try {
      stream = await ask({ frameRate: { ideal: fps() } });
    } catch (e) {
      if (['NotAllowedError', 'AbortError', 'SecurityError'].includes((e as Error).name)) throw e;
      stream = await ask(true);
    }
    for (const t of stream.getVideoTracks()) t.applyConstraints({ frameRate: { ideal: fps() } }).catch(() => {});
    return stream;
  }

  async function show(id: string) {
    error = '';
    dropPreview();
    selected = id;
    try {
      preview = await capture(false, () => desktop!.pickScreenSource(id));
    } catch (e) {
      error = `Could not capture this: ${(e as Error).message}`;
    }
  }

  async function showCamera(deviceId = camera) {
    error = '';
    dropPreview();
    const wanted: MediaTrackConstraints = cameraConstraints();
    if (deviceId) wanted.deviceId = { exact: deviceId };
    else wanted.facingMode = 'user';
    try {
      try {
        preview = await navigator.mediaDevices.getUserMedia({ video: wanted });
      } catch (e) {
        // A refusal or a missing camera is final; anything else may be a phone camera that
        // dislikes the wishes above, so ask once more for whatever it has
        if (['NotAllowedError', 'SecurityError', 'NotFoundError'].includes((e as Error).name)) throw e;
        preview = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true });
      }
      // Names are only given out once a camera was allowed
      cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      camera = preview.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId;
    } catch (e) {
      const { name, message } = e as Error;
      error = name === 'NotFoundError' ? 'No camera was found.'
        : name === 'NotAllowedError' || name === 'SecurityError'
          ? 'The camera was refused. If no question appeared, access is blocked: allow the camera for this site (the icon next to the address), and for the browser app in the phone\'s settings, then try again.'
          : `Could not open the camera (${name}): ${message}`;
    }
  }

  if (!canScreen) showCamera();

  function setKind(next: DialogKind) {
    if (kind === next) return;
    kind = next;
    selected = '';
    dropPreview();
    error = '';
    if (next === 'camera') showCamera();
  }

  // The system's or the browser's picker
  async function chooseElsewhere() {
    error = '';
    try {
      if (desktop) {
        const { sources: picked } = await desktop.screenSources(false);
        if (!picked.length) return;
        sources = picked;
        await show(picked[0].id);
      } else {
        dropPreview();
        preview = await capture(browserAudio);
      }
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') error = `Could not capture the screen: ${(e as Error).message}`;
    }
  }

  // The virtual microphone shows up as a recording device a moment after it is created
  async function virtualMic(): Promise<MediaStreamTrack> {
    const find = async () => (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'audioinput' && d.label.includes(info.micLabel));
    let device = await find();
    for (let i = 0; i < 20 && !device; i++) {
      await new Promise(r => setTimeout(r, 150));
      device = await find();
    }
    if (!device) throw new Error('The audio capture device did not appear.');
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: device.deviceId }, echoCancellation: false, autoGainControl: false, noiseSuppression: false, channelCount: 2 }
    });
    return s.getAudioTracks()[0];
  }


  // YouTube search: the person types a title instead of a link; choosing a result fills the link and shows its preview
  const canSearchYoutube = !!desktop?.youtube?.search;
  let yQuery = $state('');
  let yResults = $state<YoutubeResult[] | null>(null);
  let yBusy = $state(false);
  let yError = $state('');
  let yRun = 0;
  async function searchYoutube() {
    const api = desktop?.youtube;
    const q = yQuery.trim();
    if (!api?.search || !q || yBusy) return;
    const run = ++yRun;
    yBusy = true; yError = ''; yResults = null;
    try {
      const r = await api.search(q);
      if (run === yRun) { yResults = r; if (!r.length) yError = `Nothing found for "${q}".`; }
    } catch (e) {
      if (run === yRun) yError = torrentError(e);
    } finally {
      if (run === yRun) yBusy = false;
    }
  }
  // The result goes where a pasted link would, and the search is done
  function useYoutube(r: YoutubeResult) {
    yRun++;
    youtubeUrl = `https://www.youtube.com/watch?v=${r.id}`;
    youtubeVideoId = r.id;
    watchTitle = r.title;
    yQuery = ''; yResults = null; yError = ''; yBusy = false;
  }

  function parseYoutubeUrl() {
    const url = youtubeUrl.trim();
    let id = '';
    // Extract video ID from various YouTube URL formats
    if (url.includes('youtube.com/watch')) {
      const u = new URL(url);
      id = u.searchParams.get('v') || '';
    } else if (url.includes('youtu.be/')) {
      id = url.split('youtu.be/')[1]?.split('?')[0]?.split('&')[0] || '';
    } else if (url.includes('youtube.com/embed/')) {
      id = url.split('youtube.com/embed/')[1]?.split('?')[0]?.split('&')[0] || '';
    } else if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
      id = url; // Direct video ID
    }
    youtubeVideoId = id;
    if (id) {
      // Fetch video title
      fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`)
        .then(r => r.json())
        .then(data => { watchTitle = data.title; })
        .catch(() => { watchTitle = 'YouTube Video'; });
    } else {
      watchTitle = '';
    }
  }

  async function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;
    const file = input.files[0];
    if (!file.type.startsWith('video/')) {
      watchFileError = 'Please select a video file';
      return;
    }
    watchFile = file;
    watchFileError = '';
    watchTitle = file.name;
    await extractFirstFrame(file);
  }

  async function extractFirstFrame(file: File) {
    try {
      const videoUrl = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => {
          video.currentTime = 0.1;
        };
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error('Failed to load video'));
        video.src = videoUrl;
      });

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        watchFilePreview = canvas.toDataURL('image/jpeg', 0.7);
      }

      URL.revokeObjectURL(videoUrl);
    } catch (err) {
      console.error('Failed to extract first frame:', err);
      watchFilePreview = null;
    }
  }

  async function start() {
    if (kind === 'watch') {
      await startWatchTogether();
      return;
    }

    if (!preview) return;
    busy = true;
    error = '';
    let usesVirtualMic = false;
    try {
      // A camera comes without extra sound: your voice already goes through the voice chat
      if (kind === 'camera') { /* nothing to add */ }
      else if (audio && info.audio === 'pipewire') {
        usesVirtualMic = true;
        await desktop!.shareAudioStart(audio === 'all' ? { kind: 'all' } : { kind: 'app', name: audio.slice(4) });
        preview.addTrack(await virtualMic());
      } else if (audio && info.audio === 'loopback') {
        // System sound comes with a capture request; only its audio track is kept
        desktop!.pickScreenSource(selected);
        const extra = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        extra.getVideoTracks().forEach(t => t.stop());
        const track = extra.getAudioTracks()[0];
        if (track) preview.addTrack(track);
      }
    } catch (e) {
      if (usesVirtualMic) desktop!.shareAudioStop();
      error = `Could not capture the sound: ${(e as Error).message}`;
      busy = false;
      return;
    }
    handedOver = true;
    share.go(target, preview, usesVirtualMic, kind);
    onclose();
  }

  async function startWatchTogether() {
    console.log('[ShareDialog] startWatchTogether called, mode:', watchMode);

    if (watchMode === 1) {
      if (!youtubeVideoId) {
        error = 'Please enter a YouTube URL or video ID';
        busy = false;
        console.log('[ShareDialog] No video ID');
        return;
      }
    } else if (watchMode === 2) {
      if (!watchFile) {
        error = 'Please select a video file';
        busy = false;
        console.log('[ShareDialog] No file');
        return;
      }
    } else if (!filled.length || needsLookup) {
      error = filled.length > 1 ? 'Look up all the links first' : 'Look up a torrent first';
      busy = false;
      return;
    }

    busy = true;
    error = '';

    try {
      console.log('[ShareDialog] Preparing to start watch party');

      // Prepare file metadata for mode 2
      let fileMeta: { id: string; name: string; size: number; mimeType: string; hash: string } | undefined;
      if (watchMode === 2 && watchFile) {
        // Generate a simple hash from file name and size (in real implementation, use SHA-256)
        fileMeta = {
          id: `${watchFile.name}-${watchFile.size}-${Date.now()}`,
          name: watchFile.name,
          size: watchFile.size,
          mimeType: watchFile.type,
          hash: `${watchFile.name}-${watchFile.size}`,
        };
      }

      // Torrent together: everybody gets the magnet link and the file's number; each downloads it themselves
      // With several links they are played in the order they are listed
      let queue: TorrentMeta[] | undefined;
      if (watchMode === 3) {
        queue = filled.flatMap(x => {
          const info = x.info!;
          if (!info.files.some(y => y.index === x.file)) throw new Error('Choose a file');
          if (x.online.length) {
            const f = info.files.find(y => y.index === x.file)!;
            return [{ infoHash: info.infoHash, magnet: info.magnet, fileIdx: f.index, name: info.name, fileName: f.name, size: f.length }, ...x.online.map(o => o.torrent)];
          }
          return episodesOf(x).slice(0, queuedBy(x)).map(f => ({ infoHash: info.infoHash, magnet: info.magnet, fileIdx: f.index, name: info.name, fileName: f.name, size: f.length }));
        });
      }
      const torrent = queue?.[0];

      console.log('[ShareDialog] Calling watchTogether.start');

      // Start the watch party
      await watchTogether.start(watchMode, {
        videoId: watchMode === 1 ? youtubeVideoId : undefined,
        fileMeta,
        title: watchMode === 3 ? (torrent?.fileName.split('/').pop() ?? 'Torrent') : watchTitle || (watchMode === 1 ? 'YouTube Video' : watchFile?.name || 'Video'),
        torrent,
        queue,
        file: watchFile ?? undefined, // Pass the file for mode 2 streaming
      });

      console.log('[ShareDialog] Watch party started successfully');
      handedOver = true;
      onclose();
    } catch (e) {
      console.error('[ShareDialog] Error starting watch party:', e);
      error = `Failed to start watch party: ${(e as Error).message}`;
      busy = false;
    }
  }

  onDestroy(() => { if (!handedOver) dropPreview(); });
</script>

<Modal title="Share your screen" {onclose} width={760}>
  <p class="help">mumh5 users in your channel can watch. Nothing is sent until you press Start sharing.</p>

  <div class="kinds" role="tablist" aria-label="What to share">
    <button role="tab" aria-selected={kind === 'screen'} class:active={kind === 'screen'} disabled={!canScreen}
      title={canScreen ? undefined : 'This browser cannot capture the screen'} onclick={() => setKind('screen')}>Screen or window</button>
    <button role="tab" aria-selected={kind === 'camera'} class:active={kind === 'camera'} onclick={() => setKind('camera')}>Camera</button>
    <button role="tab" aria-selected={kind === 'watch'} class:active={kind === 'watch'} onclick={() => setKind('watch')}>Watch together</button>
  </div>

  {#if !canScreen}<p class="help">This browser cannot capture the screen (no browser on Android or iOS can), so only a camera can be shared from here. Watching other people's screens works.</p>{/if}
  {#if kind === 'camera'}
    <label for="sh-cam">Camera</label>
    <select id="sh-cam" value={camera} onchange={e => showCamera(e.currentTarget.value)} disabled={!cameras.length}>
      {#each cameras as c, i (c.deviceId)}<option value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>{:else}<option value="">{error ? 'None' : 'Asking for the camera...'}</option>{/each}
    </select>
  {:else if kind === 'watch'}
    <!-- Watch together mode selection -->
    <div class="watch-modes" role="tablist" aria-label="Watch together mode">
      <button role="tab" aria-selected={watchMode === 1} class:active={watchMode === 1} onclick={() => { watchMode = 1; error = ''; }}>YouTube together</button>
      <button role="tab" aria-selected={watchMode === 2} class:active={watchMode === 2} onclick={() => { watchMode = 2; error = ''; }}>Stream from host</button>
      {#if desktop?.torrent}
        <button role="tab" aria-selected={watchMode === 3} class:active={watchMode === 3} onclick={() => { watchMode = 3; error = ''; }}>Torrent together</button>
      {/if}
    </div>

    {#if watchMode === 1}
      <div class="watch-panel">
        {#if canSearchYoutube}
          <div class="tsearch">
            <label for="sh-ysearch">Search YouTube</label>
            <div class="torrent-row">
              <input id="sh-ysearch" type="search" bind:value={yQuery} placeholder="Search for a video" maxlength="200" disabled={busy}
                onkeydown={e => { if (e.key === 'Enter') void searchYoutube(); }} />
              <button class="btn" onclick={searchYoutube} disabled={!yQuery.trim() || yBusy || busy}>{yBusy ? 'Searching...' : 'Search'}</button>
            </div>
            {#if yError}<p class="err" role="alert">{yError}</p>{/if}
            {#if yResults?.length}
              <ul class="s-titles" aria-label="Videos found">
                {#each yResults as r (r.id)}
                  <li>
                    <button class="s-title yt-hit" onclick={() => useYoutube(r)} disabled={busy}>
                      <span class="yt-thumb">
                        <img src="https://i.ytimg.com/vi/{r.id}/mqdefault.jpg" alt="" loading="lazy" />
                        {#if r.duration}<span class="yt-len" class:live={r.duration === 'LIVE'}>{r.duration}</span>{/if}
                      </span>
                      <span class="s-text">
                        <span class="yt-title">{r.title}</span>
                        <span class="s-blurb">{[r.channel, r.views, r.published].filter(Boolean).join(' · ')}</span>
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
        <label for="sh-yt">YouTube URL or video ID</label>
        <input id="sh-yt" type="text" bind:value={youtubeUrl} placeholder="https://youtube.com/watch?v=... or video ID" oninput={parseYoutubeUrl} />
        {#if youtubeVideoId}
          <div class="yt-preview">
            <img src="https://img.youtube.com/vi/{youtubeVideoId}/mqdefault.jpg" alt="" />
            <span>{watchTitle || 'Loading title...'}</span>
          </div>
        {/if}
      </div>
    {:else if watchMode === 3}
      <div class="watch-panel">
        {#if canSearch}
          <div class="tsearch">
            <label for="sh-search">Search for something to watch</label>
            <div class="torrent-row">
              <input id="sh-search" type="search" bind:value={sQuery} placeholder="Movie, series or anime title" maxlength="200" disabled={busy}
                onkeydown={e => { if (e.key === 'Enter') void searchTitles(); }} />
              <button class="btn" onclick={searchTitles} disabled={!sQuery.trim() || sBusy || busy}>{sBusy && !sTitle ? 'Searching...' : 'Search'}</button>
            </div>
            {#if sError}<p class="err" role="alert">{sError}</p>{/if}
            {#if sTitles?.length && !sTitle}
              <ul class="s-titles" aria-label="Titles found">
                {#each sTitles as t (t.source + t.id)}
                  <li>
                    <button class="s-title" onclick={() => pickTitle(t)} disabled={busy}>
                      {#if t.poster}<img src={t.poster} alt="" loading="lazy" />{:else}<span class="s-nopic"></span>{/if}
                      <span class="s-text">
                        <span class="s-name">{t.name}{#if t.year}<span class="s-year"> ({t.year})</span>{/if}</span>
                        <span class="s-blurb">{t.type === 'movie' ? 'Movie' : 'Series'}{t.source === 'kitsu' ? ' · Anime' : ''}{t.blurb ? ` · ${t.blurb}` : ''}</span>
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if sTitle}
              <div class="s-picked">
                <button class="btn" onclick={backToTitles} aria-label="Back to the titles found">&larr;</button>
                <strong class="s-name">{sTitle.name}{#if sTitle.year}<span class="s-year"> ({sTitle.year})</span>{/if}</strong>
              </div>
              {#if sTitle.type === 'series'}
                <div class="ep-row s-ep">
                  {#if sTitle.source === 'imdb'}
                    <label class="s-num">Season <input type="number" min="0" max="99" bind:value={sSeason} disabled={sBusy || busy} /></label>
                  {/if}
                  <label class="s-num">Episode <input type="number" min="1" max="9999" bind:value={sEpisode} disabled={sBusy || busy} /></label>
                  <button class="btn" onclick={findTorrents} disabled={sBusy || busy}>{sBusy ? 'Searching...' : 'Find torrents'}</button>
                </div>
              {/if}
              {#if sBusy}<p class="help" aria-live="polite">Searching every provider...</p>{/if}
              {#if sFound?.length}
                <div class="s-filter">
                  <label for="sh-prov">Provider</label>
                  <select id="sh-prov" bind:value={sProvider}>
                    <option value="">All providers ({sFound.length})</option>
                    {#each sProviders as p (p)}<option value={p}>{p} ({sFound.filter(f => f.provider === p).length})</option>{/each}
                  </select>
                  {#each [['quality', 'Quality'], ['size', 'Size'], ['peers', 'Peers']] as const as [k, name] (k)}
                    <button class="btn s-sort" class:on={sSort === k} onclick={() => toggleSort(k)}
                      aria-label="Sort by {name}{sSort === k ? (sDesc ? ', high to low' : ', low to high') : ''}"
                      title="Sort by {name}{sSort === k ? (sDesc ? ' (high to low)' : ' (low to high)') : ''}">{name}{#if sSort === k} {sDesc ? '\u25BC' : '\u25B2'}{/if}</button>
                  {/each}
                </div>
                <ul class="s-found" aria-label="Torrents found">
                  {#each sShown as f (f.torrent.infoHash)}
                    <li>
                      <button class="s-hit" onclick={() => useFound(f)} disabled={busy || torrentBusy}
                        title="Use this torrent">
                        <span class="s-line1">
                          {#if f.quality}<span class="s-chip">{f.quality}</span>{/if}
                          <span class="s-rel">{f.title}</span>
                        </span>
                        <span class="s-line2">
                          <span title="Seeders">&#9650; {fmtCount(f.seeders)}</span>
                          {#if f.size}<span>{fmtSize(f.size)}</span>{/if}
                          {#if f.provider}<span>{f.provider}</span>{/if}
                          {#if f.languages}<span>{f.languages}</span>{/if}
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
                <p class="help">Pick one to put it in a link below. It is looked up like a pasted link.</p>
              {/if}
            {/if}
          </div>
        {/if}
        <label for="sh-torrent-0">Magnet link, info hash or .torrent address</label>
        {#each slots as slot, i (i)}
          <div class="torrent-row">
            <input id="sh-torrent-{i}" type="text" bind:value={slot.input} placeholder={i === 0 ? 'magnet:?xt=urn:btih:...' : `Link ${i + 1}: magnet:?xt=urn:btih:...`} disabled={torrentBusy || busy}
              aria-label={slots.length > 1 ? `Link ${i + 1}` : undefined}
              oninput={() => editLink(slot)} onkeydown={e => { if (e.key === 'Enter') void lookUpTorrents(); }} />
            {#if i === 0}
              <button class="btn" onclick={lookUpTorrents} disabled={!needsLookup || torrentBusy || busy}>{torrentBusy ? 'Looking...' : slots.length > 1 ? 'Look up all' : 'Look up'}</button>
            {:else}
              <button class="btn" onclick={() => removeLink(i)} disabled={torrentBusy || busy} aria-label="Remove link {i + 1}" title="Remove this link">&times;</button>
            {/if}
          </div>
        {/each}
        {#if canAddLink}
          <button class="btn add-link" onclick={() => slots.push(newSlot())} disabled={torrentBusy || busy} aria-label="Add another link" title="Add another link ({slots.length} of {MAX_LINKS})">+</button>
        {/if}
        <button class="btn" onclick={lookUpTorrentFile} disabled={torrentBusy || busy}>Choose a .torrent file...</button>
        <p class="help">Everybody who joins downloads the video themselves and plays it in their own player, with subtitles found for them. Joining shows their address to the other people sharing the torrent.</p>
        {#each slots as slot, i (i)}
          {#if slot.info}
            {@const eps = episodesOf(slot)}
            <span class="label">{slots.length > 1 ? `Link ${i + 1}: file to play` : 'File to play'}</span>
            <div class="torrent-files" role="radiogroup" aria-label="File to play{slots.length > 1 ? ` for link ${i + 1}` : ''}">
              {#each slot.info.files as f (f.index)}
                <label class:dim={!isVideoName(f.name)}>
                  <input type="radio" name="torrent-file-{i}" value={f.index} bind:group={slot.file} onchange={() => { slot.count = 1; resetOnline(slot); }} />
                  <span class="fname">{f.name}</span><span class="fsize">{fmtSize(f.length)}</span>
                </label>
              {/each}
            </div>
            {#if eps.length > 1}
              <div class="episodes">
                <span class="label">Episodes found in this torrent: {eps.length - 1} more after this one. How many should play?</span>
                <div class="ep-row">
                  <button class="btn" onclick={() => setCount(slot, queuedBy(slot) - 1)} disabled={queuedBy(slot) <= 1 || busy} aria-label="One episode fewer">&minus;</button>
                  <output class="ep-n" aria-live="polite">{queuedBy(slot)}</output>
                  <button class="btn" onclick={() => setCount(slot, queuedBy(slot) + 1)} disabled={queuedBy(slot) >= maxCount(slot) || busy} aria-label="One episode more">+</button>
                  <button class="btn" onclick={() => setCount(slot, maxCount(slot))} disabled={queuedBy(slot) >= maxCount(slot) || busy}>All</button>
                  <span class="ep-last">{queuedBy(slot) > 1 ? `Last: ${baseName(eps[queuedBy(slot) - 1].name)}` : 'Only the chosen file'}</span>
                </div>
              </div>
            {:else if canSearchOnline(slot)}
              <div class="episodes">
                <span class="label">This looks like one episode. How many episodes should play? The next ones are looked up online (Torrentio), in the same release if it has them.</span>
                <div class="ep-row">
                  <button class="btn" onclick={() => setOnlineCount(slot, slot.count - 1)} disabled={slot.count <= 1 || slot.searching || busy} aria-label="One episode fewer">&minus;</button>
                  <output class="ep-n" aria-live="polite">{slot.count}</output>
                  <button class="btn" onclick={() => setOnlineCount(slot, slot.count + 1)} disabled={slot.count >= maxOnline(slot) || slot.searching || busy} aria-label="One episode more">+</button>
                  <button class="btn" onclick={() => searchOnline(slot)} disabled={slot.count < 2 || slot.searching || busy}>{slot.searching ? 'Searching...' : 'Find episodes'}</button>
                </div>
                {#if slot.searchNote}<p class="help">{slot.searchNote}</p>{/if}
                {#if slot.online.length}
                  <ul class="ep-found">
                    {#each slot.online as o (o.episode)}<li><strong>{o.episode}</strong> {baseName(o.torrent.fileName)}</li>{/each}
                  </ul>
                {/if}
                {#if slot.count > 1 && !slot.online.length && !slot.searching && !slot.searchNote}<p class="help">Press Find episodes to look them up. Without it, only this file plays.</p>{/if}
              </div>
            {/if}
          {/if}
        {/each}
        {#if slots.length > 1}<p class="help">The links play in this order. When one has downloaded, the next starts downloading, and Next moves everybody on.</p>{/if}
      </div>
    {:else if watchMode === 2}
      <div class="watch-panel">
        <label for="sh-watch-file">Video file</label>
        <input id="sh-watch-file" type="file" accept="video/*" onchange={handleFileSelect} disabled={busy} />
        {#if watchFile}
          <div class="file-preview">
            <span class="name">{watchFile.name}</span>
            <span class="size">{(watchFile.size / 1024 / 1024).toFixed(1)} MB</span>
          </div>
        {/if}
        {#if watchFileError}<p class="err">{watchFileError}</p>{/if}
        <p class="help">Only you need the file. Your player is streamed live, so everyone can start watching right away. Lower the bitrate, quality or FPS below if viewers have a slow connection.</p>
      </div>
    {/if}
  {:else if !desktop && info.audio === 'browser'}
    <label class="check"><input type="checkbox" bind:checked={browserAudio} disabled={!!preview} /> Include sound (the browser offers what it can share, usually a tab's sound)</label>
  {/if}

  {#if kind === 'camera'}
    <!-- chosen above -->
  {:else if kind === 'watch'}
    <!-- Watch together content is shown above -->
  {:else if desktop && !info.portal}
    <div class="row head"><label for="sh-src">Screen or window</label><button class="link" onclick={loadSources}>Refresh</button></div>
    <ul class="sources" id="sh-src">
      {#each sources as s (s.id)}
        <li>
          <button class:active={selected === s.id} aria-pressed={selected === s.id} onclick={() => show(s.id)}>
            {#if s.thumbnail}<img src={s.thumbnail} alt="" />{:else}<span class="blank"></span>{/if}
            <span class="name">{s.name}</span>
          </button>
        </li>
      {:else}
        <li class="dim">{listing ? 'Looking for screens and windows...' : 'Nothing found. Try Refresh.'}</li>
      {/each}
    </ul>
  {:else}
    <div class="row"><button class="btn" onclick={chooseElsewhere}>{preview ? 'Choose another screen or window...' : 'Choose a screen or window...'}</button></div>
  {/if}

  <!-- Torrent together has nothing to preview: the torrent only starts loading after sharing starts -->
  {#if !(kind === 'watch' && watchMode === 3)}
  <span class="label">Preview</span>
  <div class="preview">
    {#if kind === 'watch'}
      {#if watchMode === 1 && youtubeVideoId}
        <img src="https://img.youtube.com/vi/{youtubeVideoId}/mqdefault.jpg" alt="" />
        <div class="preview-title">{watchTitle || 'YouTube Video'}</div>
      {:else if watchMode === 2 && watchFile}
        <div class="file-preview-large">
          {#if watchFilePreview}
            <img src={watchFilePreview} alt="Video preview" class="video-preview" />
          {/if}
          <div class="file-info">
            <span class="name">{watchFile.name}</span>
            <span class="size">{(watchFile.size / 1024 / 1024).toFixed(1)} MB</span>
          </div>
        </div>
      {:else}
        <p>Nothing chosen yet</p>
      {/if}
    {:else if kind === 'camera'}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} class:mirror={preview?.getVideoTracks()[0]?.getSettings().facingMode !== 'environment'} autoplay playsinline muted></video>
      {#if !preview}<p>Nothing chosen yet</p>{/if}
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} autoplay playsinline muted></video>
      {#if !preview}<p>Nothing chosen yet</p>{/if}
    {/if}
  </div>
  {/if}

  {#if desktop && kind === 'screen'}
    <div class="row">
      <div>
        <label for="sh-audio">Sound</label>
        {#if info.audio === 'pipewire'}
          <select id="sh-audio" bind:value={audio} onfocus={loadApps}>
            <option value="">No sound</option>
            <option value="all">Everything except mumh5</option>
            {#each apps as a (a)}<option value={`app:${a}`}>{a}</option>{/each}
          </select>
        {:else if info.audio === 'loopback'}
          <select id="sh-audio" bind:value={audio}>
            <option value="">No sound</option>
            <option value="all">Whole system (viewers also hear the voice chat again)</option>
          </select>
        {:else}
          <select id="sh-audio" disabled><option>Not available on this system</option></select>
        {/if}
      </div>
      <label class="check dyn" title="When nothing on the screen changes for 2 seconds, only 1 frame per second is sent, which saves processor and bandwidth. The full rate is back the moment something moves.">
        <input type="checkbox" bind:checked={store.settings.shareDynamicFps} onchange={set} /> Dynamic FPS
      </label>
    </div>
  {:else if !desktop && kind === 'screen'}
    <div class="row">
      <label class="check" title="When nothing on the screen changes for 2 seconds, only 1 frame per second is sent. The full rate is back the moment something moves.">
        <input type="checkbox" bind:checked={store.settings.shareDynamicFps} onchange={set} /> Dynamic FPS
      </label>
    </div>
  {/if}

  <!-- A YouTube party encodes nothing; a streamed file is encoded with these -->
  <fieldset class="quality" disabled={kind === 'watch' && (watchMode === 1 || watchMode === 3)}>
    <div>
      <label for="sh-bitrate">Bitrate limit: {q.bitrate} Mbit/s</label>
      <input id="sh-bitrate" type="range" min="0" max={SHARE_BITRATES.length - 1} step="1" value={SHARE_BITRATES.indexOf(q.bitrate)}
        oninput={e => { store.settings.shareBitrate = SHARE_BITRATES[Number(e.currentTarget.value)]; set(); }} />
    </div>
    <div>
      <label for="sh-height">Quality: {q.height}p</label>
      <input id="sh-height" type="range" min="0" max={SHARE_HEIGHTS.length - 1} step="1" value={SHARE_HEIGHTS.indexOf(q.height)}
        oninput={e => { store.settings.shareHeight = SHARE_HEIGHTS[Number(e.currentTarget.value)]; set(); }} />
    </div>
    <div>
      <label for="sh-fps">FPS: {q.fps}</label>
      <input id="sh-fps" type="range" min="0" max={SHARE_FPS.length - 1} step="1" value={SHARE_FPS.indexOf(q.fps)}
        oninput={e => { store.settings.shareFps = SHARE_FPS[Number(e.currentTarget.value)]; set(); }} />
    </div>
    <div>
      <label for="sh-mode">Mode: {SHARE_MODES[q.mode]}</label>
      <input id="sh-mode" type="range" min="0" max={modeIds.length - 1} step="1" value={modeIds.indexOf(q.mode)}
        oninput={e => { store.settings.shareMode = modeIds[Number(e.currentTarget.value)]; set(); }} />
    </div>
    {#if kind === 'watch' && (watchMode === 1 || watchMode === 3)}<p class="help">These apply to screen, camera and file streaming, not to YouTube or torrents.</p>{/if}
  </fieldset>

  {#if error}<p class="err">{error}</p>{/if}
  {#if kind === 'camera' && error}<div class="row"><button class="btn" onclick={() => showCamera()}>Try the camera again</button></div>{/if}

  {#snippet footer()}
    <button class="btn" onclick={onclose}>Cancel</button>
    <button class="btn primary" disabled={(kind === 'watch' ? !watchReady : !preview) || busy} onclick={start}>{busy ? 'Starting...' : 'Start sharing'}</button>
  {/snippet}
</Modal>

<style>
  .yt-hit { align-items: flex-start; }
  .yt-thumb { position: relative; flex: none; width: 96px; height: 54px; border-radius: 4px; overflow: hidden; background: var(--line); }
  .s-title .yt-thumb img { width: 100%; height: 100%; border-radius: 0; object-fit: cover; display: block; }
  .yt-len { position: absolute; right: 3px; bottom: 3px; padding: 0 4px; border-radius: 3px; font-size: 11px; font-weight: 600; color: #fff; background: rgba(0, 0, 0, 0.8); font-variant-numeric: tabular-nums; }
  .yt-len.live { background: #d62d20; }
  .yt-title { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-weight: 600; line-height: 1.25; }
  .tsearch { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .tsearch .torrent-row input { flex: 1; min-width: 0; }
  .s-titles, .s-found { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; max-height: 240px; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; }
  .s-title, .s-hit { display: flex; gap: 10px; align-items: center; width: 100%; padding: 6px 8px; text-align: left; border-radius: 0; }
  .s-title:hover:not(:disabled), .s-hit:hover:not(:disabled) { background: var(--hover, rgba(127, 127, 127, 0.14)); }
  .s-title img, .s-nopic { flex: none; width: 34px; height: 50px; border-radius: 3px; object-fit: cover; background: var(--line); }
  .s-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .s-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .s-year { font-weight: 400; color: var(--text-dim); }
  .s-blurb { font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-picked { display: flex; align-items: center; gap: 8px; margin-top: 8px; min-width: 0; }
  .s-ep { margin-top: 8px; }
  .s-num { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .s-num input { width: 64px; }
  .s-filter { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .s-filter select { flex: 1; min-width: 0; }
  .s-sort { flex: none; white-space: nowrap; }
  .s-sort.on { border-color: var(--accent); color: var(--accent); }
  .s-hit { flex-direction: column; align-items: stretch; gap: 2px; }
  .s-line1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .s-rel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .s-chip { flex: none; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 4px; background: var(--accent); color: var(--accent-text, #fff); }
  .s-line2 { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
  .torrent-row { display: flex; gap: 6px; margin-bottom: 6px; }
  .episodes { margin-top: 8px; }
  .ep-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .ep-found { list-style: none; margin: 6px 0 0; padding: 0; font-size: 12px; color: var(--text-dim); }
  .ep-found li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ep-n { min-width: 28px; text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
  .ep-last { font-size: 12px; color: var(--text-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .add-link { display: flex; margin-bottom: 8px; min-width: 40px; }
  .torrent-row input { flex: 1; min-width: 0; }
  .torrent-files { display: flex; flex-direction: column; max-height: 160px; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; }
  .torrent-files label { display: flex; gap: 8px; align-items: center; padding: 4px 8px; cursor: pointer; }
  .torrent-files label.dim { opacity: 0.55; }
  .torrent-files .fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .torrent-files .fsize { font-size: 12px; opacity: 0.7; font-variant-numeric: tabular-nums; }
  .help { margin: 8px 0 0; font-size: 13px; color: var(--text-dim); }
  .kinds { display: flex; gap: 2px; margin-top: 12px; border-bottom: 1px solid var(--line); }
  .kinds button { padding: 6px 14px; color: var(--text-dim); font-weight: 600; }
  .kinds button.active { color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .row.head { justify-content: space-between; margin-top: 0; }
  .row > div { flex: 1; min-width: 0; }
  .row .dyn { flex: none; align-self: flex-end; padding-bottom: 7px; white-space: nowrap; }
  .quality { border: 0; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .quality > div { width: 100%; }
  .quality input[type=range] { width: 100%; }
  .quality:disabled { opacity: 0.5; }
  .label { display: block; font-size: 13px; font-weight: 600; color: var(--text-dim); margin: 16px 0 6px; }
  .link { color: var(--link); font-size: 13px; margin-top: 8px; }
  .sources { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; max-height: 190px; overflow-y: auto; }
  .sources button { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 6px; text-align: left; border: 1px solid var(--line); background: var(--bg-0); }
  .sources button:hover { border-color: var(--text-faint); }
  .sources button.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  img, .blank { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: #000; display: block; }
  .name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview { position: relative; background: #000; aspect-ratio: 16 / 9; max-height: 240px; margin: 0 auto; width: 100%; }
  .preview video { width: 100%; height: 100%; object-fit: contain; display: block; }
  /* Your own camera as a mirror shows you; a camera facing away is left as it is */
  .preview video.mirror { transform: scaleX(-1); }
  .preview p { position: absolute; inset: 0; margin: 0; display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 13px; }
  .check { display: flex; align-items: center; gap: 8px; text-transform: none; font-weight: 400; letter-spacing: 0; font-size: 14px; color: var(--text); margin-top: 12px; }
  .dim { color: var(--text-dim); font-size: 13px; }
  .err { color: var(--danger); font-size: 13px; margin: 10px 0 0; }

  /* Watch together styles */
  .watch-modes { display: flex; gap: 2px; margin-top: 8px; border-bottom: 1px solid var(--line); }
  .watch-modes button { padding: 6px 14px; color: var(--text-dim); font-weight: 600; font-size: 13px; }
  .watch-modes button.active { color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
  .watch-panel { margin-top: 12px; }
  .watch-panel label { display: block; font-size: 13px; font-weight: 600; color: var(--text-dim); margin-bottom: 6px; }
  .watch-panel input[type="text"] { width: 100%; padding: 8px 10px; border: 1px solid var(--line); background: var(--bg-0); color: var(--text); font-size: 13px; }
  .watch-panel input[type="text"]:focus { outline: none; border-color: var(--accent); }
  .watch-panel input[type="file"] { display: block; width: 100%; padding: 8px 0; }
  .yt-preview { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 8px; background: var(--bg-0); border: 1px solid var(--line); }
  .yt-preview img { width: 160px; height: 90px; object-fit: cover; }
  .file-preview { display: flex; align-items: center; gap: 12px; margin-top: 8px; padding: 8px; background: var(--bg-0); border: 1px solid var(--line); }
  .file-preview .name { font-weight: 500; }
  .file-preview .size { color: var(--text-dim); font-size: 13px; }
  .preview img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .preview-title { position: absolute; bottom: 0; left: 0; right: 0; padding: 12px; background: linear-gradient(to top, rgba(0,0,0,0.8), transparent); color: #fff; font-size: 13px; font-weight: 500; }
  .file-preview-large { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; width: 100%; height: 100%; }
  .file-preview-large .video-preview { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .file-preview-large .file-info { position: absolute; bottom: 0; left: 0; right: 0; padding: 12px; background: linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.6) 60%, transparent); display: flex; flex-direction: column; gap: 4px; }
  .file-preview-large .name { color: #fff; font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-preview-large .size { color: rgba(255,255,255,0.8); font-size: 13px; }
</style>
