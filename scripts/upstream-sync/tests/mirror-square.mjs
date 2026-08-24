import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchSquareMirrorApp } from '../patches/patch-backup.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = relativePath => readFile(path.join(projectRoot, relativePath), 'utf8');

const upstreamFixture = [
  '        // Square State',
  '        const isSquareLoading = ref(true);',
  "        const squareUrl = ref('https://rphforum.zeabur.app/');",
  '',
  '        onBeforeUnmount(() => {',
  '        });'
].join('\n');

const patchedFixture = patchSquareMirrorApp(upstreamFixture);
assert.match(patchedFixture, /const squareUrl = ref\(getSquareUrl\(\)\);/);
assert.match(patchedFixture, /squareUrl\.value = getSquareUrl\(true\);/);
assert.match(patchedFixture, /stopSquareMirrorChange\(\);/);
assert.equal(patchSquareMirrorApp(patchedFixture), patchedFixture, 'square mirror patch must be idempotent');

const mirrorFixture = upstreamFixture.replace('https://rphforum.zeabur.app/', 'https://rp.zhaoyangxx.ccwu.cc/');
assert.equal(patchSquareMirrorApp(mirrorFixture), patchedFixture, 'patch must normalize the existing mirror hardcode too');

const [app, backup] = await Promise.all([
  read('assets/js/app.js'),
  read('assets/js/rphub-backup.js')
]);

assert.match(app, /getMirrorSquarePreference\?\.\(\) !== false/, 'app.js must read the persisted mirror preference');
assert.match(app, /const squareUrl = ref\(getSquareUrl\(\)\);/, 'initial square URL must use the preference');
assert.match(app, /squareUrl\.value = getSquareUrl\(true\);/, 'square view refresh must use the preference');
assert.match(app, /onMirrorSquareChange\?\./, 'app.js must subscribe to live preference changes');
assert.doesNotMatch(app, /const squareUrl = ref\('https:\/\/(?:rphforum\.zeabur\.app|rp\.zhaoyangxx\.ccwu\.cc)\/'\)/);
assert.doesNotMatch(app, /squareUrl\.value = `https:\/\/(?:rphforum\.zeabur\.app|rp\.zhaoyangxx\.ccwu\.cc)\/\?t=/);

assert.match(backup, /function getMirrorSquarePreference\(\)/);
assert.match(backup, /function onMirrorSquareChange\(listener\)/);
assert.match(backup, /setMirrorSquarePreference\(!getMirrorSquarePreference\(\)\)/);
assert.match(backup, /getMirrorSquarePreference,\s*onMirrorSquareChange,/);

console.log('Wanxiang Square mirror preference integration: PASS');
