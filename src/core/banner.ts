// A profile banner or card background: a color, or a small picture or GIF. Mumble has no field for it, so it travels
// inside the description (the comment) as an HTML comment, which every client keeps and none
// shows: <!--mumh5:banner:c:#aabbcc--> or <!--mumh5:banner:i:data:image/gif;base64,...-->
// Other mumh5 clients read it back and show it on the profile card. The same goes for the card
// background, the picture behind someone's tile, as <!--mumh5:card:...-->; without one the tile
// uses the banner.
//
// A picture or GIF too big to ride in the description is announced as a file instead
// (<!--mumh5:banner:f:...-->, see core/file-transfer.ts) and fetched by whoever opens the card,
// straight from the owner's computer over WebRTC.
import { validMeta, type FileMeta } from './file-transfer.ts';

export type Banner =
  | { kind: 'color'; color: string }
  | { kind: 'image'; src: string }          // a data: URI of a png, jpeg, gif or webp
  | { kind: 'file'; meta: FileMeta };       // fetched from its owner

// What a card can draw. mime tells a GIF, which tiles show as its first frame only.
export type BannerView = { kind: 'color'; color: string } | { kind: 'image'; src: string; mime: string };

export type Slot = 'banner' | 'card';

// The type of a data: URI
export const dataMime = (src: string): string => /^data:([^;,]+)/.exec(src)?.[1] ?? 'image/jpeg';

const FILE_TYPE = /^image\/(?:gif|png|jpeg|webp)$/;

const COLOR = /^#[0-9a-f]{6}$/i;
const IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
// Nothing larger is read, whatever a server would pass along
export const MAX_BANNER_CHARS = 262144;

const FIND: Record<Slot, RegExp> = { banner: /<!--mumh5:banner:([^>]*)-->/, card: /<!--mumh5:card:([^>]*)-->/ };
const FIND_ALL = /<!--mumh5:(?:banner|card):[^>]*-->/g;

// A short fingerprint of the banner and card background inside a description, to tell whether they changed
export function bannerSignature(comment: string): string {
  const tags = (FIND.banner.exec(comment)?.[0] ?? '') + '|' + (FIND.card.exec(comment)?.[0] ?? '');
  let h = 2166136261;
  for (let i = 0; i < tags.length; i++) { h ^= tags.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${tags.length}.${(h >>> 0).toString(36)}`;
}

export const isBannerColor = (v: unknown): v is string => typeof v === 'string' && COLOR.test(v);
export const isBannerImage = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_BANNER_CHARS && IMAGE.test(v);

export function encodeBanner(b: Banner, slot: Slot = 'banner'): string {
  if (b.kind === 'file') return `<!--mumh5:${slot}:f:${encodeURIComponent(JSON.stringify(b.meta)).replace(/-/g, '%2D')}-->`;
  return `<!--mumh5:${slot}:${b.kind === 'color' ? 'c:' + b.color.toLowerCase() : 'i:' + b.src}-->`;
}

// The banner in someone's description, if it has a valid one
export function parseBanner(comment: string | null | undefined, slot: Slot = 'banner'): Banner | null {
  if (!comment) return null;
  const m = FIND[slot].exec(comment);
  if (!m) return null;
  const body = m[1];
  if (body.startsWith('c:') && isBannerColor(body.slice(2))) return { kind: 'color', color: body.slice(2).toLowerCase() };
  if (body.startsWith('i:') && isBannerImage(body.slice(2))) return { kind: 'image', src: body.slice(2) };
  if (body.startsWith('f:') && body.length < 2000) {
    try {
      const meta = validMeta(JSON.parse(decodeURIComponent(body.slice(2))));
      if (meta && FILE_TYPE.test(meta.m)) return { kind: 'file', meta };
    } catch { /* not ours */ }
  }
  return null;
}

// The description without the banner, for showing and editing
export const stripBanner = (comment: string): string => comment.replace(FIND_ALL, '');

// The description carrying these (none: carrying none)
export const withBanners = (comment: string, b: { banner: Banner | null; card: Banner | null }): string =>
  (b.banner ? encodeBanner(b.banner, 'banner') : '') + (b.card ? encodeBanner(b.card, 'card') : '') + stripBanner(comment);

export function sameBanner(a: Banner | null, b: Banner | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'color') return b.kind === 'color' && a.color.toLowerCase() === b.color.toLowerCase();
  if (a.kind === 'image') return b.kind === 'image' && a.src === b.src;
  return b.kind === 'file' && a.meta.i === b.meta.i && a.meta.h === b.meta.h;
}

// How many bytes of picture fit, leaving room for a description, in a server that takes
// messages up to limit characters (0: no limit). Base64 makes the picture a third larger.
export const RESERVED_FOR_TEXT = 16000;
export function bannerBudget(limit: number): number {
  const cap = limit > 0 ? Math.min(limit, 131072) : 131072;
  return Math.max(0, Math.floor((cap - RESERVED_FOR_TEXT - 40) * 3 / 4));
}
