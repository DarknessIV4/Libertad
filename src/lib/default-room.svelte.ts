import type { Session } from './session.svelte.ts';
import type { Channel } from '../core/client.ts';
import { ui } from './ui.svelte.ts';
import { load, save } from './storage.ts';

// Connecting to a server that has several rooms asks which one to go to. "Set this room as default for me"
// remembers the answer for that server, on this computer only; from then on connecting goes straight to that
// room. The server's right-click menu has "Clear Default room". The server never sees any of it.
const KEY = 'libertad.defaultRoom';
interface Entry { id: number; name: string }

class DefaultRooms {
  // server id -> its default room
  private all = $state<Record<string, Entry>>(load<Record<string, Entry>>(KEY, {}));

  get(serverId: string): Entry | undefined { return this.all[serverId]; }
  has(serverId: string): boolean { return !!this.all[serverId]; }

  set(serverId: string, room: Entry): void {
    this.all[serverId] = room;
    save(KEY, $state.snapshot(this.all));
  }

  clear(serverId: string): void {
    delete this.all[serverId];
    save(KEY, $state.snapshot(this.all));
  }

  // Called when a connection is ready. Returns true when it took care of where you are: it joined the default
  // room or opened the question. restoring: the app is returning you to the channel you were last in (connect on
  // start), which stays as it is unless a default room is set.
  connected(s: Session, restoring: boolean): boolean {
    const serverId = s.server?.id;
    if (!serverId) return false;
    const saved = this.all[serverId];
    if (saved) {
      const room = s.client?.channels.get(saved.id);
      if (room && !s.isText(room.id) && room.canEnter && (room.name || 'Root') === saved.name) {
        if (s.self?.channelId !== room.id) s.joinChannel(room.id);
        return true;
      }
      // The room is gone, renamed or locked: ask again
    }
    if (restoring) return false;
    if (roomsOf(s).filter(r => r.channel.canEnter).length < 2) return false;
    // You are already in the server's first room while you choose: nobody there may hear you, and you hear nobody.
    // RoomPicker puts your own mute and deafen back when it closes.
    s.applyOwnState(true, true);
    ui.roomPicker = { serverId };
    return true;
  }
}

export const defaultRooms = new DefaultRooms();

// The server's voice rooms in the order of the channel list, with how deep each one is. The root channel is a
// room too (often the main one, named by the server), so it comes first.
export function roomsOf(s: Session): { channel: Channel; depth: number }[] {
  const out: { channel: Channel; depth: number }[] = [];
  const root = s.channel(0);
  if (root) out.push({ channel: root, depth: 0 });
  const walk = (parent: number, depth: number) => {
    for (const c of s.childrenOf(parent)) {
      const text = s.isText(c.id);
      if (!text) out.push({ channel: c, depth });
      walk(c.id, text ? depth : depth + 1);
    }
  };
  walk(0, 1);
  return out;
}
