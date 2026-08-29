import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { androidReleaseMetadata, deriveRevision, readmeAnchorDiff, selectRevision, transformPackageJson, transformPackageLock, transformBuildGradle, transformBuildScript, transformReadmeAnchors, updateReadmeAnchors } from '../prepare-android-release.mjs';

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

// README anchor rewriting: version/SHA/download lines change, everything else stays byte-identical.
const readmeFixtureLf = [
  '# Roleplay Hub APP',
  '',
  '[![Android Release](https://img.shields.io/badge/Android-1.8.4.3-3DDC84?logo=android&logoColor=white)](https://github.com/125pq/RP-Hub-app/releases/tag/v1.8.4.3-android)',
  '',
  '当前正式版本：**RP-Hub Android 1.8.4.3**',
  '',
  '- Package ID：`io.github.pq125.rphub`',
  '- Version code：`1080403`',
  '- 下载：[RP-Hub-1.8.4.3-release.apk](https://github.com/125pq/RP-Hub-app/releases/download/v1.8.4.3-android/RP-Hub-1.8.4.3-release.apk)',
  '- SHA-256：`0241f73f6253ae015c07b0b1a08ce661e3fc44fe5572031a881c09aaf8b76497`',
  '',
  '其他内容行不变。',
  ''
].join('\n');

const readmeUpdated = transformReadmeAnchors(readmeFixtureLf, {
  versionName: '1.8.4.4',
  versionCode: '1080404',
  sha256: 'A'.repeat(64),
  downloadUrl: 'https://github.com/125pq/RP-Hub-app/releases/download/v1.8.4.4-android/RP-Hub-1.8.4.4-release.apk'
});
assert.deepEqual(readmeUpdated.missing, []);
assert.deepEqual(readmeUpdated.drift, []);
const readmeUpdatedLines = readmeUpdated.text.split('\n');
assert.equal(readmeUpdatedLines[0], '# Roleplay Hub APP', 'surrounding lines must stay untouched');
assert.equal(readmeUpdatedLines[1], '', 'blank line must stay untouched');
assert.equal(readmeUpdatedLines[2], '[![Android Release](https://img.shields.io/badge/Android-1.8.4.4-3DDC84?logo=android&logoColor=white)](https://github.com/125pq/RP-Hub-app/releases/tag/v1.8.4.4-android)', 'badge image and release link update together');
assert.equal(readmeUpdatedLines[3], '');
assert.equal(readmeUpdatedLines[4], '当前正式版本：**RP-Hub Android 1.8.4.4**', 'version line replaced');
assert.equal(readmeUpdatedLines[5], '');
assert.equal(readmeUpdatedLines[6], '- Package ID：`io.github.pq125.rphub`', 'non-anchor backtick line unchanged');
assert.equal(readmeUpdatedLines[7], '- Version code：`1080404`', 'versionCode line replaced');
assert.equal(readmeUpdatedLines[8], '- 下载：[RP-Hub-1.8.4.4-release.apk](https://github.com/125pq/RP-Hub-app/releases/download/v1.8.4.4-android/RP-Hub-1.8.4.4-release.apk)', 'download URL line replaced');
assert.equal(readmeUpdatedLines[9], `- SHA-256：\`${'a'.repeat(64)}\``, 'SHA-256 normalized to lowercase');
assert.equal(readmeUpdatedLines[10], '');
assert.equal(readmeUpdatedLines[11], '其他内容行不变。', 'line after anchors unchanged');
const readmeDiff = readmeAnchorDiff(readmeFixtureLf, readmeUpdated.text);
assert.deepEqual(readmeDiff.map((entry) => entry.line), [3, 5, 8, 9, 10], 'only badge, version, versionCode, download, SHA lines change');

// CRLF fixtures must come back CRLF.
const readmeFixtureCrlf = readmeFixtureLf.split('\n').join('\r\n');
const readmeCrlfResult = transformReadmeAnchors(readmeFixtureCrlf, { versionName: '1.8.4.4', versionCode: '1080404' });
assert.equal(readmeCrlfResult.text.includes('\r'), true, 'CRLF fixture preserves carriage returns');
assert.equal(readmeCrlfResult.text.split('\r\n').length, readmeFixtureCrlf.split('\r\n').length, 'line count unchanged under CRLF');
assert.equal(readmeCrlfResult.text.split('\r\n')[4], '当前正式版本：**RP-Hub Android 1.8.4.4**');

