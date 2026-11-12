// Watch Together file streaming state - reactive for UI
import { SvelteMap } from 'svelte/reactivity';
import type { Session } from './session.svelte.ts';
import type { FileWatcher, FileStreamer } from '../core/watch-stream.ts';
import { NO_CAP, type ViewerCap } from './stream-quality.ts';

export { type FileWatcher, type FileStreamer } from '../core/watch-stream.ts';

export class WatchFileStreamState {
  watchers = $state<SvelteMap<Session, FileWatcher[]>>(new SvelteMap());
  streamers = $state<SvelteMap<Session, FileStreamer>>(new SvelteMap());
  // What we asked of the hosts' streams we watch, by host session (shown by the stream's menu)
  quality = $state<Record<number, ViewerCap>>({});

  qualityOf(hostSession: number): ViewerCap {
    return this.quality[hostSession] ?? NO_CAP;
  }

  setQuality(hostSession: number, cap: ViewerCap | null): void {
    if (cap) { this.quality = { ...this.quality, [hostSession]: cap }; return; }
    if (hostSession in this.quality) { const { [hostSession]: _gone, ...rest } = this.quality; this.quality = rest; }
  }

  watchersOf(s: Session): FileWatcher[] {
    return this.watchers.get(s) ?? [];
  }

  setWatchers(s: Session, ws: FileWatcher[]): void {
    this.watchers.set(s, ws);
  }

  streamerOf(s: Session): FileStreamer | undefined {
    return this.streamers.get(s);
  }

  setStreamer(s: Session, streamer: FileStreamer | undefined): void {
    if (streamer) {
      this.streamers.set(s, streamer);
    } else {
      this.streamers.delete(s);
    }
  }
}

export const watchFileStreamState = new WatchFileStreamState();