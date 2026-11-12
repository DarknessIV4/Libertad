import { getData, putData, getBlob, putBlob, deleteBlob } from './blobstore.ts';
import { load, save } from './storage.ts';
import { isBannerColor, isBannerImage, dataMime, MEDIA_MIME, type BannerView, type CardScope, type Slot } from '../core/banner.ts';

// Your own banner, card, profile card background or avatar: a color (not for the avatar) or a file (picture, GIF or
// video) that others fetch from this computer over WebRTC.
export type OwnBannerValue =
  | { kind: 'color'; color: string; scope?: CardScope }
  | { kind: 'image'; src: string; scope?: CardScope }
  | { kind: 'file'; blob: Blob; mime: string; url: string; scope?: CardScope };
export type OwnBannerInput =
  | { kind: 'color'; color: string; scope?: CardScope }
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
    return { meta: `libertad.${this.slot}`, image: `${this.slot}-image`, file: `${this.slot}-file` };
  }

  private async restore(): Promise<void> {
    const k = this.keys;
    const saved = load<{ kind: string; color: string; mime: string; scope?: string }>(k.meta, { kind: 'none', color: '', mime: '' });
    if (this.value) return;
    const scope = this.slot === 'profile' ? scopeOf(saved.scope) : undefined;
    const file = (blob: Blob, mime: string) => ({ kind: 'file' as const, blob, mime, url: URL.createObjectURL(new Blob([blob], { type: mime })), ...(scope && { scope }) });
    if (saved.kind === 'color' && isBannerColor(saved.color)) this.value = { kind: 'color', color: saved.color, ...(scope && { scope }) };
    else if (saved.kind === 'image') {
      // Older versions kept small pictures inline: they are files now, so they go over WebRTC like the rest
      const src = await getData<string>(k.image);
      if (!this.value && isBannerImage(src)) this.value = file(await (await fetch(src)).blob(), dataMime(src));
    } else if (saved.kind === 'file' && MEDIA_MIME.test(saved.mime)) {
      const blob = await getBlob(k.file);
      if (!this.value && blob) this.value = file(blob, saved.mime);
    } else if (this.slot === 'avatar') {
      // The picture older versions kept under the name 'avatar'
      const blob = await getBlob('avatar');
      const b = blob ? new Uint8Array(await blob.slice(0, 4).arrayBuffer()) : null;
      const mime = !b ? '' : b[0] === 0x89 ? 'image/png' : b[0] === 0xff ? 'image/jpeg' : b[0] === 0x47 ? 'image/gif' : b[0] === 0x52 ? 'image/webp' : '';
      if (blob && mime && !this.value) this.value = file(blob, mime);
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
    if (this.slot === 'avatar') await deleteBlob('avatar').catch(() => {});
    save(k.meta, { kind: b?.kind ?? 'none', color: b?.kind === 'color' ? b.color : '', mime: b?.kind === 'file' ? b.mime : '', scope: b ? b.scope ?? '' : '' });
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
export const ownAvatar = new OwnBanner('avatar');
export const OWN = { banner: ownBanner, card: ownCard, profile: ownProfile, avatar: ownAvatar } as const;

// What your tile shows behind you when it has no background of its own: your banner (the default), or the picture
// of your profile card background, when that one is the lower half ('under') or the whole card ('whole')
export type CardFrom = 'banner' | 'under' | 'whole';
const CARD_FROM = 'libertad.cardFrom';
class CardSource {
  from = $state<CardFrom>((() => { const v = load<{ from: string }>(CARD_FROM, { from: 'banner' }).from; return v === 'under' || v === 'whole' ? v : 'banner'; })());
  set(v: CardFrom): void { this.from = v; save(CARD_FROM, { from: v }); }
  // The profile card background to use for the tile, as it is stored (null: use the banner)
  value(): OwnBannerValue | null {
    if (this.from === 'banner') return null;
    const p = ownProfile.value;
    return p && p.kind !== 'color' && p.scope === this.from ? p : null;
  }
  view(): BannerView | null {
    if (!this.value()) return null;
    const v = ownProfile.view();
    // The tile draws the picture itself: no profile card scope
    return v && v.kind === 'image' ? { kind: 'image', src: v.src, mime: v.mime } : null;
  }
}
export const cardSource = new CardSource();
