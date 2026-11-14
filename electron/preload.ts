import { contextBridge, ipcRenderer } from 'electron';

type Listener = (connId: string, ...args: any[]) => void;
const listeners = {
  secure: new Set<Listener>(), data: new Set<Listener>(), close: new Set<Listener>(),
  udpVoice: new Set<Listener>(), udpState: new Set<Listener>(), udpResync: new Set<Listener>()
};
for (const key of Object.keys(listeners) as (keyof typeof listeners)[]) {
  ipcRenderer.on(`mumble:${key}`, (_e, connId: string, ...args: any[]) => {
    for (const fn of listeners[key]) fn(connId, ...args);
  });
}

// The only native surface the renderer gets
contextBridge.exposeInMainWorld('libertadNative', {
  profiles: {
    read: (name: string, file: string) => ipcRenderer.invoke('profiles:read', name, file),
    write: (name: string, file: string, bytes: Uint8Array | null) => ipcRenderer.invoke('profiles:write', name, file, bytes),
  },
  files: {
    begin: (id: string, name: string, size: number, hash: string) => ipcRenderer.invoke('files:begin', id, name, size, hash),
    write: (id: string, offset: number, bytes: Uint8Array) => ipcRenderer.invoke('files:write', id, offset, bytes),
    finish: (id: string) => ipcRenderer.invoke('files:finish', id),
    remove: (id: string) => ipcRenderer.invoke('files:remove', id),
    where: (id: string, hash: string) => ipcRenderer.invoke('files:where', id, hash),
    reveal: (id: string) => ipcRenderer.invoke('files:reveal', id),
    export: (id: string, name: string, hash: string) => ipcRenderer.invoke('files:export', id, name, hash),
    saveFrame: (name: string, bytes: Uint8Array) => ipcRenderer.invoke('files:saveFrame', name, bytes),
  },
  // Torrent Together: the torrent is downloaded here and played from a local address (see electron/torrent.ts)
  torrent: {
    inspect: (input: string) => ipcRenderer.invoke('torrent:inspect', String(input)),
    openFile: () => ipcRenderer.invoke('torrent:openFile'),
    play: (meta: { magnet: string; fileIdx: number; fileName?: string; size?: number }) => ipcRenderer.invoke('torrent:play', { magnet: String(meta.magnet), fileIdx: Number(meta.fileIdx), fileName: meta.fileName, size: meta.size }),
    probe: (infoHash: string, fileIdx: number) => ipcRenderer.invoke('torrent:probe', String(infoHash), Number(fileIdx)),
    stats: (infoHash: string, fileIdx: number) => ipcRenderer.invoke('torrent:stats', String(infoHash), Number(fileIdx)),
    stop: (infoHash: string) => ipcRenderer.invoke('torrent:stop', String(infoHash)),
    subtitles: (infoHash: string, fileIdx: number, query?: string) => ipcRenderer.invoke('torrent:subtitles', String(infoHash), Number(fileIdx), query ? String(query) : undefined),
    findEpisodes: (filename: string, count: number) => ipcRenderer.invoke('torrent:findEpisodes', String(filename), Number(count)),
    searchTitles: (query: string) => ipcRenderer.invoke('torrent:searchTitles', String(query)),
    searchTorrents: (t: { source: string; id: string; type: string }, season: number, episode: number) =>
      ipcRenderer.invoke('torrent:searchTorrents', { source: String(t.source), id: String(t.id), type: String(t.type) }, Number(season), Number(episode)),
    embeddedTracks: (infoHash: string, fileIdx: number) => ipcRenderer.invoke('torrent:embeddedTracks', String(infoHash), Number(fileIdx)),
    embeddedScan: (infoHash: string, fileIdx: number, startMs: number) => ipcRenderer.invoke('torrent:embeddedScan', String(infoHash), Number(fileIdx), Number(startMs)),
    embeddedStop: (infoHash: string, fileIdx: number) => ipcRenderer.invoke('torrent:embeddedStop', String(infoHash), Number(fileIdx)),
    // Batches of cues from a scan; returns the function that stops listening
    onEmbeddedCues: (fn: (batch: unknown) => void) => {
      const on = (_e: unknown, batch: unknown) => fn(batch);
      ipcRenderer.on('torrent:embeddedCues', on);
      return () => { ipcRenderer.removeListener('torrent:embeddedCues', on); };
    },
    subtitleFile: (url: string, lang: string) => ipcRenderer.invoke('torrent:subtitleFile', String(url), String(lang))
  },
  storage: {
    flush: () => ipcRenderer.invoke('storage:flush')
  },
  system: {
    get: () => ipcRenderer.invoke('system:get'),
    setHardwareAcceleration: (on: boolean) => ipcRenderer.invoke('system:setHardwareAcceleration', !!on),
    setLaunchOnStartup: (on: boolean) => ipcRenderer.invoke('system:setLaunchOnStartup', !!on),
    setAutoUpdate: (on: boolean) => ipcRenderer.invoke('system:setAutoUpdate', !!on),
    relaunch: () => ipcRenderer.invoke('system:relaunch'),
    quit: () => ipcRenderer.invoke('system:quit')
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onProgress: (fn: (done: number, total: number) => void) => {
      const on = (_e: unknown, done: number, total: number) => fn(done, total);
      ipcRenderer.on('update:progress', on);
      return () => { ipcRenderer.removeListener('update:progress', on); };
    },
    // The start-up check found an update: the window asks the person
    onAvailable: (fn: (info: unknown) => void) => {
      const on = (_e: unknown, info: unknown) => fn(info);
      ipcRenderer.on('update:available', on);
      return () => { ipcRenderer.removeListener('update:available', on); };
    }
  },
  // The title bar the page draws itself on Linux and Windows (macOS keeps the system one); see src/ui/TitleBar.svelte
  titleBar: {
    custom: process.platform !== 'darwin',
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    state: () => ipcRenderer.invoke('window:state'),
    onState: (fn: (s: { maximized: boolean; fullscreen: boolean }) => void) => {
      const on = (_e: unknown, s: { maximized: boolean; fullscreen: boolean }) => fn(s);
      ipcRenderer.on('window:state', on);
      return () => { ipcRenderer.removeListener('window:state', on); };
    }
  },
  shortcuts: {
    setGlobal: (list: { id: string; accelerator: string }[]) => ipcRenderer.invoke('shortcuts:setGlobal', list)
  },
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  setFullScreen: (fullscreen: boolean) => ipcRenderer.invoke('window:setFullScreen', fullscreen),
  isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),
  youtube: {
    search: (query: string) => ipcRenderer.invoke('youtube:search', String(query)),
    account: () => ipcRenderer.invoke('youtube:account'),
    signIn: () => ipcRenderer.invoke('youtube:signIn'),
    browserSignIn: () => ipcRenderer.invoke('youtube:browserSignIn'),
    browserCancel: () => ipcRenderer.invoke('youtube:browserCancel'),
    companionFolder: () => ipcRenderer.invoke('youtube:companionFolder'),
    openCompanionFolder: () => ipcRenderer.invoke('youtube:openCompanionFolder'),
    importCookies: (text: string) => ipcRenderer.invoke('youtube:importCookies', String(text)),
    signOut: () => ipcRenderer.invoke('youtube:signOut'),
    setNoHistory: (on: boolean) => ipcRenderer.invoke('youtube:setNoHistory', !!on)
  },
  setPopoutFullScreen: (name: string, fullscreen?: boolean) => ipcRenderer.invoke('popout:setFullScreen', name, fullscreen),
  isPopoutFullScreen: (name: string) => ipcRenderer.invoke('popout:isFullScreen', name),
  updateTray: (state: unknown) => ipcRenderer.send('tray:update', state),
  linkPreview: (url: string) => ipcRenderer.invoke('preview:fetch', url),
  gifFetch: (url: string) => ipcRenderer.invoke('gif:fetch', url),
  gifSearch: (q: string, page: number) => ipcRenderer.invoke('gif:search', q, page),
  youtubeQuality: (level: string) => ipcRenderer.invoke('yt:quality', level),
  youtubeRate: (rate: number) => ipcRenderer.invoke('yt:rate', rate),
  youtubeVideoSize: () => ipcRenderer.invoke('yt:size'),
  youtubeFrame: (full?: boolean) => ipcRenderer.invoke('yt:frame', !!full),
  youtubeThumbnail: (id: string) => ipcRenderer.invoke('yt:thumbnail', id),
  publicServers: (url: string) => ipcRenderer.invoke('publist:fetch', url),
  pingServer: (host: string, port: number) => ipcRenderer.invoke('publist:ping', host, port),
  onContextMenu: (fn: (params: unknown) => void) => { ipcRenderer.on('context-menu', (_e, p) => fn(p)); },
  editAction: (action: string, arg?: unknown) => ipcRenderer.send('edit:action', action, arg),
  onTrayAction: (fn: (action: string) => void) => { ipcRenderer.on('tray:action', (_e, a: string) => fn(a)); },
  screenSources: (thumbnails: boolean) => ipcRenderer.invoke('share:sources', !!thumbnails),
  pickScreenSource: (id: string) => ipcRenderer.send('share:pick', id),
  shareInfo: () => ipcRenderer.invoke('share:info'),
  cameraAccess: () => ipcRenderer.invoke('share:cameraAccess'),
  openCameraSettings: () => ipcRenderer.invoke('share:openCameraSettings'),
  shareAudioApps: () => ipcRenderer.invoke('share:audioApps'),
  shareAudioStart: (target: unknown) => ipcRenderer.invoke('share:audioStart', target),
  shareAudioStop: () => ipcRenderer.invoke('share:audioStop'),
  onSharePcm: (fn: (chunk: Uint8Array) => void) => {
    const listener = (_e: unknown, chunk: Uint8Array) => fn(chunk);
    ipcRenderer.on('share:pcm', listener);
    return () => { ipcRenderer.removeListener('share:pcm', listener); };
  },
  describeCerts: (ders: Uint8Array[]) => ipcRenderer.invoke('certs:describe', ders),
  identities: {
    list: () => ipcRenderer.invoke('identities:list'),
    create: (name: string, email: string) => ipcRenderer.invoke('identities:create', name, email),
    importP12: (bytes: Uint8Array, password: string, name: string) => ipcRenderer.invoke('identities:import', bytes, password, name),
    findMumble: () => ipcRenderer.invoke('identities:findMumble'),
    importMumble: (name: string) => ipcRenderer.invoke('identities:importMumble', name),
    exportP12: (id: string, password: string) => ipcRenderer.invoke('identities:export', id, password),
    setDefault: (id: string) => ipcRenderer.invoke('identities:setDefault', id),
    rename: (id: string, name: string) => ipcRenderer.invoke('identities:rename', id, name),
    remove: (id: string) => ipcRenderer.invoke('identities:remove', id),
    finishSetup: () => ipcRenderer.invoke('identities:finishSetup')
  },
  open: (connId: string, host: string, port: number, identityId?: string) => ipcRenderer.invoke('mumble:open', connId, host, port, identityId),
  send: (connId: string, bytes: Uint8Array) => ipcRenderer.send('mumble:send', connId, bytes),
  close: (connId: string) => ipcRenderer.send('mumble:close', connId),
  udpSetup: (connId: string, key: Uint8Array, cn: Uint8Array, sn: Uint8Array, protobuf: boolean) => ipcRenderer.send('mumble:udpSetup', connId, key, cn, sn, protobuf),
  udpNonce: (connId: string, sn: Uint8Array) => ipcRenderer.send('mumble:udpNonce', connId, sn),
  udpSend: (connId: string, bytes: Uint8Array) => ipcRenderer.send('mumble:udpSend', connId, bytes),
  udpClientNonce: (connId: string) => ipcRenderer.invoke('mumble:udpClientNonce', connId),
  on: (event: keyof typeof listeners, fn: Listener) => {
    listeners[event].add(fn);
    return () => listeners[event].delete(fn);
  }
});
