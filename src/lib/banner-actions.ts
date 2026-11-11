import { session, sessions } from './session.svelte.ts';
import { makeBanner } from './images.ts';
import { bannerBudget, type Slot } from '../core/banner.ts';

// A picture or GIF as the banner or the card background. Small enough for the description, it goes in
// there; a larger one is shared as a file and fetched over WebRTC. Returns what went wrong, or ''.
export async function setBannerFromFile(slot: Slot, file: File): Promise<string> {
  try {
    const made = await makeBanner(file, bannerBudget(session.htmlLimit));
    if (!made) return 'This file could not be read as a picture.';
    if ('src' in made) await sessions.setBanner(slot, { kind: 'image', src: made.src });
    else await sessions.setBanner(slot, { kind: 'file', blob: made.blob, mime: made.mime });
    return '';
  } catch {
    return 'This file could not be read as a picture.';
  }
}
