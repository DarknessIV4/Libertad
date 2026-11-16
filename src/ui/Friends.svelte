<script lang="ts">
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import Avatar from './Avatar.svelte';
  import { p2p } from '../lib/p2p.svelte.ts';
  import { ui } from '../lib/ui.svelte.ts';
  import FriendCard from './FriendCard.svelte';
  import { sessions } from '../lib/session.svelte.ts';
  import { groupKey, friendLink } from '../core/p2p-wire.ts';

  // panel: shown in place (the right side of the start page) instead of in a window
  let { panel = false }: { panel?: boolean } = $props();

  const s = $derived(p2p.state);
  const self = $derived(s.self);
  const inCall = $derived(!!s.call);

  let code = $state('');
  let name = $state('');
  let problem = $state('');
  let copied = $state('');
  let view = $state<'main' | 'code' | 'add'>('main');
  let query = $state('');

  async function add(e: Event) {
    e.preventDefault();
    problem = await p2p.add(code, name);
    if (!problem) { code = ''; name = ''; }
  }

  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); copied = what; setTimeout(() => { if (copied === what) copied = ''; }, 1800); } catch { /* clipboard blocked */ }
  }

  const rename = (key: string, current: string) => (ui.prompt = {
    title: 'Rename friend', label: 'Name', confirm: 'Save', initial: current, onsubmit: v => { p2p.rename(key, v); }
  });
  const remove = (key: string, who: string) => (ui.prompt = {
    title: 'Remove friend', label: '', input: 'none', confirm: 'Remove', danger: true,
    text: `Remove ${who} from your friends? They stay able to ask again.`, onsubmit: () => { p2p.remove(key); }
  });

  // The friend's own profile comes over the friend network (see FriendCard). A friend who runs an older version
  // sends none; his picture is then taken from a server we are both on, found by his certificate hash.
  function onServer(hash?: string) {
    const h = hash?.toLowerCase();
    if (!h) return null;
    for (const s of sessions.list) {
      if (s.status !== 'connected') continue;
      const user = s.allUsers().find(u => u.hash.toLowerCase() === h);
      if (user) return { s, user };
    }
    return null;
  }
  const serverPicture = (hash?: string): string | null => { const f = onServer(hash); return f ? f.s.avatar(f.user.session) : null; };
  const pictureOf = (key: string, hash?: string): string | null => p2p.avatarOf(key) ?? serverPicture(hash);

  let card = $state<string | null>(null);

  const label = (f: { name: string; key: string }) => f.name || `${f.key.slice(0, 8)}…`;
  const sorted = $derived([...s.friends].sort((a, b) => Number(b.online) - Number(a.online) || label(a).localeCompare(label(b))));
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? sorted.filter(f => label(f).toLowerCase().includes(q) || (f.name || '').toLowerCase().includes(q)) : sorted;
  });
</script>

