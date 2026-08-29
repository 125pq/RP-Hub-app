import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countOccurrences, projectRoot } from './lib.mjs';

const read = relativePath => readFile(path.join(projectRoot, relativePath), 'utf8');
const [index, app, core, character, novel, platform, android, updateCheck] = await Promise.all([
  read('index.html'),
  read('assets/js/app.js'),
  read('assets/js/core-utils.js'),
  read('character/index.html'),
  read('novel/index.html'),
  read('assets/js/platform-services.js'),
  read('assets/js/rphub-android-adapter.js'),
  read('assets/js/update-check.js')
]);

assert.match(platform, /global\.platformAdapter\s*=\s*platformAdapter/);
assert.match(platform, /global\.PlatformServices\s*=\s*platformAdapter/);
assert.equal(countOccurrences(index, 'assets/js/rphub-android-adapter.js'), 1, 'Android adapter script must load exactly once');
assert.equal(countOccurrences(index, 'assets/js/update-check.js'), 1, 'Update check script must load exactly once');
assert.equal(countOccurrences(android, 'if (global.__rphubAndroidAdapterLoaded) return;'), 1, 'Android adapter needs one initialization guard');
assert.equal(countOccurrences(android, 'platform.installNativeAdapter(new AndroidAdapter(global));'), 1, 'Android adapter must install once');

assert.match(app, /initializePlatformAdapters[\s\S]*adapter\.onBackButton\(handlePlatformBackButton\)/);
assert.match(app, /removePlatformBackListener\(\);/);
assert.doesNotMatch(app, /removePlatformStateListener|isNativeAppActive/);
assert.match(core, /adapter\.exportFile\(/);
assert.match(character, /cardUtils\.saveGeneratedFile\(/);
assert.match(novel, /adapter\.exportFile[\s\S]*mimeType:\s*'text\/plain'/);
assert.match(updateCheck, /window\.platformAdapter\?\.isNative\?\.\(\) === true/, 'Native update guard must target the loaded update-check module');

const platformIndex = index.indexOf('assets/js/platform-services.js');
const androidIndex = index.indexOf('assets/js/rphub-android-adapter.js');
const appIndex = index.indexOf('assets/js/app.js');
assert.ok(platformIndex >= 0 && platformIndex < androidIndex && androidIndex < appIndex, 'Platform facade must load before Android adapter and app.js');

const publicMethods = [
  'isNative', 'getPlatform', 'openExternalUrl', 'share', 'exportFile', 'saveFile', 'download',
  'pickFile', 'importFile', 'readFile', 'blobToBase64', 'base64ToBlob', 'invokeNative',
  'onBackButton', 'onAppStateChange', 'getAppInfo'
];
for (const method of publicMethods) {
  assert.match(platform, new RegExp(`\\b${method}\\b`), `Platform facade missing ${method}`);
}
for (const method of ['isNative', 'getPlatform', 'openExternalUrl', 'share', 'exportFile', 'invokeNative', 'onBackButton', 'onAppStateChange', 'getAppInfo']) {
  assert.match(android, new RegExp(`\\b${method}\\s*\\(`), `Android adapter missing ${method}`);
}
assert.match(android, /class AndroidAdapter extends platform\.BrowserAdapter/);
assert.match(android, /invokeNative\('NativeClipboard', 'readText'\)/, 'Android secure paste must use the native clipboard');
assert.match(android, /input\[type="password"\]/, 'Android secure paste must preserve password inputs');
assert.match(android, /rphub-native-paste-menu/, 'Android secure paste needs a contextual action');
assert.match(await read('android/app/src/main/java/io/github/pq125/rphub/MainActivity.java'), /registerPlugin\(NativeClipboardPlugin\.class\)/);
assert.match(await read('android/app/src/main/java/io/github/pq125/rphub/MainActivity.java'), /registerPlugin\(AppUpdatePlugin\.class\)/);
assert.match(await read('android/app/src/main/java/io/github/pq125/rphub/AppUpdatePlugin.java'), /@CapacitorPlugin\(name = "AppUpdate"\)/);
assert.match(await read('android/app/src/main/java/io/github/pq125/rphub/AppUpdatePlugin.java'), /checkNow\(PluginCall call\)/);
assert.match(await read('assets/js/rphub-backup.js'), /data-action="check-update"/);

const scanRoots = ['assets/js', 'character', 'novel'];
const candidates = [];
async function walk(relativeDirectory) {
  for (const entry of await readdir(path.join(projectRoot, relativeDirectory), { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!['vendor', 'generated'].includes(entry.name)) await walk(relativePath);
    } else if (/\.(?:js|html)$/.test(entry.name)) {
      candidates.push(relativePath);
    }
  }
}
for (const root of scanRoots) await walk(root);
candidates.push('index.html');

const allowed = new Set(['assets/js/rphub-android-adapter.js']);
const forbiddenPatterns = [
  ['window.Android', /window\.Android/],
  ['Android.xxx', /\bAndroid\s*\./],
  ['Capacitor.xxx', /\bCapacitor\s*\./],
  ['NativeFile.xxx', /\bNativeFile\s*\./]
];
for (const relativePath of candidates) {
  if (allowed.has(relativePath.replace(/\\/g, '/'))) continue;
  const source = await read(relativePath);
  for (const [label, pattern] of forbiddenPatterns) {
    assert.doesNotMatch(source, pattern, `${label} leaked into ${relativePath}`);
  }
}

assert.match(await read('android/app/src/test/java/io/github/pq125/rphub/NativeFilePluginTest.java'), /abc\.card \(3\)\.json/);
console.log('Upstream hook and Android adapter verification: PASS');
console.log(`Checked upstream-facing files: ${candidates.length}`);
