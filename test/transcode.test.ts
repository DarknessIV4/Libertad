import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildPlaylist, ffmpegArgs, parseProbe, pickAudio, planPlayback, segmentCount, videoFilter, type MediaInfo
} from '../src/core/transcode.ts';
import { createTranscoder } from '../electron/transcode.ts';

const hevcDts: MediaInfo = {
  duration: 7200,
  video: { codec: 'hevc', profile: 'Main 10', level: 153, pixFmt: 'yuv420p10le', bitDepth: 10, width: 3840, height: 2160, hdr: true },
  audio: [
    { ord: 0, codec: 'dts', profile: 'DTS-HD MA', channels: 6, lang: 'eng', title: '', default: true },
    { ord: 1, codec: 'aac', profile: 'LC', channels: 2, lang: 'ara', title: 'Commentary', default: false }
  ]
};
const all = () => true, none = () => false;

test('ffprobe output is read into streams, HDR and audio tracks', () => {
  const info = parseProbe({
    format: { duration: '125.5' },
    streams: [
      { codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', level: 153, pix_fmt: 'yuv420p10le', width: 3840, height: 2160, color_transfer: 'smpte2084' },
      { codec_type: 'audio', codec_name: 'dts', profile: 'DTS-HD MA', channels: 6, tags: { language: 'ENG' }, disposition: { default: 1 } },
      { codec_type: 'subtitle', codec_name: 'subrip' }
    ]
  })!;
  assert.equal(info.duration, 125.5);
  assert.equal(info.video?.hdr, true);
  assert.equal(info.video?.bitDepth, 10);
  assert.equal(info.audio.length, 1);
  assert.equal(info.audio[0].lang, 'eng');
  assert.equal(parseProbe({ nonsense: 1 }), null);
});

test('direct play only when container, picture and first voice are all playable', () => {
  assert.equal(planPlayback(hevcDts, 'a.mkv', none).direct, false);
  assert.match(planPlayback(hevcDts, 'a.mkv', none).reason, /HEVC/);
  // Hardware HEVC but DTS: the sound is what fails
  const hevcOk = (m: string) => /hvc1/.test(m);
  assert.match(planPlayback(hevcDts, 'a.mkv', hevcOk).reason, /DTS/);
  assert.equal(planPlayback({ ...hevcDts, audio: [hevcDts.audio[1]] }, 'a.mkv', all).direct, true);
  assert.equal(planPlayback(hevcDts, 'a.avi', all).direct, false, 'avi is not a container the page opens');
});

test('the voice to start with: language, then default, then first', () => {
  assert.equal(pickAudio(hevcDts.audio, ['ar']), 1);
  assert.equal(pickAudio(hevcDts.audio, ['fr']), 0);
  assert.equal(pickAudio([], []), 0);
});

test('the playlist has a segment per six seconds and a short last one', () => {
  assert.equal(segmentCount(60), 10);
  assert.equal(segmentCount(61), 11);
  const list = buildPlaylist(14);
  assert.match(list, /#EXT-X-ENDLIST\n$/);
  assert.deepEqual(list.match(/#EXTINF:[\d.]+/g), ['#EXTINF:6.000000', '#EXTINF:6.000000', '#EXTINF:2.000000']);
});

test('ffmpeg arguments: seek, keyframes on boundaries, HDR tonemap, stereo AAC', () => {
  const args = ffmpegArgs({ input: 'http://x/y', info: hevcDts, audio: 1, start: 5, dir: '/tmp/d', tonemap: true });
  assert.equal(args[args.indexOf('-ss') + 1], '30.000');
  assert.equal(args[args.indexOf('-output_ts_offset') + 1], '30.000');
  assert.ok(args.includes('0:a:1'));
  assert.equal(args[args.indexOf('-start_number') + 1], '5');
  assert.match(args[args.indexOf('-vf') + 1], /tonemap=tonemap=hable/);
  assert.doesNotMatch(videoFilter(hevcDts.video, false), /tonemap/, 'without the filters the picture is only converted');
  assert.ok(!ffmpegArgs({ input: 'i', info: hevcDts, audio: 0, start: 0, dir: '/d', tonemap: true }).includes('-ss'));
});

// ── End to end, with the real ffmpeg: an HEVC + DTS 5.1 Matroska file, converted and seeked in ──
const have = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('an HEVC + DTS file comes out as H.264 + AAC segments that line up after a seek', { skip: !have, timeout: 120000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mumh5-tc-'));
  const src = path.join(dir, 'film.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-c:a', 'dca', '-strict', '-2', '-ac', '6', '-b:a', '768k', src], { stdio: 'inherit' });

  // The "torrent server": the file, with ranges, plus the converted video under /hls/
  const tc = createTranscoder({ bin: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, root: path.join(dir, 'tc'), lookahead: 3 });
  let base = '';
  const srv = http.createServer((req, res) => {
    const m = /^\/film\/hls\/(\d+)\/(.+)$/.exec(req.url!);
    if (m) return void tc.serve(res, 'hash:0', `${base}/film`, Number(m[1]), m[2]);
    const size = statSync(src).size;
    const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = r ? Number(r[1]) : 0, end = r && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
    res.writeHead(r ? 206 : 200, { 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(r ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    createReadStream(src, { start, end }).pipe(res);
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const info = await tc.probe('hash:0', `${base}/film`);
    assert.equal(info?.video?.codec, 'hevc');
    assert.equal(info?.audio[0].codec, 'dts');
    assert.equal(info?.audio[0].channels, 6);

    const get = async (p: string) => Buffer.from(await (await fetch(`${base}/film/hls/0/${p}`)).arrayBuffer());
    const list = (await get('index.m3u8')).toString();
    assert.equal(list.match(/seg\d+\.ts/g)?.length, 7);

    const probeSeg = (b: Buffer, name: string) => {
      const f = path.join(dir, name);
      execFileSync('sh', ['-c', 'cat > "$0"', f], { input: b });
      const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f]).toString());
      return j;
    };
    const s0 = probeSeg(await get('seg0.ts'), 's0.ts');
    const codecs = s0.streams.map((s: any) => s.codec_name).sort();
    assert.deepEqual(codecs, ['aac', 'h264']);
    assert.equal(s0.streams.find((s: any) => s.codec_name === 'aac').channels, 2, 'the 5.1 DTS is mixed down to stereo');
    assert.equal(s0.streams.find((s: any) => s.codec_name === 'h264').pix_fmt, 'yuv420p');

    // A jump forward: the conversion starts again there and its time stays where the segment is in the film
    const s5 = probeSeg(await get('seg5.ts'), 's5.ts');
    const t = Number(s5.format.start_time);
    assert.ok(t >= 30 - 0.1 && t < 31.5, `segment 5 starts near 30 s (got ${t})`);
    const d = Number(s5.format.duration);
    assert.ok(d > 5 && d < 7.5, `a segment lasts about six seconds (got ${d})`);
    // And one back, from the files that are already there
    assert.ok((await get('seg0.ts')).length > 1000);
  } finally {
    await tc.shutdown();
    srv.close();
    srv.closeAllConnections();
    rmSync(dir, { recursive: true, force: true });
  }
});
