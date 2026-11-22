import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { h264CodecOf, h264Sps } from '../../src/lib/android-capture.ts';

// The page side of screen sharing (src/lib/android-capture.ts), run in a real Chromium: a fake source stands in for the
// Java encoder and produces VP8 frames of a known colour; getDisplayMedia() must hand back a live video track showing them,
// and stopping, refusal and a native stop must behave. Skipped when Playwright / Chromium are not installed.
const require = createRequire(import.meta.url);
let chromium: { launch(o?: object): Promise<any> } | null = null;
try { chromium = require('playwright').chromium; } catch { try { chromium = require('playwright-core').chromium; } catch { /* skipped below */ } }

test('h264CodecOf reads the profile and level from the SPS', () => {
  const sps = Uint8Array.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9]);
  assert.equal(h264CodecOf(sps), 'avc1.64001f');
  assert.equal(h264CodecOf(Uint8Array.from([0, 0, 1, 0x67, 0x42, 0xc0, 0x1e, 1, 2, 3])), 'avc1.42c01e');
  assert.equal(h264CodecOf(Uint8Array.from([0, 0, 0, 1, 0x65, 1, 2, 3, 4, 5, 6, 7])), null);
});

async function makeBundle(): Promise<string> {
  const bundle = await build({
    stdin: {
      contents: `
        import { installAndroidDisplayMedia } from './src/lib/android-capture.ts';
        import { installAndroidCameraKeeper } from './src/lib/android-camera.ts';
        window.keeper = (calls) => installAndroidCameraKeeper(async () => ({ setCamera: async (o) => { calls.push(o.on); } }));
        window.installed = (mode) => {
          let handlers; let encoder; let timer; const log = [];
          const source = {
            async start(options, h) {
              if (mode === 'refuse') throw new DOMException('Permission denied', 'NotAllowedError');
              handlers = h; log.push('start');
              let w = 320, h2 = 180;
              var c = new OffscreenCanvas(w, h2); const x = c.getContext('2d');
              encoder = new VideoEncoder({
                output: (chunk) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); handlers.frame({ key: chunk.type === 'key', ts: chunk.timestamp, data: d }); },
                error: (e) => log.push('enc ' + e)
              });
              encoder.configure({ codec: 'vp8', width: w, height: h2, bitrate: 500000, framerate: 15 });
              var n = 0;
              timer = setInterval(() => {
                x.fillStyle = '#ff0000'; x.fillRect(0, 0, w, h2);
                const f = new VideoFrame(c, { timestamp: n * 66000 }); encoder.encode(f, { keyFrame: n % 15 === 0 }); f.close(); n++;
              }, 66);
              if (mode === 'audio') {
                let t = 0; const pcm = new Int16Array(960 * 2);
                const sound = setInterval(() => { for (let i = 0; i < 960; i++) { const v = Math.round(Math.sin(2 * Math.PI * 440 * (t++) / 48000) * 12000); pcm[2 * i] = v; pcm[2 * i + 1] = v; } handlers.audio(new Uint8Array(pcm.slice().buffer)); }, 20);
                const prev = source.stop; source.stop = async () => { clearInterval(sound); await prev(); };
              }
              if (mode === 'rotate') {
                // like the phone turning: a new encoder of another size, first frame a keyframe
                setTimeout(() => {
                  encoder.close(); w = 180; h2 = 320;
                  encoder = new VideoEncoder({ output: (chunk) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); handlers.frame({ key: chunk.type === 'key', ts: chunk.timestamp, data: d }); }, error: () => {} });
                  encoder.configure({ codec: 'vp8', width: w, height: h2, bitrate: 500000, framerate: 15 });
                  c.width = w; c.height = h2; n = 0;
                }, 700);
              }
              return { width: w, height: h2, codec: 'vp8', audio: mode === 'audio' };
            },
            async stop() { log.push('stop'); clearInterval(timer); }
          };
          if (mode !== 'keep') navigator.mediaDevices.getDisplayMedia = undefined;
          installAndroidDisplayMedia(source);
          window.nativeStop = () => { clearInterval(timer); handlers.stopped(); };
          window.log = log;
        };`,
      resolveDir: process.cwd(), sourcefile: 'entry.ts', loader: 'ts'
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022'
  });
  return bundle.outputFiles[0].text;
}

const launch = () => chromium!.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
async function openPage(browser: any, code: string) {
  const page = await browser.newPage();
  // mediaDevices only exists on a secure origin
  await page.route('https://libertad.test/', (r: { fulfill(o: object): unknown }) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>t</title>' }));
  await page.goto('https://libertad.test/');
  await page.evaluate(code);
  return page;
}

test('a different SPS (rotation) gives a different fingerprint', () => {
  const a = h264Sps(Uint8Array.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0, 0, 0, 1, 0x68, 0xee]));
  const b = h264Sps(Uint8Array.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x41, 0, 0, 0, 1, 0x68, 0xee]));
  assert.equal(a?.codec, 'avc1.64001f');
  assert.equal(a?.key, '6764001facd940');
  assert.notEqual(a?.key, b?.key);
});

