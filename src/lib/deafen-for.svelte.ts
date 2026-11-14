import type { Session } from './session.svelte.ts';
import type { MumbleClient, User } from '../core/client.ts';
import { PERM } from '../core/client.ts';
import { sessions } from './session.svelte.ts';
import { voice } from './audio/voice.svelte.ts';
import { ui } from './ui.svelte.ts';
import { recipients } from './whisper.ts';

// "Deafen for me" on a person: they stop hearing you, everyone else still does, and they still hear everyone
// else (a server deafen would stop that). Mumble cannot leave one listener out of normal talking, so while anyone
// is deafened for you, your voice goes out as a whisper to everyone who would hear you except them (a voice
// target listing those people), and back to normal talking when nobody is left. It lasts for this connection.
// Needs the server's Whisper permission; without it nobody would hear you, so the choice is refused.
const TARGET = 1;

const reply = (title: string, text: string) => { ui.prompt = { title, label: '', confirm: 'OK', input: 'none', text, onsubmit: () => {} }; };

class DeafenFor {
  // server id -> sessions of the people who do not hear you there
  private by = new Map<string, Set<number>>();
  private watched = new WeakSet<MumbleClient>();
  private lastClient: MumbleClient | null = null;
  private lastKey = '';

  has(s: Session, u: User): boolean { return !!s.server && !!this.by.get(s.server.id)?.has(u.session); }

  toggle(s: Session, u: User): void {
    const id = s.server?.id, self = s.client?.self;
    if (!id || !self) return;
    const set = this.by.get(id) ?? new Set<number>();
    if (set.has(u.session)) set.delete(u.session);
    else {
      if (s.can(self.channelId, PERM.Whisper) === false) {
        reply('Deafen for me', 'This server does not allow whispering for you, which this needs: your voice is sent to the others one by one. Nothing was changed.');
        return;
      }
      set.add(u.session);
    }
    this.by.set(id, set);
    this.sync();
  }

  // Keeps the voice target and the voice engine in step: call when anything about the voice server's people changes
  sync(): void {
    // Connections that ended start over
    for (const id of [...this.by.keys()]) {
      const s = sessions.byServer(id);
      if (!s?.client || s.status !== 'connected') this.by.delete(id);
    }
    const vs = sessions.voiceSession;
    void vs?.tick;
    const client = vs?.client, self = client?.self;
    const left = vs?.server ? this.by.get(vs.server.id) : undefined;
    if (!vs || !client || !self || !left?.size) {
      voice.target = 0;
      this.lastKey = '';
      return;
    }
    if (!this.watched.has(client)) {
      this.watched.add(client);
      // The server refused the whisper: stop, or nobody would hear you
      client.on('permissionDenied', d => {
        if (d.type !== 1 || d.permission !== PERM.Whisper) return;
        const id = sessions.voiceSession?.server?.id;
        if (!id || !this.by.get(id)?.size) return;
        this.by.delete(id);
        this.sync();
        reply('Deafen for me', 'The server refused to let you whisper, so everyone hears you normally again.');
      });
    }
    const list = recipients(self.session, self.channelId, client.users.values(), id => client.channels.get(id)?.links ?? [], left);
    const key = list.join(',');
    if (this.lastClient !== client || key !== this.lastKey) {
      client.send('VoiceTarget', { id: TARGET, targets: [{ session: list }] });
      this.lastClient = client;
      this.lastKey = key;
    }
    voice.target = TARGET;
  }
}

export const deafenFor = new DeafenFor();
