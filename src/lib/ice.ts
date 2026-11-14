// The connection settings every direct connection uses (screen sharing, watch together, file
// sharing), so that the STUN and relay servers chosen in Settings apply to all of them alike.
import { store } from './settings.svelte.ts';

// STUN and the relay of a Libertad relay server, for screen sharing. The relay needs credentials,
// which the server hands out for a few hours at a time.
const relays = new Map<string, { servers: RTCIceServer[]; until: number }>();
export async function relayIce(address: string): Promise<RTCIceServer[]> {
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`); } catch { return []; }
  const root = url.href.replace(/\/*$/, '/');
  const known = relays.get(root);
  if (known && known.until > Date.now()) return known.servers;
  try {
    const res = await fetch(`${root}api/relay`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const c = await res.json() as { port: number; username?: string; credential?: string; ttl?: number; urls?: string[] };
    const servers: RTCIceServer[] = [{ urls: `stun:${url.hostname}:${c.port}` }];
    // UDP where it is allowed, TCP for networks that forbid it; the operator may name other ways in,
    // such as a TLS front on port 443 for networks that allow nothing else
    const direct = [`turn:${url.hostname}:${c.port}?transport=udp`, `turn:${url.hostname}:${c.port}?transport=tcp`];
    if (c.username) servers.push({ urls: [...direct, ...(c.urls ?? [])], username: c.username, credential: c.credential });
    relays.set(root, { servers, until: Date.now() + Math.max(60, (c.ttl ?? 3600) - 3000) * 1000 });
    return servers;
  } catch {
    return [];
  }
}

export async function iceServers(): Promise<RTCIceServer[]> {
  const stun = store.settings.stunServer.trim();
  // Empty contacts nobody, as the setting says
  const chosen: RTCIceServer[] = stun ? [{ urls: /^stuns?:/.test(stun) ? stun : `stun:${stun}` }] : [];
  // A Libertad relay server adds its STUN and its relay, which takes over by itself when no direct
  // connection comes up (mobile and company networks). It is the one set in Settings.
  const relay = store.settings.relayServer.trim();
  return [...chosen, ...(relay ? await relayIce(relay) : [])];
}

// For testing the relay: localStorage libertad.iceDebug = "relay" uses only relayed routes,
// "relay-tcp" only the relay reached over TCP (what a browser without direct UDP is left with)
export async function rtcConfig(): Promise<RTCConfiguration> {
  const servers = await iceServers();
  let debug = '';
  try { debug = localStorage.getItem('libertad.iceDebug') ?? ''; } catch { /* storage unavailable */ }
  if (!debug.startsWith('relay')) return { iceServers: servers };
  const tcpOnly = (urls: string | string[]) => [urls].flat().filter(u => !u.startsWith('turn') || u.includes('transport=tcp'));
  return { iceTransportPolicy: 'relay', iceServers: debug === 'relay-tcp' ? servers.map(s => ({ ...s, urls: tcpOnly(s.urls) })) : servers };
}

// Candidates travel inside the description, so wait for them instead of sending each one. Too
// short a wait sends a description without the addresses the STUN server reported, and then
// only the slow way through the server is left.
export const GATHER_MS = 3000;
// Once the STUN or relay server has answered (the address it reports is the one that matters), a
// short grace period catches the other routes, and then the description goes out. Waiting for
// gathering to be complete can take the whole GATHER_MS when one server or network interface is
// slow, and that wait happens twice (offer and answer) before any picture is sent.
export const GRACE_MS = 350;
export function gathered(pc: RTCPeerConnection, ms = GATHER_MS): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  const relayOnly = pc.getConfiguration().iceTransportPolicy === 'relay';
  return new Promise(resolve => {
    let grace: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer); clearTimeout(grace);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const onCandidate = (e: RTCPeerConnectionIceEvent) => {
      const type = e.candidate?.type;
      if (grace || !(type === 'relay' || (type === 'srflx' && !relayOnly))) return;
      grace = setTimeout(done, GRACE_MS);
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
  });
}
