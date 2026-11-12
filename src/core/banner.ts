// A profile banner or card background: a color, or a small picture or GIF. Mumble has no field for it, so it travels
// inside the description (the comment) as an HTML comment, which every client keeps and none
// shows: <!--libertad:banner:c:#aabbcc--> or <!--libertad:banner:i:data:image/gif;base64,...-->
// Other Libertad clients read it back and show it on the profile card. The same goes for the card
// background, the picture behind someone's tile, as <!--libertad:card:...-->; without one the tile
// uses the banner.
//
// A picture or GIF too big to ride in the description is announced as a file instead
// (<!--libertad:banner:f:...-->, see core/file-transfer.ts) and fetched by whoever opens the card,
// straight from the owner's computer over WebRTC.
import { validMeta, type FileMeta } from './file-transfer.ts';

// The profile card's own background picture: 'under' the banner (the space below it) or the 'whole' card
// (banner included). Its own slot, <!--libertad:profile@under:...--> / profile@whole, apart from the tile's card background.
export type CardScope = 'under' | 'whole';

export type Banner =
  | { kind: 'color'; color: string; scope?: CardScope }           // a scope: the profile card's own color, under the banner or over all of it
  | { kind: 'image'; src: string; scope?: CardScope }          // a data: URI of a png, jpeg, gif or webp
  | { kind: 'file'; meta: FileMeta; scope?: CardScope };       // fetched from its owner

// What a card can draw. mime tells a GIF, which tiles show as its first frame only.
export type BannerView = { kind: 'color'; color: string; scope?: CardScope } | { kind: 'image'; src: string; mime: string; scope?: CardScope };

// banner: profile banner; card: user card in chat; profile: the profile card (scope under = under the banner, whole = full card); avatar: the picture
export type Slot = 'banner' | 'card' | 'profile' | 'avatar';
export const SLOTS: readonly Slot[] = ['banner', 'card', 'profile', 'avatar'];
// Pictures, GIFs and videos: every element accepts all three
export const MEDIA_MIME = /^(?:image\/(?:gif|png|jpeg|webp)|video\/(?:mp4|webm))$/;
export const isVideoMime = (m: string): boolean => m.startsWith('video/');

// The type of a data: URI
export const dataMime = (src: string): string => /^data:([^;,]+)/.exec(src)?.[1] ?? 'image/jpeg';


const COLOR = /^#[0-9a-f]{6}$/i;
const IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
// Nothing larger is read, whatever a server would pass along
export const MAX_BANNER_CHARS = 262144;

// Group 1: the scope (card only), group 2: the picture or color
const FIND: Record<Slot, RegExp> = { banner: /<!--libertad:banner()?:([^>]*)-->/, card: /<!--libertad:card()?:([^>]*)-->/, profile: /<!--libertad:profile(?:@(under|whole))?:([^>]*)-->/, avatar: /<!--libertad:avatar()?:([^>]*)-->/ };
const FIND_ALL = /<!--libertad:(?:banner|card|profile|avatar)(?:@[a-z]+)?:[^>]*-->/g;

// A short fingerprint of the banner and card background inside a description, to tell whether they changed
export function bannerSignature(comment: string): string {
  const tags = SLOTS.map(s => FIND[s].exec(comment)?.[0] ?? '').join('|');
  let h = 2166136261;
  for (let i = 0; i < tags.length; i++) { h ^= tags.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${tags.length}.${(h >>> 0).toString(36)}`;
}

export const isBannerColor = (v: unknown): v is string => typeof v === 'string' && COLOR.test(v);
export const isBannerImage = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_BANNER_CHARS && IMAGE.test(v);

export function encodeBanner(b: Banner, slot: Slot = 'banner'): string {
  const at = slot === 'profile' && b.scope ? `@${b.scope}` : '';
  if (b.kind === 'file') return `<!--libertad:${slot}${at}:f:${encodeURIComponent(JSON.stringify(b.meta)).replace(/-/g, '%2D')}-->`;
  return `<!--libertad:${slot}${at}:${b.kind === 'color' ? 'c:' + b.color.toLowerCase() : 'i:' + b.src}-->`;
}

// The banner in someone's description, if it has a valid one
export function parseBanner(comment: string | null | undefined, slot: Slot = 'banner'): Banner | null {
  if (!comment) return null;
  const m = FIND[slot].exec(comment);
  if (!m) return null;
  const body = m[2];
  const scope = (m[1] as CardScope | undefined) || undefined;
  if (body.startsWith('c:') && isBannerColor(body.slice(2))) return { kind: 'color', color: body.slice(2).toLowerCase(), ...(scope && { scope }) };
  if (body.startsWith('i:') && isBannerImage(body.slice(2))) return { kind: 'image', src: body.slice(2), ...(scope && { scope }) };
  if (body.startsWith('f:') && body.length < 2000) {
    try {
      const meta = validMeta(JSON.parse(decodeURIComponent(body.slice(2))));
      if (meta && MEDIA_MIME.test(meta.m)) return { kind: 'file', meta, ...(scope && { scope }) };
    } catch { /* not ours */ }
  }
  return null;
}

// The description without the banner, for showing and editing
export const stripBanner = (comment: string): string => comment.replace(FIND_ALL, '');

// The description carrying these (none: carrying none)
export const withBanners = (comment: string, b: Record<Slot, Banner | null>): string =>
  SLOTS.map(s => (b[s] ? encodeBanner(b[s]!, s) : '')).join('') + stripBanner(comment);

export function sameBanner(a: Banner | null, b: Banner | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'color') return b.kind === 'color' && a.color.toLowerCase() === b.color.toLowerCase() && a.scope === b.scope;
  if (a.kind === 'image') return b.kind === 'image' && a.src === b.src && a.scope === b.scope;
  return b.kind === 'file' && a.meta.i === b.meta.i && a.meta.h === b.meta.h && a.scope === b.scope;
}