{#snippet startupBox()}
  <label class="startup" title="Go online by itself every time the app starts"><input type="checkbox" checked={p2p.startup} onchange={e => p2p.setStartup(e.currentTarget.checked)} /> Online on Startup</label>
{/snippet}

{#snippet body()}
  {#if view === 'code'}
    <button class="btn back" onclick={() => (view = 'main')}>Back</button>
    {#if self}
      <section>
        <div class="code" title="Send this to a friend so they can add you">{groupKey(self.key)}</div>
        <div class="row">
          <button class="btn" onclick={() => copy(self.key, 'code')}>{copied === 'code' ? 'Copied' : 'Copy code'}</button>
          <button class="btn" onclick={() => copy(friendLink(self.key), 'link')}>{copied === 'link' ? 'Copied' : 'Copy link'}</button>
        </div>
        <p class="hint">The same identity gives the same code on any computer, so back it up in Settings &gt; Identities. Whoever holds the code can ask to be your friend; they can do nothing else until you accept.</p>
      </section>
    {:else}
      <p class="hint">No identity is selected yet, so there is no friend code.</p>
    {/if}
  {:else if view === 'add'}
    <button class="btn back" onclick={() => (view = 'main')}>Back</button>
    {#if s.running}
      <label class="check"><input type="checkbox" checked={s.acceptRequests} onchange={e => p2p.acceptRequests(e.currentTarget.checked)} /> Let new people send me friend requests</label>
    {/if}

    <section>
      <h3>Add a friend</h3>
      <form onsubmit={add}>
        <input bind:value={code} placeholder="Their friend code" autocomplete="off" spellcheck="false" aria-label="Friend code" />
        <input bind:value={name} placeholder="Name (optional)" maxlength="64" autocomplete="off" aria-label="Name" />
        <button class="btn primary" type="submit" disabled={!code.trim()}><Icon name="plus" size={16} />Add</button>
      </form>
      {#if problem}<p class="error">{problem}</p>{/if}
    </section>

    <section>
      <h3>Friend requests{s.requests.length ? ` (${s.requests.length})` : ''}</h3>
      {#if !s.requests.length}<p class="hint">No incoming requests.</p>{/if}
      {#each s.requests as r (r.key)}
        <div class="person">
          <Avatar name={r.name || '?'} size={36} />
          <div class="who"><strong>{r.name || 'Someone'}</strong><span class="key">{r.key.slice(0, 16)}…</span></div>
          <button class="btn primary" onclick={() => p2p.accept(r.key)}>Accept</button>
          <button class="btn danger" title="Decline and block this code" onclick={() => p2p.decline(r.key)}>Decline</button>
        </div>
      {/each}
    </section>
  {:else}
    <div class="head">
      <h3>Friends{s.friends.length ? ` (${s.friends.length})` : ''}</h3>
      <div class="actions">
        <button class="btn" onclick={() => (view = 'code')}>View Code</button>
        <button class="btn" onclick={() => (view = 'add')}>Add a Friend{s.requests.length ? ` (${s.requests.length})` : ''}</button>
      </div>
    </div>

    <div class="toggle">
      <span class="dot" class:on={s.running} title={s.running ? 'You are online for friends. They can see you and call you.' : 'You are offline. Friends cannot see or call you.'}></span>
      {#if s.running}
        <button class="btn" disabled={p2p.busy || inCall} onclick={() => p2p.disable()}>Go offline</button>
      {:else}
        <button class="btn primary" disabled={p2p.busy || s.starting} onclick={() => p2p.enable()}>{s.starting ? 'Joining…' : 'Go online'}</button>
      {/if}
      {@render startupBox()}
    </div>
    {#if s.error}<p class="error">{s.error}</p>{/if}

    <section class="list">
      <input class="search" type="search" bind:value={query} placeholder="Search friends" autocomplete="off" spellcheck="false" aria-label="Search friends" />
      {#if !s.friends.length}<p class="hint">No friends yet. Use Add a Friend, and send them your code with View Code.</p>{/if}
      {#if s.friends.length && !shown.length}<p class="hint">No friend matches that name.</p>{/if}
      {#each shown as f (f.key)}
        <div class="person">
          <button class="hit" title="Open profile" onclick={() => (card = f.key)}>
            <span class="face"><Avatar name={label(f)} size={36} src={pictureOf(f.key, f.hash)} /><span class="pip" class:on={f.online}></span></span>
            <span class="who">
              <strong>{label(f)}</strong>
              <span>{f.status === 'pending' ? 'Waiting for them to accept' : f.online ? 'Online' : s.running ? 'Offline' : 'Go online to see who is here'}</span>
            </span>
          </button>
          {#if f.status === 'friend'}
            <button class="btn primary" disabled={!f.online || inCall} aria-label="Call {label(f)}" title="Call" onclick={() => p2p.callFriend(f.key)}><Icon name="phone" size={16} />{#if !panel}Call{/if}</button>
          {/if}
          <button class="icon-btn" aria-label="Rename" title="Rename" onclick={() => rename(f.key, f.name)}><Icon name="pen" size={16} /></button>
          <button class="icon-btn" aria-label="Remove" title="Remove" onclick={() => remove(f.key, label(f))}><Icon name="trash" size={16} /></button>
        </div>
      {/each}
    </section>
  {/if}
{/snippet}

{#if panel}
  <aside class="panel" aria-label="Friends">
    {#if view === 'code'}<h3 class="ptitle">Your friend code</h3>{/if}
    {@render body()}
  </aside>
{:else}
<Modal title={view === 'code' ? 'Your friend code' : view === 'add' ? 'Add a friend' : 'Friends'} onclose={() => (p2p.open = false)} width={560}>
  {@render body()}
</Modal>
{/if}

{#if card}<FriendCard friendKey={card} onclose={() => (card = null)} />{/if}

<style>
  /* The panel on the right of the start page: always there, a column of its own */
  .panel {
    flex: none; width: clamp(280px, 28vw, 360px); box-sizing: border-box; overflow-y: auto; padding: 24px 20px;
    background-color: color-mix(in srgb, var(--bg-1) var(--panel-solid, 100%), transparent);
    background-image: linear-gradient(rgb(0 0 0 / var(--panel-shade, 0)), rgb(0 0 0 / var(--panel-shade, 0)));
    backdrop-filter: blur(var(--panel-blur, 0px));
    border: 1px solid var(--line);
  }
  .panel .person { gap: 8px; }
  /* Headed like the servers container: a title, then its controls */
  .panel .head { flex-direction: column; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
  .panel .head h3 { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; text-transform: none; color: var(--text); }
  .panel .actions { margin-left: 0; flex-wrap: wrap; }
  .ptitle { margin-top: 0; }
  /* A narrow window has no room for it (the Friends button in the side bar opens the window instead) */
  @media (max-width: 760px) { .panel { display: none; } }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .head h3 { margin: 0; }
  .actions { display: flex; gap: 8px; margin-left: auto; }
  .back { margin-bottom: 4px; }
  .search { width: 100%; box-sizing: border-box; margin-bottom: 6px; }
  section { margin-top: 18px; }
  h3 { margin: 0 0 8px; font-size: 12px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); }
  .code { font-family: var(--mono); font-size: 13px; line-height: 1.6; padding: 10px 12px; background: var(--bg-0); border: 1px solid var(--line); word-break: break-all; user-select: all; }
  .row { display: flex; gap: 8px; margin-top: 8px; }
  .hint { margin: 8px 0 0; font-size: 13px; color: var(--text-dim); }
  .error { margin: 8px 0 0; font-size: 13px; color: var(--danger); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-faint); flex: none; }
  .dot.on { background: var(--success); }
  .toggle { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .startup { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-dim); cursor: pointer; }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; color: var(--text-dim); }
  form { display: flex; gap: 8px; flex-wrap: wrap; }
  form input { flex: 1 1 200px; min-width: 0; }
  .person { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
  .person + .person { border-top: 1px solid var(--line); }
  .hit { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 0; background: none; border: 0; color: inherit; text-align: left; font: inherit; cursor: pointer; }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
  .who strong, .who span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who span { font-size: 13px; color: var(--text-dim); }
  .who .key { font-family: var(--mono); font-size: 12px; color: var(--text-faint); }
  .face { position: relative; flex: none; display: inline-flex; }
  .pip { position: absolute; right: -2px; bottom: -2px; width: 11px; height: 11px; border-radius: 50%; background: var(--text-faint); border: 2px solid var(--bg-1); }
  .pip.on { background: var(--success); }
</style>
