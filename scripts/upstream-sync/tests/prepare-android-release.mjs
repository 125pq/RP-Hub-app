import assert from 'node:assert/strict';
import { androidReleaseMetadata } from '../prepare-android-release.mjs';

assert.deepEqual(androidReleaseMetadata('1.8.3'), {
  versionName: '1.8.3',
  versionCode: '10803',
  androidTag: 'v1.8.3-android',
  apkName: 'RP-Hub-1.8.3-release.apk',
  title: 'RP-Hub Android 1.8.3'
});
assert.equal(androidReleaseMetadata('v2.0.0').versionCode, '20000');
assert.throws(() => androidReleaseMetadata('1.8.3-rc.1'), /not a supported semantic version/);
assert.throws(() => androidReleaseMetadata('1.100.0'), /below 100/);

console.log('Android release metadata mapping: PASS');
