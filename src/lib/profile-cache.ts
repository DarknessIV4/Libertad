// What this computer keeps of other people's profile backgrounds (banner and card), so they are not
// fetched again each time. One folder per person, named as the app names them: on the desktop
// userData/user-profiles/<name>/ with meta.json, banner and card; in a browser the same names in
// IndexedDB. The description's hash says whether anything changed since: when it is the same, the
// whole profile comes from here; when a picture's hash is the same, that picture does.
import { desktop } from './native.ts';
import { getData, putData, getBlob, putBlob, deleteBlob } from './blobstore.ts';
import { isBannerColor, MEDIA_MIME as MIME, SLOTS } from '../core/banner.ts';
import type { CardScope, Slot } from '../core/banner.ts';

export interface CachedSlot {
  kind: 'color' | 'image' | 'file';
  color?: string;  // kind color
  hash?: string;   // kind file: the picture's hash from its announcement
  mime?: string;   // kind image and file
  scope?: CardScope; // kind image and file, card background only
}
export interface CachedProfile {
  v: 1;
  commentHash: string; // hash of the description it was made from
  banner: CachedSlot | null;
  card: CachedSlot | null;
  profile?: CachedSlot | null;
  avatar?: CachedSlot | null;
}


function validSlot(v: unknown): CachedSlot | null {
  const s = v as Partial<CachedSlot> | null;
  if (!s || typeof s !== 'object') return null;
  if (s.kind === 'color') return isBannerColor(s.color) ? { kind: 'color', color: s.color } : null;
  if ((s.kind === 'image' || s.kind === 'file') && typeof s.mime === 'string' && MIME.test(s.mime)) {
    if (s.kind === 'file' && !(typeof s.hash === 'string' && /^[0-9a-f]{64}$/.test(s.hash))) return null;
    return { kind: s.kind, mime: s.mime, hash: s.hash, ...((s.scope === 'under' || s.scope === 'whole') && { scope: s.scope }) };
  }
  return null;
}

function validMeta(v: unknown): CachedProfile | null {
  const m = v as Partial<CachedProfile> | null;
  if (!m || typeof m !== 'object' || m.v !== 1 || typeof m.commentHash !== 'string') return null;
  return { v: 1, commentHash: m.commentHash, banner: validSlot(m.banner), card: validSlot(m.card), profile: validSlot(m.profile), avatar: validSlot(m.avatar) };
}

const key = (name: string, file: string) => `user-profiles/${name}/${file}`;

class ProfileCache {
  async read(name: string): Promise<CachedProfile | null> {
    try {
      if (desktop?.profiles) {
        const bytes = await desktop.profiles.read(name, 'meta.json');
        return bytes ? validMeta(JSON.parse(new TextDecoder().decode(bytes))) : null;
      }
      return validMeta(await getData<unknown>(key(name, 'meta.json')));
    } catch {
      return null;
    }
  }

  async readBlob(name: string, slot: Slot, mime: string): Promise<Blob | null> {
    try {
      if (desktop?.profiles) {
        const bytes = await desktop.profiles.read(name, slot);
        return bytes ? new Blob([bytes as BlobPart], { type: mime }) : null;
      }
      const blob = await getBlob(key(name, slot));
      return blob ? new Blob([blob], { type: mime }) : null;
    } catch {
      return null;
    }
  }

  // Someone changed their profile: what was kept of them no longer counts
  async forget(name: string): Promise<void> {
    try {
      if (desktop?.profiles) await desktop.profiles.write(name, 'meta.json', null);
      else await deleteBlob(key(name, 'meta.json'));
    } catch { /* nothing kept, or storage unavailable */ }
  }

  // The pictures go first, so a profile that is cut off halfway never looks complete
  async write(name: string, meta: CachedProfile, blobs: Partial<Record<Slot, Blob | null>>): Promise<void> {
    try {
      for (const slot of SLOTS) {
        const blob = blobs[slot];
        if (desktop?.profiles) await desktop.profiles.write(name, slot, blob ? new Uint8Array(await blob.arrayBuffer()) : null);
        else if (blob) await putBlob(key(name, slot), blob);
        else await deleteBlob(key(name, slot)).catch(() => {});
      }
      if (desktop?.profiles) await desktop.profiles.write(name, 'meta.json', new TextEncoder().encode(JSON.stringify(meta)));
      else await putData(key(name, 'meta.json'), meta);
    } catch { /* storage unavailable: the profile is simply fetched again next time */ }
  }
}

export const profileCache = new ProfileCache();
