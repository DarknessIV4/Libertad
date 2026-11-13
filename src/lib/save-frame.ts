// "Save this frame": the picture on screen as a PNG, saved where this person picks (desktop app).
// Nothing is sent to the others.
import { desktop } from './native.ts';

// Where it can be saved: the desktop app has the Save dialog
export const canSaveFrame = (): boolean => !!desktop?.files?.saveFrame;
// The YouTube player lives in a frame of another origin: only the desktop app can read its picture
export const canSaveYoutubeFrame = (): boolean => canSaveFrame() && typeof desktop?.youtubeFrame === 'function';

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join('-');
};

let busy = false;

async function save(name: string, bytes: Uint8Array): Promise<void> {
  await desktop?.files.saveFrame(name, bytes);
}

// A plain <video>: a screen, a camera, a streamed file, a torrent. `at` names the file by the position in the video.
export async function saveVideoFrame(v: HTMLVideoElement | null | undefined, at = v?.currentTime ?? 0): Promise<void> {
  if (!v || !v.videoWidth || busy || !canSaveFrame()) return;
  busy = true;
  try {
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/png'));
    if (!blob) return;
    await save(`frame-${clock(at * 1000)}.png`, new Uint8Array(await blob.arrayBuffer()));
  } catch { /* a frame the browser will not let us read: nothing to save */ }
  finally { busy = false; }
}

// The YouTube player: its picture is read inside its own frame, at the size it plays
export async function saveYoutubeFrame(positionMs: number): Promise<void> {
  if (busy || !canSaveYoutubeFrame()) return;
  busy = true;
  try {
    const url = await desktop!.youtubeFrame(true);
    const m = url ? /^data:image\/(?:png|jpeg);base64,(.*)$/.exec(url) : null;
    if (!m) return;
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await save(`frame-${clock(positionMs)}.${url!.startsWith('data:image/png') ? 'png' : 'jpg'}`, bytes);
  } catch { /* the picture could not be read: nothing to save */ }
  finally { busy = false; }
}
