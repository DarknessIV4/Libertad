// Loads a Capacitor plugin of this app (the native Java classes in mobile/android/templates) for the page.
//
// Why this exists: `registerPlugin()` returns a Proxy that answers to EVERY property name, `then` included, as if it were a
// native method. A Promise that resolves with such a Proxy (`import(...).then(() => registerPlugin(...))`, or an async
// function that returns it) asks it for `.then`, gets a function that never calls back, and so never settles. The result
// was `await getPlugin()` hanging for ever: every button in Settings, System did nothing and full screen never reached
// the phone. The handle is therefore wrapped here so that it is not "thenable" and the promise settles normally.

type Loaded<T> = Promise<T>;

const cache = new Map<string, Loaded<unknown>>();

export function loadPlugin<T extends object>(name: string): Promise<T> {
  let p = cache.get(name) as Loaded<T> | undefined;
  if (!p) {
    p = import('@capacitor/core').then(({ registerPlugin }) => {
      const raw = registerPlugin<T>(name);
      return new Proxy({} as T, {
        get(_, prop) {
          if (prop === 'then') return undefined;
          return (raw as Record<string | symbol, unknown>)[prop];
        }
      });
    });
    cache.set(name, p);
  }
  return p;
}

// A native call that never answers (an old build without the method, a phone that drops the request) must not leave a
// button greyed out for ever: it fails with a message instead.
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms);
    work.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
