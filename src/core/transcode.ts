// Playing what the page's <video> can not play. A browser decodes only some codecs (HEVC just with hardware help,
// DTS and TrueHD never) and a few containers, so a file that is not one of those is converted while it is played:
// ffmpeg (in the desktop app) reads the file from the local torrent server and cuts H.264 + AAC into short HLS
// segments, on demand, so seeking works like it does for a plain file. Pure functions; the processes live in
// electron/transcode.ts.

export const SEGMENT_SECONDS = 6;
export const MAX_HEIGHT = 1080;

export interface VideoStreamInfo {
  codec: string;        // ffprobe's name: h264, hevc, vp9, av1, mpeg2video ...
  profile: string;
  level: number;
  pixFmt: string;
  bitDepth: number;
  width: number;
  height: number;
  hdr: boolean;         // PQ (HDR10, Dolby Vision's base layer) or HLG
}

export interface AudioStreamInfo {
  ord: number;          // the position among the audio streams: what ffmpeg's "0:a:<ord>" means
  codec: string;        // aac, ac3, eac3, dts, truehd, flac, opus ...
  profile: string;      // "DTS-HD MA" tells a lossless DTS from the core
  channels: number;
  lang: string;         // ISO 639 code or ''
  title: string;
  default: boolean;
}

export interface MediaInfo {
  duration: number;     // seconds
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo[];
}

const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown, max = 80): string => (typeof v === 'string' ? v.slice(0, max) : '');

// What `ffprobe -print_format json -show_format -show_streams` prints
export function parseProbe(json: unknown): MediaInfo | null {
  const j = json as { streams?: unknown; format?: { duration?: unknown } } | null;
  if (!j || !Array.isArray(j.streams)) return null;
  let video: VideoStreamInfo | null = null;
  const audio: AudioStreamInfo[] = [];
  let streamDuration = 0;
  for (const s of j.streams as Record<string, any>[]) {
    if (!s || typeof s !== 'object') continue;
    if (s.codec_type === 'video' && !video && !s.disposition?.attached_pic) {
      const transfer = str(s.color_transfer, 24);
      const bits = num(s.bits_per_raw_sample) || (/10/.test(str(s.pix_fmt, 24)) ? 10 : /12/.test(str(s.pix_fmt, 24)) ? 12 : 8);
      video = {
        codec: str(s.codec_name, 24), profile: str(s.profile, 40), level: num(s.level), pixFmt: str(s.pix_fmt, 24), bitDepth: bits,
        width: num(s.width), height: num(s.height),
        hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67'
      };
      streamDuration = num(s.duration);
    } else if (s.codec_type === 'audio' && audio.length < 32) {
      audio.push({
        ord: audio.length, codec: str(s.codec_name, 24), profile: str(s.profile, 40), channels: num(s.channels),
        lang: str(s.tags?.language, 8).toLowerCase(), title: str(s.tags?.title, 80), default: s.disposition?.default === 1
      });
    }
  }
  if (!video && !audio.length) return null;
  const duration = num(j.format?.duration) || streamDuration;
  return { duration, video, audio };
}

// ─── Can the page play it as it is? ────────────────────────────────────────

// What the page asks <video>.canPlayType (true when the answer is not '')
export type CanPlay = (mime: string) => boolean;

const DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);
export const extOf = (name: string): string => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

// The codec string a browser wants, with the kind of file it goes in. null: a codec no browser plays.
export function videoMime(v: VideoStreamInfo): string | null {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  switch (v.codec) {
    case 'h264': {
      const profile = /baseline/i.test(v.profile) ? '42' : /main/i.test(v.profile) ? '4d' : '64';
      return `video/mp4; codecs="avc1.${profile}00${hex(Math.min(Math.max(v.level, 10), 62))}"`;
    }
    case 'hevc': {
      const main10 = v.bitDepth > 8 || /10/.test(v.profile);
      return `video/mp4; codecs="hvc1.${main10 ? '2.4' : '1.6'}.L${v.level || 153}.B0"`;
    }
    case 'vp9': return `video/webm; codecs="vp09.0${v.bitDepth > 8 ? '2' : '0'}.10.${String(v.bitDepth).padStart(2, '0')}"`;
    case 'av1': return `video/mp4; codecs="av01.0.08M.${String(v.bitDepth).padStart(2, '0')}"`;
    case 'vp8': return 'video/webm; codecs="vp8"';
    default: return null;
  }
}

