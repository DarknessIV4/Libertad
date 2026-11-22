// The page's handle on the Android connection service (mobile/android/templates/*.java): a foreground service that keeps
// the app, and the nodejs-mobile backend inside it, running while a Mumble server is connected. Without it Android freezes
// a backgrounded app within minutes and the connection drops.
//
// It is a small Capacitor plugin of this app ("LibertadService"), added to the Android project by
// mobile/android/apply.mjs. Only loaded on Android: the desktop and web builds never touch it.

import { loadPlugin, withTimeout } from './capacitor-plugin.ts';

// What full screen ended up as: whether the status bar still shows, whether the older way had to be used, and how far the page
// starts from the top-left corner of the screen (both 0 when the picture really fills it, notch included)
export interface ImmersiveResult { statusBarVisible?: boolean; legacy?: boolean; offsetTop?: number; offsetLeft?: number }

export interface ConnectionService {
  // Starts the service, or updates its notification when it runs already. The first start asks for the microphone
  // (and notifications on Android 13+); with no microphone permission it still runs, for listening only.
  start(options: { title?: string; text: string; speaker?: boolean }): Promise<{ microphone: boolean }>;
  stop(): Promise<void>;
  // Loudspeaker (true) or earpiece / headset (false). A connected headset or Bluetooth device is never overridden.
  setSpeakerphone(options: { on: boolean }): Promise<void>;
  // A camera is open in the page: lets Android keep it going in the background (no effect when no server is connected)
  setCamera(options: { on: boolean }): Promise<void>;
  // Full screen: the status and navigation bars hidden (a swipe from the edge shows them for a moment), and the phone turned to
  // landscape when asked. Off: the bars and the rotation as they were.
  // Going to full screen answers whether the status bar is still showing after all that (and whether the older way was needed)
  setImmersive(options: { on: boolean; landscape?: boolean }): Promise<ImmersiveResult>;
  // The phone and this install: Android version, the maker and model, when this app was installed
  diagnose(): Promise<{ sdk: number; release: string; device: string; installedAt?: number; targetSdk?: number; webview?: string; cutoutTop?: number; cutoutSide?: number }>;
  // One of Android's settings pages for this app: battery (set Libertad to unrestricted), notifications, or the app's details
  openSettings(options: { what: 'battery' | 'notifications' | 'app' }): Promise<{ page?: string } | void>;
}

export function capacitorConnectionService(): Promise<ConnectionService> {
  return loadPlugin<ConnectionService>('LibertadService');
}

// Full screen of a picture on Android (no effect anywhere else)
export async function setAndroidImmersive(on: boolean, landscape = false): Promise<ImmersiveResult> {
  if ((globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() !== 'android') return {};
  // Never left waiting: full screen is a few hundred ms of work on the phone
  return (await withTimeout((await capacitorConnectionService()).setImmersive({ on, landscape }), 6000, 'The phone')) ?? {};
}

// What to tell the person when full screen left the status bar showing ('' when it did not)
export const immersiveProblem = (r: ImmersiveResult | null | undefined): string =>
  r?.statusBarVisible ? 'This phone kept its status bar visible in full screen. Settings, System, "Test full screen" shows what it says.' : '';

// The loudspeaker / earpiece choice, kept on this phone (the Android tab in Settings). Loudspeaker unless chosen otherwise.
const SPEAKER_KEY = 'libertad.android.loudspeaker';
export const speakerPref = {
  get(): boolean { try { return localStorage.getItem(SPEAKER_KEY) !== '0'; } catch { return true; } },
  set(on: boolean): void { try { localStorage.setItem(SPEAKER_KEY, on ? '1' : '0'); } catch { /* not kept */ } }
};

// Follows the set of connections that are up: the service runs while there is at least one. The calls are made one
// at a time, in order, and a failure never reaches the connection (it is logged: the app still works, in the foreground).
export function createKeepAlive(serviceFor: () => Promise<ConnectionService>) {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    update(labels: string[]): void {
      chain = chain
        .then(async () => {
          const service = await serviceFor();
          if (!labels.length) await service.stop();
          else await service.start({ title: 'Libertad', speaker: speakerPref.get(), text: labels.length === 1 ? `Connected to ${labels[0]}` : `Connected to ${labels.length} servers` });
        })
        .catch(e => { console.warn('[android] connection service:', e); });
    }
  };
}