// Mixed-EOL fixtures keep each line's original line ending; only anchor lines
// change and every untouched line retains its own CRLF or LF.
const mixedLines = readmeFixtureLf.split('\n');
const readmeFixtureMixed = mixedLines
  .map((line, index) => line + (index % 2 === 0 ? '\r\n' : '\n'))
  .join('')
  .replace(/\n$/, '');
const readmeMixedResult = transformReadmeAnchors(readmeFixtureMixed, {
  versionName: '1.8.4.4',
  versionCode: '1080404',
  sha256: 'b'.repeat(64),
  downloadUrl: 'https://github.com/125pq/RP-Hub-app/releases/download/v1.8.4.4-android/RP-Hub-1.8.4.4-release.apk'
});
assert.equal(readmeMixedResult.missing.length, 0);
const mixedDiff = readmeAnchorDiff(readmeFixtureMixed, readmeMixedResult.text);
assert.deepEqual(mixedDiff.map((entry) => entry.line), [3, 5, 8, 9, 10], 'mixed-EOL fixture still only touches anchor lines');
for (const entry of mixedDiff) {
  const originalEol = readmeFixtureMixed.split(/(?<=\r\n|\n)/)[entry.line - 1]?.match(/(\r\n|\n)$/)?.[1];
  const updatedEol = readmeMixedResult.text.split(/(?<=\r\n|\n)/)[entry.line - 1]?.match(/(\r\n|\n)$/)?.[1];
  assert.equal(updatedEol, originalEol, `line ${entry.line} keeps its original line ending`);
}

// No-op when values already match: zero diff, no missing anchors.
const readmeIdle = transformReadmeAnchors(readmeFixtureLf, {
  versionName: '1.8.4.3',
  versionCode: '1080403',
  sha256: '0241f73f6253ae015c07b0b1a08ce661e3fc44fe5572031a881c09aaf8b76497',
  downloadUrl: 'https://github.com/125pq/RP-Hub-app/releases/download/v1.8.4.3-android/RP-Hub-1.8.4.3-release.apk'
});
assert.equal(readmeAnchorDiff(readmeFixtureLf, readmeIdle.text).length, 0, 'identical inputs produce no diff');
assert.deepEqual(readmeIdle.missing, []);
assert.deepEqual(readmeIdle.drift, []);

// Missing anchor lines are reported instead of throwing inside the pure transform.
const readmeMissing = transformReadmeAnchors('# no anchors\n\nplain text\n', { versionName: '1.9.0', versionCode: '1090000' });
assert.deepEqual(readmeMissing.missing, ['badge', 'version line', 'versionCode'], 'optional sha/download stay silent, required anchors are reported');
assert.deepEqual(readmeMissing.drift, []);
assert.equal(readmeMissing.text, '# no anchors\n\nplain text\n', 'text unchanged when anchors are missing');

const duplicateBadge = transformReadmeAnchors(`${readmeFixtureLf}${readmeFixtureLf.split('\n')[2]}\n`, {
  versionName: '1.9.0',
  versionCode: '1090000'
});
assert.deepEqual(duplicateBadge.missing, []);
assert.deepEqual(duplicateBadge.drift, ['badge line (expected 1, found 2)'], 'duplicate badge lines are reported as drift');

const driftedBadgeImageFixture = readmeFixtureLf.replace('img.shields.io/badge/Android-1.8.4.3-', 'img.shields.io/badge/Android-current-');
const driftedBadgeImage = transformReadmeAnchors(driftedBadgeImageFixture, { versionName: '1.9.0', versionCode: '1090000' });
assert.deepEqual(driftedBadgeImage.missing, []);
assert.deepEqual(driftedBadgeImage.drift, ['badge image version anchor (expected 1, found 0)'], 'image-version anchor drift is reported');
assert.equal(driftedBadgeImage.text.split('\n')[2], driftedBadgeImageFixture.split('\n')[2], 'drifted badge line is not partially rewritten');