export function audioMime(a: AudioStreamInfo): string | null {
  switch (a.codec) {
    case 'aac': return 'audio/mp4; codecs="mp4a.40.2"';
    case 'mp3': return 'audio/mpeg';
    case 'opus': return 'audio/webm; codecs="opus"';
    case 'vorbis': return 'audio/webm; codecs="vorbis"';
    case 'flac': return 'audio/mp4; codecs="flac"';
    case 'ac3': return 'audio/mp4; codecs="ac-3"';
    case 'eac3': return 'audio/mp4; codecs="ec-3"';
    default: return null; // dts, truehd, pcm in odd containers, wma ...
  }
}

export interface PlaybackPlan {
  direct: boolean;
  // Why the file is converted (shown to the person); '' when it plays as it is
  reason: string;
}

// Direct play only when the container, the picture and the sound the page starts with are all things it decodes.
// The first audio stream is the one a <video> plays by itself.
export function planPlayback(info: MediaInfo, fileName: string, canPlay: CanPlay): PlaybackPlan {
  const ext = extOf(fileName);
  if (!DIRECT_CONTAINERS.has(ext)) return { direct: false, reason: `the .${ext} format` };
  if (info.video) {
    const mime = videoMime(info.video);
    if (!mime || !canPlay(mime)) return { direct: false, reason: `${info.video.codec.toUpperCase()} video` };
  }
  const first = info.audio[0];
  if (first) {
    const mime = audioMime(first);
    if (!mime || !canPlay(mime)) return { direct: false, reason: `${first.codec.toUpperCase()} audio` };
  }
  return { direct: true, reason: '' };
}

// The voice to start a converted video with: in the person's language, else the file's default, else the first
export function pickAudio(audio: readonly AudioStreamInfo[], langs: readonly string[] = []): number {
  for (const l of langs) {
    const hit = audio.find(a => a.lang && (a.lang === l || a.lang.slice(0, 2) === l.slice(0, 2)));
    if (hit) return hit.ord;
  }
  return (audio.find(a => a.default) ?? audio[0])?.ord ?? 0;
}

// ─── The conversion ────────────────────────────────────────────────────────

export const segmentCount = (duration: number, seg = SEGMENT_SECONDS): number => Math.max(1, Math.ceil(duration / seg - 1e-6));

export function buildPlaylist(duration: number, seg = SEGMENT_SECONDS): string {
  const n = segmentCount(duration, seg);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${seg + 1}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (let i = 0; i < n; i++) {
    const len = i === n - 1 ? Math.max(0.001, duration - seg * i) : seg;
    lines.push(`#EXTINF:${len.toFixed(6)},`, `seg${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

export interface FfmpegPlan {
  input: string;
  info: MediaInfo;
  audio: number;        // MediaInfo.audio[].ord; ignored when the file has no sound
  start: number;        // first segment to make
  dir: string;
  tonemap: boolean;     // this ffmpeg has the filters to turn HDR into SDR
  maxHeight?: number;
  segSeconds?: number;
}

// The filter that makes the picture what every screen shows: at most 1080 lines tall, 8-bit 4:2:0, and HDR brought down to SDR
export function videoFilter(v: VideoStreamInfo | null, tonemap: boolean, maxHeight = MAX_HEIGHT): string {
  const scale = `scale=w=-2:h='min(${maxHeight},ih)'`;
  if (v?.hdr && tonemap) {
    return [scale, 'zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p'].join(',');
  }
  return `${scale},format=yuv420p`;
}

// ffmpeg's arguments for making the segments from `start` on. Keyframes sit on every segment boundary, and the
// timestamps carry on from where the segment is in the film, so a conversion that starts again after a seek
// still fits the ones before it.
export function ffmpegArgs(p: FfmpegPlan): string[] {
  const seg = p.segSeconds ?? SEGMENT_SECONDS;
  const at = p.start * seg;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (at > 0) args.push('-ss', at.toFixed(3));
  args.push('-i', p.input, '-map', '0:v:0?');
  const hasAudio = p.info.audio.length > 0;
  if (hasAudio) args.push('-map', `0:a:${Math.max(0, Math.min(p.audio, p.info.audio.length - 1))}`);
  args.push('-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-profile:v', 'high', '-threads', '0',
    '-vf', videoFilter(p.info.video, p.tonemap, p.maxHeight),
    '-force_key_frames', `expr:gte(t,n_forced*${seg})`, '-sc_threshold', '0'
  );
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-af', 'aresample=async=1:first_pts=0');
  args.push(
    '-max_muxing_queue_size', '2048', '-muxdelay', '0', '-muxpreload', '0',
    '-output_ts_offset', at.toFixed(3),
    '-f', 'hls', '-hls_time', String(seg), '-hls_list_size', '0', '-hls_segment_type', 'mpegts',
    '-hls_flags', 'temp_file+independent_segments', '-start_number', String(p.start),
    '-hls_segment_filename', `${p.dir}/seg%d.ts`, `${p.dir}/ffmpeg.m3u8`
  );
  return args;
}
