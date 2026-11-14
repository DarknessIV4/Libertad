import type { ChannelAcl, AclEntry } from '../core/client.ts';

// The Admin role. Mumble has no roles, only groups and ACL rules, and the server enforces them: the role is
// membership of one group on the root channel plus two rules that give that group its permissions.
//   everywhere (root and below):   Mute/Deafen, Move, Make channel
//   below the root only:           Write (needed to delete a channel; nothing grants it on the root, so the
//                                  group's members can never be changed by an Admin)
// Only the SuperUser may change the group (editing the root's groups needs Write on the root).
export const ADMIN_GROUP = 'libertad_admin';

const WRITE = 0x1, MUTE_DEAFEN = 0x10, MOVE = 0x20, MAKE_CHANNEL = 0x40;
export const ADMIN_EVERYWHERE = MUTE_DEAFEN | MOVE | MAKE_CHANNEL;
export const ADMIN_BELOW_ROOT = WRITE;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const mine = (r: AclEntry) => !r.inherited && r.userId == null && r.group === ADMIN_GROUP;

// The root's ACL with `userId` in the Admin group, and the group's rules in place (added when missing)
export function withAdmin(acl: ChannelAcl, userId: number): ChannelAcl {
  const out = clone(acl);
  let group = out.groups.find(g => g.name === ADMIN_GROUP);
  if (!group) {
    group = { name: ADMIN_GROUP, inherited: false, inherit: true, inheritable: true, add: [], remove: [], inheritedMembers: [] };
    out.groups.push(group);
  }
  if (!group.add.includes(userId)) group.add.push(userId);
  group.remove = group.remove.filter(id => id !== userId);

  const rule = (applyHere: boolean, bits: number) => {
    let r = out.acls.find(x => mine(x) && x.applyHere === applyHere && x.applySubs);
    if (!r) {
      r = { applyHere, applySubs: true, inherited: false, userId: null, group: ADMIN_GROUP, grant: 0, deny: 0 };
      out.acls.push(r);
    }
    r.grant |= bits;
    r.deny &= ~bits;
  };
  rule(true, ADMIN_EVERYWHERE);
  rule(false, ADMIN_BELOW_ROOT);
  return out;
}

// The root's ACL without `userId` in the Admin group (the group and its rules stay for the next one)
export function withoutAdmin(acl: ChannelAcl, userId: number): ChannelAcl {
  const out = clone(acl);
  const group = out.groups.find(g => g.name === ADMIN_GROUP);
  if (group) group.add = group.add.filter(id => id !== userId);
  return out;
}

export function adminIds(acl: ChannelAcl): number[] {
  return [...(acl.groups.find(g => g.name === ADMIN_GROUP)?.add ?? [])];
}

// What the server says we may do (PermissionQuery bits per channel) matches the Admin role: the three
// permissions on the root, no Write there, and Write somewhere below it. Judged from what the server
// answered, never from anything stored on this computer.
export function looksLikeAdmin(perms: ReadonlyMap<number, number>): boolean {
  const root = perms.get(0);
  if (root == null || (root & ADMIN_EVERYWHERE) !== ADMIN_EVERYWHERE || (root & WRITE) !== 0) return false;
  for (const [id, bits] of perms) if (id !== 0 && (bits & WRITE) !== 0) return true;
  return false;
}
