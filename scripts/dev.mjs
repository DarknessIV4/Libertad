import { spawn } from 'node:child_process';
import * as esbuild from 'esbuild';
import { createServer } from 'vite';
import electronPath from 'electron';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { options } from './build-electron.mjs';

// The window system chosen in Settings > System (Linux): X11 unless Wayland was chosen or LIBERTAD_WAYLAND is set
const wantX11 = () => {
  if (process.platform !== 'linux' || process.env.LIBERTAD_WAYLAND) return false;
  try { return JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Libertad', 'system.json'), 'utf8')).displayServer !== 'wayland'; } catch { return true; }
};

// Vite dev server for the renderer, esbuild watch for main/preload, Electron restarted on main changes.
const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];

let child = null;
const startElectron = () => {
  if (child) {
    child.removeAllListeners('exit');
    child.kill();
  }
  // ELECTRON_RUN_AS_NODE (set by some editor terminals) would start Electron as plain Node
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  child = spawn(electronPath, ['.', ...(wantX11() ? ['--ozone-platform=x11'] : [])], { stdio: 'inherit', env: { ...env, VITE_DEV_SERVER_URL: url } });
  child.on('exit', () => { server.close(); process.exit(0); });
};

const ctx = await esbuild.context({
  ...options,
  plugins: [{ name: 'restart', setup(b) { b.onEnd(r => { if (!r.errors.length) startElectron(); }); } }]
});
await ctx.watch();
