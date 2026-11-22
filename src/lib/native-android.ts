import type { YoutubeResult } from '../core/youtube-search.ts';
import type { PlatformApi, IdentitySummary, PingResult, PublicServer } from './native.ts';
import type { Transport, ServerCertInfo, UdpChannel, CertDetails } from '../core/transport.ts';
import {
  CH, type CallMethod, type CastMethod, type CallMsg, type CastMsg, type ReplyMsg, type EventMsg, type EventName, type P12Backup
} from '../../mobile/shared/protocol.ts';
import { installAndroidDisplayMedia } from './android-capture.ts';
import { installAndroidCameraKeeper } from './android-camera.ts';
import { createKeepAlive, capacitorConnectionService, type ConnectionService } from './android-service.ts';
import { isAndroid } from './platform.ts';

// The Android app's side of Mumble server support: the same PlatformApi and transport the desktop app gets from
// Electron's preload script (see native.ts), but backed by the Node.js backend in mobile/nodejs.
//
// That backend runs inside Node.js for Mobile Apps (nodejs-mobile), started by the capacitor-nodejs plugin. This page
// is the Capacitor WebView; the two talk over the plugin's channel (NodeJS.send / NodeJS.addListener), which carries
// JSON, so bytes are sent as base64 (mobile/shared/protocol.ts). The Mumble protocol itself (core/client.ts) stays here
// in the page; only what a WebView cannot do, TLS and UDP sockets and the certificate store, is done by the backend.

// ─── The line to the backend ──────────────────────────────────────────────────

export interface Bridge {
  // Resolves once the listener is in place
  on(event: string, fn: (...args: any[]) => void): Promise<void>;
  send(event: string, ...args: unknown[]): Promise<void>;
}

// The capacitor-nodejs plugin, loaded only on Android so the desktop and web builds never touch it
async function capacitorBridge(): Promise<Bridge> {
  const { NodeJS } = await import('capacitor-nodejs');
  await NodeJS.whenReady();
  return {
    on: async (event, fn) => { await NodeJS.addListener(event, e => fn(...e.args)); },
    send: (event, ...args) => NodeJS.send({ eventName: event, args })
  };
}

// ─── Bytes as base64 ──────────────────────────────────────────────────────────

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ─── The backend ──────────────────────────────────────────────────────────────

const HELLO_MS = 300;
const START_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 60000;

