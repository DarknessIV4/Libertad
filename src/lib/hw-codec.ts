// Video encoding that stays off the processor. Whether this computer has a video encoder in the graphics card is asked
// of the browser (which follows the "Use hardware acceleration" setting: with it off there is no such encoder to find).
// The codec that has one goes first in the offer or answer; the viewer takes the first it can decode, so nothing breaks
// when it cannot.
type EncodingInfo = { supported: boolean; powerEfficient: boolean };
type Caps = { encodingInfo(c: unknown): Promise<EncodingInfo> };

const picks = new Map<string, Promise<string | null>>();

export function hardwareCodec(height: number, fps: number, bitrateMbit: number): Promise<string | null> {
  const key = `${height}:${fps}:${bitrateMbit}`;
  let p = picks.get(key);
  if (!p) {
    p = (async () => {
      const caps = (navigator as unknown as { mediaCapabilities?: Caps }).mediaCapabilities;
      if (!caps) return null;
      for (const mime of ['video/H264', 'video/VP9', 'video/VP8']) {
        try {
          const info = await caps.encodingInfo({ type: 'webrtc', video: { contentType: mime, width: Math.round(height * 16 / 9), height, bitrate: bitrateMbit * 1_000_000, framerate: fps } });
          if (info.supported && info.powerEfficient) return mime;
        } catch { /* not a codec this browser knows */ }
      }
      return null;
    })();
    picks.set(key, p);
  }
  return p;
}

// Puts the hardware codec first for every video sender of the connection (call before createOffer / createAnswer)
export async function preferHardwareVideo(pc: RTCPeerConnection, track: MediaStreamTrack | null | undefined, bitrateMbit = 8): Promise<string | null> {
  const st = track?.getSettings?.() ?? {};
  const hw = await hardwareCodec(Math.round(st.height ?? 1080), Math.round(st.frameRate ?? 30), bitrateMbit);
  const offered = typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities('video') : null;
  if (!hw || !offered) return null;
  const order = [...offered.codecs.filter(x => x.mimeType === hw), ...offered.codecs.filter(x => x.mimeType !== hw)];
  for (const t of pc.getTransceivers()) {
    if (t.sender.track?.kind !== 'video') continue;
    try { t.setCodecPreferences(order); } catch { /* keep the default order */ }
  }
  return hw;
}
