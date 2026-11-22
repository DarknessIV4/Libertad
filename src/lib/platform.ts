// Which app this is. Capacitor puts `window.Capacitor` in the page before any script runs, so this can be asked at
// module load (the settings defaults do). Without Capacitor (desktop, a browser) it is false and nothing else is loaded.
export const isAndroid = (): boolean =>
  (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android';
