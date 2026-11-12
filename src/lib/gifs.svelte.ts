// GIF search (GIPHY's website, through the desktop app) and the recent and favourite lists, kept locally.
import { load, save } from './storage.ts';
import { desktop } from './native.ts';

export interface Gif { id: string; preview: string; url: string }

const MAX_RECENT = 30;
const list = (key: string): Gif[] => load<{ list: Gif[] }>(key, { list: [] }).list.filter(g => g.id && g.url);

class GifStore {
  recent = $state<Gif[]>(list('libertad.gifRecent'));
  favs = $state<Gif[]>(list('libertad.gifFavs'));

  isFav = (g: Gif) => this.favs.some(f => f.id === g.id);

  toggleFav(g: Gif) {
    this.favs = this.isFav(g) ? this.favs.filter(f => f.id !== g.id) : [g, ...this.favs];
    save('libertad.gifFavs', { list: $state.snapshot(this.favs) });
  }

  removeRecent(g: Gif) {
    this.recent = this.recent.filter(r => r.id !== g.id);
    save('libertad.gifRecent', { list: $state.snapshot(this.recent) });
  }

  clearRecent() {
    this.recent = [];
    save('libertad.gifRecent', { list: [] });
  }

  used(g: Gif) {
    this.recent = [g, ...this.recent.filter(r => r.id !== g.id)].slice(0, MAX_RECENT);
    save('libertad.gifRecent', { list: $state.snapshot(this.recent) });
  }
}

export const gifs = new GifStore();

// Page 0 is the search; each next page is more related GIFs, until `more` is false
export async function searchGifs(q: string, page = 0): Promise<{ gifs: Gif[]; more: boolean }> {
  if (!desktop) throw new Error('GIF search needs the desktop app');
  if (!q.trim()) return { gifs: [], more: false };
  return desktop.gifSearch(q, page);
}

// The GIF itself, as a file the picture editor and the banner code can take
export async function gifFile(g: Gif): Promise<File> {
  if (!desktop) throw new Error('This needs the desktop app');
  const bytes = await desktop.gifFetch(g.url);
  return new File([bytes], `${g.id}.gif`, { type: 'image/gif' });
}
