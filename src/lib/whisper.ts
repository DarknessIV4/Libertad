// Who hears you when you talk normally in a Mumble channel: everyone in it and in the channels linked to it
// (links count through other links). "Deafen for me" talks to exactly those people except the ones left out.
export function recipients(
  selfSession: number,
  selfChannel: number,
  users: Iterable<{ session: number; channelId: number }>,
  linksOf: (channelId: number) => Iterable<number>,
  excluded: ReadonlySet<number>
): number[] {
  const reach = new Set<number>([selfChannel]);
  const todo = [selfChannel];
  while (todo.length) {
    for (const l of linksOf(todo.pop()!)) if (!reach.has(l)) { reach.add(l); todo.push(l); }
  }
  const out: number[] = [];
  for (const u of users) if (u.session !== selfSession && reach.has(u.channelId) && !excluded.has(u.session)) out.push(u.session);
  return out.sort((a, b) => a - b);
}
