import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './lib.mjs';

export function androidReleaseMetadata(upstreamTag, revision = 0) {
  const match = String(upstreamTag || '').match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Upstream release tag is not a supported semantic version: ${upstreamTag || '(empty)'}`);
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (minor > 99 || patch > 99) throw new Error(`Android versionCode requires minor and patch below 100: ${upstreamTag}`);
  const numericRevision = Number(revision);
  if (!Number.isInteger(numericRevision) || numericRevision < 0 || numericRevision > 99) {
    throw new Error(`Android release revision must be an integer from 0 through 99: ${revision}`);
  }
  const versionCode = (major * 10000 + minor * 100 + patch) * 100 + numericRevision;
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
    throw new Error(`Android versionCode is outside the supported range: ${versionCode}`);
  }
  const baseVersionName = `${major}.${minor}.${patch}`;
  const versionName = numericRevision > 0 ? `${baseVersionName}.${numericRevision}` : baseVersionName;
  return {
    versionName,
    versionCode: String(versionCode),
    androidTag: `v${versionName}-android`,
    apkName: `RP-Hub-${versionName}-release.apk`,
    title: `RP-Hub Android ${versionName}`
  };
}

export function deriveRevision(upstreamTag, currentVersion) {
  const upstream = String(upstreamTag || '').replace(/^v/, '');
  const current = String(currentVersion || '').replace(/^v/, '');
  if (!upstream || !current) return 0;
  if (current === upstream) return 0;
  const prefix = `${upstream}.`;
  if (current.startsWith(prefix)) {
    const revision = Number(current.slice(prefix.length));
    if (Number.isInteger(revision) && revision >= 1 && revision <= 99) return revision;
  }
  return 0;
}

function currentPackageVersion() {
  const version = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
  return String(version || '');
}

export function transformPackageJson(source, versionName) {
  return source.replace(/("version"\s*:\s*")[^"]*(")/, `$1${versionName}$2`);
}

export function transformPackageLock(source, oldVersion, newVersion) {
  return source.split(`"version": "${oldVersion}"`).join(`"version": "${newVersion}"`);
}

export function transformBuildGradle(source, versionName, versionCode) {
  const next = source.replace(
    /(def releaseVersionName = System\.getenv\('RPHUB_VERSION_NAME'\) \?: ')[^']*(')/,
    `$1${versionName}$2`
  );
  return next.replace(
    /(def releaseVersionCode = \(System\.getenv\('RPHUB_VERSION_CODE'\) \?: ')[^']*('\)\.toInteger\(\))/,
    `$1${versionCode}$2`
  );
}

export function transformBuildScript(source, versionName) {
  return source.replace(/(else \{ ')[^']*(' \})/, `$1${versionName}$2`);
}

export function applyAndroidVersion(versionName, versionCode) {
  const oldVersion = currentPackageVersion();

  const packageJsonPath = path.join(projectRoot, 'package.json');
  writeFileSync(packageJsonPath, transformPackageJson(readFileSync(packageJsonPath, 'utf8'), versionName), 'utf8');

  const lockPath = path.join(projectRoot, 'package-lock.json');
  writeFileSync(lockPath, transformPackageLock(readFileSync(lockPath, 'utf8'), oldVersion, versionName), 'utf8');

  const gradlePath = path.join(projectRoot, 'android', 'app', 'build.gradle');
  writeFileSync(gradlePath, transformBuildGradle(readFileSync(gradlePath, 'utf8'), versionName, versionCode), 'utf8');

  const scriptPath = path.join(projectRoot, 'scripts', 'android', 'build-android-release.ps1');
  writeFileSync(scriptPath, transformBuildScript(readFileSync(scriptPath, 'utf8'), versionName), 'utf8');
}

function publishOutputs(metadata) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, [
    `version_name=${metadata.versionName}`,
    `version_code=${metadata.versionCode}`,
    `android_tag=${metadata.androidTag}`,
    `apk_name=${metadata.apkName}`,
    `title=${metadata.title}`,
    ''
  ].join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const upstreamTag = process.argv[2];
  const rawRevision = process.argv.length > 3 ? String(process.argv[3]).trim() : '';
  const explicitRevision = rawRevision === '' ? null : Number(rawRevision);
  const revision = Number.isInteger(explicitRevision) ? explicitRevision : deriveRevision(upstreamTag, currentPackageVersion());
  const metadata = androidReleaseMetadata(upstreamTag, revision);
  publishOutputs(metadata);
  for (const [key, value] of Object.entries(metadata)) console.log(`${key}=${value}`);
  applyAndroidVersion(metadata.versionName, metadata.versionCode);
}
