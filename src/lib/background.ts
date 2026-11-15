import { tick } from 'svelte';
import { desktop } from './native.ts';
import { ui } from './ui.svelte.ts';
import { drafts } from './drafts.ts';
import { files } from './files.svelte.ts';
import { sessions } from './session.svelte.ts';
import { voice } from './audio/voice.svelte.ts';

// Settings > System > Throttle when hidden. While the window is hidden or minimized the desktop app says so, and then:
//  - the main view is not drawn (App.svelte), which frees the pictures, GIFs, videos and blurred layers it held
//  - files announced in chat are not fetched by themselves, even under "download files up to"; they start when the window is back
// What carries on, because none of it needs the view: voice, the connection to the server, chat messages and files
// being added to the log, and other people's profile changes (their pictures are fetched as they arrive).
// What the page holds with nothing drawn (development logging): its JS heap, and the things that usually make it large
function stats(): Record<string, number> {
  const mb = (n: number) => Math.round(n / 1048576);
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  let entries = 0, chars = 0, profiles = 0;
  for (const s of sessions.list) {
    for (const log of Object.values(s.logs)) { entries += log.length; for (const e of log) chars += e.html.length; }
    profiles += Object.keys(s.profiles).length;
  }
  return { jsHeapUsedMB: heap ? mb(heap.usedJSHeapSize) : -1, jsHeapTotalMB: heap ? mb(heap.totalJSHeapSize) : -1, chatEntries: entries, chatHtmlMB: mb(chars * 2), profiles };
}

export function startBackground(): void {
  desktop?.onHidden(hidden => {
    if (hidden === ui.hidden) return;
    if (hidden) drafts.capture();
    ui.hidden = hidden;
    // Nothing is drawn: voice slows its meter and lets go of a microphone nobody can use (see voice.setHidden)
    voice.setHidden(hidden);
    if (!hidden) files.resume();
    // After the view has been taken down or drawn again (the main process logs it when running from npm run dev)
    void tick().then(() => {
      // The pictures and videos the view held are let go of now that no card shows them (they return from storage when drawn)
      if (hidden && ui.hidden) files.suspend();
      desktop?.reportHidden(hidden, hidden ? stats() : undefined);
    });
  });
}
