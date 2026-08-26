import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../lib.mjs';
import { assertReleaseTargetsHead, determineSyncMode } from '../sync-decision.mjs';

const read = relativePath => readFile(path.join(projectRoot, relativePath), 'utf8');
const [workflow, gradle, updater] = await Promise.all([
  read('.github/workflows/sync-upstream.yml'),
  read('android/app/build.gradle'),
  read('android/app/src/main/java/io/github/pq125/rphub/AppUpdateManager.java')
]);

assert.match(gradle, /RPHUB_VERSION_NAME/);
assert.match(gradle, /RPHUB_VERSION_CODE/);
const configGitIdentityIndex = workflow.indexOf('name: Configure Git identity');
const fetchMergeIndex = workflow.indexOf('name: Fetch, merge, and reapply categorized hooks');
assert.ok(configGitIdentityIndex !== -1 && configGitIdentityIndex < fetchMergeIndex);
assert.match(workflow, /git config user\.name "github-actions\[bot\]"/);
assert.match(workflow, /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/);
assert.match(workflow, /repository_dispatch:[\s\S]*types:[\s\S]*- upstream-release/);
assert.match(workflow, /Report no new upstream release/);
assert.match(workflow, /has_updates != 'true'/);
assert.match(workflow, /has_updates == 'true'/);
assert.match(workflow, /actions\/setup-java@v4[\s\S]*if: steps\.upstream_sync\.outputs\.has_updates == 'true'/);
assert.match(workflow, /Install dependencies[\s\S]*if: steps\.upstream_sync\.outputs\.has_updates == 'true'/);
assert.match(workflow, /Sync Capacitor and build Android release[\s\S]*if: steps\.upstream_sync\.outputs\.has_updates == 'true'/);
assert.match(workflow, /prepare-android-release\.mjs .*steps\.upstream_sync\.outputs\.release_tag.*steps\.upstream_sync\.outputs\.revision/);
assert.match(workflow, /SYNC_MODE: \$\{\{ steps\.upstream_sync\.outputs\.sync_mode \}\}/);
assert.match(workflow, /if \[ "\$SYNC_MODE" != "recover" \][\s\S]*refusing to reuse it[\s\S]*exit 1/);
assert.match(workflow, /if \[ "\$SYNC_MODE" = "recover" \][\s\S]*skipping duplicate recovery publication[\s\S]*exit 0/);
assert.match(workflow, /appeared during sync mode \$SYNC_MODE[\s\S]*refusing to skip publication[\s\S]*exit 1/);
assert.ok((workflow.match(/--json targetCommitish --jq '\.targetCommitish'/g) || []).length >= 2);
assert.ok((workflow.match(/if \[ "\$release_target" != "\$current_head" \]/g) || []).length >= 2);
const syncSource = await read('scripts/upstream-sync/sync-upstream.mjs');
assert.match(syncSource, /merge-base', '--is-ancestor/);
assert.match(syncSource, /has_updates=\$\{upstreamUpdated\}/);
assert.match(syncSource, /UPSTREAM_HAS_UPDATES=false \(release/);
const integrationCheckIndex = syncSource.indexOf('const alreadyIntegrated = await upstreamReleaseAlreadyIntegrated');
const mergeIndex = syncSource.indexOf('await mergeWithAutoResolver');
assert.ok(integrationCheckIndex !== -1 && integrationCheckIndex < mergeIndex);
assert.match(syncSource, /if \(mode === 'noop'\) \{[\s\S]*UPSTREAM_HAS_UPDATES=false \(release[\s\S]*\} else if \(mode === 'merge'\)/);
assert.match(syncSource, /publicationComplete/);
assert.match(syncSource, /sync_mode=\$\{mode\}/);
assert.match(syncSource, /revision=\$\{revision\}/);
const publicationCheck = syncSource.slice(syncSource.indexOf('async function publicationComplete'), syncSource.indexOf('async function mergeInProgress'));
assert.match(publicationCheck, /rawRevision === '' \? deriveRevision\(release\.tagName, packageJson\.version\)/);
assert.doesNotMatch(publicationCheck, /selectRevision/);
assert.equal(determineSyncMode({ alreadyIntegrated: false, publicationComplete: false }), 'merge');
assert.equal(determineSyncMode({ alreadyIntegrated: false, publicationComplete: true }), 'merge');
assert.equal(determineSyncMode({ alreadyIntegrated: true, publicationComplete: true }), 'noop');
assert.equal(determineSyncMode({ alreadyIntegrated: true, publicationComplete: false }), 'recover');
const matchingHead = '0123456789abcdef0123456789abcdef01234567';
assert.equal(assertReleaseTargetsHead({ androidTag: 'v1.8.8.1-android', targetCommitish: matchingHead, headSha: matchingHead }), true);
assert.throws(
  () => assertReleaseTargetsHead({
    androidTag: 'v1.8.8.1-android',
    targetCommitish: 'fedcba9876543210fedcba9876543210fedcba98',
    headSha: matchingHead
  }),
  /refusing to reuse its APK/
);
assert.match(publicationCheck, /assertReleaseTargetsHead/);
assert.match(workflow, /npm audit --omit=dev/);
assert.match(workflow, /apksigner[\s\S]*verify --verbose --print-certs/);
assert.match(workflow, /manifest application-id[\s\S]*io\.github\.pq125\.rphub/);
assert.match(workflow, /manifest debuggable[\s\S]*= "false"/);
assert.match(workflow, /sha256sum/);
assert.match(workflow, /gh release download "\$ANDROID_TAG"[\s\S]*Using canonical APK from existing GitHub Release/);
assert.match(workflow, /gh release view[\s\S]*skipping duplicate recovery publication/);
assert.match(workflow, /gh release create[\s\S]*--latest/);
assert.match(workflow, /APK SHA-256/);
assert.match(workflow, /repos\/STA1N156\/RP-Hub\/releases\/tags\/\$\{UPSTREAM_RELEASE_TAG\}/);
assert.match(workflow, /upstream_notes[\s\S]*printf '%s\\n'/);
assert.match(workflow, /Prepare mirrored release notes/);
assert.match(workflow, /CHANGELOG\.md/);
assert.match(workflow, /hotfix_section/);
assert.match(workflow, /Android 本次更新/);
assert.match(workflow, /secrets\.GITEE_TOKEN/);
assert.match(workflow, /refs\/heads\/android-latest/);
assert.match(workflow, /split -b 4m/);
assert.match(workflow, /sources: \[\[\$githubApkUrl\], \$giteeParts\]/);
assert.match(workflow, /remote_mirror\/pull/);
assert.match(workflow, /access_token=\$GITEE_TOKEN/);
assert.match(workflow, /push --force origin HEAD:refs\/heads\/android-latest/);
assert.doesNotMatch(workflow, /push --force origin HEAD:refs\/heads\/main/);
assert.match(workflow, /timeout-minutes: 10/);
assert.match(updater, /GITEE_UPDATE_MANIFEST/);
assert.match(updater, /Update metadata source: GitHub API/);
assert.match(updater, /Update metadata source: Gitee mirror fallback/);
assert.ok(updater.indexOf('readUtf8(LATEST_RELEASE_API') < updater.indexOf('readUtf8(GITEE_UPDATE_MANIFEST'));
assert.match(updater, /parseUpdateManifest/);
assert.match(updater, /optJSONArray\("sources"\)/);
assert.match(updater, /downloadAndVerifyFromParts/);
for (const publicProxy of ['ghfast.top', 'gh-proxy.com', 'ghproxy.net', 'cdn.jsdelivr.net', 'cdn.staticdelivr.com']) {
  assert.doesNotMatch(updater, new RegExp(publicProxy.replace('.', '\\.')));
}

console.log('Automated signed Android Release and Gitee mirror workflow contract: PASS');
