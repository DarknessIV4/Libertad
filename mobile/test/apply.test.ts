import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../android/apply.mjs';

// A project the way `npx cap add android` leaves it (the parts apply.mjs touches)
async function project(activity: string, activityTag?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'libertad-apply-'));
  const main = path.join(root, 'android', 'app', 'src', 'main');
  await mkdir(path.join(main, 'java', 'dev', 'f0ck', 'Libertad'), { recursive: true });
  await writeFile(path.join(root, 'android', 'app', 'build.gradle'), 'android {\n    namespace = "dev.f0ck.Libertad"\n}\n');
  await writeFile(path.join(main, 'AndroidManifest.xml'), `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Libertad">
        ${activityTag ?? '<activity android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density" android:name=".MainActivity" android:launchMode="singleTask" android:exported="true">'}
        </activity>
    </application>
</manifest>
`);
  await writeFile(path.join(main, 'java', 'dev', 'f0ck', 'Libertad', 'MainActivity.java'), activity);
  return { root, manifest: path.join(main, 'AndroidManifest.xml'), activity: path.join(main, 'java', 'dev', 'f0ck', 'Libertad', 'MainActivity.java') };
}
const BARE = 'package dev.f0ck.Libertad;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n';

test('a fresh project gets the picture-in-picture plugin, its manifest entries and the two hand-overs', async () => {
  const p = await project(BARE);
  await apply(p.root);
  const manifest = await readFile(p.manifest, 'utf8');
  assert.match(manifest, /<activity android:supportsPictureInPicture="true"/);
  const activity = await readFile(p.activity, 'utf8');
  assert.match(activity, /registerPlugin\(LibertadPipPlugin\.class\);/);
  assert.match(activity, /LibertadPipPlugin\.userLeaveHint\(this\);/);
  assert.match(activity, /LibertadPipPlugin\.modeChanged\(isInPictureInPictureMode, newConfig\);/);
  assert.match(await readFile(path.join(path.dirname(p.activity), 'LibertadPipPlugin.java'), 'utf8'), /^package dev\.f0ck\.Libertad;/);
  // the closing brace of the class is still the last thing in the file
  assert.equal(activity.trimEnd().endsWith('}'), true);
  // a second run finds nothing to do
  const again = await apply(p.root);
  assert.deepEqual(again, []);
});

test('a project set up before (two plugins registered) gets the new one added', async () => {
  const old = `package dev.f0ck.Libertad;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LibertadServicePlugin.class);
        registerPlugin(LibertadCapturePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;
  const p = await project(old);
  const changes = await apply(p.root);
  const activity = await readFile(p.activity, 'utf8');
  assert.equal((activity.match(/registerPlugin\(/g) ?? []).length, 3);
  assert.match(activity, /public void onUserLeaveHint\(\)/);
  assert.ok(changes.some(c => c.includes('picture-in-picture')));
  assert.deepEqual(await apply(p.root), []);
});

test('the activity is told to handle size changes itself when it did not', async () => {
  const p = await project(BARE, '<activity android:name=".MainActivity" android:configChanges="orientation|keyboard" android:exported="true">');
  await apply(p.root);
  const tag = /<activity[^>]*>/.exec(await readFile(p.manifest, 'utf8'))![0];
  for (const x of ['screenSize', 'smallestScreenSize', 'screenLayout', 'orientation', 'keyboard']) assert.ok(tag.includes(x), x);
  assert.equal((tag.match(/supportsPictureInPicture/g) ?? []).length, 1);
});

test('an activity with its own onUserLeaveHint is not rewritten', async () => {
  const own = `package dev.f0ck.Libertad;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LibertadServicePlugin.class);
        registerPlugin(LibertadCapturePlugin.class);
        registerPlugin(LibertadPipPlugin.class);
        super.onCreate(savedInstanceState);
    }
    @Override public void onUserLeaveHint() {}
}
`;
  const p = await project(own);
  await assert.rejects(() => apply(p.root), /onUserLeaveHint/);
});
