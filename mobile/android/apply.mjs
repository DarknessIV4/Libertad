import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Adds the connection service to the Android project that `npx cap add android` made (android/):
//
//   - copies LibertadForegroundService and LibertadServicePlugin into the app's package (templates/);
//   - declares their permissions and the service in AndroidManifest.xml;
//   - registers the plugin in MainActivity;
//   - picture-in-picture (LibertadPipPlugin): the activity declares it, and MainActivity hands it the two calls it needs.
//
// Safe to run again: whatever is already there is left alone. Run it after `npx cap add android`
// (`npm run android:setup`). Capacitor's template files are plain Java, so this does not need Kotlin.
//
// Each file is `<package>` from the app's own gradle namespace, so it follows the appId in capacitor.config.ts.

const here = path.dirname(fileURLToPath(import.meta.url));
const PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
  'android.permission.CAMERA',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
  'android.permission.FOREGROUND_SERVICE_CAMERA'
];
const SERVICE_XML = `
        <service
            android:name=".LibertadForegroundService"
            android:exported="false"
            android:foregroundServiceType="microphone|camera|specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="Keeps a Mumble server connection open while the app is in the background" />
        </service>
`;

const CAPTURE_SERVICE_XML = `
        <service
            android:name=".LibertadCaptureService"
            android:exported="false"
            android:foregroundServiceType="mediaProjection" />
`;
// A camera is not required to install the app (tablets, Chromebooks)
const CAMERA_FEATURE = '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n';
const PLUGINS = ['LibertadServicePlugin', 'LibertadCapturePlugin', 'LibertadPipPlugin', 'LibertadYoutubePlugin'];
// What the activity has to handle itself for its window to become the small one without restarting
const PIP_CONFIG_CHANGES = ['screenSize', 'smallestScreenSize', 'screenLayout', 'orientation'];

