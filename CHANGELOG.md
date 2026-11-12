# Changelog
 
All notable changes to Libertad.

## 0.4.0 -2026-11-12

- Changed project name to Libertad, and changed icon.
- Added an update button in system settings, and an auto-update toggle, Will ask you before updating.
- Added custom background image, for the connect screen.
- added a download button in torrent together, that saves a frame and downloads it for you.
- Added playback speed for torrent together.
- Added a memo for torrent together, shows last shows watched with their seasons and episodes.
- fixes to UI and gif recents.
- added the ability to edit or delete your sent messages.
- added clear chat button on right click, for your client only.
- Added the ability to quick send a message from outside the server, (will connect you for milliseconds to send and disconnect you after sending).
- better right click menu for some panels.

## 0.3.0 - 2026-11-11

### Added

- **Watch Together**:
  - Watch YouTube videos, stream local files, and play torrent streams together in a channel.
  - Playback is synced between users for time, pause, and resume across all three sources; YouTube and local file streams also sync playback speed.
  - Built-in YouTube search and YouTube sign-in support.
  - Built-in torrent search across all Torrentio providers to find streams.
  - Automatic and manual subtitle support for torrent streams.
- **P2P file transfer over WebRTC**: Direct peer-to-peer file sharing between users, alongside improved file-saving behavior.
- **Appearance & UI customization**:
  - Custom colors in Appearance settings and custom background support.
  - Profile banners behind user pictures.
  - Rounded edges across the interface.
- **Keyboard shortcuts**.
- **Hardware acceleration** support.
- **Watching Multiple Screen Shares**: The ability to watch more than wane screen share at once, each with their respective controls, This doeasnt apply to watch together though, you can only open one watch together session as of now, but any number of screen shares.
- **Dynaimc Fps on screen shareing**: Added dynamic fps that drops the share fps when idle for a while, to preserve resources.
- **Per user screen share controls**: Any user can edit their own quality and fps for the screen share they are watching, Not exccedint the shared parameters by host.
- **Hiding Member Cards**: You can hide a member card for yourself if you didnt want to see it, Like bots cards.
- **Keyboard Shortcuts**: Added keyboard shortcuts in settings.

### Changed

- **Screen sharing**: Replaced vague bitrate settings with clearer, improved screen-sharing controls and quality options.
- **Leaving Sessions**: For Host, The ability to leave a session (Screen Share, Watch together) without ending the session.
- **UI & layout**: Multiple visual and layout overhauls, Removed classic and stacked layouts, didn't edit Group interface for mobiles.
- **Avatar & Banner Sync**: The app saves your friend's avatars and banners for you locally (so the app doeasn't repeatedly download them), and only compares their Hash to see if an update is needed.

### Fixed

- Stacked UI elements and general interface glitches.
- Banner display and hiding behavior on profile cards.
- Fullscreen button not working.
- Pop-out missing features and the inability to fullscreen it.
- App stuck on fullscreen if the host turns off the session while users were on fullscreen.
 
## 0.2.1 - 2026-11-03
 
### Changed

- Files of 256 MB and up ask where to save when you click Download, before anything is fetched, and are written straight into that file. They no longer take twice the space.
- Closing the dialog cancels the download. Free space and the drive's file size limit are checked first.
- Stopped or failed downloads delete their part file at once.
- Save errors now show on the card, and saved large files have a "Show in folder" button.
- Large files always need a click to download, whatever the auto-download setting says.
- The file size limit is 100 GB (older notes said 2 GB).
- Saving large files has been tested on Linux only.
 

## 0.2.0 - 2026-10-17
 
### Added
 
