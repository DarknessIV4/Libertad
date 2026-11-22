// The messages between the page (the Capacitor WebView) and the Mumble backend running in nodejs-mobile.
//
// They travel over the capacitor-nodejs channel (NodeJS.send / NodeJS.addListener in the page, `bridge`'s
// channel.send / channel.addListener in Node). The channel serializes every argument as JSON, so bytes are
// sent as base64 strings and decoded on the other side.
//
// Used by mobile/nodejs/src (the backend) and src/lib/native-android.ts (the page). Types and names only.

export const CH = {
  hello: 'mm:hello',   // page -> backend, repeated until the backend answers with `ready`; also resets the backend
  ready: 'mm:ready',   // backend -> page
  call: 'mm:call',     // page -> backend, answered with `reply`
  reply: 'mm:reply',   // backend -> page
  cast: 'mm:cast',     // page -> backend, no answer (bytes to send, UDP keys)
  event: 'mm:event'    // backend -> page: connection events
} as const;

// Calls that are answered (the Electron app's ipcRenderer.invoke)
export type CallMethod =
  | 'platformInfo'
  | 'describeCerts'
  | 'pingServer'
  | 'localAddresses'
  | 'youtubeSearch'
  | 'publicServers'
  | 'identities.list'
  | 'identities.create'
  | 'identities.importP12'
  | 'identities.findMumble'
  | 'identities.importMumble'
  | 'identities.exportP12'
  | 'identities.setDefault'
  | 'identities.rename'
  | 'identities.remove'
  | 'identities.finishSetup'
  | 'open'
  | 'udpClientNonce';

// Messages that are not answered (the Electron app's ipcRenderer.send)
export type CastMethod = 'send' | 'close' | 'udpSetup' | 'udpNonce' | 'udpSend';

// What a connection reports, the same events the Electron app's preload API has
export type EventName = 'secure' | 'data' | 'close' | 'udpVoice' | 'udpState' | 'udpResync';

export interface CallMsg { id: number; method: CallMethod; args: unknown[] }
export type ReplyMsg = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
export interface CastMsg { method: CastMethod; args: unknown[] }
export interface EventMsg { name: EventName; connId: string; args: unknown[] }

// What `identities.exportP12` answers with: the page saves the file (Android has no save dialog in Node)
export interface P12Backup { name: string; bytes: string }
