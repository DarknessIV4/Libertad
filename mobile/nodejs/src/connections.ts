import { openTls } from '../../../electron/tls-transport.ts';
import { udpChannel } from '../../../electron/udp-voice.ts';
import type { IdentityStore } from '../../../electron/identity-store.ts';
import type { EventMsg, EventName } from '../../shared/protocol.ts';

// Mumble connections for the Android app. This is electron/main.ts's `mumble:*` handlers without Electron:
// the same TLS socket (electron/tls-transport.ts) and encrypted UDP voice (electron/udp-voice.ts), kept per
// connection id. It runs inside Node.js for Mobile Apps (nodejs-mobile, through the capacitor-nodejs plugin);
// the page in the Capacitor WebView drives it through the channel in channel.ts, so the Mumble protocol
// itself (src/core/client.ts) stays in the page, as it does in the desktop app.

const MAX_CONNECTIONS = 8;
// The longest message the page may hand over in one piece (Mumble's own limit is 8 MiB per message)
const MAX_BYTES = 16 * 1024 * 1024;

type Conn = ReturnType<typeof openTls> & { udp?: ReturnType<typeof udpChannel> };

export const toB64 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');

// Bytes from the page. A copy, so no Buffer pool is shared with the sockets.
export function fromB64(s: unknown): Uint8Array {
  if (typeof s !== 'string' || s.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('Invalid data');
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export class Connections {
  private conns = new Map<string, Conn>();
  private emit: (e: EventMsg) => void;
  private identities: () => Promise<IdentityStore>;

  constructor(emit: (e: EventMsg) => void, identities: () => Promise<IdentityStore>) {
    this.emit = emit;
    this.identities = identities;
  }

  // The page picks the connection id and subscribes before calling open, so no event can be missed
  async open(connId: unknown, host: unknown, port: unknown, identityId?: unknown): Promise<void> {
    if (typeof connId !== 'string' || !connId || connId.length > 64 || this.conns.has(connId)) throw new Error('Invalid connection id');
    if (this.conns.size >= MAX_CONNECTIONS) throw new Error('Too many connections');
    if (typeof host !== 'string' || !host || host.length > 255) throw new Error('Invalid server address');
    const p = Number(port) || 64738;
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Invalid port');
    const id = await this.identities().then(s => s.get(typeof identityId === 'string' ? identityId : undefined));

    const emit = (name: EventName, ...args: unknown[]) => this.emit({ name, connId, args });
    const conn: Conn = openTls(host, p, id.certPem, id.keyPem, {
      onSecure: info => {
        // Encrypted UDP voice to the address the TLS connection actually reached
        const udp = udpChannel(info.address, info.port);
        udp.onVoice = v => emit('udpVoice', toB64(v));
        udp.onState = (ok, rtt) => emit('udpState', ok, rtt);
        udp.onResync = () => emit('udpResync');
        const c = this.conns.get(connId);
        if (c) c.udp = udp;
        else udp.close();
        emit('secure', info);
      },
      onData: chunk => emit('data', toB64(chunk)),
      onClose: reason => {
        this.conns.get(connId)?.udp?.close();
        this.conns.delete(connId);
        emit('close', reason);
      }
    });
    this.conns.set(connId, conn);
  }

  send(connId: unknown, data: unknown): void {
    this.conns.get(String(connId))?.send(fromB64(data));
  }

  // UDP voice: keys from the server's CryptSetup, voice packets, nonce resync
  udpSetup(connId: unknown, key: unknown, clientNonce: unknown, serverNonce: unknown, protobuf: unknown): void {
    this.conns.get(String(connId))?.udp?.setup(fromB64(key), fromB64(clientNonce), fromB64(serverNonce), !!protobuf);
  }

  udpNonce(connId: unknown, serverNonce: unknown): void {
    this.conns.get(String(connId))?.udp?.setServerNonce(fromB64(serverNonce));
  }

  udpSend(connId: unknown, data: unknown): void {
    this.conns.get(String(connId))?.udp?.send(fromB64(data));
  }

  async udpClientNonce(connId: unknown): Promise<string | null> {
    const nonce = await this.conns.get(String(connId))?.udp?.clientNonce();
    return nonce ? toB64(nonce) : null;
  }

  close(connId: unknown): void {
    this.conns.get(String(connId))?.close();
  }

  // The page was reloaded: its connections are gone with it
  closeAll(): void {
    for (const c of [...this.conns.values()]) c.close();
  }
}