- Linux: `install.sh` and `uninstall.sh` in the `.tar.gz`. They install for one user (`~/.local`) or for everyone (`/opt`, with sudo), with a `Libertad` command and a menu entry; running the installer again updates. Uninstalling keeps settings and identities unless `--purge` is given.
- File sharing through the Mumble server itself, with no file host: any file up to 2 GB, announced in the chat with a preview picture (all that regular Mumble clients see) and sent in pieces to the Libertad users who fetch it. Small files are fetched by themselves (up to 20 MB, Settings, Chat and files). About 12 MB a minute per sender on a server with default limits; anyone who has the file can send it, and a download shares the pieces out between up to four of them. Files sent and received are kept on the computer, up to 2 GB.
- 95 more color schemes, 100 in all: six made by hand (Forest, Ember, Ocean, Plum, Paper, High contrast) and 89 generated from a hue and an accent (`npm run themes`), 64 dark and 25 light. The picker can be narrowed by name and by dark or light.
- Voice setting "Give the microphone back while muted", on by default on phones and tablets: a Bluetooth headset then stays out of its telephone mode while you are muted, so what you hear keeps its full quality.
- A second interface, "Rooms" (Settings, Appearance, Interface), made for phones first: one screen at a time with a bar for Rooms, Chat, Voice, People and You. Rooms are a list with the people inside shown inline and a Join button; your room and a mute and deafen dock stay in reach; the voice screen shows the room as tiles with large controls. Wide windows keep the rooms next to the chosen screen. It uses the same dialogs and menus as the standard interface. Not in it yet: moving channels and people by dragging.
- Text channels (Libertad only): a channel marked as a text channel in its dialog is read and written without joining it, from any voice channel. Messages travel between Libertad clients; other Mumble clients see an ordinary channel and none of the messages. The server keeps nothing: each client keeps the last 200 messages per channel and hands the last 50 to people who connect later. Everyone on the server who uses Libertad can read them.
- Channels can be dragged in front of or behind another channel, not only into one. A line shows where the channel will land, the dragged channel is dimmed, the people under a channel count as part of its drop target, and resting on a closed channel opens it.
- Voice in browsers without an audio codec of their own (Firefox on Android): a built-in Opus codec takes over there.
- Cameras of people in your channel show by themselves, like in a video call; each one can be hidden from its right-click menu, and all of them switched off with one button.
- Camera sharing, as a second source in the screen sharing dialog, and camera rounds: several people's cameras at once in the voice tiles.
- A relay for streams in the web proxy, used automatically by the browser version and, with its address entered in Settings, by the desktop app, for networks and browsers that allow no direct connection.
- Screen sharing between Libertad users in a channel: a dialog to choose the screen or window (with preview), the sound and the quality; sound from one program or the whole system on Linux through PipeWire. Viewers watch in the voice tiles, enlarge a stream like in a meeting and set its volume. Streams go directly between clients; a STUN server can be set in Settings, Voice.
- Browser version: `npm run build:web` builds the web app and a small self-hosted proxy that bridges browsers to Mumble servers on an allowlist. Identities are kept in the browser, voice goes through the TCP tunnel. See "Browser version" in the README.
- Link previews in chat: title, description and image for web links (up to two per message), fetched by this computer when turned on in Settings, Chat and files (off by default).
- Voice tiles on small windows: when the window is too narrow for the member list, the people in your voice channel appear as tiles above the chat, light up while they talk, and keep mute and deafen at hand. The tiles can be collapsed.
- Per-person volume slider (0 to 300%) directly in the user context menu. Double-click resets it to 100%.
### Changed
 
- Profile panel: the current channel sits on its own line under the name, and the badge row wraps on narrow panels.
- Profile panel: guests no longer get a "Guest" badge; registered users keep the "Registered" badge.
- Profile panel: volume, "mute for me" and nickname moved to the user context menu, which has them for every place a user appears.
- User context menu: "Information" moved to the end of the menu.
- User information dialog updates every second, so online and idle times tick live.
- Channel tree: channels no longer show an icon in front of the name; only channels you cannot enter show a lock.
- Channel details header without the channel icon.
### Removed
 
- Uploads to a f0ckm instance, its settings (upload host, key, expiry) and link previews fetched through it. Files now go through the Mumble server.
### Fixed
 
- A description preview could open after dropping a channel and stay on screen.
- Messages sent in quick, irregular bursts could still be dropped by the server's rate limit. The client now mirrors Murmur's bucket exactly (it only leaks whole seconds and restarts its timer on every message) and queues instead of losing messages.
## 0.1.0
 
- Initial version.
 
