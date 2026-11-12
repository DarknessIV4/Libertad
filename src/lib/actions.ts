import { session, sessions } from './session.svelte.ts';
import { share } from './share.svelte.ts';
import { ui } from './ui.svelte.ts';
import { store } from './settings.svelte.ts';
import { voice, userKey } from './audio/voice.svelte.ts';
import { sounds } from './audio/sounds.svelte.ts';
import { menu, type MenuItem } from './menu.svelte.ts';
import { ownCard, ownProfile, cardSource } from './banner.svelte.ts';
import { bgPause } from './still.svelte.ts';
import { hiddenCards } from './hidden-cards.svelte.ts';
import { pickColor, pickFile } from './pick.ts';
import { setBannerFromFile } from './banner-actions.ts';
import { imageEditor, EDITABLE_OR_GIF } from './image-editor.svelte.ts';
import { PERM, type Channel, type User } from '../core/client.ts';

// A person's profile card, next to the element that was clicked (or at a point, from a menu)
export function openProfile(user: number, at: Element | { x: number; y: number }): void {
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
  session.loadComment(user);
  ui.profile = { session: user, anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, el: at instanceof Element ? at : undefined };
}

// Right-click menu for a channel in the tree
export function channelMenu(c: Channel): MenuItem[] {
  const here = session.self?.channelId === c.id;
  const mine = session.self?.channelId ?? 0;
  // Greyed out only when the server said no; unknown permissions stay enabled
  const no = (bit: number) => session.can(c.id, bit) === false;
  const linked = c.links.has(mine);
  const manage: MenuItem[] = [
    { separator: true, label: '' },
    { label: 'Create channel...', disabled: no(PERM.MakeChannel) && no(PERM.MakeTempChannel), action: () => (ui.channelDialog = { mode: 'create', parent: c.id }) },
    { label: 'Edit channel...', disabled: no(PERM.Write), action: () => (ui.channelDialog = { mode: 'edit', id: c.id }) },
    { label: 'Permissions...', disabled: no(PERM.Write), action: () => (ui.channelDialog = { mode: 'edit', id: c.id, tab: 'permissions' }) }
  ];
  if (!here) {
    manage.push(linked
      ? { label: 'Unlink from my channel', disabled: no(PERM.LinkChannel), action: () => session.client?.setLinks(c.id, [], [mine]) }
      : { label: 'Link to my channel', disabled: no(PERM.LinkChannel), action: () => session.client?.setLinks(c.id, [mine], []) });
  }
  if (c.links.size) manage.push({ label: 'Unlink all', disabled: no(PERM.LinkChannel), action: () => session.client?.setLinks(c.id, [], [...c.links]) });
  if (c.id !== 0) {
    manage.push({
      label: 'Delete channel...', danger: true, disabled: no(PERM.Write),
      action: () => (ui.prompt = {
        title: `Delete ${c.name}?`, label: '', confirm: 'Delete channel', danger: true, input: 'none',
        text: 'The channel, its subchannels and their permissions are removed for everyone. People inside are moved out.',
        onsubmit: () => { session.client?.removeChannel(c.id); sounds.play('channelDeleted'); }
      })
    });
  }
  // A text channel is opened, not joined
  const open: MenuItem[] = session.isText(c.id)
    ? [{ label: 'Open text channel', action: () => session.selectView(`ch:${c.id}`) }]
    : [
      { label: here ? 'You are here' : 'Join channel', action: () => session.joinChannel(c.id), disabled: here || !c.canEnter },
      // Opens the channel's chat in the side panel, ready to type, without joining it
      { label: 'Send message to channel', action: () => { session.showChannel(c.id, 'chat'); ui.panelOpen = true; } }
    ];
  return [
    { header: true, label: c.name || 'Root' },
    ...open,
    // The tree shows it next to the channel; the Rooms interface has no tree and uses its panel
    { label: 'Show description', action: () => {
      if (store.settings.interface === 'rooms') { session.showChannel(c.id, 'info'); ui.panelOpen = true; }
      else ui.channelPreview = { id: c.id, ...menu.last };
    } },
    { separator: true, label: '' },
    { label: session.isExpanded(c.id) ? 'Collapse' : 'Expand', action: () => session.toggleExpanded(c.id), disabled: c.id === 0 },
    { label: 'Expand all', action: () => session.setAllExpanded(true) },
    { label: 'Collapse all', action: () => session.setAllExpanded(false) },
    { separator: true, label: '' },
    { label: 'Copy channel name', action: () => navigator.clipboard.writeText(c.name || 'Root') },
    ...manage
  ];
}