async function read(file) {
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

// Returns what it changed, as short lines
export async function apply(projectRoot = path.resolve(here, '..', '..')) {
  const changes = [];
  const main = path.join(projectRoot, 'android', 'app', 'src', 'main');

  const gradle = await read(path.join(projectRoot, 'android', 'app', 'build.gradle'));
  if (gradle === null) throw new Error('No android/ project here. Run `npx cap add android` first.');
  const namespace = /namespace\s*=?\s*["']([^"']+)["']/.exec(gradle)?.[1];
  if (!namespace) throw new Error('Could not find the namespace in android/app/build.gradle');
  const javaDir = path.join(main, 'java', ...namespace.split('.'));

  // 1. The two classes (always refreshed: they are ours)
  for (const name of ['LibertadForegroundService', 'LibertadServicePlugin', 'LibertadCaptureService', 'LibertadCapturePlugin', 'LibertadPipPlugin', 'LibertadYoutubePlugin']) {
    const source = (await readFile(path.join(here, 'templates', `${name}.java`), 'utf8')).replaceAll('__PACKAGE__', namespace);
    const target = path.join(javaDir, `${name}.java`);
    if ((await read(target)) !== source) {
      await mkdir(javaDir, { recursive: true });
      await writeFile(target, source);
      changes.push(`wrote ${path.relative(projectRoot, target)}`);
    }
  }

  // 1b. androidx.webkit: the YouTube plugin needs it to run its style sheet inside the player's frame
  const gradlePath = path.join(projectRoot, 'android', 'app', 'build.gradle');
  if (!/androidx\.webkit:webkit/.test(gradle)) {
    const m = /dependencies\s*\{/.exec(gradle);
    if (!m) throw new Error('android/app/build.gradle has no dependencies block. Add `implementation "androidx.webkit:webkit:1.12.1"` to it.');
    await writeFile(gradlePath, gradle.slice(0, m.index + m[0].length) + '\n    implementation "androidx.webkit:webkit:1.12.1"' + gradle.slice(m.index + m[0].length));
    changes.push('added androidx.webkit to build.gradle');
  }

  // 2. Manifest
  const manifestPath = path.join(main, 'AndroidManifest.xml');
  let manifest = await read(manifestPath);
  if (manifest === null) throw new Error('android/app/src/main/AndroidManifest.xml is missing');
  const before = manifest;
  const missing = PERMISSIONS.filter(p => !manifest.includes(`"${p}"`));
  if (missing.length) {
    const lines = missing.map(p => `    <uses-permission android:name="${p}" />\n`).join('');
    manifest = manifest.replace('</manifest>', `${lines}</manifest>`);
    changes.push(`added permissions: ${missing.map(p => p.split('.').pop()).join(', ')}`);
  }
  if (!manifest.includes('LibertadForegroundService')) {
    if (!manifest.includes('</application>')) throw new Error('AndroidManifest.xml has no <application>');
    manifest = manifest.replace('</application>', `${SERVICE_XML}    </application>`);
    changes.push('declared the service');
  }
  if (manifest.includes('foregroundServiceType="microphone|specialUse"')) {
    manifest = manifest.replace('foregroundServiceType="microphone|specialUse"', 'foregroundServiceType="microphone|camera|specialUse"');
    changes.push('connection service may hold the camera');
  }
  if (!manifest.includes('.LibertadCaptureService')) {
    manifest = manifest.replace('</application>', `${CAPTURE_SERVICE_XML}    </application>`);
    changes.push('declared the screen capture service');
  }
  if (!manifest.includes('android.hardware.camera')) {
    manifest = manifest.replace('</manifest>', `${CAMERA_FEATURE}</manifest>`);
    changes.push('camera feature (optional)');
  }
  // The activity may go to the small picture-in-picture window, and is not restarted when its size changes
  const activityTag = [...manifest.matchAll(/<activity\b[^>]*>/g)].map(m => m[0]).find(t => t.includes('MainActivity'));
  if (!activityTag) throw new Error('AndroidManifest.xml has no MainActivity <activity>');
  let tag = activityTag;
  if (!tag.includes('android:supportsPictureInPicture')) {
    tag = tag.replace('<activity', '<activity android:supportsPictureInPicture="true"');
    changes.push('the activity supports picture-in-picture');
  }
  const configAttr = /android:configChanges="([^"]*)"/.exec(tag);
  if (configAttr) {
    const have = configAttr[1].split('|').map(x => x.trim()).filter(Boolean);
    const add = PIP_CONFIG_CHANGES.filter(x => !have.includes(x));
    if (add.length) {
      tag = tag.replace(configAttr[0], `android:configChanges="${[...have, ...add].join('|')}"`);
      changes.push(`the activity handles ${add.join(', ')} changes itself`);
    }
  } else {
    tag = tag.replace('<activity', `<activity android:configChanges="${PIP_CONFIG_CHANGES.join('|')}"`);
    changes.push('the activity handles size changes itself');
  }
  if (tag !== activityTag) manifest = manifest.replace(activityTag, tag);
  if (manifest !== before) await writeFile(manifestPath, manifest);

  // 3. MainActivity registers the plugin (before super.onCreate: Capacitor loads its plugins there)
  const activityPath = path.join(javaDir, 'MainActivity.java');
  const activity = await read(activityPath);
  if (activity === null) throw new Error(`${path.relative(projectRoot, activityPath)} is missing`);
  const missingPlugins = PLUGINS.filter(n => !activity.includes(n));
  if (missingPlugins.length) {
    const lines = missingPlugins.map(n => `        registerPlugin(${n}.class);`);
    const bare = /public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\}/;
    let next;
    if (bare.test(activity)) {
      next = activity
        .replace('import com.getcapacitor.BridgeActivity;', 'import android.os.Bundle;\nimport com.getcapacitor.BridgeActivity;')
        .replace(bare, [
          'public class MainActivity extends BridgeActivity {',
          '    @Override',
          '    public void onCreate(Bundle savedInstanceState) {',
          ...lines,
          '        super.onCreate(savedInstanceState);',
          '    }',
          '}'
        ].join('\n'));
    } else if (/registerPlugin\(LibertadServicePlugin\.class\);/.test(activity) && missingPlugins.every(n => n !== 'LibertadServicePlugin')) {
      // Made by an earlier run of this script: add the new plugin next to the first
      next = activity.replace(/(\n\s*)registerPlugin\(LibertadServicePlugin\.class\);/, `$&${lines.map(l => '\n' + l).join('')}`);
    } else {
      throw new Error(`MainActivity.java has been changed already. Add ${missingPlugins.map(n => `\`registerPlugin(${n}.class);\``).join(' and ')} before \`super.onCreate(...)\` in its onCreate.`);
    }
    await writeFile(activityPath, next);
    changes.push('registered the plugins in MainActivity');
  }

  // 3b. Picture-in-picture: the activity tells the plugin when the app is left and when its window becomes the small one
  // (the page then shows only the picture). Both are the system's own calls, so they have to be in MainActivity itself.
  const current = await readFile(activityPath, 'utf8');
  if (!current.includes('LibertadPipPlugin.userLeaveHint')) {
    if (/\bonUserLeaveHint\b|\bonPictureInPictureModeChanged\b/.test(current)) {
      throw new Error('MainActivity.java has its own onUserLeaveHint or onPictureInPictureModeChanged. Add `LibertadPipPlugin.userLeaveHint(this);` to the first and `LibertadPipPlugin.modeChanged(isInPictureInPictureMode, newConfig);` to the second.');
    }
    const end = current.lastIndexOf('}');
    if (end < 0) throw new Error('MainActivity.java has no closing brace');
    const methods = [
      '',
      '    @Override',
      '    public void onUserLeaveHint() {',
      '        super.onUserLeaveHint();',
      '        LibertadPipPlugin.userLeaveHint(this);',
      '    }',
      '',
      '    @Override',
      '    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, android.content.res.Configuration newConfig) {',
      '        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);',
      '        LibertadPipPlugin.modeChanged(isInPictureInPictureMode, newConfig);',
      '    }',
      ''
    ].join('\n');
    await writeFile(activityPath, current.slice(0, end).replace(/\s*$/, '\n') + methods + current.slice(end));
    changes.push('MainActivity hands picture-in-picture to the plugin');
  }

  // 4. The app icon (mobile/android/icons, drawn from scripts/make-icon.py): replaces Capacitor's default launcher icon.
  // Old and round icons, and the adaptive icon's foreground (the adaptive XML Capacitor made already points at it);
  // its background colour is the icon's own.
  const iconsDir = path.join(here, 'icons');
  const res = path.join(main, 'res');
  let icons = 0;
  for (const density of (await readdir(iconsDir)).filter(n => n.startsWith('mipmap-'))) {
    await mkdir(path.join(res, density), { recursive: true });
    for (const file of await readdir(path.join(iconsDir, density))) {
      const from = path.join(iconsDir, density, file);
      const to = path.join(res, density, file);
      const a = await readFile(from);
      const b = await readFile(to).catch(() => null);
      if (!b || !a.equals(b)) { await copyFile(from, to); icons++; }
    }
  }
  const color = (await readFile(path.join(iconsDir, 'background.txt'), 'utf8')).trim();
  const colorFile = path.join(res, 'values', 'ic_launcher_background.xml');
  const colorXml = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${color}</color>\n</resources>\n`;
  if ((await read(colorFile)) !== colorXml) { await mkdir(path.dirname(colorFile), { recursive: true }); await writeFile(colorFile, colorXml); icons++; }
  if (icons) changes.push('app icon');

  return changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changes = await apply(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(changes.length ? changes.map(c => `  ${c}`).join('\n') : '  nothing to change, already set up');
}