type ConnHandler = (name: EventName, ...args: any[]) => void;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class AndroidBackend {
  private bridgeFor: () => Promise<Bridge>;
  private wired: Promise<Bridge> | null = null;
  private ready: Promise<Bridge> | null = null;
  private onReady: (() => void) | null = null;
  // Tells the backend which page this is: a new page closes the old one's connections, repeated hellos change nothing
  private token = crypto.randomUUID();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private conns = new Map<string, ConnHandler>();
  // Connections that are up (their TLS handshake is done), by what to call them in the service's notification
  private active = new Map<string, string>();
  private onActive: ((labels: string[]) => void) | null;

  constructor(bridgeFor: () => Promise<Bridge> = capacitorBridge, onActive: ((labels: string[]) => void) | null = null) {
    this.bridgeFor = bridgeFor;
    this.onActive = onActive;
  }

  // Listens once, before anything is sent, so no answer or event can be missed
  private wire(): Promise<Bridge> {
    return (this.wired ??= (async () => {
      const bridge = await this.bridgeFor();
      await Promise.all([
        bridge.on(CH.ready, (token: unknown) => { if (token === this.token) this.onReady?.(); }),
        bridge.on(CH.reply, (r: ReplyMsg) => this.answer(r)),
        bridge.on(CH.event, (e: EventMsg) => this.dispatch(e))
      ]);
      return bridge;
    })().catch(e => { this.wired = null; throw e; }));
  }

  // The backend may have started before this page was listening, so say hello until it answers
  private start(): Promise<Bridge> {
    return (this.ready ??= (async () => {
      const bridge = await this.wire();
      const answered = new Promise<void>(res => { this.onReady = res; });
      const hello = () => { bridge.send(CH.hello, this.token).catch(() => { /* tried again */ }); };
      hello();
      const again = setInterval(hello, HELLO_MS);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The Mumble backend did not start')), START_TIMEOUT_MS); });
      try { await Promise.race([answered, late]); } finally { clearInterval(again); clearTimeout(timer); this.onReady = null; }
      return bridge;
    })().catch(e => { this.ready = null; throw e; }));
  }

  // A call with an answer
  async call<T = unknown>(method: CallMethod, ...args: unknown[]): Promise<T> {
    const bridge = await this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The Mumble backend did not answer (${method})`)); }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      bridge.send(CH.call, { id, method, args } satisfies CallMsg).catch((e: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  // A message with no answer. Every one goes through the same promise, so they reach the backend in the order they were made.
  cast(method: CastMethod, ...args: unknown[]): void {
    this.start().then(bridge => bridge.send(CH.cast, { method, args } satisfies CastMsg)).catch(() => { /* the connection's own call reports it */ });
  }

  // Events of one connection
  subscribe(connId: string, handler: ConnHandler): () => void {
    this.conns.set(connId, handler);
    return () => {
      if (this.conns.get(connId) === handler) this.conns.delete(connId);
      this.setActive(connId, null);
    };
  }

  // A connection came up (with its label) or went away (null). The service that keeps the app alive follows the set.
  setActive(connId: string, label: string | null): void {
    if (label === null) {
      if (!this.active.delete(connId)) return;
    } else {
      if (this.active.get(connId) === label) return;
      this.active.set(connId, label);
    }
    this.onActive?.([...this.active.values()]);
  }

  private answer(r: ReplyMsg): void {
    const p = r && this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    clearTimeout(p.timer);
    if (r.ok) p.resolve(r.value);
    else p.reject(new Error(r.error));
  }

  private dispatch(e: EventMsg): void {
    const handler = e && this.conns.get(e.connId);
    if (!handler) return;
    // Bytes arrive as base64
    const args = e.name === 'data' || e.name === 'udpVoice' ? [fromB64(String(e.args[0]))] : e.args;
    handler(e.name, ...args);
  }
}

// ─── A connection to a Mumble server ──────────────────────────────────────────

// Transport backed by a TLS socket in the Node.js backend, like ElectronTransport is by one in Electron's main process.
// `secure` resolves once the TLS handshake is done, before any Mumble data is sent,
// so the caller can check the server certificate before sending a password.
export class AndroidTransport implements Transport {
  onData: ((chunk: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  readonly secure: Promise<ServerCertInfo>;
  udp: UdpChannel;
  private id = crypto.randomUUID();
  private backend: AndroidBackend;
  private unsubscribe: () => void;

  constructor(backend: AndroidBackend, host: string, port: number, identityId?: string) {
    this.backend = backend;
    let resolveSecure!: (i: ServerCertInfo) => void;
    let rejectSecure!: (e: Error) => void;
    this.secure = new Promise((res, rej) => { resolveSecure = res; rejectSecure = rej; });
    const id = this.id;
    // UDP voice lives in the backend; this bridges it to the client's UdpChannel
    const udp: UdpChannel = {
      onVoice: null, onState: null, onResync: null,
      setup: (k, c, s, p) => backend.cast('udpSetup', id, toB64(k), toB64(c), toB64(s), p),
      setServerNonce: n => backend.cast('udpNonce', id, toB64(n)),
      clientNonce: async () => {
        const n = await backend.call<string | null>('udpClientNonce', id);
        return n ? fromB64(n) : null;
      },
      send: p => backend.cast('udpSend', id, toB64(p))
    };
    this.udp = udp;
    this.unsubscribe = backend.subscribe(id, (name, ...args) => {
      switch (name) {
        case 'secure': backend.setActive(id, host); resolveSecure(args[0]); break;
        case 'data': this.onData?.(args[0]); break;
        case 'udpVoice': udp.onVoice?.(args[0]); break;
        case 'udpState': udp.onState?.(!!args[0], Number(args[1]) || 0); break;
        case 'udpResync': udp.onResync?.(); break;
        case 'close':
          this.unsubscribe();
          rejectSecure(new Error(String(args[0])));
          this.onClose?.(String(args[0]));
          break;
      }
    });
    backend.call('open', id, host, port, identityId ?? null).catch(e => { this.unsubscribe(); rejectSecure(e); });
  }

  send(bytes: Uint8Array): void { this.backend.cast('send', this.id, toB64(bytes)); }
  close(): void { this.backend.cast('close', this.id); }
}

// ─── What the app uses ────────────────────────────────────────────────────────

// Public list of servers, which the Electron preload has as well (native.ts declares it on its own interface)
export type AndroidPlatform = PlatformApi & { publicServers(url: string): Promise<PublicServer[]> };

// Android has no save dialog the backend could open, so the backup is written by the page
async function saveBackupFile(name: string, base64: string): Promise<string | null> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const file = `${name.replace(/[^\w.-]+/g, '_') || 'identity'}.p12`;
  const saved = await Filesystem.writeFile({ path: `Libertad/${file}`, data: base64, directory: Directory.Documents, recursive: true });
  return saved.uri;
}

export interface AndroidOptions {
  // Where an identity backup goes; resolves to where it was saved, or null when cancelled
  saveBackup?: (name: string, base64: string) => Promise<string | null>;
  // The foreground service that keeps connections alive in the background (android-service.ts); null for none
  service?: (() => Promise<ConnectionService>) | null;
}

export function createAndroidApi(bridgeFor: () => Promise<Bridge> = capacitorBridge, options: AndroidOptions = {}) {
  // The service runs while at least one server is connected
  const keepAlive = options.service === null ? null : createKeepAlive(options.service ?? capacitorConnectionService);
  const backend = new AndroidBackend(bridgeFor, labels => keepAlive?.update(labels));
  const saveBackup = options.saveBackup ?? saveBackupFile;
  const call = <T>(method: CallMethod, ...args: unknown[]) => backend.call<T>(method, ...args);

  const platform: AndroidPlatform = {
    platformInfo: () => call<{ os: string; osVersion: string }>('platformInfo'),
    localAddresses: () => call<string[]>('localAddresses'),
    youtubeSearch: q => call<YoutubeResult[]>('youtubeSearch', q),
    describeCerts: ders => call<CertDetails[]>('describeCerts', ders.map(toB64)),
    pingServer: (host, port) => call<PingResult | null>('pingServer', host, port),
    publicServers: url => call<PublicServer[]>('publicServers', url),
    identities: {
      list: () => call<{ identities: IdentitySummary[]; setupDone: boolean }>('identities.list'),
      create: (name, email) => call<IdentitySummary>('identities.create', name, email),
      importP12: (bytes, password, name) => call<IdentitySummary>('identities.importP12', toB64(bytes), password, name),
      findMumble: () => call<{ name: string } | null>('identities.findMumble'),
      importMumble: name => call<IdentitySummary>('identities.importMumble', name),
      exportP12: async (id, password) => {
        const backup = await call<P12Backup>('identities.exportP12', id, password);
        return saveBackup(backup.name, backup.bytes);
      },
      setDefault: async id => { await call('identities.setDefault', id); },
      rename: async (id, name) => { await call('identities.rename', id, name); },
      remove: async id => { await call('identities.remove', id); },
      finishSetup: async () => { await call('identities.finishSetup'); }
    }
  };

  return { backend, platform, openTransport: (host: string, port: number, identityId?: string) => new AndroidTransport(backend, host, port, identityId) };
}

// Only inside the Capacitor Android app; everywhere else (desktop, a browser) these answer null and nothing is loaded

let shared: ReturnType<typeof createAndroidApi> | null = null;
const api = () => (shared ??= createAndroidApi());

// native.ts: `native` is this on Android. Nothing talks to the backend until the first call.
export function androidPlatform(): AndroidPlatform | null {
  if (!isAndroid()) return null;
  // The WebView has no getDisplayMedia: screen sharing out goes through the native capture plugin (android-capture.ts)
  installAndroidDisplayMedia();
  installAndroidCameraKeeper(capacitorConnectionService);
  return api().platform;
}

// Loudspeaker or earpiece / headset while connected (nothing off Android). A headset in use is never overridden.
export async function setAndroidSpeakerphone(on: boolean): Promise<void> {
  if (isAndroid()) await (await capacitorConnectionService()).setSpeakerphone({ on });
}

// native.ts: openTransport() on Android
export function androidTransport(host: string, port: number, identityId?: string): (Transport & { secure: Promise<ServerCertInfo> }) | null {
  return isAndroid() ? api().openTransport(host, port, identityId) : null;
}