const driftedBadgeHrefFixture = readmeFixtureLf.replace('releases/tag/v1.8.4.3-android)', 'releases/latest)');
const driftedBadgeHref = transformReadmeAnchors(driftedBadgeHrefFixture, { versionName: '1.9.0', versionCode: '1090000' });
assert.deepEqual(driftedBadgeHref.missing, []);
assert.deepEqual(driftedBadgeHref.drift, ['badge release href anchor (expected 1, found 0)'], 'release-href anchor drift is reported');
assert.equal(driftedBadgeHref.text.split('\n')[2], driftedBadgeHrefFixture.split('\n')[2], 'drifted badge href prevents a partial rewrite');

const duplicateImageAnchorFixture = readmeFixtureLf.replace('?logo=android', 'img.shields.io/badge/Android-1.8.4.3-?logo=android');
const duplicateImageAnchor = transformReadmeAnchors(duplicateImageAnchorFixture, { versionName: '1.9.0', versionCode: '1090000' });
assert.deepEqual(duplicateImageAnchor.drift, ['badge image version anchor (expected 1, found 2)'], 'duplicate image-version sub-anchors are rejected');

const duplicateHrefAnchorFixture = readmeFixtureLf.replace('-android)', '-android)releases/tag/v1.8.4.3-android)');
const duplicateHrefAnchor = transformReadmeAnchors(duplicateHrefAnchorFixture, { versionName: '1.9.0', versionCode: '1090000' });
assert.deepEqual(duplicateHrefAnchor.drift, ['badge release href anchor (expected 1, found 2)'], 'duplicate release-href sub-anchors are rejected');

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'rphub-readme-anchor-'));
const tempReadmePath = path.join(tempDir, 'README.md');
try {
  writeFileSync(tempReadmePath, driftedBadgeHrefFixture, 'utf8');
  const originalLog = console.log;
  console.log = () => {};
  let dryRunResult;
  try {
    dryRunResult = updateReadmeAnchors({ versionName: '1.9.0', versionCode: '1090000', dryRun: true, readmePath: tempReadmePath });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(dryRunResult.drift, ['badge release href anchor (expected 1, found 0)'], 'dry-run reports badge drift without failing');
  const rejectedFixtures = [
    ['missing anchors', '# no anchors\n', /README anchor validation failed \(missing:/],
    ['duplicate badge lines', `${readmeFixtureLf}${readmeFixtureLf.split('\n')[2]}\n`, /drift: badge line \(expected 1, found 2\)/],
    ['image-version drift', driftedBadgeImageFixture, /drift: badge image version anchor \(expected 1, found 0\)/],
    ['release-href drift', driftedBadgeHrefFixture, /drift: badge release href anchor \(expected 1, found 0\)/]
  ];
  for (const [label, fixture, errorPattern] of rejectedFixtures) {
    writeFileSync(tempReadmePath, fixture, 'utf8');
    assert.throws(
      () => updateReadmeAnchors({ versionName: '1.9.0', versionCode: '1090000', readmePath: tempReadmePath }),
      errorPattern,
      `non-dry-run fails closed on ${label}`
    );
    assert.equal(readFileSync(tempReadmePath, 'utf8'), fixture, `${label} failure does not write a partial README update`);
  }

  const readmeLines = readmeFixtureLf.split('\n');
  const fullUpdateOptions = {
    versionName: '1.9.0',
    versionCode: '1090000',
    sha256: 'c'.repeat(64),
    downloadUrl: 'https://github.com/125pq/RP-Hub-app/releases/download/v1.9.0-android/RP-Hub-1.9.0-release.apk'
  };
  const duplicateNonBadgeAnchors = [
    ['version line', 4, /drift: version line \(expected 1, found 2\)/],
    ['versionCode', 7, /drift: versionCode line \(expected 1, found 2\)/],
    ['download URL', 8, /drift: download URL line \(expected 1, found 2\)/],
    ['SHA-256', 9, /drift: SHA-256 line \(expected 1, found 2\)/]
  ];
  for (const [label, lineIndex, errorPattern] of duplicateNonBadgeAnchors) {
    const fixture = `${readmeFixtureLf}${readmeLines[lineIndex]}\n`;
    writeFileSync(tempReadmePath, fixture, 'utf8');
    assert.throws(
      () => updateReadmeAnchors({ ...fullUpdateOptions, readmePath: tempReadmePath }),
      errorPattern,
      `non-dry-run fails closed on duplicate ${label}`
    );
    assert.equal(readFileSync(tempReadmePath, 'utf8'), fixture, `duplicate ${label} does not write a partial README update`);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('README anchor rewriting: PASS');
