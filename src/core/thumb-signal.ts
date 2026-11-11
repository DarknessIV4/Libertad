// A small picture of what someone is hosting (a screen share or a watch together session), sent by
// the host to the people in their channel so their tile can show it. Carried as Mumble plugin data
// like the other mumh5 signals; murmur drops plugin data over 1000 bytes, so a picture goes in
// chunks: [id, index, total, ...data].
export const THUMB_DATA_ID = 'mumh5.thumb';

const CHUNK = 900;
export const MAX_CHUNKS = 16;
// What fits in the chunks; the sender keeps its pictures under this
export const MAX_THUMB_BYTES = MAX_CHUNKS * CHUNK - 48;
let nextId = 0;

export function encodeThumb(bytes: Uint8Array): Uint8Array[] {
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
  if (total > MAX_CHUNKS) throw new Error('Picture too large');
  const id = nextId = (nextId + 1) & 255;
  return Array.from({ length: total }, (_, i) => {
    const part = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
    const packet = new Uint8Array(3 + part.length);
    packet.set([id, i, total]);
    packet.set(part, 3);
    return packet;
  });
}

// A JPEG starts with these bytes; nothing else is shown
export const isJpeg = (b: Uint8Array) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// Puts the chunks back together, per sender
export class ThumbAssembler {
  private pending = new Map<string, { parts: (Uint8Array | undefined)[]; got: number; at: number }>();

  push(sender: number, packet: Uint8Array, now = Date.now()): Uint8Array | null {
    if (packet.length < 4) return null;
    const [id, index, total] = packet;
    if (!total || total > MAX_CHUNKS || index >= total) return null;
    // Abandoned transfers must not pile up
    for (const [k, v] of this.pending) if (now - v.at > 15000) this.pending.delete(k);
    if (this.pending.size > 64) this.pending.clear();
    const key = `${sender}:${id}`;
    let entry = this.pending.get(key);
    if (!entry || entry.parts.length !== total) {
      entry = { parts: new Array(total), got: 0, at: now };
      this.pending.set(key, entry);
    }
    if (!entry.parts[index]) entry.got++;
    entry.parts[index] = packet.slice(3);
    if (entry.got < total) return null;
    this.pending.delete(key);
    const joined = new Uint8Array(entry.parts.reduce((n, p) => n + p!.length, 0));
    let at = 0;
    for (const p of entry.parts) { joined.set(p!, at); at += p!.length; }
    return isJpeg(joined) ? joined : null;
  }
}
