import { sessions } from './session.svelte.ts';
import { makeBanner } from './images.ts';
import { imageEditor } from './image-editor.svelte.ts';
import { desktop } from './native.ts';
import { ui } from './ui.svelte.ts';
import { type CardScope, type Slot } from '../core/banner.ts';

// A picture, GIF or video for any element (banner, card, profile card, avatar): always shared as a file and
// fetched over WebRTC. Returns what went wrong, or ''.
// keepShape: the picture was cropped by the person and must not be cut to the banner's shape again.
// scope: for the card background, whether it also covers the profile card (see core/banner.ts).
export async function setBannerFromFile(slot: Slot, file: File, opts: { keepShape?: boolean; scope?: CardScope } = {}): Promise<string> {
  try {
    const made = await makeBanner(file, !!opts.keepShape || slot === 'avatar');
    if (!made) return 'This file is not a picture, GIF or video this app can use.';
    const scope = slot === 'profile' ? opts.scope : undefined;
    await sessions.setBanner(slot, { kind: 'file', blob: made.blob, mime: made.mime, ...(scope && { scope }) });
    return '';
  } catch {
    return 'This file could not be read.';
  }
}

// A picture or GIF as the profile background, by the same steps as the profile card's "Use an image":
// the editor (crop, turn, darken, blur), where it goes (banner, under it, whole card), then applied.
// A GIF keeps its movement, also when it is changed in the editor (every frame is edited).
// Returns what went wrong, or ''.
export async function useAsProfileBackground(file: File): Promise<string> {
  const r = await imageEditor.open(file, { effects: true, scopes: true });
  if (!r) return '';
  const scope = r.scope ?? 'banner';
  // A picture the person did not change keeps the usual banner cut; a cropped one keeps its shape
  const keepShape = scope !== 'banner' || r.file !== file;
  return scope === 'banner'
    ? setBannerFromFile('banner', r.file, { keepShape })
    : setBannerFromFile('profile', r.file, { keepShape, scope });
}

// The picture or GIF behind an address from the chat as a file. GIPHY pictures are fetched by the app itself
// (the window cannot read other sites); data: and blob: pictures are read directly.
async function fileFromUrl(src: string): Promise<File> {
  let blob: Blob;
  if (desktop && /^https:\/\/media\d*\.giphy\.com\/media\//.test(src)) blob = new Blob([await desktop.gifFetch(src) as BlobPart]);
  else blob = await (await fetch(src)).blob();
  // The type the file says it is, else a GIF by its first bytes
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38;
  return new File([blob], isGif ? 'picture.gif' : 'picture', { type: isGif ? 'image/gif' : blob.type });
}

// A picture or GIF from the chat (the address of the <img> that was right-clicked) as the profile background,
// by the same steps. A problem is shown in a dialog.
export async function useUrlAsProfileBackground(src: string): Promise<void> {
  let problem = '';
  try { problem = await useAsProfileBackground(await fileFromUrl(src)); }
  catch { problem = 'This picture could not be loaded.'; }
  if (problem) ui.prompt = { title: 'Profile background', label: problem, confirm: 'OK', input: 'none', onsubmit: () => {} };
}

// A picture or GIF as the user card (the picture behind your tile), by the same steps as "Add user card...":
// the editor (crop, turn, darken, blur), then applied. Returns what went wrong, or ''.
export async function useAsUserCard(file: File): Promise<string> {
  const r = await imageEditor.open(file, { effects: true, scopes: false, title: 'Crop card background' });
  if (!r) return '';
  // A picture the person did not change keeps the usual cut; a cropped one keeps its shape
  return setBannerFromFile('card', r.file, { keepShape: r.file !== file });
}

export async function useUrlAsUserCard(src: string): Promise<void> {
  let problem = '';
  try { problem = await useAsUserCard(await fileFromUrl(src)); }
  catch { problem = 'This picture could not be loaded.'; }
  if (problem) ui.prompt = { title: 'User card', label: problem, confirm: 'OK', input: 'none', onsubmit: () => {} };
}

// Save a picture or GIF from the chat or the GIF menu to the computer
export function saveImage(src: string): void {
  if (desktop) { desktop.editAction('saveImage', src); return; }
  const a = document.createElement('a');
  a.href = src; a.download = ''; a.rel = 'noopener noreferrer';
  a.click();
}
