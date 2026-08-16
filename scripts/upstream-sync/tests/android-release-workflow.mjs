import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../lib.mjs';

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
assert.match(workflow, /npm audit --omit=dev/);
assert.match(workflow, /apksigner[\s\S]*verify --verbose --print-certs/);
assert.match(workflow, /manifest application-id[\s\S]*io\.github\.pq125\.rphub/);
assert.match(workflow, /manifest debuggable[\s\S]*= "false"/);
assert.match(workflow, /sha256sum/);
assert.match(workflow, /gh release download "\$ANDROID_TAG"[\s\S]*Using canonical APK from existing GitHub Release/);
assert.match(workflow, /gh release view[\s\S]*skipping duplicate publication/);
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
