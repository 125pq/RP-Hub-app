import assert from 'node:assert/strict';
import { androidReleaseMetadata, deriveRevision, transformPackageJson, transformPackageLock, transformBuildGradle, transformBuildScript } from '../prepare-android-release.mjs';

assert.deepEqual(androidReleaseMetadata('1.8.3'), {
  versionName: '1.8.3',
  versionCode: '1080300',
  androidTag: 'v1.8.3-android',
  apkName: 'RP-Hub-1.8.3-release.apk',
  title: 'RP-Hub Android 1.8.3'
});
assert.deepEqual(androidReleaseMetadata('1.8.3', 2), {
  versionName: '1.8.3.2',
  versionCode: '1080302',
  androidTag: 'v1.8.3.2-android',
  apkName: 'RP-Hub-1.8.3.2-release.apk',
  title: 'RP-Hub Android 1.8.3.2'
});
assert.equal(androidReleaseMetadata('v2.0.0').versionCode, '2000000');
assert.throws(() => androidReleaseMetadata('1.8.3-rc.1'), /not a supported semantic version/);
assert.throws(() => androidReleaseMetadata('1.100.0'), /below 100/);
assert.throws(() => androidReleaseMetadata('1.8.3', 100), /revision must be an integer/);

assert.equal(deriveRevision('1.8.3', '1.8.3'), 0);
assert.equal(deriveRevision('1.8.3', '1.8.3.3'), 3);
assert.equal(deriveRevision('v1.8.3', '1.8.3.3'), 3);
assert.equal(deriveRevision('1.8.4', '1.8.3.3'), 0);

assert.equal(transformPackageJson('{\n  "version": "1.8.3.3"\n}', '1.8.4'), '{\n  "version": "1.8.4"\n}');
assert.equal(transformPackageLock('"version": "1.8.3.3"', '1.8.3.3', '1.8.4'), '"version": "1.8.4"');
assert.equal(
  transformBuildGradle(
    "def releaseVersionName = System.getenv('RPHUB_VERSION_NAME') ?: '1.8.3.3'\ndef releaseVersionCode = (System.getenv('RPHUB_VERSION_CODE') ?: '1080303').toInteger()",
    '1.8.4',
    '1080400'
  ),
  "def releaseVersionName = System.getenv('RPHUB_VERSION_NAME') ?: '1.8.4'\ndef releaseVersionCode = (System.getenv('RPHUB_VERSION_CODE') ?: '1080400').toInteger()"
);
assert.equal(
  transformBuildScript("$versionName = if ($env:RPHUB_VERSION_NAME) { $env:RPHUB_VERSION_NAME } else { '1.8.3.3' }", '1.8.4'),
  "$versionName = if ($env:RPHUB_VERSION_NAME) { $env:RPHUB_VERSION_NAME } else { '1.8.4' }"
);

console.log('Android release metadata mapping: PASS');
