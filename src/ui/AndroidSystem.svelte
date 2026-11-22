<script lang="ts">
  // The System tab of Settings on Android (the desktop one is about Chromium start-up flags, GPUs and updates, none of which
  // exist here). Speaker choice, and shortcuts to the Android pages that decide whether a connection survives in the background.
  import { store } from '../lib/settings.svelte.ts';
  import { speakerPref, capacitorConnectionService, setAndroidImmersive } from '../lib/android-service.ts';
  import { setAndroidSpeakerphone } from '../lib/native-android.ts';
  import { rawPipPlugin, enterPip, watchPip, pipProblem } from '../lib/android-pip.ts';
  import { withTimeout } from '../lib/capacitor-plugin.ts';

  let loud = $state(speakerPref.get());
  let error = $state('');
  let note = $state('');

  async function setLoud() {
    speakerPref.set(loud);
    error = '';
    try { await setAndroidSpeakerphone(loud); }
    catch (e) { error = `Could not switch the sound: ${(e as Error).message}`; }
  }
  const PAGES = { battery: 'Battery settings', notifications: 'Notification settings', app: 'App permissions' } as const;
  async function open(what: keyof typeof PAGES) {
    error = '';
    note = '';
    try {
      await withTimeout((await capacitorConnectionService()).openSettings({ what }), 5000, 'The phone');
      note = `Opened ${PAGES[what].toLowerCase()}. Come back to Libertad when you are done.`;
    } catch (e) {
      error = `Could not open Android settings: ${msg(e)}${/not implemented|did not answer/i.test(msg(e)) ? '. The native part of this build is old: build it again (npm run build:android, then npx cap run android).' : ''}`;
    }
  }

  // What this phone says about full screen and the small window (picture-in-picture): one tap, in words, for when either
  // does not behave. It also shows when this install was made, which tells a build that did not take from one that did.
  let report = $state('');
  let busy = $state(false);
  const say = (lines: string[]) => { report = lines.join('\n'); };
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const OLD_BUILD = 'Build the app again: npm run build:android, then npx cap run android.';
  async function check() {
    busy = true;
    const lines: string[] = [];
    try {
      const d = await withTimeout((await capacitorConnectionService()).diagnose(), 5000, 'The phone');
      lines.push(`Phone: ${d.device}, Android ${d.release} (API ${d.sdk})${d.targetSdk ? `, the app is built for API ${d.targetSdk}` : ''}`);
      if (d.webview) lines.push(`Web view: ${d.webview}`);
      if (d.cutoutTop || d.cutoutSide) lines.push(`Notch / camera hole: ${d.cutoutTop ? `${d.cutoutTop} px at the top` : ''}${d.cutoutTop && d.cutoutSide ? ', ' : ''}${d.cutoutSide ? `${d.cutoutSide} px at the side` : ''}`);
      if (d.installedAt) lines.push(`This app was installed: ${new Date(d.installedAt).toLocaleString()}`);
    } catch (e) { lines.push(`Phone: not answering (${msg(e)}). The native part of this build is old. ${OLD_BUILD}`); }
    try {
      const p = await withTimeout((await rawPipPlugin()).state(), 5000, 'The phone');
      lines.push(`Small window: ${p.supported ? 'this phone has it' : 'this phone does NOT have it'}; permission ${p.allowed ? 'on' : 'OFF (the button asks for it)'}`);
    } catch (e) { lines.push(`Small window: not in this build (${msg(e)}). ${OLD_BUILD}`); }
    say(lines);
    busy = false;
  }
  async function testFullscreen() {
    busy = true;
    say(['Full screen for 3 seconds...']);
    try {
      const on = await setAndroidImmersive(true, false);
      await new Promise(r => setTimeout(r, 3000));
      await setAndroidImmersive(false);
      const lines = [on.statusBarVisible
        ? 'The status bar was still visible' + (on.legacy ? ', even with the older way too.' : '.')
        : `The status bar was hidden${on.legacy ? ' (the older way was needed)' : ''}.`];
      if (on.offsetTop || on.offsetLeft) lines.push(`The page started ${on.offsetTop ?? 0} px from the top and ${on.offsetLeft ?? 0} px from the left of the screen: the notch area was not covered.`);
      else if (on.offsetTop === 0) lines.push('The page reached the corner of the screen (notch area covered).');
      say(lines);
    } catch (e) {
      await setAndroidImmersive(false).catch(() => {});
      say([`Full screen failed: ${msg(e)}`]);
    }
    busy = false;
  }
  // A small picture of its own, so there is something to show in the small window (nothing else is on screen while testing)
  async function testPip() {
    busy = true;
    say(['Asking for the small window...']);
    const el = document.createElement('div');
    el.textContent = 'Libertad: the small window works';
    el.style.cssText = 'position:fixed;left:-9999px;top:0;width:160px;height:90px;display:flex;align-items:center;justify-content:center;text-align:center;color:#fff;background:#222;font:600 16px sans-serif';
    document.body.appendChild(el);
    let seen = false;
    let cleaned = false;
    let stop = () => {};
    const timer = setTimeout(() => cleanup(), 5 * 60 * 1000);
    function cleanup() { if (cleaned) return; cleaned = true; clearTimeout(timer); stop(); el.remove(); }
    stop = watchPip(on => { if (on) seen = true; else if (seen) cleanup(); });
    try {
      const r = await withTimeout(enterPip(() => ({ el, width: 16, height: 9, running: false })), 8000, 'The phone');
      if (r.entered) say(['It opened (the app is in the small window: tap it to come back).']);
      else if (r.reason === 'permission') say(['The permission is off: a dialog asks for it. Turn "Picture-in-picture" on for Libertad on the page it opens, and come back: the small window opens by itself.']);
      else { say([pipProblem(r) || 'It did not open.']); cleanup(); }
    } catch (e) { say([`The small window failed: ${msg(e)}. ${OLD_BUILD}`]); cleanup(); }
    busy = false;
  }
