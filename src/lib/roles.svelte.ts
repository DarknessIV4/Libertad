import type { Session } from './session.svelte.ts';
import type { ChannelAcl, User, MumbleClient } from '../core/client.ts';
import { ui } from './ui.svelte.ts';
import { load, save } from './storage.ts';
import { withAdmin, withoutAdmin, adminIds, looksLikeAdmin } from './roles.ts';

// The Admin role (see roles.ts). The server is the only judge of what anyone may do: every action goes to it and
// it answers yes or no. What is kept on this computer is a note, per server, that you were an Admin there; it
// only fills the gap before the server has answered and grants nothing. It is checked against the server's
// answer on every connection, so copying it to another server's entry, editing it, or moving it to another
// computer changes nothing: that server does not list the person in its Admin group.
const KEY = 'libertad.roles';

const reply = (title: string, text: string) => { ui.prompt = { title, label: '', confirm: 'OK', input: 'none', text, onsubmit: () => {} }; };

class Roles {
  // SuperUser only: the registered ids in the Admin group, per server
  admins = $state<Record<string, number[]>>({});
  // This computer's note: servers where the server last said we are an Admin
  private noted = $state<Record<string, boolean>>(load<Record<string, boolean>>(KEY, {}));

  isSuper(s: Session): boolean { return s.self?.userId === 0; }

  // The server says we are an Admin (or, until it has answered, this computer remembers that it did)
  isAdmin(s: Session): boolean {
    void s.tick;
    const client = s.client, id = s.server?.id;
    if (!client || !id || this.isSuper(s)) return false;
    if (looksLikeAdmin(client.permissions)) return true;
    const answered = client.permissions.has(0) && client.permissions.size > 1;
    return !answered && !!this.noted[id];
  }

  // Admins do not edit permissions or groups (the server would let them below the root; the app does not)
  limited(s: Session): boolean { return this.isAdmin(s); }

  hasAdmin(s: Session, u: User): boolean {
    const id = s.server?.id;
    return !!id && u.userId != null && (this.admins[id] ?? []).includes(u.userId);
  }

  // Keeps the note in step with the server's answer; call when the permissions may have changed
  verify(s: Session): void {
    const id = s.server?.id, client = s.client;
    if (!id || !client || this.isSuper(s) || !client.permissions.has(0) || client.permissions.size < 2) return;
    const yes = looksLikeAdmin(client.permissions);
    if (!!this.noted[id] === yes) return;
    if (yes) this.noted[id] = true; else delete this.noted[id];
    save(KEY, $state.snapshot(this.noted));
  }

  // SuperUser: who is in the Admin group
  async refresh(s: Session): Promise<void> {
    const id = s.server?.id;
    if (!id || !s.client || !this.isSuper(s)) return;
    const acl = await rootAcl(s.client);
    if (acl) this.admins[id] = adminIds(acl);
  }

  // SuperUser: Make admin / Remove admin. The person must be registered; the server keeps the role by account.
  grant(s: Session, u: User): void {
    if (!this.isSuper(s)) return;
    if (u.userId == null) {
      ui.prompt = {
        title: `Make ${u.name} admin`, label: '', confirm: 'Register and make admin', input: 'none',
        text: `${u.name} is not registered on this server, and the server keeps roles by account. Register them and make them an admin?`,
        onsubmit: () => { void this.registerThen(s, u); }
      };
      return;
    }
    void this.change(s, u.userId, true, u.name);
  }

  revoke(s: Session, u: User): void {
    if (!this.isSuper(s) || u.userId == null) return;
    void this.change(s, u.userId, false, u.name);
  }

  private async registerThen(s: Session, u: User): Promise<void> {
    s.register(u.session);
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 150));
      const id = s.client?.users.get(u.session)?.userId;
      if (id != null && id > 0) { await this.change(s, id, true, u.name); return; }
    }
    reply('Admin role', `${u.name} could not be registered, so nothing was changed.`);
  }

  private async change(s: Session, userId: number, on: boolean, name: string): Promise<void> {
    const client = s.client;
    if (!client) return;
    // Fresh from the server just before saving, so rules others added since are kept
    const acl = await rootAcl(client);
    if (!acl) { reply('Admin role', 'The server did not answer, so nothing was changed.'); return; }
    client.saveAcl(on ? withAdmin(acl, userId) : withoutAdmin(acl, userId));
    // The server flushes everyone's permissions after an ACL change (the session asks again); then read the group back
    await new Promise(r => setTimeout(r, 400));
    await this.refresh(s);
    const id = s.server?.id;
    if (id && ((this.admins[id] ?? []).includes(userId)) !== on) reply('Admin role', `The server did not accept the change for ${name}.`);
  }
}

// The root channel's rules and groups, as the server has them now (null if it does not answer)
function rootAcl(client: MumbleClient): Promise<ChannelAcl | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { off(); resolve(null); }, 5000);
    const off = client.on('acl', a => {
      if (a.channelId !== 0) return;
      clearTimeout(timer); off(); resolve(a);
    });
    client.queryAcl(0);
  });
}

export const roles = new Roles();
