// The connection settings every direct connection uses (screen sharing, watch together, file
// sharing), so that the STUN and relay servers chosen in Settings apply to all of them alike.
import { isWeb } from './native.ts';
import { proxyIce, relayIce } from './web.svelte.ts';
import { store } from './settings.svelte.ts';

export async function iceServers(): Promise<RTCIceServer[]> {
  const stun = store.settings.stunServer.trim();
  // Empty contacts nobody, as the setting says
  const chosen: RTCIceServer[] = stun ? [{ urls: /^stuns?:/.test(stun) ? stun : `stun:${stun}` }] : [];
  // A Libertad proxy adds its STUN and its relay, which takes over by itself when no direct
  // connection comes up (mobile and company networks, browsers that forbid direct UDP). The
  // browser build has the proxy it is served from; the desktop app the one set in Settings.
  const relay = store.settings.relayServer.trim();
  return [...chosen, ...(relay ? await relayIce(relay) : isWeb ? await proxyIce() : [])];
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