</script>

<h3>Sound output</h3>
<label class="check"><input type="checkbox" bind:checked={loud} onchange={setLoud} /> Play through the loudspeaker</label>
<p class="help">Off: the earpiece, like a phone call. A headset, wired or Bluetooth, is always used when it is connected. The change applies at once while you are connected.</p>

<h3>Staying connected in the background</h3>
<p class="help">While connected, Libertad runs a notification service so Android keeps it alive. Some phones (Xiaomi, Samsung, Huawei, OnePlus and others) still stop apps that are not "unrestricted". If you drop off when the screen is off, set Libertad to unrestricted under battery, and allow notifications.</p>
<div class="actions">
  <button class="btn" onclick={() => open('battery')}>Battery settings</button>
  <button class="btn" onclick={() => open('notifications')}>Notification settings</button>
  <button class="btn" onclick={() => open('app')}>App permissions</button>
</div>
{#if error}<p class="help warn">{error}</p>{:else if note}<p class="help">{note}</p>{/if}

<h3>Full screen and small window</h3>
<p class="help">If full screen keeps the status bar, or the pop-out button does nothing, these ask this phone and say what it answers.</p>
<div class="actions">
  <button class="btn" disabled={busy} onclick={check}>Check this phone</button>
  <button class="btn" disabled={busy} onclick={testFullscreen}>Test full screen</button>
  <button class="btn" disabled={busy} onclick={testPip}>Test small window</button>
</div>
{#if report}<pre class="report">{report}</pre>{/if}

<h3>Startup</h3>
<label class="check"><input type="checkbox" bind:checked={store.settings.connectOnStart} onchange={() => store.saveSettings()} /> Connect to the last channel on app startup</label>
<p class="help">When Libertad opens, it connects to the server you were last on and joins the channel you were last in.</p>

<style>
  h3 { margin: 24px 0 0; font-size: 15px; font-weight: 650; }
  .help { margin: 10px 0 0; font-size: 13px; color: var(--text-dim); }
  .help.warn { color: var(--danger); }
  .report { margin: 12px 0 0; padding: 10px 12px; white-space: pre-wrap; font: 12px/1.5 var(--mono, monospace); background: var(--bg-0); border: 1px solid var(--line); user-select: text; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
</style>
