import { createCodec } from '../core/proto.ts';
import { MumbleClient } from '../core/client.ts';
import { native, openTransport } from './native.ts';
import { store, type SavedServer } from './settings.svelte.ts';
import { sessions } from './session.svelte.ts';

const codec = createCodec();

// Sends one message (HTML, like the chat bar makes) to the server's main channel without opening the server or joining voice.
// Already connected: it goes through that connection. Otherwise a short text-only connection
// logs in, sends, and leaves again. Throws a sentence a person can read.
export async function quickMessage(server: SavedServer, html: string): Promise<void> {
  if (!html.trim()) return;

  const open = sessions.byServer(server.id);
  if (open?.status === 'connected') {
    if (!open.sendHtml(html, 'ch:0')) throw new Error('The message could not be sent.');
    return;
  }
  if (open && open.status !== 'idle') throw new Error('Still connecting to this server. Try again in a moment.');
  if (!native) throw new Error('Connecting needs the desktop app or the web build served by a Libertad proxy.');

  const transport = (await openTransport(server.host, server.port, server.identityId))!;
  let client: MumbleClient | null = null;
  try {
    const info = await transport.secure;
    // Same trust on first use as a normal connection
    const hostPort = `${server.host.toLowerCase()}:${server.port}`;
    const pinned = store.pins[hostPort];
    if (!pinned) store.pin(hostPort, info.fingerprint);
    else if (pinned !== info.fingerprint && !info.authorized) {
      throw new Error('The server certificate changed. Connect to the server once to review it.');
    }

    const c = (client = new MumbleClient(codec));
    const platform = await native.platformInfo();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The server did not finish the login.')), 20000);
      c.on('synced', () => { clearTimeout(timer); resolve(); });
      c.on('close', reason => { clearTimeout(timer); reject(new Error(reason || 'The server closed the connection.')); });
      c.connect(transport, { username: server.username, password: server.password, os: platform.os, osVersion: platform.osVersion });
    });

    const limit = /<img/i.test(html) ? c.config.imageMessageLength : c.config.messageLength;
    if (limit && html.length > limit) throw new Error(`Message too long for this server (${html.length} / ${limit} characters).`);
    c.sendText({ channels: [0] }, html);
    // Leave once the server has read it
    await c.flushed();
  } finally {
    if (client) client.disconnect(); else transport.close();
  }
}
