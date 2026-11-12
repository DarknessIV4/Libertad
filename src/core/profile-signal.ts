// "My profile changed" ping. When someone changes their banner, card background or description, they send this
// to everyone else on the server, who forget what they kept of that person and look again. Murmur only tells
// people the new description's hash (and text, for short ones); this makes sure nobody keeps showing the old one.
// Carried as Mumble plugin data like the other Libertad signals; clients that do not know it ignore it.
export const PROFILE_DATA_ID = 'libertad.profile';

const VERSION = 1;

// Second byte says what changed: 0 (or missing, from older clients) the banner/description, 1 the picture
export const encodeProfilePing = (avatar = false): Uint8Array => new Uint8Array([VERSION, avatar ? 1 : 0]);
export const isProfilePing = (data: Uint8Array): boolean => data.length >= 1 && data[0] === VERSION;
export const isAvatarPing = (data: Uint8Array): boolean => data.length >= 2 && data[1] === 1;
