# Libertad for Android: Mumble backend

The Android app is the same Svelte page in a **Capacitor** WebView, plus a Node backend running inside **nodejs-mobile**
(started by the `capacitor-nodejs` plugin). This folder is the first part: **Mumble server support only**.

```
page (Capacitor WebView)                      backend (nodejs-mobile, Node 18)
src/core/client.ts  (Mumble protocol)         mobile/nodejs/src/main.ts
src/lib/native-android.ts  ── JSON channel ── connections.ts  → electron/tls-transport.ts, udp-voice.ts, ocb2.ts
                                              identities.ts   → electron/identity-store.ts
                                              (also certs.ts, publist.ts: pings, public list)
```

The backend reuses the desktop modules in `electron/` as they are (they only use Node), so a fix there reaches both apps.
Nothing from Electron is involved.

## Files

| File | What |
|---|---|
| `capacitor.config.ts` | Capacitor + capacitor-nodejs settings (`webDir: dist-android`, `nodeDir: nodejs`) |
| `mobile/nodejs/src/*` | the backend: channel, connections (TLS + UDP voice), identities, calls |
| `mobile/shared/protocol.ts` | message names/types shared by page and backend |
| `mobile/scripts/build-node.mjs` | esbuild bundle → `dist-android/nodejs/index.js` (target node18) |
| `mobile/test/backend.test.ts` | end-to-end test against a mock Mumble server |
| `src/lib/native-android.ts` | page side: `PlatformApi` + `Transport` backed by the backend |
| `src/lib/android-service.ts` | page side of the foreground service (start while connected, stop after) |
| `mobile/android/templates/*.java` | `LibertadForegroundService` + `LibertadServicePlugin` (Capacitor plugin) |
| `src/lib/android-capture.ts` | `getDisplayMedia` for Android: native screen encoder in, canvas video track out |
| `mobile/android/templates/LibertadCapture*.java` | MediaProjection + MediaCodec service and its Capacitor plugin |
| `src/lib/android-pip.ts` | picture-in-picture, page side: which picture is on screen, and the app reduced to just it in the small window |
| `mobile/android/templates/LibertadPipPlugin.java` | picture-in-picture, native side (the activity enters the small window) |
| `mobile/android/apply.mjs` | adds them to `android/`: classes, manifest, `MainActivity` (safe to re-run) |

## Setup

The zip already contains the edited `package.json` (Capacitor dependencies and the scripts below) and the edited
`src/lib/native.ts` (the hook-up). Unzip it over the project root, then:

```sh
npm install                 # also downloads the plugin tarball into node_modules/capacitor-nodejs; nothing to place by hand
npx cap add android         # once: makes android/
npm run build:android       # page + Node backend + native files into android/, then Gradle: release/Libertad-<version>-android.apk
npx cap run android         # optional: install and run on a phone or emulator (or `npx cap open android` for Android Studio)
```

`build:android` needs **JDK 21** in `JAVA_HOME` and stops with a message if the shell uses another Java. `npm run android:prepare`
does only the first part (no Gradle).

