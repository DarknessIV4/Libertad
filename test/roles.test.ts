import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withAdmin, withoutAdmin, adminIds, looksLikeAdmin, ADMIN_GROUP, ADMIN_EVERYWHERE, ADMIN_BELOW_ROOT } from '../src/lib/roles.ts';
import type { ChannelAcl } from '../src/core/client.ts';

const root = (): ChannelAcl => ({
  channelId: 0, inheritAcls: true,
  groups: [{ name: 'admin', inherited: false, inherit: true, inheritable: true, add: [5], remove: [], inheritedMembers: [] }],
  acls: [{ applyHere: true, applySubs: true, inherited: false, userId: null, group: 'admin', grant: 0xffff, deny: 0 }]
});

test('making an admin adds the group, its two rules and the member, and keeps what was there', () => {
  const out = withAdmin(root(), 7);
  assert.deepEqual(adminIds(out), [7]);
  assert.deepEqual(out.groups.find(g => g.name === 'admin')?.add, [5]);
  const mine = out.acls.filter(r => r.group === ADMIN_GROUP);
  assert.equal(mine.length, 2);
  assert.equal(mine.find(r => r.applyHere)?.grant, ADMIN_EVERYWHERE);
  assert.equal(mine.find(r => !r.applyHere)?.grant, ADMIN_BELOW_ROOT);
  assert.equal(out.acls.length, 3);
});

test('the Write rule never applies on the root, so Admins cannot edit the root group', () => {
  const rules = withAdmin(root(), 7).acls.filter(r => r.group === ADMIN_GROUP);
  const write = rules.filter(r => (r.grant & 0x1) !== 0);
  assert.equal(write.length, 1);
  assert.equal(write[0].applyHere, false);
  assert.equal(write[0].applySubs, true);
});

test('a second admin reuses the rules; the same one twice is one member', () => {
  const out = withAdmin(withAdmin(withAdmin(root(), 7), 8), 7);
  assert.deepEqual(adminIds(out), [7, 8]);
  assert.equal(out.acls.filter(r => r.group === ADMIN_GROUP).length, 2);
});

test('a deny on the rules is lifted, other bits are kept', () => {
  const acl = withAdmin(root(), 7);
  for (const r of acl.acls) if (r.group === ADMIN_GROUP) { r.deny = 0x10 | 0x400; r.grant |= 0x800; }
  const out = withAdmin(acl, 8);
  const here = out.acls.find(r => r.group === ADMIN_GROUP && r.applyHere)!;
  assert.equal(here.deny, 0x400);
  assert.equal(here.grant & 0x800, 0x800);
});

test('removing an admin takes only that member out', () => {
  const out = withoutAdmin(withAdmin(withAdmin(root(), 7), 8), 7);
  assert.deepEqual(adminIds(out), [8]);
  assert.deepEqual(out.groups.find(g => g.name === 'admin')?.add, [5]);
  assert.deepEqual(adminIds(withoutAdmin(root(), 7)), []);
});

test('the input is not changed', () => {
  const before = root();
  withAdmin(before, 7);
  assert.deepEqual(before, root());
});

test('the server\'s answer is what makes an Admin', () => {
  const ok = new Map([[0, 0x4 | 0x2 | ADMIN_EVERYWHERE], [1, 0x1 | ADMIN_EVERYWHERE]]);
  assert.equal(looksLikeAdmin(ok), true);
  assert.equal(looksLikeAdmin(new Map([[0, ADMIN_EVERYWHERE]])), false);                       // no Write below the root
  assert.equal(looksLikeAdmin(new Map([[0, ADMIN_EVERYWHERE | 0x1], [1, 0x1]])), false);       // Write on the root: a full admin
  assert.equal(looksLikeAdmin(new Map([[0, 0x10], [1, 0x1]])), false);                         // missing permissions
  assert.equal(looksLikeAdmin(new Map()), false);
});
