<script lang="ts">
  // A friend's profile card: the picture, banner, card background and description they send over the friend
  // network (see p2p.svelte.ts), so it needs no server and shows what was kept even when they are away.
  import Icon from './Icon.svelte';
  import Avatar from './Avatar.svelte';
  import MediaFill from './MediaFill.svelte';
  import { p2p } from '../lib/p2p.svelte.ts';
  import { store } from '../lib/settings.svelte.ts';
  import { renderIncoming } from '../lib/html.ts';

  let { friendKey, onclose }: { friendKey: string; onclose: () => void } = $props();

  const friend = $derived(p2p.state.friends.find(f => f.key === friendKey));
  const prof = $derived(p2p.profileOf(friendKey));
  const name = $derived(friend ? friend.name || `${friend.key.slice(0, 8)}…` : '');
  const comment = $derived(prof?.text ? renderIncoming(prof.text, store.trustedHosts).html : '');
  const inCall = $derived(!!p2p.call);

  const banner = $derived(prof?.banner ?? null);
  const bannerStyle = $derived(banner?.kind === 'image' ? undefined : `background-color: ${banner?.kind === 'color' ? banner.color : 'transparent'}`);
  // A card background picture that covers the card too: under the banner, or all of it (banner included)
  const skin = $derived(prof?.profile && (prof.profile.kind === 'image' || prof.profile.kind === 'color') && prof.profile.scope ? prof.profile : null);

  // Gone when the friend is
  $effect(() => { if (!friend) onclose(); });
  const call = () => { onclose(); void p2p.callFriend(friendKey); };
</script>

<!-- Before the Friends window's own Escape, so Escape closes only the card -->
<svelte:window onkeydowncapture={e => { if (e.key === 'Escape') { e.stopPropagation(); onclose(); } }} />

{#if friend}
  <div class="scrim" role="presentation" onmousedown={onclose}></div>
  <div class="card" class:skinned={skin?.scope === 'whole'} role="dialog" aria-label="Profile of {name}">
    {#if skin?.scope === 'whole'}{#if skin.kind === 'color'}<div class="fill" style:background-color={skin.color}></div>{:else}<MediaFill class="fill" view={skin} />{/if}{/if}
    <div class="banner" style={skin?.scope === 'whole' ? undefined : bannerStyle}>
      {#if skin?.scope !== 'whole' && banner?.kind === 'image'}<MediaFill class="fill" view={banner} />{/if}
    </div>
    <div class="lower" class:skinned={skin?.scope === 'under'}>
      {#if skin?.scope === 'under'}{#if skin.kind === 'color'}<div class="fill" style:background-color={skin.color}></div>{:else}<MediaFill class="fill" view={skin} />{/if}{/if}
      <div class="top">
        <span class="pic"><Avatar name={name} size={80} src={p2p.avatarOf(friendKey)} /></span>
      </div>
      <div class="body">
        <h3>{name}</h3>
        <p class="sub">
          <span class="state"><span class="pip" class:on={friend.online}></span>{friend.status === 'pending' ? 'Waiting for them to accept' : friend.online ? 'Online' : 'Offline'}</span>
        </p>
        <div class="box">
          <h4>Description</h4>
          {#if comment}<div class="html">{@html comment}</div>
          {:else}<p class="dim">{prof ? 'No description.' : 'Their profile arrives when you are both online.'}</p>{/if}
        </div>
        <div class="actions">
          {#if friend.status === 'friend'}
            <button class="btn primary" disabled={!friend.online || inCall} onclick={call}><Icon name="phone" size={16} />Call</button>
          {/if}
          <button class="btn" onclick={onclose}>Close</button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Above the Friends window (100) and the call bar (120), under menus (200) */
  .scrim { position: fixed; inset: 0; z-index: 130; background: rgb(0 0 0 / 0.5); }
  .card {
    position: fixed; z-index: 131; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(320px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow-y: auto;
    background: var(--bg-1); border: 1px solid var(--line-strong); box-shadow: var(--shadow-modal);
  }
  .card.skinned, .lower.skinned { isolation: isolate; }
  .lower { position: relative; }
  .fill { position: absolute; inset: 0; z-index: -1; }
  .card :global(.fill) { position: absolute; inset: 0; z-index: -1; }
  .card.skinned .banner { background: none; }
  .card.skinned h3, .card.skinned .sub, .lower.skinned h3, .lower.skinned .sub { text-shadow: 0 1px 3px rgb(0 0 0 / 0.75); color: #fff; }
  .card.skinned .sub, .lower.skinned .sub { color: rgb(255 255 255 / 0.8); }
  .banner { position: relative; height: 128px; overflow: hidden; isolation: isolate; }
  .top { position: relative; height: 0; padding: 0 16px; }
  .pic { position: absolute; left: 14px; top: -108px; display: flex; border: 4px solid var(--bg-1); background: var(--bg-1); }
  .body { padding: 16px; }
  h3 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.015em; overflow-wrap: anywhere; }
  .sub { display: flex; flex-wrap: wrap; gap: 0 10px; margin: 2px 0 0; font-size: 13px; color: var(--text-dim); }
  .state { display: inline-flex; align-items: center; gap: 6px; }
  .pip { width: 9px; height: 9px; border-radius: 50%; background: var(--text-faint); }
  .pip.on { background: var(--success); }
  .box { margin-top: 14px; padding: 10px 12px 12px; background: var(--bg-0); border: 1px solid var(--line); }
  h4 { margin: 0 0 4px; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-faint); }
  .html { max-height: 220px; overflow-y: auto; font-size: 14px; overflow-wrap: anywhere; user-select: text; }
  .html :global(p) { margin: 0 0 6px; }
  .html :global(img) { max-width: 100%; }
  .dim { margin: 0; font-size: 14px; color: var(--text-dim); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
</style>
