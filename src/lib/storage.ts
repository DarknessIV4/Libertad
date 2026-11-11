// localStorage wrapper that tolerates missing or broken storage.
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function loadList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// In the desktop app Chromium only writes localStorage to disk a few seconds later (or on a clean quit), so
// a killed app loses recent changes. After saving, ask the main process to write it out now. The short delay
// merges bursts (sliders, dragging) into one request.
let flushTimer: ReturnType<typeof setTimeout> | undefined;
function flushSoon(): void {
  const native = (globalThis as { mumh5Native?: { storage?: { flush?: () => Promise<void> } } }).mumh5Native;
  if (!native?.storage?.flush) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { native.storage!.flush!().catch(() => {}); }, 100);
}

export function save(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ return; }
  flushSoon();
}
