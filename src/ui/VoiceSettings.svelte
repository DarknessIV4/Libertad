<script lang="ts">
  import { onDestroy } from 'svelte';
  import { voice, type TransmitMode, type Detector } from '../lib/audio/voice.svelte.ts';
  import { session, sessions } from '../lib/session.svelte.ts';
  import type { NoiseEngine } from '../lib/audio/noise.ts';

  function setForceTcp(on: boolean) {
    voice.update({ forceTcp: on });
    for (const s of sessions.list) if (s.client) s.client.forceTcp = on;
  }

  const s = voice.settings;
  let capturing = $state(false);

  // Opening the settings starts audio so the meter and device names work before connecting
  // The level meter below needs the microphone even when it is muted
  voice.holdMeter(true);
  voice.start();
  onDestroy(() => { voice.holdMeter(false); if (voice.testing) voice.setTesting(false); if (session.status !== 'connected') voice.stop(); });

  const METER_MIN = -80;
  const pct = (db: number) => Math.max(0, Math.min(100, ((db - METER_MIN) / -METER_MIN) * 100));
  const open = $derived(voice.speech);
  // RNNoise and Silero rate speech as a probability; the others go by loudness
  const byProb = $derived(s.detector === 'rnnoise' || s.detector === 'silero');

  const keyName = (code: string) => code
    .replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ')
    .replace('Backquote', 'Backtick (`)').replace(/([a-z])([A-Z])/g, '$1 $2');

  function captureKey(e: KeyboardEvent) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code !== 'Escape') voice.update({ pttKey: e.code });
    capturing = false;
  }

  const modes: { id: TransmitMode; label: string; help: string }[] = [
    { id: 'vad', label: 'Voice activity', help: 'Sends when you speak louder than the threshold' },
    { id: 'ptt', label: 'Push to talk', help: 'Sends while you hold the key' },
    { id: 'continuous', label: 'Always on', help: 'Sends all the time' }
  ];
</script>

<svelte:window onkeydowncapture={captureKey} />

