import assert from 'node:assert/strict';
import { androidReleaseMetadata, deriveRevision, selectRevision, transformPackageJson, transformPackageLock, transformBuildGradle, transformBuildScript } from '../prepare-android-release.mjs';

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

assert.equal(selectRevision({ upstreamTag: '1.8.9', currentVersion: '1.8.8.1', mode: 'merge' }), 0, 'new upstream base starts at revision 0');
assert.equal(selectRevision({ upstreamTag: '1.8.8', currentVersion: '1.8.8', mode: 'merge' }), 1, 'same upstream base increments 0 to 1');
assert.equal(selectRevision({ upstreamTag: '1.8.8', currentVersion: '1.8.8.1', mode: 'merge' }), 2, 'same upstream base increments 1 to 2');
assert.equal(selectRevision({ upstreamTag: '1.8.8', currentVersion: '1.8.8.1', mode: 'recover' }), 1, 'recover keeps current revision');
assert.equal(selectRevision({ upstreamTag: '1.8.8', currentVersion: '1.8.8.1', mode: 'noop' }), 1, 'noop keeps current revision');
assert.throws(
  () => selectRevision({ upstreamTag: '1.8.8', currentVersion: '1.8.8.100', mode: 'recover' }),
  /revision must be an integer/,
  'recover must reject an invalid current revision'
);
assert.equal(selectRevision({ upstreamTag: '1.8.8', currentVersion: '1.8.8.1', mode: 'merge', explicitRevision: '7' }), 7, 'explicit revision overrides automatic selection');
assert.throws(
  () => selectRevision({ upstreamTag: '1.8.8', currentVersion: '1.8.8.99', mode: 'merge' }),
  /revision must be an integer/,
  'same-base revision overflow must fail closed'
);
assert.throws(
  () => selectRevision({ upstreamTag: '1.8.8', currentVersion: '1.8.8.100', mode: 'merge' }),
  /revision must be an integer/,
  'invalid current revision must fail closed'
);
assert.throws(
  () => selectRevision({ upstreamTag: '1.8.9', currentVersion: '1.8.8.100', mode: 'merge' }),
  /revision must be an integer/,
  'a new upstream base must not hide an invalid current revision'
);
assert.throws(
  () => selectRevision({ upstreamTag: '1.8.8', currentVersion: '1.8.8', mode: 'merge', explicitRevision: 100 }),
  /revision must be an integer/,
  'explicit revision overflow must fail closed'
);
assert.throws(
  () => selectRevision({ upstreamTag: '1.8.8', currentVersion: '1.8.8', mode: 'manual' }),
  /Unsupported sync mode/,
  'unknown sync mode must fail closed'
);
assert.throws(
  () => selectRevision({ upstreamTag: '1.8.8', currentVersion: 'not-a-version', mode: 'merge' }),
  /Current package version is not a supported semantic version/,
  'malformed current version must fail closed'
);
assert.throws(
  () => selectRevision({ upstreamTag: '1.8.8', currentVersion: 'not-a-version', mode: 'merge', explicitRevision: 7 }),
  /Current package version is not a supported semantic version/,
  'explicit revision must not hide a malformed current version'
);

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
