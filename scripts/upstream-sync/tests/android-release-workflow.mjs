import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../lib.mjs';
import { pollGiteeMirror } from '../poll-gitee-mirror.mjs';
import { assertReleaseTargetAncestry, assertReleaseTargetLock, determineComposeMode, determineSyncMode, resolveMode } from '../sync-decision.mjs';

const read = relativePath => readFile(path.join(projectRoot, relativePath), 'utf8');
const [workflow, gradle, updater] = await Promise.all([
  read('.github/workflows/sync-upstream.yml'),
  read('android/app/build.gradle'),
  read('android/app/src/main/java/io/github/pq125/rphub/AppUpdateManager.java')
]);

assert.match(gradle, /RPHUB_VERSION_NAME/);
assert.match(gradle, /RPHUB_VERSION_CODE/);
const configGitIdentityIndex = workflow.indexOf('name: Configure Git identity');
const resolveReleaseIndex = workflow.indexOf('name: Resolve stable upstream release and sync mode');
assert.ok(configGitIdentityIndex !== -1 && resolveReleaseIndex !== -1 && configGitIdentityIndex < resolveReleaseIndex);
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
const pinIndex = workflow.indexOf('node scripts/compose/pin-upstream.mjs');
assert.ok(pinIndex > workflow.indexOf('git fetch upstream "refs/tags/'));
assert.ok(pinIndex < workflow.indexOf('node scripts/upstream-sync/prepare-android-release.mjs'));
assert.match(workflow.slice(pinIndex, workflow.indexOf('\n', pinIndex)), /steps\.upstream_sync\.outputs\.upstream_sha/);
const verifyApkIndex = workflow.indexOf('name: Verify and package signed APK');
const finalizeMetadataIndex = workflow.indexOf('name: Finalize Android release metadata');
const finalDiffIndex = workflow.indexOf('name: Check final diff');
assert.ok(verifyApkIndex !== -1 && verifyApkIndex < finalizeMetadataIndex, 'README metadata is finalized after APK verification');
assert.ok(finalizeMetadataIndex < finalDiffIndex, 'README metadata is finalized before the final diff check');
const finalizeMetadataStep = workflow.slice(finalizeMetadataIndex, workflow.indexOf('\n      - name:', finalizeMetadataIndex + 1));
assert.match(finalizeMetadataStep, /if: steps\.upstream_sync\.outputs\.has_updates == 'true'/);
assert.match(finalizeMetadataStep, /prepare-android-release\.mjs .*steps\.upstream_sync\.outputs\.release_tag.*steps\.upstream_sync\.outputs\.revision.*--apk-sha256="\$\{\{ steps\.apk\.outputs\.sha256 \}\}"/);
assert.match(workflow, /SYNC_MODE: \$\{\{ steps\.upstream_sync\.outputs\.sync_mode \}\}/);
assert.match(workflow, /if \[ "\$SYNC_MODE" != "recover" \][\s\S]*refusing to reuse it[\s\S]*exit 1/);
assert.match(workflow, /if \[ "\$SYNC_MODE" = "recover" \][\s\S]*skipping duplicate recovery publication[\s\S]*exit 0/);
assert.match(workflow, /appeared during sync mode \$SYNC_MODE[\s\S]*refusing to skip publication[\s\S]*exit 1/);
assert.ok((workflow.match(/--json targetCommitish --jq '\.targetCommitish'/g) || []).length >= 2);
// Compose recovery proof: target-in-history plus a lock match, in both the APK
// packaging and publication recovery blocks.
assert.ok((workflow.match(/git merge-base --is-ancestor "\$release_target" "\$current_head"/g) || []).length >= 2);
assert.ok((workflow.match(/git show "\$release_target:upstream\.lock\.json"/g) || []).length >= 2);
assert.ok((workflow.match(/target_lock" != "\$UPSTREAM_SHA"/g) || []).length >= 2);
assert.doesNotMatch(workflow, /git merge-base --is-ancestor "\$UPSTREAM_SHA" "\$release_target"/);
assert.doesNotMatch(workflow, /if \[ "\$release_target" != "\$current_head" \]/);
const syncSource = await read('scripts/upstream-sync/sync-upstream.mjs');
assert.match(syncSource, /merge-base', '--is-ancestor/);
assert.match(syncSource, /has_updates=\$\{upstreamUpdated\}/);
assert.match(syncSource, /UPSTREAM_HAS_UPDATES=false \(release/);
// The default path composes from the lock; the explicit --legacy-merge path
// keeps the old merge ordering. Both are wired in one CLI.
assert.match(syncSource, /--legacy-merge/);
assert.match(syncSource, /runComposeSync\(\{/);
assert.match(syncSource, /resolveMode\(\{/);
const composeIndex = syncSource.indexOf('await runCompose(release, revision)');
const mergeIndex = syncSource.indexOf('await mergeWithAutoResolver');
assert.ok(composeIndex !== -1 && mergeIndex !== -1 && composeIndex < mergeIndex,
  'compose is the default branch and legacy merge follows it');
assert.match(syncSource, /if \(mode === 'noop'\) \{[\s\S]*UPSTREAM_HAS_UPDATES=false \(release[\s\S]*mode === 'recover'/);
assert.match(syncSource, /publicationCompleteCompose/);
assert.match(syncSource, /sync_mode=\$\{mode\}/);
assert.match(syncSource, /revision=\$\{revision\}/);
const publicationCheck = syncSource.slice(syncSource.indexOf('async function publicationComplete('), syncSource.indexOf('async function mergeInProgress'));
assert.match(publicationCheck, /rawRevision === '' \? deriveRevision\(release\.tagName, packageJson\.version\)/);
assert.doesNotMatch(publicationCheck, /selectRevision/);
// Compose-model mode decision: locked release -> noop/recover; anything else ->
// compose. There is no Git-ancestry input.
assert.equal(determineComposeMode({ lockedTag: '1.9.4', lockedCommit: 'a'.repeat(40), release: { tagName: '1.9.4', commitSha: 'a'.repeat(40) }, publicationComplete: true }), 'noop');
assert.equal(determineComposeMode({ lockedTag: '1.9.4', lockedCommit: 'a'.repeat(40), release: { tagName: '1.9.4', commitSha: 'a'.repeat(40) }, publicationComplete: false }), 'recover');
assert.equal(determineComposeMode({ lockedTag: '1.9.3', lockedCommit: 'b'.repeat(40), release: { tagName: '1.9.4', commitSha: 'a'.repeat(40) }, publicationComplete: false }), 'compose');
// Legacy merge mode decision is retained for the explicit escape hatch.
assert.equal(determineSyncMode({ alreadyIntegrated: false, publicationComplete: false }), 'merge');
assert.equal(determineSyncMode({ alreadyIntegrated: false, publicationComplete: true }), 'merge');
assert.equal(determineSyncMode({ alreadyIntegrated: true, publicationComplete: true }), 'noop');
assert.equal(determineSyncMode({ alreadyIntegrated: true, publicationComplete: false }), 'recover');

// resolveMode is the exact branch the CLI runs. Exercise it offline so a
// ReferenceError or a wrong branch is caught without a network remote.
const rel = { tagName: '1.9.4', commitSha: 'a'.repeat(40) };
assert.equal(await resolveMode({ legacyMerge: false, release: rel, lock: { tag: '1.9.3', commit: 'b'.repeat(40) } }), 'compose');
assert.equal(await resolveMode({ legacyMerge: false, release: rel, lock: { tag: '1.9.4', commit: 'a'.repeat(40) }, publicationCheck: async () => true }), 'noop');
assert.equal(await resolveMode({ legacyMerge: false, release: rel, lock: { tag: '1.9.4', commit: 'a'.repeat(40) }, publicationCheck: async () => false }), 'recover');
assert.equal(await resolveMode({ legacyMerge: false, release: rel, lock: null }), 'compose');
assert.equal(await resolveMode({ legacyMerge: true, release: rel, lock: null, integrationCheck: async () => false }), 'merge');
assert.equal(await resolveMode({ legacyMerge: true, release: rel, lock: null, integrationCheck: async () => true, publicationCheck: async () => false }), 'recover');
const upstreamSha = '0562644622384ae645b2be959aeec0968a11d436';
const intermediateTarget = '93c950a';
const currentHead = '9482f302217f4dd5d69753741f26f5c9611ce4c7';
const ancestryCalls = [];
assert.equal(await assertReleaseTargetAncestry({
  androidTag: 'v1.8.8.1-android',
  upstreamSha,
  targetCommitish: intermediateTarget,
  headSha: currentHead,
  isAncestor: async (ancestor, descendant) => {
    ancestryCalls.push([ancestor, descendant]);
    return true;
  }
}), true);
assert.deepEqual(ancestryCalls, [[upstreamSha, intermediateTarget], [intermediateTarget, currentHead]]);
await assert.rejects(
  () => assertReleaseTargetAncestry({
    androidTag: 'v1.8.8.1-android',
    upstreamSha,
    targetCommitish: intermediateTarget,
    headSha: currentHead,
    isAncestor: async () => false
  }),
  /Upstream release .* not an ancestor.*refusing to reuse its APK/
);
await assert.rejects(
  () => assertReleaseTargetAncestry({
    androidTag: 'v1.8.8.1-android',
    upstreamSha,
    targetCommitish: intermediateTarget,
    headSha: currentHead,
    isAncestor: async (ancestor) => ancestor === upstreamSha
  }),
  /targets .* not an ancestor of current HEAD.*refusing to reuse its APK/
);
assert.match(publicationCheck, /assertReleaseTargetAncestry/);
assert.match(publicationCheck, /merge-base', '--is-ancestor/);
const composePublicationCheck = syncSource.slice(syncSource.indexOf('async function publicationCompleteCompose'), syncSource.indexOf('async function mergeInProgress'));
assert.match(composePublicationCheck, /assertReleaseTargetLock/);
assert.match(composePublicationCheck, /lockAt/);
// Compose-model release-target proof: target must be in our history and its
// lock must pin exactly the selected release.
const lockCommit = 'c'.repeat(40);
const composedHead = 'd'.repeat(40);
const lockCalls = [];
assert.equal(await assertReleaseTargetLock({
  androidTag: 'v1.9.4-android',
  upstreamSha: lockCommit,
  targetCommitish: 'abc1234',
  headSha: composedHead,
  lockAt: async target => { lockCalls.push(target); return lockCommit; },
  isAncestor: async () => true,
}), true);
assert.deepEqual(lockCalls, ['abc1234']);
await assert.rejects(
  () => assertReleaseTargetLock({
    androidTag: 'v1.9.4-android', upstreamSha: lockCommit, targetCommitish: 'abc1234', headSha: composedHead,
    lockAt: async () => 'e'.repeat(40), isAncestor: async () => true,
  }),
  /pinned upstream .* not the selected release .*refusing to reuse its APK/s
);
await assert.rejects(
  () => assertReleaseTargetLock({
    androidTag: 'v1.9.4-android', upstreamSha: lockCommit, targetCommitish: 'abc1234', headSha: composedHead,
    lockAt: async () => '', isAncestor: async () => true,
  }),
  /has no readable upstream lock.*refusing to reuse its APK/
);
await assert.rejects(
  () => assertReleaseTargetLock({
    androidTag: 'v1.9.4-android', upstreamSha: lockCommit, targetCommitish: 'abc1234', headSha: composedHead,
    lockAt: async () => lockCommit, isAncestor: async () => false,
  }),
  /not an ancestor of current HEAD.*refusing to reuse its APK/
);
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
assert.match(workflow, /id: mirror_publish/);
assert.match(workflow, /node scripts\/upstream-sync\/poll-gitee-mirror\.mjs "\$mirror_sha"/);
assert.match(workflow, /Open GitHub issue on sync failure[\s\S]*continue-on-error: true/);
assert.match(workflow, /\.has_issues[\s\S]*Issues are disabled or unavailable[\s\S]*exit 0/);
assert.match(workflow, /mirror_publish:\$\{\{ steps\.mirror_publish\.outcome \}\}/);
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

const expectedMirrorSha = '572b93a96b15f56dae930414a5eaf6489b89bf03';
const transientWarnings = [];
const transientWaits = [];
let transientLookups = 0;
await pollGiteeMirror({
  expectedSha: expectedMirrorSha,
  attempts: 3,
  delayMs: 0,
  lookup: async () => {
    transientLookups += 1;
    if (transientLookups === 1) {
      const error = new Error('git ls-remote failed');
      error.code = 128;
      error.stderr = 'error: RPC failed; HTTP 429\nfatal: expected flush after ref listing';
      throw error;
    }
    return expectedMirrorSha;
  },
  verify: async () => {},
  wait: async delay => transientWaits.push(delay),
  logger: { log() {}, warn: message => transientWarnings.push(message) }
});
assert.equal(transientLookups, 2, 'a transient Gitee ls-remote failure must be retried');
assert.deepEqual(transientWaits, [0]);
assert.match(transientWarnings.join('\n'), /1\/3 failed; retrying:.*HTTP 429/);

let mismatchLookups = 0;
let mismatchManifestChecks = 0;
const mismatchWaits = [];
await assert.rejects(
  () => pollGiteeMirror({
    expectedSha: expectedMirrorSha,
    attempts: 2,
    delayMs: 0,
    lookup: async () => {
      mismatchLookups += 1;
      return 'd8a6ff450300a0d197632867a203a3ee88f371d1';
    },
    verify: async () => { mismatchManifestChecks += 1; },
    wait: async delay => mismatchWaits.push(delay),
    logger: { log() {}, warn() {} }
  }),
  /did not reach android-latest commit .* after 2 attempts/
);
assert.equal(mismatchLookups, 2, 'a stale mirror ref must be checked through the final attempt');
assert.equal(mismatchManifestChecks, 0, 'a stale ref must never be accepted by a healthy manifest alone');
assert.deepEqual(mismatchWaits, [0], 'polling must not sleep after the final failed attempt');

let manifestChecks = 0;
await pollGiteeMirror({
  expectedSha: expectedMirrorSha,
  attempts: 2,
  delayMs: 0,
  lookup: async () => expectedMirrorSha,
  verify: async () => {
    manifestChecks += 1;
    if (manifestChecks === 1) throw new Error('HTTP 429');
  },
  wait: async () => {},
  logger: { log() {}, warn() {} }
});
assert.equal(manifestChecks, 2, 'a transient manifest failure must not accept the matching ref prematurely');

console.log('Automated signed Android Release and Gitee mirror workflow contract: PASS');
