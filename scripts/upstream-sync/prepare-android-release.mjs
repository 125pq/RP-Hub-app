import { appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function androidReleaseMetadata(upstreamTag) {
  const match = String(upstreamTag || '').match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Upstream release tag is not a supported semantic version: ${upstreamTag || '(empty)'}`);
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (minor > 99 || patch > 99) throw new Error(`Android versionCode requires minor and patch below 100: ${upstreamTag}`);
  const versionCode = major * 10000 + minor * 100 + patch;
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
    throw new Error(`Android versionCode is outside the supported range: ${versionCode}`);
  }
  const versionName = `${major}.${minor}.${patch}`;
  return {
    versionName,
    versionCode: String(versionCode),
    androidTag: `v${versionName}-android`,
    apkName: `RP-Hub-${versionName}-release.apk`,
    title: `RP-Hub Android ${versionName}`
  };
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
  const metadata = androidReleaseMetadata(process.argv[2]);
  publishOutputs(metadata);
  for (const [key, value] of Object.entries(metadata)) console.log(`${key}=${value}`);
}
