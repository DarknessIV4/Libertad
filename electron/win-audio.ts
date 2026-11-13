// Sound for screen sharing on Windows: everything playing on the system except this app.
// Chromium's own system capture ("loopback") records the whole mix, this app's voice chat and
// sounds included, so the people watching would hear the voice chat again. Windows can leave one
// process tree out of a capture (WASAPI process loopback, "exclude" mode); the native package
// loopback-capture does that and hands over 16-bit stereo 48 kHz PCM, which the page turns into
// an audio track.
import os from 'node:os';

// Excluding a process tree needs Windows 10/11 build 20348 or later
const MIN_BUILD = 20348;

interface Capture { startSystemAudio(cb: (chunk: Buffer) => void, excludeProcessId?: number): void; stop(): void }
interface Addon { LoopbackCapture: new () => Capture }

let addonP: Promise<Addon | null> | null = null;
function loadAddon(): Promise<Addon | null> {
  addonP ??= (async () => {
    try {
      // The name is not a literal, so a bundler leaves it alone and Node loads the package at run time
      const spec = 'loopback-capture';
      const mod: any = await import(spec);
      return (mod.default?.LoopbackCapture ? mod.default : mod) as Addon;
    } catch { return null; }
  })();
  return addonP;
}

export const windowsBuild = (release = os.release()): number => Number(release.split('.')[2]) || 0;

// Whether this system can capture everything except this app
export async function windowsExcludeSupported(): Promise<boolean> {
  if (process.platform !== 'win32' || windowsBuild() < MIN_BUILD) return false;
  return (await loadAddon()) !== null;
}

export class WindowsShareAudio {
  private capture: Capture | null = null;

  // Starts sending sound; this app's whole process tree (voice chat, sounds, embedded players) is left out
  async start(send: (chunk: Buffer) => void): Promise<void> {
    this.stop();
    const addon = await loadAddon();
    if (!addon) throw new Error('The sound capture module is not available.');
    const capture = new addon.LoopbackCapture();
    capture.startSystemAudio(chunk => { if (this.capture === capture) send(chunk); }, process.pid);
    this.capture = capture;
  }

  stop(): void {
    const capture = this.capture;
    this.capture = null;
    try { capture?.stop(); } catch { /* already stopped */ }
  }
}
