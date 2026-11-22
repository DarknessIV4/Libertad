import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Bundles the Mumble backend (mobile/nodejs/src) into one CommonJS file for Node.js for Mobile Apps
// (nodejs-mobile, run by the capacitor-nodejs plugin). Capacitor's webDir is dist-android, and the plugin
// looks for its Node project in <webDir>/nodejs (its `nodeDir` setting), so that is where the bundle goes.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function build(outDir = path.join(root, 'dist-android', 'nodejs')) {
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(root, 'mobile', 'nodejs', 'src', 'main.ts')],
    outfile: path.join(outDir, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // nodejs-mobile is Node 18 (18.20 at the time of writing); esbuild lowers the syntax, not the APIs
    target: 'node18',
    // `bridge` is the module nodejs-mobile provides to the app's Node code
    external: ['bridge'],
    legalComments: 'none',
    logLevel: 'info'
  });
  // The plugin starts the folder's package.json `main`
  await copyFile(path.join(root, 'mobile', 'nodejs', 'package.json'), path.join(outDir, 'package.json'));
  return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  await build(out ? path.resolve(out) : undefined);
}
