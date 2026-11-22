// Keeps the camera alive in the background on Android. Since Android 11 an app that goes to the background loses the camera
// unless a foreground service of type "camera" is running (LibertadForegroundService, see android-service.ts). Cameras are
// opened by the page's own getUserMedia calls (share.svelte.ts, the share dialog), so instead of touching those this wraps
// getUserMedia: while at least one live video track from it exists, the service is told a camera is open.
//
// Only a necessary condition: whether the WebView then keeps delivering camera frames while the app is hidden is up to the
// WebView itself and has to be tried on a phone.

import type { ConnectionService } from './android-service.ts';

export function installAndroidCameraKeeper(serviceFor: () => Promise<ConnectionService>): void {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) return;
  const original = devices.getUserMedia.bind(devices);
  const open = new Set<MediaStreamTrack>();
  let chain: Promise<unknown> = Promise.resolve();
  let told = false;

  const update = () => {
    const want = open.size > 0;
    if (want === told) return;
    told = want;
    chain = chain
      .then(async () => (await serviceFor()).setCamera({ on: want }))
      .catch(e => { console.warn('[android] camera service:', e); });
  };
  const forget = (track: MediaStreamTrack) => { if (open.delete(track)) update(); };

  devices.getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    const stream = await original(constraints);
    if (constraints?.video) {
      for (const track of stream.getVideoTracks()) {
        open.add(track);
        const stop = track.stop.bind(track);
        track.stop = () => { stop(); forget(track); };
        track.addEventListener('ended', () => forget(track));
      }
      update();
    }
    return stream;
  };
}