<div class="voice">
  {#if voice.error}<p class="error">{voice.error}</p>{/if}
  {#if voice.notice}<p class="help">{voice.notice}</p>{/if}

  <h3>Devices</h3>
  <div class="grid">
    <div>
      <label for="v-in">Microphone</label>
      <select id="v-in" value={s.inputDevice} onchange={e => voice.update({ inputDevice: e.currentTarget.value })}>
        {#each voice.inputDevices as d (d.id)}<option value={d.id}>{d.label}</option>{:else}<option value="default">System default</option>{/each}
      </select>
    </div>
    <div>
      <label for="v-out">Speakers / headphones</label>
      <select id="v-out" value={s.outputDevice} onchange={e => voice.update({ outputDevice: e.currentTarget.value })}>
        {#each voice.outputDevices as d (d.id)}<option value={d.id}>{d.label}</option>{:else}<option value="default">System default</option>{/each}
      </select>
    </div>
  </div>

  <h3>Transmit</h3>
  <div class="modes" role="radiogroup" aria-label="Transmit mode">
    {#each modes as m (m.id)}
      <button role="radio" aria-checked={s.mode === m.id} class:active={s.mode === m.id} onclick={() => voice.update({ mode: m.id })}>
        <strong>{m.label}</strong><small>{m.help}</small>
      </button>
    {/each}
  </div>

  {#if s.mode === 'ptt'}
    <label for="v-ptt">Push-to-talk key</label>
    <div class="row">
      <button id="v-ptt" class="btn key" class:capturing onclick={() => (capturing = true)}>
        {capturing ? 'Press a key... (Esc cancels)' : keyName(s.pttKey)}
      </button>
      <span class="hint" class:on={voice.pttDown}>{voice.pttDown ? 'Talking' : 'Hold the key to talk'}</span>
    </div>
    <p class="help">Works while Libertad is focused. System-wide push to talk is planned.</p>
  {/if}

  {#if s.mode === 'vad'}
    <label for="v-det">Voice detection</label>
    <select id="v-det" value={s.detector} onchange={e => voice.update({ detector: e.currentTarget.value as Detector })}>
      <option value="standard">Standard: Normal</option>
      <option value="gate">Noise gate: Good</option>
      <option value="rnnoise">RNNoise probability: Good</option>
      <option value="silero">Silero VAD: Best</option>
    </select>
    <p class="help">{s.detector === 'standard' ? 'Sends when the sound is louder than the threshold.'
      : s.detector === 'gate' ? 'Like Standard, but it closes lower than it opens and fades the sound in and out, so there are fewer cut-offs and clicks.'
      : s.detector === 'rnnoise' ? 'Sends when RNNoise judges that it is speech, not just loud. Light on the processor.'
      : 'Sends when Silero judges that it is speech, not just loud. The most accurate; the model loads the first time it is used.'}</p>
  {/if}

  <label for="v-level">Input level{s.mode === 'vad' ? (byProb ? ' and speech' : ' and threshold') : ''}</label>
  <div class="meter" class:open={s.mode !== 'vad' || open} aria-hidden="true">
    <div class="level-bar" style:width="{pct(voice.level)}%"></div>
    {#if s.mode === 'vad' && !byProb}<div class="mark" style:left="{pct(s.vadThreshold)}%"></div>{/if}
  </div>
  {#if voice.level <= -99}<p class="help">{voice.diag || 'Audio engine not running'}</p>{/if}
  {#if s.mode === 'vad'}
    {#if byProb}
      <input id="v-level" type="range" min="5" max="95" step="1" value={s.speechThreshold}
        oninput={e => voice.update({ speechThreshold: Number(e.currentTarget.value) })} aria-label="Speech threshold" />
      <p class="help">Speak normally; the bar turns green when it hears speech. Needs {s.speechThreshold}% certainty: lower catches quieter speech, higher lets less noise through.</p>
    {:else}
      <input id="v-level" type="range" min={METER_MIN} max="0" step="1" value={s.vadThreshold}
        oninput={e => voice.update({ vadThreshold: Number(e.currentTarget.value) })} aria-label="Voice activity threshold" />
      <p class="help">Speak normally and put the marker just below your voice; the bar turns green when you would be sending. Threshold {s.vadThreshold} dB.</p>
    {/if}
    <label for="v-hold">Keep sending after speech: {s.vadHoldMs} ms</label>
    <input id="v-hold" type="range" min="100" max="1500" step="50" value={s.vadHoldMs}
      oninput={e => voice.update({ vadHoldMs: Number(e.currentTarget.value) })} />
  {/if}

  <div class="grid">
    <div>
      <label for="v-gain">Microphone volume: {Math.round(s.inputGain * 100)}%</label>
      <input id="v-gain" type="range" min="0" max="3" step="0.05" value={s.inputGain}
        oninput={e => voice.update({ inputGain: Number(e.currentTarget.value) })} />
    </div>
    <div>
      <label for="v-vol">Output volume: {Math.round(s.outputVolume * 100)}%</label>
      <input id="v-vol" type="range" min="0" max="2" step="0.05" value={s.outputVolume}
        oninput={e => voice.update({ outputVolume: Number(e.currentTarget.value) })} />
    </div>
  </div>

  <div class="row test">
    <button class="btn" class:primary={voice.testing} onclick={() => voice.setTesting(!voice.testing)}>
      {voice.testing ? 'Stop test' : 'Test microphone'}
    </button>
    <span class="help">{voice.testing ? 'You should hear yourself. Use headphones to avoid feedback.' : 'Plays your microphone back to you'}</span>
  </div>

  <h3>Processing</h3>
  <label class="check"><input type="checkbox" checked={s.releaseMicMuted} onchange={e => voice.update({ releaseMicMuted: e.currentTarget.checked })} /> Give the microphone back while muted</label>
  <p class="help">For Bluetooth headsets: with the microphone open, a headset switches to its telephone mode and everything sounds like a phone call. Muted, you then hear in full quality. To talk in full quality too, choose the phone's own microphone above instead of the headset's. No reminder when you speak while muted.{#if s.releaseMicMuted && voice.running} <strong>{voice.micOpen ? 'The microphone is open now.' : 'The microphone is given back now.'}</strong>{/if}</p>
  <label class="check"><input type="checkbox" checked={s.noiseSuppression} onchange={e => voice.update({ noiseSuppression: e.currentTarget.checked })} /> Noise suppression</label>
  <label for="v-ns">Noise suppression engine</label>
  <select id="v-ns" value={s.noiseEngine} disabled={!s.noiseSuppression} onchange={e => voice.update({ noiseEngine: e.currentTarget.value as NoiseEngine })}>
    <option value="speex">Speex: Lightest</option>
    <option value="rnnoise">RNNoise: Medium</option>
    <option value="deepfilter">DeepFilterNet3: Heaviest</option>
  </select>
  {#if s.noiseEngine === 'rnnoise'}
    <label for="v-ns-set">Strength: {s.rnnoiseStrength}%</label>
    <input id="v-ns-set" type="range" min="0" max="100" step="5" value={s.rnnoiseStrength} disabled={!s.noiseSuppression}
      oninput={e => voice.update({ rnnoiseStrength: Number(e.currentTarget.value) })} />
    <p class="help">How much of the cleaned voice is mixed in. 100% removes the most noise; lower keeps more of the original sound.</p>
  {:else if s.noiseEngine === 'speex'}
    <label for="v-ns-set">Noise reduction: {-s.speexLevel} dB</label>
    <input id="v-ns-set" type="range" min="-60" max="-5" step="1" value={s.speexLevel} disabled={!s.noiseSuppression}
      oninput={e => voice.update({ speexLevel: Number(e.currentTarget.value) })} />
    <p class="help">Higher removes more noise but can make the voice sound thin or watery.</p>
  {:else}
    <label for="v-ns-set">Noise reduction: up to {s.dfLevel} dB</label>
    <input id="v-ns-set" type="range" min="6" max="100" step="1" value={s.dfLevel} disabled={!s.noiseSuppression}
      oninput={e => voice.update({ dfLevel: Number(e.currentTarget.value) })} />
    <p class="help">The most noise the model may remove. Higher is cleaner; around 100 can sound choppy. Needs the most processing.</p>
  {/if}
  <label class="check"><input type="checkbox" checked={s.echoCancellation} onchange={e => voice.update({ echoCancellation: e.currentTarget.checked })} /> Echo cancellation (for speakers instead of headphones)</label>
  <label class="check"><input type="checkbox" checked={s.autoGainControl} onchange={e => voice.update({ autoGainControl: e.currentTarget.checked })} /> Automatic gain control</label>

  <h3>Quality</h3>
  <div class="grid">
    <div>
      <label for="v-br">Bitrate: {Math.round(s.bitrate / 1000)} kbit/s</label>
      <input id="v-br" type="range" min="8000" max="128000" step="4000" value={s.bitrate}
        oninput={e => voice.update({ bitrate: Number(e.currentTarget.value) })} />
      {#if voice.effectiveBitrate && voice.effectiveBitrate < s.bitrate && session.status === 'connected'}
        <p class="help warn">Limited to {Math.round(voice.effectiveBitrate / 1000)} kbit/s by this server</p>
      {/if}
    </div>
    <div>
      <label for="v-frame">Audio per packet</label>
      <select id="v-frame" value={String(s.frameMs)} onchange={e => voice.update({ frameMs: Number(e.currentTarget.value) as 10 | 20 | 40 | 60 })}>
        <option value="10">10 ms (lowest latency)</option>
        <option value="20">20 ms (recommended)</option>
        <option value="40">40 ms</option>
        <option value="60">60 ms (least bandwidth)</option>
      </select>
    </div>
  </div>
  <label class="check"><input type="checkbox" checked={s.forceTcp} onchange={e => setForceTcp(e.currentTarget.checked)} /> Send voice over TCP only (for networks that block or mangle UDP)</label>
  <label for="v-jit">Jitter buffer: {s.jitterMs} ms</label>
  <input id="v-jit" type="range" min="20" max="300" step="10" value={s.jitterMs}
    oninput={e => voice.update({ jitterMs: Number(e.currentTarget.value) })} />
  <p class="help">Higher values smooth out bad connections at the cost of delay.</p>

  {#if session.status === 'connected'}
    <h3>Statistics</h3>
    {@const t = session.voiceTransport}
    <p class="help stats">Sent {voice.stats.sent} packets, received {voice.stats.received}, decoded {voice.stats.decoded}, gaps {voice.stats.lost}. Transport: {t.udp ? `UDP, ${Math.round(t.rtt)} ms ping` : 'TCP tunnel'}.</p>
  {/if}
</div>

<style>
  h3 { margin: 24px 0 0; font-size: 15px; font-weight: 650; }
  h3:first-of-type { margin-top: 8px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  .modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 8px; }
  @media (max-width: 560px) { .modes { grid-template-columns: 1fr; } }
  .modes button { display: flex; flex-direction: column; gap: 2px; padding: 10px; text-align: left; background: var(--bg-0); border: 1px solid var(--line); }
  .modes button.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .modes small { color: var(--text-dim); font-size: 12px; }
  .row { display: flex; align-items: center; gap: 12px; }
  .key { min-width: 160px; }
  .key.capturing { border-color: var(--accent); color: var(--accent-hover); }
  .hint { font-size: 13px; color: var(--text-dim); }
  .hint.on { color: var(--speaking); font-weight: 600; }
  .meter { position: relative; height: 12px; background: var(--bg-0); border: 1px solid var(--line); overflow: hidden; }
  .level-bar { height: 100%; position: static; z-index: auto; background: var(--text-faint); transition: width 50ms linear; }
  .meter.open .level-bar { background: var(--speaking); }
  .mark { position: absolute; top: -1px; bottom: -1px; width: 2px; background: var(--warn); }
  input[type=range] { padding: 0; border: 0; background: transparent; accent-color: var(--accent); }
  .test { margin-top: 14px; }
  .check { display: flex; align-items: center; gap: 8px; text-transform: none; font-weight: 400; letter-spacing: 0; font-size: 14px; color: var(--text); margin-top: 10px; }
  .help { margin: 6px 0 0; font-size: 13px; color: var(--text-dim); }
  .warn { color: var(--warn); }
  .error { color: var(--danger); margin: 8px 0 0; }
</style>
