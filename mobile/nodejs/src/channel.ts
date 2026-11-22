// The line to the page.
//
// In the app this is the `bridge` module that capacitor-nodejs (Node.js for Mobile Apps, "nodejs-mobile")
// provides inside the embedded Node runtime: channel.send / channel.addListener carry JSON messages to and
// from the Capacitor WebView, which uses NodeJS.send / NodeJS.addListener from the `capacitor-nodejs` package.
//
// Outside the app (the tests, or `node index.js` forked from a script) the same API runs over the parent
// process's IPC, so the backend can be run and tested on a computer with no phone.

export interface Channel {
  on(event: string, fn: (...args: any[]) => void): void;
  send(event: string, ...args: unknown[]): void;
  // A folder the app may write to and keeps between launches
  dataPath(): string;
  // The app went to the background / came back (nodejs-mobile only; a no-op elsewhere)
  onLifecycle(fn: (state: 'pause' | 'resume') => void): void;
}

// `bridge` only exists inside nodejs-mobile; esbuild leaves this require alone (see scripts/build-node.mjs)
function loadBridge(): any | null {
  try { return require('bridge'); } catch { return null; }
}

// The plugin has described the data folder and the pause/resume hooks in more than one shape across versions,
// so each is looked up where it has been seen
function firstFunction(...candidates: unknown[]): ((...a: any[]) => any) | null {
  for (const c of candidates) if (typeof c === 'function') return c as (...a: any[]) => any;
  return null;
}

export function openChannel(): Channel {
  const bridge = loadBridge();
  if (bridge?.channel) {
    const ch = bridge.channel;
    return {
      on: (event, fn) => { ch.addListener(event, fn); },
      send: (event, ...args) => { ch.send(event, ...args); },
      dataPath: () => {
        const get = firstFunction(bridge.getDataPath, ch.getDataPath, bridge.app?.datadir, bridge.app?.getDataPath);
        const dir = get?.call(bridge.app ?? bridge);
        if (typeof dir !== 'string' || !dir) throw new Error('nodejs-mobile did not give a data folder');
        return dir;
      },
      onLifecycle: fn => {
        firstFunction(bridge.onPause, ch.onPause)?.call(bridge, () => fn('pause'));
        firstFunction(bridge.onResume, ch.onResume)?.call(bridge, () => fn('resume'));
      }
    };
  }

  // Not in the app: talk to the parent process, as `{ event, args }` messages
  if (!process.send) throw new Error('Not running in nodejs-mobile, and there is no parent process to talk to');
  const handlers = new Map<string, ((...args: any[]) => void)[]>();
  process.on('message', (m: any) => {
    if (!m || typeof m.event !== 'string' || !Array.isArray(m.args)) return;
    for (const fn of handlers.get(m.event) ?? []) fn(...m.args);
  });
  return {
    on: (event, fn) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
    send: (event, ...args) => { process.send?.({ event, args }); },
    dataPath: () => process.env.LIBERTAD_DATA_DIR || process.cwd(),
    onLifecycle: () => { /* no lifecycle outside the app */ }
  };
}
