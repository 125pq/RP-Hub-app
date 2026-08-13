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
assert.match(workflow, /Generate mirrored update manifest/);
assert.match(workflow, /gitee\.com\/pq125pq\/rp-hub-app\/raw\/latest/);
assert.match(workflow, /secrets\.GITEE_TOKEN/);
assert.match(workflow, /HEAD:refs\/heads\/latest/);
assert.match(workflow, /git -C "\$mirror_dir" push --force gitee/);
assert.doesNotMatch(workflow, /git push --force (?:origin|gitee) HEAD:main/);
assert.match(updater, /GITEE_UPDATE_MANIFEST/);
assert.match(updater, /Update metadata source: Gitee latest branch/);
assert.match(updater, /Update metadata source: GitHub API fallback/);
assert.match(updater, /optJSONArray\("urls"\)/);
for (const publicProxy of ['ghfast.top', 'gh-proxy.com', 'ghproxy.net', 'cdn.jsdelivr.net', 'cdn.staticdelivr.com']) {
  assert.doesNotMatch(updater, new RegExp(publicProxy.replace('.', '\\.')));
}

console.log('Automated signed Android Release and Gitee mirror workflow contract: PASS');
