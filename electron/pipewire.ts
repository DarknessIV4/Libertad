// Sound for screen sharing on Linux. Chromium cannot capture what other programs play, so a
// virtual microphone is created in PipeWire and the chosen programs' output is linked into it;
// the renderer then records that microphone like any other. Works through PipeWire's command
// line tools (pw-cli, pw-dump, pw-link, pw-mon), no native module.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const VIRTUAL_MIC = 'libertad-share-audio';
export const VIRTUAL_MIC_LABEL = 'Libertad screen share audio';

// What to capture: everything except this app's own sound, or one program
export type AudioTarget = { kind: 'all' } | { kind: 'app'; name: string };

interface PwObject { id: number; type: string; info?: { direction?: string; props?: Record<string, any> } }

function run(cmd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer, timeout: 5000 }, (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

const dump = async (): Promise<PwObject[]> => JSON.parse(await run('pw-dump', []));

// A playing program: its name and process come from the stream itself or from the client that owns it
function describe(node: PwObject, byId: Map<number, PwObject>): { name: string; pid: number | null; binary: string } {
  const p = node.info?.props ?? {};
  const client = byId.get(p['client.id'])?.info?.props ?? {};
  return {
    name: String(p['application.name'] ?? client['application.name'] ?? p['node.name'] ?? ''),
    pid: Number(p['application.process.id'] ?? client['application.process.id']) || null,
    binary: String(p['application.process.binary'] ?? client['application.process.binary'] ?? '')
  };
}

// Who counts as this app. The process id alone is not enough: Chromium plays sound from helper
// processes (audio service, utility processes) that are not always in the app's own process list,
// and some set-ups report no process id at all. So a stream is also this app's when one of its
// parent processes is this app, or when it carries this app's name or executable name.
export interface OwnApp {
  pids: number[];
  names?: string[];     // lower-case application / executable names of this app
  isOwnPid?: (pid: number) => boolean;  // e.g. "is a child of this app"
}

const asOwn = (own: OwnApp | number[]): OwnApp => Array.isArray(own) ? { pids: own } : own;

function isOwnStream(d: { name: string; pid: number | null; binary: string }, own: OwnApp): boolean {
  if (d.pid && (own.pids.includes(d.pid) || own.isOwnPid?.(d.pid))) return true;
  const names = own.names ?? [];
  if (!names.length) return false;
  const base = d.binary.split('/').pop()!.toLowerCase();
  return names.includes(d.name.toLowerCase()) || (base !== '' && names.includes(base));
}

// Parent of a process (Linux), 0 when unknown
function parentOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // pid (comm) state ppid ...; comm can contain spaces and parentheses
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || 0;
  } catch { return 0; }
}

// True when the process is this app or descends from it
export function descendsFrom(pid: number, roots: number[]): boolean {
  for (let i = 0; i < 32 && pid > 1; i++) {
    if (roots.includes(pid)) return true;
    pid = parentOf(pid);
  }
  return false;
}

const outputs = (objects: PwObject[]) =>
  objects.filter(o => o.type === 'PipeWire:Interface:Node' && o.info?.props?.['media.class'] === 'Stream/Output/Audio');

