import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  const numericRevision = validateRevision(revision);
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

function normalizeBaseVersion(value) {
  const normalized = String(value || '').replace(/^v/, '');
  const match = normalized.match(/^(\d+\.\d+\.\d+)(?:\.(\d+))?$/);
  return match ? { base: match[1], revision: Number(match[2] || 0) } : null;
}

function validateRevision(revision) {
  const numericRevision = Number(revision);
  if (!Number.isInteger(numericRevision) || numericRevision < 0 || numericRevision > 99) {
    throw new Error(`Android release revision must be an integer from 0 through 99: ${revision}`);
  }
  return numericRevision;
}

export function selectRevision({ upstreamTag, currentVersion, mode = 'merge', explicitRevision = null }) {
  if (!['merge', 'recover', 'noop'].includes(mode)) {
    throw new Error(`Unsupported sync mode for revision selection: ${mode}`);
  }
  const upstream = normalizeBaseVersion(upstreamTag);
  const current = normalizeBaseVersion(currentVersion);
  if (!upstream) throw new Error(`Upstream release tag is not a supported semantic version: ${upstreamTag || '(empty)'}`);
  if (!current) throw new Error(`Current package version is not a supported semantic version: ${currentVersion || '(empty)'}`);
  validateRevision(current.revision);
  const hasExplicitRevision = explicitRevision !== null
    && explicitRevision !== undefined
    && String(explicitRevision).trim() !== '';
  if (hasExplicitRevision) return validateRevision(explicitRevision);

  if (mode !== 'merge') {
    const revision = upstream && current && upstream.base === current.base
      ? current.revision
      : deriveRevision(upstreamTag, currentVersion);
    return validateRevision(revision);
  }

  const revision = upstream && current && upstream.base === current.base
    ? validateRevision(current.revision) + 1
    : 0;
  return validateRevision(revision);
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

// Split the source into (content, lineEnding) pairs so the rewrite preserves
// each line's original EOL instead of normalizing to a single style. This
// keeps a mixed-EOL README byte-stable outside the anchor lines.
function splitLinesKeepEol(source) {
  const parts = String(source).split(/(\r?\n)/);
  const entries = [];
  for (let index = 0; index < parts.length; index += 2) {
    entries.push({ content: parts[index] ?? '', eol: parts[index + 1] ?? '' });
  }
  return entries;
}

export function transformReadmeAnchors(source, { versionName, versionCode, sha256 = null, downloadUrl = null } = {}) {
  const entries = splitLinesKeepEol(source);
  const missing = [];
  const drift = [];
  const enabledAnchors = [
    ['badge', true],
    ['version line', true],
    ['versionCode', true],
    ['download URL', downloadUrl !== null],
    ['SHA-256', sha256 !== null]
  ];
  const anchorIndexes = new Map();
  for (const [key, enabled] of enabledAnchors) {
    if (!enabled) continue;
    const indexes = entries
      .map((entry, index) => anchorLinePredicates[key](entry.content) ? index : -1)
      .filter((index) => index !== -1);
    if (indexes.length === 0) {
      missing.push(key);
    } else if (indexes.length !== 1) {
      drift.push(`${anchorLineLabels[key]} (expected 1, found ${indexes.length})`);
    } else {
      anchorIndexes.set(key, indexes[0]);
    }
  }

  let badgeIndex = anchorIndexes.get('badge') ?? -1;
  if (badgeIndex !== -1) {
    const badgeLine = entries[badgeIndex].content;
    const imageAnchorCount = badgeLine.match(/img\.shields\.io\/badge\/Android-[\d.]+-/g)?.length ?? 0;
    const hrefAnchorCount = badgeLine.match(/releases\/tag\/v[\d.]+-android\)/g)?.length ?? 0;
    if (imageAnchorCount !== 1) {
      drift.push(`badge image version anchor (expected 1, found ${imageAnchorCount})`);
    }
    if (hrefAnchorCount !== 1) {
      drift.push(`badge release href anchor (expected 1, found ${hrefAnchorCount})`);
    }
    if (imageAnchorCount !== 1 || hrefAnchorCount !== 1) badgeIndex = -1;
  }
  const updates = [
    {
      key: 'badge',
      index: badgeIndex,
      rewrite: (line) => line
        .replace(/(img\.shields\.io\/badge\/Android-)[\d.]+(-)/, `$1${versionName}$2`)
        .replace(/(releases\/tag\/v)[\d.]+(-android\))/, `$1${versionName}$2`)
    },
    { key: 'version line', rewrite: () => `当前正式版本：**RP-Hub Android ${versionName}**` },
    { key: 'versionCode', rewrite: () => `- Version code：\`${versionCode}\`` },
    { key: 'download URL', rewrite: downloadUrl === null ? null : () => `- 下载：[${downloadUrl.split('/').pop()}](${downloadUrl})` },
    { key: 'SHA-256', rewrite: sha256 === null ? null : () => `- SHA-256：\`${sha256.toLowerCase()}\`` }
  ];
  for (const update of updates) {
    if (update.rewrite === null) continue;
    const index = update.index ?? anchorIndexes.get(update.key);
    if (index === undefined || index === -1) continue;
    entries[index].content = update.rewrite(entries[index].content);
  }
  return { text: entries.map((entry) => entry.content + entry.eol).join(''), missing, drift };
}

