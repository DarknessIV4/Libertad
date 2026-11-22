// Builds the debug APK with Gradle and copies it to release/Libertad-<version>-android.apk.
// Run by `npm run build:android` after the page, the Node backend and the native files are in android/.
// Gradle only rebuilds what changed, so running this again with no edits takes a few seconds.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const androidDir = join(root, 'android');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function fail(message) {
  console.error(`\nbuild-apk: ${message}\n`);
  process.exit(1);
}

if (!existsSync(join(androidDir, 'gradlew'))) fail('android/ not found. Run `npx cap add android` once, then build again.');

// Gradle cannot run on a Java that is too new ("Unsupported class file major version"), so check first.
const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
const major = /version "(\d+)/.exec(`${java.stderr ?? ''}${java.stdout ?? ''}`)?.[1];
if (!major) fail('java was not found. Install JDK 21 and set JAVA_HOME to it.');
if (Number(major) !== 21) fail(`the Android build needs JDK 21, but this shell uses Java ${major}. Set JAVA_HOME to JDK 21 (see the README), then try again.`);

const gradle = spawnSync('./gradlew', ['assembleDebug'], { cwd: androidDir, stdio: 'inherit' });
if (gradle.status !== 0) fail('Gradle failed, see the output above.');

const apkDir = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug');
const apks = existsSync(apkDir) ? readdirSync(apkDir).filter((f) => f.endsWith('.apk')) : [];
if (apks.length === 0) fail(`no APK found in ${apkDir}`);
apks.sort((a, b) => statSync(join(apkDir, b)).mtimeMs - statSync(join(apkDir, a)).mtimeMs);

const outDir = join(root, 'release');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `Libertad-${version}-android.apk`);
copyFileSync(join(apkDir, apks[0]), out);
console.log(`\nAPK ready: ${out}\n`);