test('getDisplayMedia on top of a native source', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const code = await makeBundle();
  const browser = await launch();
  try {
    const page = await openPage(browser, code);

    // 1. a normal capture shows the colour the encoder produced
    await page.evaluate(() => (window as any).installed('ok'));
    const result = await page.evaluate(async () => {
      const w = window as any;
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
      const track = stream.getVideoTracks()[0];
      const video = document.createElement('video'); video.muted = true; video.srcObject = stream; document.body.append(video); await video.play();
      let pixel: number[] = [0, 0, 0];
      for (let i = 0; i < 40; i++) {
        await new Promise<void>(r => setTimeout(r, 100));
        if (!video.videoWidth) continue;
        const c = document.createElement('canvas'); c.width = 8; c.height = 8; const x = c.getContext('2d')!;
        x.drawImage(video, 0, 0, 8, 8); pixel = Array.from(x.getImageData(4, 4, 1, 1).data);
        if (pixel[0] > 200) break;
      }
      const sized = [video.videoWidth, video.videoHeight];
      // a second capture while one runs replaces it (a forgotten preview must not block the next capture)
      let second = '';
      let replacement: MediaStreamTrack | null = null;
      try { replacement = (await navigator.mediaDevices.getDisplayMedia({ video: true })).getVideoTracks()[0]; } catch (e) { second = (e as Error).name; }
      let ended = false; replacement?.addEventListener('ended', () => (ended = true));
      w.nativeStop(); await new Promise<void>(r => setTimeout(r, 100));
      return { pixel, sized, ended, second, state: replacement?.readyState ?? 'none', log: w.log };
    });
    assert.ok(result.pixel[0] > 200 && result.pixel[1] < 60 && result.pixel[2] < 60, `red picture expected, got ${result.pixel}`);
    assert.deepEqual(result.sized, [320, 180]);
    assert.equal(result.second, '', 'a second request replaces the first');
    assert.equal(result.ended, true, 'a native stop ends the track');
    assert.equal(result.state, 'ended');

    // 2. stopping the track stops the native side; the next capture works again
    await page.evaluate(() => { (navigator.mediaDevices as any).getDisplayMedia = undefined; (window as any).installed('ok'); });
    const stopped = await page.evaluate(async () => {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      s.getVideoTracks()[0].stop(); await new Promise<void>(r => setTimeout(r, 100));
      return (window as any).log as string[];
    });
    assert.deepEqual(stopped, ['start', 'stop']);

    // 3. a refusal reaches the caller as the browser's own error
    const refused = await page.evaluate(async () => {
      (navigator.mediaDevices as any).getDisplayMedia = undefined; (window as any).installed('refuse');
      try { await navigator.mediaDevices.getDisplayMedia({ video: true }); return 'no error'; } catch (e) { return (e as Error).name; }
    });
    assert.equal(refused, 'NotAllowedError');
  } finally {
    await browser.close();
  }
});

test('sound of the phone becomes an audio track', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const browser = await launch();
  try {
    const page = await openPage(browser, await makeBundle());
    await page.evaluate(() => { (navigator.mediaDevices as any).getDisplayMedia = undefined; (window as any).installed('audio'); });
    const r = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const ctx = new AudioContext(); await ctx.resume();
      const analyser = ctx.createAnalyser(); ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let rms = 0;
      for (let i = 0; i < 30 && rms < 0.05; i++) {
        await new Promise<void>(res => setTimeout(res, 100));
        analyser.getFloatTimeDomainData(data); rms = Math.sqrt(data.reduce((a, v) => a + v * v, 0) / data.length);
      }
      const tracks = [stream.getVideoTracks().length, stream.getAudioTracks().length];
      stream.getVideoTracks()[0].stop(); await new Promise<void>(res => setTimeout(res, 100));
      return { rms, tracks, log: (window as any).log };
    });
    assert.deepEqual(r.tracks, [1, 1]);
    assert.ok(r.rms > 0.05, `a 440 Hz tone was expected, rms ${r.rms}`);
    assert.deepEqual(r.log, ['start', 'stop']);

    // without audio asked for there is no audio track
    const plain = await page.evaluate(async () => {
      (navigator.mediaDevices as any).getDisplayMedia = undefined; (window as any).installed('ok');
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const n = s.getAudioTracks().length; s.getVideoTracks()[0].stop(); return n;
    });
    assert.equal(plain, 0);
  } finally { await browser.close(); }
});

test('a rotation (new encoder, other size) changes the picture size', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const browser = await launch();
  try {
    const page = await openPage(browser, await makeBundle());
    await page.evaluate(() => { (navigator.mediaDevices as any).getDisplayMedia = undefined; (window as any).installed('rotate'); });
    const sizes = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const video = document.createElement('video'); video.muted = true; video.srcObject = stream; document.body.append(video); await video.play();
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) { await new Promise<void>(res => setTimeout(res, 100)); if (video.videoWidth) seen.add(`${video.videoWidth}x${video.videoHeight}`); if (seen.has('180x320')) break; }
      stream.getVideoTracks()[0].stop();
      return [...seen];
    });
    assert.ok(sizes.includes('320x180') && sizes.includes('180x320'), `both sizes expected, got ${sizes}`);
  } finally { await browser.close(); }
});

test('the camera keeper tells the service while a camera is open', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const browser = await launch();
  try {
    const page = await openPage(browser, await makeBundle());
    const calls = await page.evaluate(async () => {
      const calls: boolean[] = []; (window as any).keeper(calls);
      const settle = () => new Promise<void>(res => setTimeout(res, 50));
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true }); await settle();
      const cam1 = await navigator.mediaDevices.getUserMedia({ video: true }); await settle();
      const cam2 = await navigator.mediaDevices.getUserMedia({ video: true }); await settle();
      cam1.getVideoTracks()[0].stop(); await settle();     // one is still open
      const mid = [...calls];
      cam2.getVideoTracks()[0].stop(); await settle();
      mic.getTracks().forEach(t => t.stop());
      return { mid, calls };
    });
    assert.deepEqual(calls.mid, [true], 'on once, not for the microphone, not off while one camera is left');
    assert.deepEqual(calls.calls, [true, false]);
  } finally { await browser.close(); }
});