// Programs currently playing sound, without this app
export function audioApps(objects: PwObject[], ownApp: OwnApp | number[]): string[] {
  const own = asOwn(ownApp);
  const byId = new Map(objects.map(o => [o.id, o]));
  const names = new Set<string>();
  for (const node of outputs(objects)) {
    const d = describe(node, byId);
    if (d.name && !isOwnStream(d, own)) names.add(d.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// Which output ports to connect to which inputs of the virtual microphone, and which existing
// links to remove. This app's own playback is never linked: the people watching are in the same
// voice channel and would hear themselves back.
export function planLinks(objects: PwObject[], target: AudioTarget, ownApp: OwnApp | number[]): { add: [number, number][]; remove: number[] } {
  const own = asOwn(ownApp);
  const byId = new Map(objects.map(o => [o.id, o]));
  const mic = objects.find(o => o.type === 'PipeWire:Interface:Node' && o.info?.props?.['node.name'] === VIRTUAL_MIC);
  if (!mic) return { add: [], remove: [] };
  const ports = objects.filter(o => o.type === 'PipeWire:Interface:Port');
  const micIn = ports.filter(p => p.info?.props?.['node.id'] === mic.id && p.info?.direction === 'input');
  const input = (channel: string) => micIn.find(p => p.info?.props?.['audio.channel'] === channel)?.id;
  const left = input('FL'), right = input('FR');
  if (left == null || right == null) return { add: [], remove: [] };

  const wanted = new Set<string>();
  for (const node of outputs(objects)) {
    const d = describe(node, byId);
    if (isOwnStream(d, own)) continue;
    if (target.kind === 'app' && d.name !== target.name) continue;
    for (const port of ports) {
      if (port.info?.props?.['node.id'] !== node.id || port.info?.direction !== 'output') continue;
      const channel = port.info.props['audio.channel'];
      // Mono programs go to both sides; surround beyond the front pair is left out
      if (channel === 'FL' || channel === 'MONO') wanted.add(`${port.id}:${left}`);
      if (channel === 'FR' || channel === 'MONO') wanted.add(`${port.id}:${right}`);
    }
  }
  const remove: number[] = [];
  for (const link of objects.filter(o => o.type === 'PipeWire:Interface:Link')) {
    const info = link.info as any;
    if (info?.['input-node-id'] !== mic.id) continue;
    const key = `${info['output-port-id']}:${info['input-port-id']}`;
    if (wanted.has(key)) wanted.delete(key);
    else remove.push(link.id);
  }
  return { add: [...wanted].map(k => k.split(':').map(Number) as [number, number]), remove };
}

// Whether PipeWire and its tools are there
export async function pipewireAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try { await dump(); await run('pw-link', ['--version']); await run('pw-cli', ['--version']); return true; } catch { return false; }
}

export class ShareAudio {
  private target: AudioTarget | null = null;
  private monitor: ChildProcess | null = null;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private busy: Promise<void> = Promise.resolve();
  private own: () => OwnApp;

  constructor(own: () => OwnApp) { this.own = own; }

  async apps(): Promise<string[]> {
    return audioApps(await dump(), this.own());
  }

  // Creates the microphone, links the target and keeps the links right while programs come and go
  async start(target: AudioTarget): Promise<void> {
    this.target = target;
    if (!(await dump()).some(o => o.info?.props?.['node.name'] === VIRTUAL_MIC)) {
      await run('pw-cli', ['create-node', 'adapter',
        `{ factory.name=support.null-audio-sink node.name=${VIRTUAL_MIC} node.description="${VIRTUAL_MIC_LABEL}" media.class=Audio/Source/Virtual object.linger=1 audio.position=[FL,FR] audio.rate=48000 audio.channels=2 }`]);
      // Give PipeWire a moment to publish the node and its ports
      for (let i = 0; i < 20; i++) {
        const objects = await dump();
        const mic = objects.find(o => o.info?.props?.['node.name'] === VIRTUAL_MIC);
        if (mic && objects.some(o => o.type === 'PipeWire:Interface:Port' && o.info?.props?.['node.id'] === mic.id)) break;
        await new Promise(r => setTimeout(r, 100));
      }
    }
    await this.relink();
    if (!this.monitor) {
      const proc = spawn('pw-mon', ['--color=never'], { stdio: ['ignore', 'pipe', 'ignore'] });
      this.monitor = proc;
      proc.stdout!.on('data', (data: Buffer) => {
        const text = data.toString();
        if (!text.includes('added') && !text.includes('removed')) return;
        // Starting a program fires many events at once
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.relink().catch(() => {}), 400);
      });
      proc.on('error', () => { if (this.monitor === proc) this.monitor = null; });
      proc.on('exit', () => { if (this.monitor === proc) this.monitor = null; });
    }
  }

  // One at a time, so two graph changes cannot interleave their link commands
  private relink(): Promise<void> {
    const next = this.busy.then(async () => {
      if (!this.target) return;
      const { add, remove } = planLinks(await dump(), this.target, this.own());
      for (const id of remove) await run('pw-link', ['-d', String(id)]).catch(() => {});
      // "File exists" when a link is already there is fine
      for (const [out, input] of add) await run('pw-link', [String(out), String(input)]).catch(() => {});
    });
    this.busy = next.catch(() => {});
    return next;
  }

  async stop(): Promise<void> {
    this.target = null;
    clearTimeout(this.debounce);
    this.monitor?.kill();
    this.monitor = null;
    await this.busy;
    try {
      for (const o of await dump()) {
        if (o.type === 'PipeWire:Interface:Node' && o.info?.props?.['node.name'] === VIRTUAL_MIC) await run('pw-cli', ['destroy', String(o.id)]).catch(() => {});
      }
    } catch { /* PipeWire gone */ }
  }
}