// Right-click menu for a user. Moderation entries are always offered; the server decides
// whether we may use them and answers with a permission denial otherwise.
// card: the menu of the profile card itself, which is not the user's menu in the lists. There is no "View profile"
// (it is the profile), nothing about the user card (its background, hiding it), and your own mute and deafen stay
// out; the choices for your avatar, banner and profile card take their place.
export interface CardChoices { avatar: () => void; background: () => void; color: () => void; remove?: () => void }
export function userMenu(u: User, card?: CardChoices): MenuItem[] {
  const self = session.self;
  const isSelf = u.session === self?.session;
  const items: MenuItem[] = [{ header: true, label: store.displayName(u) }];
  if (!card) items.push({ label: 'View profile', action: () => openProfile(u.session, menu.last) });
  // Only on this computer: their tile leaves your voice view. Unhide it here, from the channel list.
  if (!isSelf && !card) items.push({ label: 'Hide card', checked: hiddenCards.has(u), action: () => hiddenCards.set(u, !hiddenCards.has(u)) });
  if (isSelf) {
    if (!card) {
      items.push(
        { label: 'Change Card Background', action: () => menu.showAt(menu.last.x, menu.last.y, cardBackgroundMenu()) },
        pauseBackgroundItem(u),
        { label: 'Mute', checked: u.selfMute, action: () => session.setSelfMute(!u.selfMute) },
        { label: 'Deafen', checked: u.selfDeaf, action: () => session.setSelfDeaf(!u.selfDeaf) }
      );
    }
    items.push({ label: 'Change name...', action: () => changeNamePrompt(u) });
    if (card) {
      items.push(
        { label: 'Change avatar...', action: card.avatar },
        { label: 'Add a background', action: card.background },
        { label: 'Add a color', action: card.color }
      );
      if (card.remove) items.push({ label: 'Remove profile card', danger: true, action: card.remove });
    }
    if (u.userId == null) items.push({ label: 'Register on this server', action: () => session.register(u.session) });
  } else {
    const sharing = session.sharing[u.session];
    if (sharing === 'camera') {
      // Cameras show by themselves; this is the per-person switch
      const hidden = share.isHidden(sessions.active, u.session) || !share.watchOf(u.session);
      items.push({ label: hidden ? 'Show camera' : 'Hide camera', action: () => share.hideCamera(sessions.active, u.session, !hidden) });
    } else if (sharing) items.push({ label: `Watch ${sharing}`, action: () => share.watch(sessions.active, u.session) });
    items.push(
      ...(card ? [] : [pauseBackgroundItem(u)]),
      { label: 'Send message', action: () => session.selectView(`dm:${u.session}`) },
      { label: 'Mute for me', checked: !!voice.settings.localMutes[userKey(u)], action: () => voice.setLocalMute(u, !voice.settings.localMutes[userKey(u)]) },
      {
        label: 'Volume',
        slider: {
          value: voice.settings.userVolumes[userKey(u)] ?? 1, min: 0, max: 3, step: 0.05,
          format: v => `${Math.round(v * 100)}%`,
          oninput: v => voice.setUserVolume(u, v)
        }
      },
      { label: 'Set nickname...', action: () => nicknamePrompt(u) }
    );
    if (self && u.channelId !== self.channelId) {
      items.push({ label: 'Move to my channel', action: () => session.moveUser(u.session, self.channelId) });
    }
  }
  items.push(
    { separator: true, label: '' },
    { label: 'Server mute', checked: u.mute, action: () => session.setServerMute(u.session, !u.mute) },
    { label: 'Server deafen', checked: u.deaf, action: () => session.setServerDeaf(u.session, !u.deaf) },
    { label: 'Priority speaker', checked: u.prioritySpeaker, action: () => session.setPrioritySpeaker(u.session, !u.prioritySpeaker) }
  );
  if (!isSelf && u.userId == null) items.push({ label: 'Register user', action: () => session.register(u.session) });
  if (!isSelf) {
    items.push(
      { separator: true, label: '' },
      { label: 'Kick...', danger: true, action: () => (ui.prompt = { title: `Kick ${u.name}`, label: 'Reason (optional)', confirm: 'Kick', danger: true, onsubmit: r => session.kick(u.session, r) }) },
      { label: 'Ban...', danger: true, action: () => (ui.prompt = { title: `Ban ${u.name}`, label: 'Reason (optional)', confirm: 'Ban', danger: true, onsubmit: r => session.kick(u.session, r, true) }) }
    );
  }
  items.push({ separator: true, label: '' }, { label: 'Copy name', action: () => navigator.clipboard.writeText(u.name) });
  if (u.hash) items.push({ label: 'Copy certificate hash', action: () => navigator.clipboard.writeText(u.hash) });
  items.push({ separator: true, label: '' }, { label: 'Information', action: () => (ui.userInfo = u.session) });
  return items;
}