const anchorLinePredicates = {
  badge: (line) => line.includes('[![Android Release]('),
  'version line': (line) => line.startsWith('当前正式版本：**RP-Hub Android '),
  versionCode: (line) => line.startsWith('- Version code：`'),
  'download URL': (line) => line.startsWith('- 下载：['),
  'SHA-256': (line) => line.startsWith('- SHA-256：`')
};

const anchorLineLabels = {
  badge: 'badge line',
  'version line': 'version line',
  versionCode: 'versionCode line',
  'download URL': 'download URL line',
  'SHA-256': 'SHA-256 line'
};

export function readmeAnchorDiff(before, after) {
  const beforeLines = String(before).split(/\r?\n/);
  const afterLines = String(after).split(/\r?\n/);
  const entries = [];
  const length = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < length; index += 1) {
    if (beforeLines[index] !== afterLines[index]) {
      entries.push({ line: index + 1, before: beforeLines[index], after: afterLines[index] });
    }
  }
  return entries;
}

export function updateReadmeAnchors({ versionName, versionCode, sha256 = null, downloadUrl = null, dryRun = false, readmePath = path.join(projectRoot, 'README.md') } = {}) {
  const source = readFileSync(readmePath, 'utf8');
  const result = transformReadmeAnchors(source, { versionName, versionCode, sha256, downloadUrl });
  const diff = readmeAnchorDiff(source, result.text);
  if (dryRun) {
    if (diff.length === 0) {
      console.log('README anchors: no changes');
    } else {
      console.log(`README anchors: ${diff.length} line(s) would change`);
      for (const entry of diff) {
        console.log(`README.md:${entry.line} - ${entry.before ?? '(missing)'}`);
        console.log(`README.md:${entry.line} + ${entry.after ?? '(removed)'}`);
      }
    }
    if (result.missing.length > 0) {
      console.log(`README anchors not found (skipped): ${result.missing.join(', ')}`);
    }
    if (result.drift.length > 0) {
      console.log(`README anchors drifted (skipped): ${result.drift.join(', ')}`);
    }
    return { changed: diff.length > 0, missing: result.missing, drift: result.drift };
  }
  if (result.missing.length > 0 || result.drift.length > 0) {
    const problems = [];
    if (result.missing.length > 0) problems.push(`missing: ${result.missing.join(', ')}`);
    if (result.drift.length > 0) problems.push(`drift: ${result.drift.join(', ')}`);
    throw new Error(`README anchor validation failed (${problems.join('; ')})`);
  }
  if (diff.length > 0) writeFileSync(readmePath, result.text, 'utf8');
  return { changed: diff.length > 0, missing: [], drift: [] };
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
  const positional = [];
  const flags = { dryRun: false, sha256: null, downloadUrl: null, apkFile: null };
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg.startsWith('--apk-sha256=')) flags.sha256 = arg.slice('--apk-sha256='.length).trim() || null;
    else if (arg.startsWith('--download-url=')) flags.downloadUrl = arg.slice('--download-url='.length).trim() || null;
    else if (arg.startsWith('--apk-file=')) flags.apkFile = arg.slice('--apk-file='.length).trim() || null;
    else positional.push(arg);
  }
  const upstreamTag = positional[0];
  const rawRevision = positional.length > 1 ? String(positional[1]).trim() : '';
  const explicitRevision = rawRevision === '' ? null : Number(rawRevision);
  const revision = explicitRevision === null
    ? deriveRevision(upstreamTag, currentPackageVersion())
    : validateRevision(explicitRevision);
  const metadata = androidReleaseMetadata(upstreamTag, revision);
  let sha256 = flags.sha256 ? flags.sha256.toLowerCase() : null;
  if (!sha256 && flags.apkFile) {
    if (existsSync(flags.apkFile)) {
      sha256 = createHash('sha256').update(readFileSync(flags.apkFile)).digest('hex');
    } else {
      console.error(`warning: --apk-file not found at ${flags.apkFile}; SHA-256 anchor will not be updated`);
    }
  }
  const downloadUrl = flags.downloadUrl
    ?? `https://github.com/125pq/RP-Hub-app/releases/download/${metadata.androidTag}/${metadata.apkName}`;
  publishOutputs(metadata);
  for (const [key, value] of Object.entries(metadata)) console.log(`${key}=${value}`);
  updateReadmeAnchors({
    versionName: metadata.versionName,
    versionCode: metadata.versionCode,
    sha256,
    downloadUrl,
    dryRun: flags.dryRun
  });
  if (!flags.dryRun) applyAndroidVersion(metadata.versionName, metadata.versionCode);
}
