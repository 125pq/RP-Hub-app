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
assert.match(workflow, /npm audit --omit=dev/);
assert.match(workflow, /apksigner[\s\S]*verify --verbose --print-certs/);
assert.match(workflow, /manifest application-id[\s\S]*io\.github\.pq125\.rphub/);
assert.match(workflow, /manifest debuggable[\s\S]*= "false"/);
assert.match(workflow, /sha256sum/);
assert.match(workflow, /gh release view[\s\S]*skipping duplicate publication/);
assert.match(workflow, /gh release create[\s\S]*--latest/);
assert.match(workflow, /APK SHA-256/);
assert.match(workflow, /repos\/STA1N156\/RP-Hub\/releases\/tags\/\$\{UPSTREAM_RELEASE_TAG\}/);
assert.match(workflow, /upstream_notes[\s\S]*printf '%s\\n'/);
assert.match(workflow, /Prepare mirrored release notes/);
assert.match(workflow, /secrets\.GITEE_TOKEN/);
assert.match(workflow, /api\/v5\/repos\/pq125pq\/rp-hub-app/);
assert.match(workflow, /releases\/\$release_id\/attach_files/);
assert.match(workflow, /type == "object" and \.id != null/);
assert.match(workflow, /timeout-minutes: 15/);
assert.match(workflow, /--max-time 600/);
assert.doesNotMatch(workflow, /push --force/);
assert.match(updater, /GITEE_RELEASE_API/);
assert.match(updater, /Update metadata source: Gitee Release/);
assert.match(updater, /Update metadata source: GitHub API fallback/);
assert.match(updater, /parseGiteeRelease/);
assert.match(updater, /githubFallback/);
for (const publicProxy of ['ghfast.top', 'gh-proxy.com', 'ghproxy.net', 'cdn.jsdelivr.net', 'cdn.staticdelivr.com']) {
  assert.doesNotMatch(updater, new RegExp(publicProxy.replace('.', '\\.')));
}

console.log('Automated signed Android Release and Gitee mirror workflow contract: PASS');
