import { store } from './settings.svelte.ts';
import { identities } from './identities.svelte.ts';
import { OWN } from './banner.svelte.ts';
import { isVideoMime } from '../core/banner.ts';
import type { User } from '../core/client.ts';

// You before any server: no session exists, so the profile card is opened for this made-up one
export const OFFLINE_SESSION = -1;

// The name you would connect with: the one chosen for your identity, else the identity's own, else your last server's
export function offlineName(): string {
  const id = identities.default?.id ?? '';
  return store.identityNames[id] || identities.default?.name || store.servers.at(-1)?.username || 'You';
}

// Your picture from this device (a video carries #video, as in session.avatar)
export function offlineAvatar(): string | null {
  const v = OWN.avatar.view();
  return v?.kind === 'image' ? v.src + (isVideoMime(v.mime) ? '#video' : '') : null;
}

// Just enough of a user for the card to draw
export function offlineUser(): User {
  return {
    session: OFFLINE_SESSION, name: offlineName(), userId: null, channelId: 0,
    mute: false, deaf: false, suppress: false, selfMute: false, selfDeaf: false, prioritySpeaker: false, recording: false,
    comment: '', commentHash: null, texture: null, textureHash: null, hash: ''
  };
}