// Pause Background: only on this computer, nobody else sees a change. Checked while this person's
// background is stopped; a click then brings it back, otherwise it asks what to stop.
function pauseBackgroundItem(u: User): MenuItem {
  const paused = bgPause.paused(u);
  return {
    label: 'Pause Background', checked: paused,
    action: () => {
      if (paused) {
        bgPause.setUser(u, false);
        bgPause.setAll(false);
        return;
      }
      menu.showAt(menu.last.x, menu.last.y, [
        { header: true, label: 'Pause Background' },
        { label: 'Stop for this user', action: () => bgPause.setUser(u, true) },
        { label: 'Stop for all users', action: () => bgPause.setAll(true) }
      ]);
    }
  };
}

// The picture behind your tile (the user card): a color, or a picture, GIF or video of its own, or your banner
export function cardBackgroundMenu(): MenuItem[] {
  const own = ownCard.value;
  const profile = ownProfile.value && ownProfile.value.kind !== 'color' ? ownProfile.value : null;
  const add = async () => {
    const f = await pickFile('image/*,video/mp4,video/webm');
    if (!f) return;
    // Like every other background: a picture or GIF is cropped, turned, darkened and blurred first. A video is used as it is.
    let use: File = f, keepShape = false;
    if (EDITABLE_OR_GIF.test(f.type)) {
      const r = await imageEditor.open(f, { effects: true, scopes: false, title: 'Crop card background' });
      if (!r) return;
      use = r.file;
      // A picture the person did not change keeps the usual cut; a cropped one keeps its shape
      keepShape = r.file !== f;
    }
    await setBannerFromFile('card', use, { keepShape });
  };
  return [
    { header: true, label: 'Card background' },
    { label: 'Choose a color...', action: async () => {
      const c = await pickColor(own?.kind === 'color' ? own.color : '#26282d');
      if (c) await sessions.setBanner('card', { kind: 'color', color: c.toLowerCase() });
    } },
    { label: 'Add user card...', action: add },
    { separator: true, label: '' },
    { label: 'Same as my banner', checked: !own && cardSource.from === 'banner', action: () => sessions.setCardFrom('banner') },
    // The picture of your profile card background: needs one set for that part of the card
    { label: 'Same as profile card, lower half', checked: !own && cardSource.from === 'under', disabled: profile?.scope !== 'under', action: () => sessions.setCardFrom('under') },
    { label: 'Same as whole profile card', checked: !own && cardSource.from === 'whole', disabled: profile?.scope !== 'whole', action: () => sessions.setCardFrom('whole') }
  ];
}

export function changeNamePrompt(u: User): void {
  ui.prompt = {
    title: 'Change your name', label: 'New name', confirm: 'Reconnect with this name', initial: u.name,
    text: u.userId != null
      ? 'You are registered here, so the server keeps your registered name. The new name applies on servers where you are a guest.'
      : 'Mumble cannot rename you while connected, so Libertad reconnects with the new name and remembers it for this server.',
    onsubmit: name => session.changeName(name)
  };
}

export function nicknamePrompt(u: User): void {
  ui.prompt = {
    title: `Nickname for ${u.name}`, label: 'Nickname (only you see it; empty to remove)', confirm: 'Save',
    initial: store.nicknames[userKey(u)] ?? '',
    onsubmit: nick => store.setNickname(userKey(u), nick)
  };
}

