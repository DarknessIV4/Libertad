import { load, save } from './storage.ts';

// Whose voice tile is hidden from your own view, kept on this computer only (nobody else sees a change)
const keyOf = (u: { hash: string; name: string }) => u.hash || `name:${u.name}`;

class HiddenCards {
  private saved = load<{ users: Record<string, boolean> }>('mumh5.hiddenCards', { users: {} });
  users = $state<Record<string, boolean>>({ ...(this.saved.users ?? {}) });

  has(u: { hash: string; name: string } | null | undefined): boolean {
    return !!u && !!this.users[keyOf(u)];
  }

  set(u: { hash: string; name: string }, on: boolean): void {
    if (on) this.users[keyOf(u)] = true;
    else delete this.users[keyOf(u)];
    save('mumh5.hiddenCards', { users: $state.snapshot(this.users) });
  }
}

export const hiddenCards = new HiddenCards();
