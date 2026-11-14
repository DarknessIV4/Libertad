import { sessions } from './session.svelte.ts';
import { makeBanner } from './images.ts';
import { imageEditor } from './image-editor.svelte.ts';
import { desktop } from './native.ts';
import { ui } from './ui.svelte.ts';
import type { MenuItem } from './menu.svelte.ts';
import { cropBackground, applyCropped } from './custom-bg-actions.ts';
import { EDITABLE_OR_GIF } from './image-editor.svelte.ts';
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

// A downloaded picture in the chat is a blob: address. Read it with fetch, and if the page's rules block that,
// draw it from an <img> (a GIF loses its movement on that path, the plain picture is kept).
async function blobFromLocalUrl(src: string): Promise<Blob> {
  try { return await (await fetch(src)).blob(); } catch { /* fall back below */ }
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return await new Promise<Blob>((ok, no) => c.toBlob(b => (b ? ok(b) : no(new Error('encode'))), 'image/png'));
}

// The picture or GIF behind an address from the chat as a file. GIPHY pictures are fetched by the app itself
// (the window cannot read other sites); data: and blob: pictures are read directly.
async function fileFromUrl(src: string): Promise<File> {
  let blob: Blob;
  if (desktop && /^https:\/\/media\d*\.giphy\.com\/media\//.test(src)) blob = new Blob([await desktop.gifFetch(src) as BlobPart]);
  else if (src.startsWith('blob:') || src.startsWith('data:')) blob = await blobFromLocalUrl(src);
  else blob = await (await fetch(src)).blob();
  // The type the file says it is, else a GIF by its first bytes
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38;
  return new File([blob], isGif ? 'picture.gif' : 'picture', { type: isGif ? 'image/gif' : blob.type });
}

// A picture or GIF as the user card (the picture behind your tile), by the same steps as "Add user card...":
// the editor (crop, turn, darken, blur), then applied. Returns what went wrong, or ''.
export async function useAsUserCard(file: File): Promise<string> {
  const r = await imageEditor.open(file, { effects: true, scopes: false, title: 'Crop card background' });
  if (!r) return '';
  // A picture the person did not change keeps the usual cut; a cropped one keeps its shape
  return setBannerFromFile('card', r.file, { keepShape: r.file !== file });
}

// A picture or GIF as your avatar: cropped square in the editor, then applied. Returns what went wrong, or ''.
export async function useAsAvatar(file: File): Promise<string> {
  let picked = file;
  if (EDITABLE_OR_GIF.test(file.type)) {
    const r = await imageEditor.open(file, { effects: false, scopes: false, square: true, title: 'Crop picture' });
    if (!r) return '';
    picked = r.file;
  }
  return setBannerFromFile('avatar', picked, { keepShape: true });
}

// A picture, GIF or video as the app background (all three panels) or the login background (the screen before a
// server is entered): the editor asks which one, with a preview of each beside the crop. Returns what went wrong, or ''.
export async function useAsAppBackground(file: File): Promise<string> {
  const f = await cropBackground(file, { target: true });
  return f ? applyCropped(f) : '';
}

// The picture entries of a right-click menu, for any picture or GIF: `get` gives the file (a chat address,
// a GIPHY GIF). A problem is shown in a dialog.
export function pictureItems(get: () => Promise<File>): MenuItem[] {
  const run = (title: string, use: (f: File) => Promise<string>) => async () => {
    let problem = '';
    try { problem = await use(await get()); }
    catch { problem = 'This picture could not be loaded.'; }
    if (problem) ui.prompt = { title, label: problem, confirm: 'OK', input: 'none', onsubmit: () => {} };
  };
  return [
    { label: 'Set as profile background', action: run('Profile background', useAsProfileBackground) },
    { label: 'Set as user card', action: run('User card', useAsUserCard) },
    { label: 'Set as avatar', action: run('Avatar', useAsAvatar) },
    { label: 'Set as app background', action: run('App background', useAsAppBackground) }
  ];
}
export const urlPictureItems = (src: string): MenuItem[] => pictureItems(() => fileFromUrl(src));

// Save a picture or GIF from the chat or the GIF menu to the computer
export function saveImage(src: string): void {
  if (desktop) { desktop.editAction('saveImage', src); return; }
  const a = document.createElement('a');
  a.href = src; a.download = ''; a.rel = 'noopener noreferrer';
  a.click();
}
