import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const [packageJson, debugScript, releaseScript, helper] = await Promise.all([
  readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../android/build-android-debug.ps1', import.meta.url), 'utf8'),
  readFile(new URL('../android/build-android-release.ps1', import.meta.url), 'utf8'),
  readFile(new URL('../android/build-utils.ps1', import.meta.url), 'utf8')
]);

const packageVersion = JSON.parse(packageJson).version;
const helperPath = path.resolve('scripts/android/build-utils.ps1');
assert.match(debugScript, /build-utils\.ps1/);
assert.match(releaseScript, /build-utils\.ps1/);
assert.match(
  debugScript,
  /Get-RPHubBuildVersion \(Join-Path \$projectRoot 'package\.json'\) \$env:RPHUB_VERSION_NAME/
);
for (const script of [debugScript, releaseScript]) {
  const resolveIndex = script.indexOf('$versionName = Get-RPHubBuildVersion');
  const exportIndex = script.indexOf('$env:RPHUB_VERSION_NAME = $versionName');
  const syncIndex = script.indexOf('& npm.cmd run android:sync');
  assert.ok(resolveIndex >= 0 && resolveIndex < exportIndex && exportIndex < syncIndex,
    'Build version must be resolved and exported before Capacitor sync and Gradle');
}
assert.doesNotMatch(debugScript, /1\.8\.3\.6/);
assert.match(debugScript, /RP-Hub-\$versionName-debug\.apk/);
assert.match(releaseScript, /RP-Hub-\$versionName-release\.apk/);
assert.doesNotMatch(releaseScript, /1\.8\.7\.1/);
assert.match(releaseScript, /apksigner verify --verbose --print-certs/);
assert.match(releaseScript, /build-tools\\35\.0\.0\\apksigner\.bat/);
assert.match(helper, /function Get-RPHubSha256Hex/);
assert.doesNotMatch(debugScript, /function Get-(?:RPHub)?Sha256Hex/);
assert.doesNotMatch(releaseScript, /Get-FileHash/);
assert.match(debugScript, /android-36/);
assert.match(releaseScript, /android-36/);

function runVersion(packagePath, environmentValue, expectFailure = false) {
  const envLiteral = environmentValue === null ? '$null' : JSON.stringify(environmentValue);
  const command = `. '${helperPath.replaceAll("'", "''")}'; Get-RPHubBuildVersion '${packagePath.replaceAll("'", "''")}' ${envLiteral}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' });
  if (expectFailure) {
    assert.notEqual(result.status, 0, `Expected version selection failure: ${environmentValue}`);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rphub-debug-version-'));
try {
  const packagePath = path.join(tempRoot, 'package.json');
  await writeFile(packagePath, JSON.stringify({ version: packageVersion }), 'utf8');
  assert.equal(runVersion(packagePath, '2.0.0-debug'), '2.0.0-debug');
  assert.equal(runVersion(packagePath, '   '), packageVersion);
  assert.equal(runVersion(packagePath, null), packageVersion);

  for (const value of ['bad/name', 'bad\\name', 'bad:name', 'bad<name>', '\u0001bad']) {
    runVersion(packagePath, value, true);
  }
  assert.equal(runVersion(packagePath, ''), packageVersion);
  assert.equal(runVersion(packagePath, '   '), packageVersion);
  runVersion(packagePath, 123, true);
  await writeFile(packagePath, '{', 'utf8');
  runVersion(packagePath, null, true);
  await writeFile(packagePath, JSON.stringify({}), 'utf8');
  runVersion(packagePath, null, true);
  await writeFile(packagePath, JSON.stringify({ version: 1080701 }), 'utf8');
  runVersion(packagePath, null, true);
  await writeFile(packagePath, JSON.stringify({ version: '' }), 'utf8');
  runVersion(packagePath, null, true);
  runVersion(path.join(tempRoot, 'missing.json'), null, true);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const hashRoot = await mkdtemp(path.join(os.tmpdir(), 'rphub-sha256-'));
try {
  const filePath = path.join(hashRoot, 'known.txt');
  await writeFile(filePath, 'RP-Hub Capacitor 8\n', 'utf8');
  const hashCommand = `. '${helperPath.replaceAll("'", "''")}'; Get-RPHubSha256Hex '${filePath.replaceAll("'", "''")}'`;
  const hashResult = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', hashCommand], { encoding: 'utf8' });
  assert.equal(hashResult.status, 0, hashResult.stderr);
  assert.equal(hashResult.stdout.trim(), '9543bc53b2918785025db5979aded11d8729af35e43888632e4af4b689b10222');
} finally {
  await rm(hashRoot, { recursive: true, force: true });
}

console.log('Android debug APK version selection and naming contract: PASS');
await import('./test-native-theme.mjs');
