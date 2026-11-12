// Libertad used to be called mumh5. Settings, servers, nicknames and the rest live in localStorage under
// keys that began with the old name; copy each one to its new name once, if the new one does not exist yet.
// Imported first in main.ts so it runs before any store reads its key.
try {
  const old = 'mumh5';
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(old)) continue;
    const next = 'libertad' + key.slice(old.length);
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key)!);
  }
} catch { /* no storage: nothing to move */ }
