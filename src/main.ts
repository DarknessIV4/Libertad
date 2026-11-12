import './lib/migrate-old-name.ts';
import { mount } from 'svelte';
// Inter, bundled: the font files are served by the app itself
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/inter/wght-italic.css';
import './app.css';
import App from './App.svelte';
// After the components' styles, so themes override them
import './themes.css';
import './rounded.css';
import './glass.css';
import { startTray } from './lib/tray.svelte.ts';
import { startTextMenu } from './lib/text-menu.ts';
import { startShortcuts } from './lib/shortcuts.svelte.ts';
import { startHints } from './lib/hints.ts';
import { isWeb } from './lib/native.ts';
import { proxyInfo } from './lib/web.svelte.ts';
import { youtubeAccount } from './lib/youtube-account.svelte.ts';
import { serverStatus } from './lib/server-status.svelte.ts';

if (isWeb) proxyInfo.load();

mount(App, { target: document.getElementById('app')! });
startTray();
startShortcuts();
startTextMenu();
startHints();
serverStatus.start();
youtubeAccount.refresh();
