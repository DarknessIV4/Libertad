// Watch Together - shared playback sync for YouTube, streamed files, and local files.
// Carried as Mumble plugin data (like screen sharing and file transfer).
import { encodeSignal, SignalAssembler } from './share-signal.ts';
import type { TorrentMeta } from './torrent-meta.ts';

export const WATCH_DATA_ID = 'mumh5.watch';

export const WATCH = {
  // Party lifecycle
  start: 1,    // Host starts a watch party: { mode, videoId?, fileMeta?, torrent?, title }
  join: 2,     // Viewer joins: { }
  leave: 3,    // Viewer leaves: { }
  end: 4,      // Host ends party: { }

  // Discovery (for late joiners)
  who: 5,      // I just got here: who is hosting a watch party?

  // Playback control (any participant can send)
  play: 10,    // { positionMs, serverTime }
  pause: 11,   // { positionMs, serverTime }
  seek: 12,    // { positionMs, serverTime }
  sync: 13,    // Periodic position broadcast: { positionMs, playing, serverTime }
  rate: 14,    // Playback speed change (YouTube): the shared state, with the new rate

  // State sync for late joiners
  state: 20,   // Current state from host: { mode, videoId?, fileMeta?, title, positionMs, playing, playlist?, currentIndex? }
  playlist: 21,// Playlist update: { videos: {id, title}[], currentIndex }

  // File streaming (mode 2: stream from host)
  fileChunk: 30, // Host sends file chunk: { offset, data }
  fileRequest: 31, // Viewer requests chunk: { offset, length }
  fileEnd: 32,     // End of file: { }
  next: 16,        // Torrent together: on to the next link of the queue, { index, rev }
  quality: 15,     // Viewer of a stream to its host: the most I want to receive, { fps, height } (0 = no cap)
} as const;

export type WatchType = typeof WATCH[keyof typeof WATCH];

export interface WatchPartyMeta {
  mode: WatchMode;
  videoId?: string;       // YouTube video ID (mode 1)
  fileMeta?: FileMeta;    // File info (mode 2)
  torrent?: TorrentMeta;  // The torrent everybody downloads and plays on their own (mode 3): the one playing now
  queue?: TorrentMeta[];  // Mode 3: all the links in order (up to 5), `torrent` is one of them
  title: string;
}

export type WatchMode = 1 | 2 | 3; // 1=YouTube, 2=Stream from host, 3=Torrent together

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  hash: string; // SHA-256 of file
}

// Payloads for each message type
export interface StartPayload {
  mode: WatchMode;
  videoId?: string;
  fileMeta?: FileMeta;
  torrent?: TorrentMeta;
  queue?: TorrentMeta[];
  title: string;
}

export interface JoinPayload {
  // Empty - just signals intent to join
}

export interface LeavePayload {
  // Empty
}

export interface EndPayload {
  // Empty
}

export interface PlayPauseSeekPayload {
  positionMs: number;
  serverTime: number; // Server timestamp for latency compensation
  playing?: boolean; // For seek: target playing state after seek
}

export interface SyncPayload {
  positionMs: number;
  playing: boolean;
  serverTime: number;
}

export interface StatePayload {
  mode: WatchMode;
  videoId?: string;
  fileMeta?: FileMeta;
  torrent?: TorrentMeta;
  queue?: TorrentMeta[];
  title: string;
  positionMs: number;
  playing: boolean;
  playlist?: { id: string; title: string }[];
  currentIndex?: number;
  // Sync state fields for late join consistency
  rev?: number;
  origin?: number;
  at?: number;
  rate?: number;
  // Who is in the session, from a member that is in it, so a newcomer's list is right at once
  participants?: number[];
}

export interface NextPayload {
  index: number;  // the queue position everybody moves to
  rev?: number;   // sync revision of the fresh (paused, at 0) state
}

export interface PlaylistPayload {
  videos: { id: string; title: string }[];
  currentIndex: number;
}

export interface FileChunkPayload {
  offset: number;
  data: string; // base64 encoded (legacy)
}

// Raw binary chunk format: [type:1][offset:4][length:2][data...]
// Offset is 4 bytes (big-endian), length is 2 bytes (big-endian)
// Murmur drops PluginDataTransmission packets over 1000 bytes, so we must stay under that.
// Packet = 1 (type) + 4 (offset) + 2 (length) + data <= 1000, so max data = 993.
// Use 900 to leave margin for protocol overhead (matches share-signal CHUNK).
export const FILE_CHUNK_HEADER = 4 + 2; // 6 bytes
export const MAX_FILE_CHUNK_SIZE = 900;

export interface FileRequestPayload {
  offset: number;
  length: number;
}

export interface FileEndPayload {
  // Empty
}

export async function encodeWatchSignal(type: WatchType, body: unknown): Promise<Uint8Array[]> {
  // If body is already a string (e.g., SDP), don't JSON.stringify it
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return encodeSignal(type, text);
}

export class WatchAssembler extends SignalAssembler<WatchType> {
  constructor() {
    super(Object.values(WATCH));
  }
}

// Encode a file chunk as raw binary: [type:1][offset:4][length:2][data...]
export function encodeFileChunk(offset: number, data: Uint8Array): Uint8Array {
  const packet = new Uint8Array(1 + FILE_CHUNK_HEADER + data.length);
  packet[0] = WATCH.fileChunk;
  // offset (4 bytes, big-endian)
  packet[1] = (offset >>> 24) & 0xff;
  packet[2] = (offset >>> 16) & 0xff;
  packet[3] = (offset >>> 8) & 0xff;
  packet[4] = offset & 0xff;
  // length (2 bytes, big-endian)
  packet[5] = (data.length >>> 8) & 0xff;
  packet[6] = data.length & 0xff;
  packet.set(data, 7);
  return packet;
}

// Decode a raw binary file chunk
export function decodeFileChunk(packet: Uint8Array): { offset: number; data: Uint8Array } | null {
  if (packet.length < 1 + FILE_CHUNK_HEADER) return null;
  if (packet[0] !== WATCH.fileChunk) return null;
  const offset = (packet[1] << 24) | (packet[2] << 16) | (packet[3] << 8) | packet[4];
  const length = (packet[5] << 8) | packet[6];
  if (packet.length !== 1 + FILE_CHUNK_HEADER + length) return null;
  return { offset, data: packet.slice(7) };
}