`capacitor-nodejs` is NOT the npm package of that name (an unrelated old one). It is a GitHub release, referenced in
`package.json` by this link, which npm downloads on `npm install`:
https://github.com/hampoelz/capacitor-nodejs/releases/download/v1.0.0-beta.10/capacitor-nodejs.tgz
(source and docs: https://github.com/hampoelz/Capacitor-NodeJS). `npx cap sync` links it into `android/` by itself.
Node's own `require('bridge')` is provided by the runtime inside the app, so there is nothing to install for it.

Scripts added: `build:android` (everything, ends with the APK), `android:prepare` (everything except Gradle), `android:setup` (only the service step), `test:mobile`, `check:mobile`.

## The hook-up (already done in `src/lib/native.ts`; for reference)

```ts
// 1. with the other imports
import { androidPlatform, androidTransport } from './native-android.ts';

// 2. in interface PlatformApi, next to pingServer
publicServers(url: string): Promise<PublicServer[]>;

// 3.
export const native: PlatformApi | null = desktop ?? androidPlatform();

// 4. in openTransport
return desktop ? new ElectronTransport(desktop, host, port, identityId) : androidTransport(host, port, identityId);
```

`desktop` stays `null` on Android, exactly as in a browser, so every desktop-only feature stays off. Connecting,
identities, server pings and `UserInfoDialog` go through `native`/`openTransport` and now work.

## Rooms interface by default on Android

The app has two interfaces (Settings → Appearance): Standard, and Rooms, which shows one screen at a time and was made for
phones. `settings.svelte.ts` starts the interface as Rooms when `isAndroid()` (`src/lib/platform.ts`, true only inside the
Capacitor Android app) and as Standard everywhere else. It is only a default: a choice the user makes is saved and wins,
and desktop is unchanged.

## Optional: "Browse public servers" on Android

`Home.svelte` and `ServerRail.svelte`: import `native` too (`import { desktop, native } from '../lib/native.ts'`) and change the
Browse button's `{#if desktop}` to `{#if native}`. `PublicServers.svelte`: `import { desktop as native, ...` → `import { native, ...`.

## Background connection (foreground service)

Android freezes a backgrounded app within minutes, which stops Node and drops the server. While at least one Mumble
server is connected, `native-android.ts` starts `LibertadForegroundService`, and stops it when the last one closes
(nothing to wire in the UI). It also updates the notification ("Connected to host" / "Connected to 2 servers").

- **Type:** `microphone` when RECORD_AUDIO is granted (the microphone keeps working in the background), otherwise `specialUse`
  (listening only). The first connection asks for the microphone, then for notifications on Android 13+. Denying either
  still connects.
- **Holds** a partial wake lock and a Wi-Fi lock for the keepalives and voice, and puts audio in communication mode
  (loudspeaker by default; a headset or Bluetooth device in use is never overridden). `setAndroidSpeakerphone(on)` from
  `native-android.ts` switches loudspeaker/earpiece; no button uses it yet.
- **Swiping the app away** stops the service. If Android kills the process the connections are gone and nothing restarts them.
- **Google Play:** `specialUse` needs a declaration in the Play Console (the manifest carries the subtype text). Sideloaded
  builds are unaffected.
- The notification icon is a system one; add a monochrome `res/drawable/ic_stat_libertad` and use it in
  `LibertadForegroundService.buildNotification`.

`apply.mjs` takes the package from `android/app/build.gradle`'s `namespace`, so it follows the appId. It refuses to
rewrite a `MainActivity.java` you have changed; add `registerPlugin(LibertadServicePlugin.class);` before `super.onCreate(...)` yourself then.

## App icon

`mobile/android/icons/` holds the launcher icons (old, round, adaptive foreground, background colour), drawn from the same 32x32
pixel art as `scripts/make-icon.py` (as it is set, black and white). `apply.mjs` copies them over Capacitor's default icon on every
`npm run build:android`. To change the icon, change the PNGs there; to redo them from a changed `make-icon.py`, regenerate the
icon and scale it to 48/72/96/144/192 px (`ic_launcher`, `ic_launcher_round`) and 108/162/216/324/432 px (`ic_launcher_foreground`,
the art at 70% on the background colour).

## Settings → System on Android

`src/ui/AndroidSystem.svelte` (shown by `SettingsDialog.svelte` on Android only; the desktop System tab is unchanged): loudspeaker /
earpiece switch (kept on the phone, applied at once while connected), shortcuts to Android's battery, notification and app
permission pages (`LibertadServicePlugin.openSettings`), and "connect on start".

## Screen sharing, watching, camera

- **Watching** a share and **the camera** need no native code: they are plain WebRTC and `getUserMedia` in the WebView.
  Capacitor's WebView client asks for the CAMERA/RECORD_AUDIO runtime permission by itself; `apply.mjs` adds `CAMERA` to the
  manifest (the camera is optional for installing the app). Setup messages still travel as Mumble plugin data (a 1.4+ server),
  the picture goes peer to peer; none of it uses the Node backend, HyperDHT or friends.
- **Sharing the screen** is the one missing browser feature (the WebView has no `getDisplayMedia`). `src/lib/android-capture.ts`
  installs one on Android: `LibertadCapturePlugin` shows the system "start recording?" dialog, `LibertadCaptureService`
  (foreground service type `mediaProjection`) encodes the screen with MediaCodec to H.264, frames arrive as base64 events, are
  decoded with WebCodecs into a canvas, and `canvas.captureStream()` is returned. `share.svelte.ts` and `ShareDialog.svelte`
  are unchanged and treat it like a desktop capture. Stopping from the notification or the system ends the track.
- Wished size/frame rate from the dialog are honoured (never enlarged, 16-px aligned); 3 Mbit/s into the encoder, and the page
  re-encodes for WebRTC, so expect warm phones on long shares.
- **Sound of the phone** (Android 10+): `AudioPlaybackCapture` of media/game audio, 48 kHz stereo PCM in 20 ms events, played by an
  AudioWorklet into the stream's audio track. Needs RECORD_AUDIO (asked when sharing with sound); without it, or on Android 9,
  the share has no sound. Libertad's own audio is excluded (a watched share is not sent back) and apps that opt out of
  capture stay silent. Mumble voice is not captured.
- **Rotation:** the service builds a new encoder for the new shape and swaps it into the virtual display; its keyframe carries a
  new SPS and the page's decoder is configured again. The viewers' picture changes size.
- **Camera in the background:** `src/lib/android-camera.ts` wraps `getUserMedia`; while a camera track is live it tells
  `LibertadServicePlugin.setCamera`, which adds service type `camera` to the connection service (Android 11+ requires it).
  Needs a connected server (the service) and the app visible when the camera starts. Whether the WebView then keeps delivering
  frames with the screen off or another app in front is up to Chromium and must be tried on a phone.
- Tested here: the page side in real Chromium with a fake encoder (picture, sound, rotation, stop, native stop, refusal, one capture at a time, camera keeper).
  **Not tested: the Java and the H.264 path on a real phone.**

## Tests

`npm run test:mobile` bundles the backend, runs it as a child process and drives it with the real page-side code over IPC
(standing in for the plugin's JSON channel) against a mock TLS + OCB2-UDP server. Covers TLS and certificates, a 200 KB
echo, encrypted UDP ping and voice both ways, server ping, identities (create, back up, restore, rename, remove), public
list parsing, refused connections and page reload. It passes with the backend on Node 22 and on Node 18.20.8.
`MOBILE_TEST_NODE=/path/to/node` picks the Node the backend runs on.

## Not done yet / known risks

- **The Android Java was not compiled or run here.** There is no Android SDK in my environment. `apply.mjs` is tested on a
  real `cap add android` template (idempotent, valid manifest) and the Capacitor calls are checked against the plugin's source,
  but the first Gradle build is its first compile. Needs a real phone: background survival with the screen off, Doze, the
  permission prompts, loudspeaker/headset routing, and microphone capture in the WebView (`getUserMedia`).
- **The plugin is on its way out.** `hampoelz/Capacitor-NodeJS` says it is no longer recommended for new projects and is stuck
  on Node 18.20. Only `channel.ts` (`require('bridge')`) and `capacitorBridge()` in `native-android.ts` know about it, so
  replacing it with nodejs-mobile wired up by your own small Capacitor plugin changes those two spots.
- **JSON bridge.** Bytes cross as base64 in JSON. Voice is ~50 small packets/s each way, fine in principle, but measure on a
  real phone. If it is too heavy, swap the bridge for a WebSocket on 127.0.0.1 (binary frames); `Bridge` is the only seam.
- **Public list.** Mumble's list CDN refuses non-browser TLS clients (HTTP 501 for Node). The backend sends browser headers,
  which is untested against the real server. If it still 501s, fetch the list in the page with Capacitor's native HTTP.
- **Identity backup** is written to `Documents/Libertad/` with `@capacitor/filesystem`; check it on a real device (Android 11+
  storage rules). The Share sheet is the fallback.
- **Voice in the page.** Microphone permission, audio routing and Opus in the WebView are the page's job and are not touched
  here. `getDisplayMedia` does not exist in Android WebView; see Screen sharing below.
- Friends, calls (HyperDHT/WebRTC), file sharing and torrents are not part of this backend yet.
- `data dir`: the backend uses the folder `getDataPath()` returns, plus `libertad/`, for `identities.json` (mode 600).

## Picture-in-picture (the pop-out button, and leaving the app)

A WebView can not give a `<video>` a window of its own (no `requestPictureInPicture`, no `window.open`), so on Android it is the
whole activity that becomes Android's small window that stays on top of everything. The page then hides everything but the
picture, which fills that window; coming back to the big window puts the page back as it was.

- **The button** (pop-out icon on a screen share, a camera, or watch together: YouTube, a streamed file) enters it at once.
- **Leaving the app** (home, recents) while a picture is *playing* enters it by itself: Android 12+ from the params
  (`setAutoEnterEnabled`), older phones from `MainActivity.onUserLeaveHint`. A paused picture does not go along.
- **Pictures:** screens and cameras of a server's voice channel (`VoiceStage`), friend calls (`CallStage`), watch together. With
  several, full screen wins, then watch together, then the first that plays.
- **The small window** has the system's own buttons (back to the app, close). The picture's controls are not in it. It
  closes by itself when the picture ends.
- **Setup:** `npm run build:android` runs `apply.mjs`, which copies `LibertadPipPlugin`, registers it, adds
  `android:supportsPictureInPicture="true"` (and the `configChanges` it needs) to the activity, and adds `onUserLeaveHint` and
  `onPictureInPictureModeChanged` to `MainActivity` (which must not have its own). Safe to re-run.
- **Permission:** Android has no pop-up for "Picture-in-picture" (unlike the camera); it is a switch on its own settings page,
  and some makers (Xiaomi, Realme, ...) leave it off for every app. Pressing the button with it off shows a dialog of the app
  ("Allow picture-in-picture", Open the page / Not now), opens that page for Libertad, and when the person comes back with
  it on, the small window opens by itself. Leaving the app does not ask (it cannot: the app is going), so allow it once
  with the button.
- **If it still does not open,** the message at the top of the stage says why, in Android's own words (the plugin returns the
  reason). "Not in this build" means the native part is old: `npm run build:android`, then `npx cap run android`. Logcat tag: `LibertadPip`.
- `src/lib/android-pip.ts` restyles the picture (`position: fixed` over the window, `html.libertad-pip`) rather than moving it:
  a `<video>` or an iframe that is moved in the page can stop or reload.

### Plugin handles must not be "thenable"

`registerPlugin()` returns a Proxy that answers to every property name, `then` included. A Promise (or `async` function) that
resolves with that Proxy therefore hangs for ever. Always get a plugin through `loadPlugin()` in `src/lib/capacitor-plugin.ts`,
which wraps it, and give native calls from buttons a `withTimeout()`.

### Full screen on Android

`LibertadServicePlugin.setImmersive` hides the bars, draws over the notch / camera hole, and takes away the padding that
Capacitor's SystemBars plugin and AppCompat keep around the page (they pad by the display cutout even when the bars are hidden).
If a phone still shows a bar or leaves a strip, it falls back to the older window flags. Settings, System, "Test full screen"
reports what happened, including how far the page starts from the corner of the screen.
