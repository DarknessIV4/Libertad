import { getData, putData, getBlob, putBlob, deleteBlob } from './blobstore.ts';
import { load, save } from './storage.ts';
import { isBannerColor, isBannerImage, dataMime, type BannerView, type CardScope, type Slot } from '../core/banner.ts';

// Your own banner or card background: a color, a small picture that rides in your description, or
// a file (a GIF or picture too big for that) that others fetch from this computer over WebRTC.
export type OwnBannerValue =
  | { kind: 'color'; color: string }
  | { kind: 'image'; src: string; scope?: CardScope }
  | { kind: 'file'; blob: Blob; mime: string; url: string; scope?: CardScope };
export type OwnBannerInput =
  | { kind: 'color'; color: string }
  | { kind: 'image'; src: string; scope?: CardScope }
  | { kind: 'file'; blob: Blob; mime: string; scope?: CardScope };

const scopeOf = (v: unknown): CardScope | undefined => (v === 'under' || v === 'whole' ? v : undefined);

// Kept on this device and put into your description on each server you connect to
class OwnBanner {
  value = $state.raw<OwnBannerValue | null>(null);
  readonly loaded: Promise<void>;
  private slot: Slot;

  constructor(slot: Slot) {
    this.slot = slot;
    this.loaded = this.restore().catch(() => {});
  }

  private get keys() {
    return this.slot === 'banner'
      ? { meta: 'mumh5.banner', image: 'banner-image', file: 'banner-file' }
      : this.slot === 'profile'
        ? { meta: 'mumh5.profile', image: 'profile-image', file: 'profile-file' }
        : { meta: 'mumh5.card', image: 'card-image', file: 'card-file' };
  }

  private async restore(): Promise<void> {
    const k = this.keys;
    const saved = load<{ kind: string; color: string; mime: string; scope?: string }>(k.meta, { kind: 'none', color: '', mime: '' });
    if (this.value) return;
    const scope = this.slot === 'profile' ? scopeOf(saved.scope) : undefined;
    if (saved.kind === 'color' && isBannerColor(saved.color)) this.value = { kind: 'color', color: saved.color };
    else if (saved.kind === 'image') {
      const src = await getData<string>(k.image);
      if (!this.value && isBannerImage(src)) this.value = { kind: 'image', src, ...(scope && { scope }) };
    } else if (saved.kind === 'file' && /^image\/(gif|png|jpeg|webp)$/.test(saved.mime)) {
      const blob = await getBlob(k.file);
      if (!this.value && blob) this.value = { kind: 'file', blob, mime: saved.mime, url: URL.createObjectURL(new Blob([blob], { type: saved.mime })), ...(scope && { scope }) };
    }
  }

  // What the card draws for you
  view(): BannerView | null {
    const v = this.value;
    if (!v) return null;
    if (v.kind === 'file') return { kind: 'image', src: v.url, mime: v.mime, ...(v.scope && { scope: v.scope }) };
    if (v.kind === 'image') return { kind: 'image', src: v.src, mime: dataMime(v.src), ...(v.scope && { scope: v.scope }) };
    return v;
  }

  async set(b: OwnBannerInput | null): Promise<void> {
    const k = this.keys;
    save(k.meta, { kind: b?.kind ?? 'none', color: b?.kind === 'color' ? b.color : '', mime: b?.kind === 'file' ? b.mime : '', scope: b && b.kind !== 'color' ? b.scope ?? '' : '' });
    if (b?.kind === 'image') await putData(k.image, b.src);
    else await deleteBlob(k.image).catch(() => {});
    if (b?.kind === 'file') await putBlob(k.file, b.blob);
    else await deleteBlob(k.file).catch(() => {});
    const old = this.value;
    if (old?.kind === 'file') URL.revokeObjectURL(old.url);
    this.value = b?.kind === 'file' ? { ...b, url: URL.createObjectURL(new Blob([b.blob], { type: b.mime })) } : b;
  }
}

export const ownBanner = new OwnBanner('banner');
export const ownCard = new OwnBanner('card');
export const ownProfile = new OwnBanner('profile');
export const OWN = { banner: ownBanner, card: ownCard, profile: ownProfile } as const;
