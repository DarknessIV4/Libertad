import { readdirSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';

// Linux computers with two graphics chips (a processor-integrated one and a separate card): which chip does the video work.
// NVIDIA has no video encoder Chromium can use on Linux, so the integrated chip is the one to pick for streams.
// Each GPU is found through the render nodes of the kernel (/sys/class/drm) and named by its PCI address, which stays the
// same across restarts where the renderD numbers can change.
export interface Gpu { id: string; label: string; kind: 'integrated' | 'discrete'; node: string; vendor: 'amd' | 'nvidia' | 'intel' | 'other' }

const VENDORS: Record<string, { name: string; vendor: Gpu['vendor'] }> = {
  '0x1002': { name: 'AMD', vendor: 'amd' },
  '0x10de': { name: 'NVIDIA', vendor: 'nvidia' },
  '0x8086': { name: 'Intel', vendor: 'intel' }
};

const read = (file: string): string => { try { return readFileSync(file, 'utf8').trim(); } catch { return ''; } };

export function listGpus(): Gpu[] {
  if (process.platform !== 'linux') return [];
  const out: Gpu[] = [];
  let names: string[] = [];
  try { names = readdirSync('/sys/class/drm').filter(n => /^renderD\d+$/.test(n)); } catch { return []; }
  for (const n of names) {
    const dev = `/sys/class/drm/${n}/device`;
    let slot = '';
    try { slot = path.basename(realpathSync(dev)); } catch { continue; }
    const v = VENDORS[read(`${dev}/vendor`)] ?? { name: 'Other', vendor: 'other' as const };
    // A separate card has its own memory (over 2 GiB); the integrated chip of an AMD or Intel processor shares the system's
    const vram = Number(read(`${dev}/mem_info_vram_total`)) || 0;
    const kind: Gpu['kind'] = v.vendor === 'nvidia' || vram > 2 * 1024 ** 3 ? 'discrete' : 'integrated';
    out.push({ id: slot, label: `${v.name} graphics (${kind}, ${slot})`, kind, node: `/dev/dri/${n}`, vendor: v.vendor });
  }
  return out.filter(g => existsSync(g.node));
}

// What the choice sets before Chromium starts its graphics process (it inherits the environment). 'auto' leaves it all to Chromium.
// Only the video work is moved, and the window keeps being drawn by the card that draws the desktop (a window drawn by the other
// chip has to be copied across to it, which comes out black or cropped). So the choice is: the integrated chip's own video
// engine (AMD, Intel: Chromium reaches it, but the frames then have to cross to the card that draws), or the NVIDIA card's decoder
// through nvidia-vaapi-driver (decoding only, no encoding; it stays on the card that draws, so nothing is copied).
export interface GpuPlan { gpu: Gpu; features: string[]; renderNode?: string }

export function planGpu(choice: string | undefined): GpuPlan | null {
  if (!choice || choice === 'auto') return null;
  const gpus = listGpus();
  const gpu = gpus.find(g => g.id === choice) ?? (choice === 'integrated' || choice === 'discrete' ? gpus.find(g => g.kind === choice) : undefined);
  if (!gpu || gpus.length < 2) return null; // gone (a card unplugged or turned off): back to automatic
  if (gpu.vendor === 'nvidia') {
    // Set even when the session names another driver: it was asked for
    process.env.LIBVA_DRIVER_NAME = 'nvidia';
    process.env.NVD_BACKEND = 'direct';
    // VaapiOnNvidiaGPUs lifts Chromium's refusal of NVIDIA for VA-API; the card also draws the window, so its node is the render one
    return { gpu, features: ['VaapiOnNvidiaGPUs', 'AcceleratedVideoDecodeLinuxZeroCopyGL'], renderNode: gpu.node };
  }
  if (gpu.vendor === 'amd') process.env.LIBVA_DRIVER_NAME = 'radeonsi';
  return { gpu, features: [] };
}
