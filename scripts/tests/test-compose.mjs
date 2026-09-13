import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, cp, mkdtemp, appendFile, mkdir, writeFile, symlink, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { patchAndroidUpdateCheck } from '../upstream-sync/patches/patch-android-hooks.mjs';
import { repositoryRoot } from '../web/paths.mjs';
import { hash, git, filesIn, transform, classifyUpstream, assertLegacy, compareBytes, safeRelative } from '../compose/compose-lib.mjs';

const recipe = JSON.parse(await readFile(path.join(repositoryRoot, 'scripts/compose/recipe.json')));
const lock = JSON.parse(await readFile(path.join(repositoryRoot, 'upstream.lock.json')));
const work = path.join(repositoryRoot, '.work/compose');
await mkdir(work, { recursive: true });
function cli(script, args = [], success = true) {
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, script), ...args], {
    cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status === 0, success, result.stdout + result.stderr);
  return result;
}
async function digest(directory) {
  const entries = [];
  for (const file of await filesIn(directory)) entries.push([file, hash(await readFile(path.join(directory, file)))]);
  return hash(JSON.stringify(entries));
}
async function candidate() {
  const before = new Set(await readdir(work));
  cli('scripts/compose/build-candidate.mjs');
  const added = (await readdir(work)).filter(name => !before.has(name));
  assert.equal(added.length, 1);
  const run = path.join(work, added[0]);
  return { run, report: JSON.parse(await readFile(path.join(run, 'report.json'))) };
}

assert.deepEqual(recipe.legacyOverrides, [], 'No full-file app override may return');
const appOriginal = git(repositoryRoot, ['show', `${lock.commit}:assets/js/app.js`]);
const appRebuilt = transform('assets/js/app.js', appOriginal);
assert.equal(compareBytes('assets/js/app.js', appRebuilt, await readFile(path.join(repositoryRoot, 'assets/js/app.js')), recipe.allowedBaselineEolDifferences), 'eol-only');
assert.ok(transform('assets/js/app.js', appRebuilt).equals(appRebuilt));
assert.throws(() => transform('assets/js/app.js', Buffer.from(appOriginal.toString().replace('const getPostprocessedChatMessages =', 'const changedProcessor ='))), /drifted|anchor/);

// Drift must be rejected, even where a whole-file legacy fallback is still needed.
for (const entry of recipe.legacyOverrides) {
  const upstream = git(repositoryRoot, ['show', `${lock.commit}:${entry.file}`]);
  const local = await readFile(path.join(repositoryRoot, entry.file));
  assertLegacy(entry, upstream, local);
  assert.throws(() => assertLegacy(entry, Buffer.concat([upstream, Buffer.from('\n// new upstream feature')]), local), /Legacy override drift/);
  assert.throws(() => assertLegacy(entry, upstream, Buffer.concat([local, Buffer.from('\n// new local feature')])), /Legacy override drift/);
}
assert.equal(classifyUpstream('assets/new-upstream-resource.js', recipe), 'publish');
assert.throws(() => classifyUpstream('new-page/index.html', recipe), /Unclassified upstream/);
assert.throws(() => safeRelative('../dist'), /Unsafe/);
assert.throws(() => transform('assets/css/styles.css', Buffer.from('.unknown {}')), /anchor|rule/);
assert.throws(() => compareBytes('index.html', Buffer.from('new feature\r\n'), Buffer.from('old feature\n'), ['index.html']), /Unexplained/);
assert.throws(() => compareBytes('assets/js/app.js', Buffer.from('x\r\n'), Buffer.from('x\n'), ['index.html']), /Unexplained/);

// Reconstruct the update guard without copying the local file. Unrelated new
// upstream content survives; ambiguous/partial notification hooks stop the build.
const updateFile = 'assets/js/update-check.js';
const updateUpstream = git(repositoryRoot, ['show', `${lock.commit}:${updateFile}`]);
const updateOutput = transform(updateFile, updateUpstream);
assert.ok(updateOutput.equals(await readFile(path.join(repositoryRoot, updateFile))));
assert.ok(transform(updateFile, updateOutput).equals(updateOutput));
const upstreamLf = updateUpstream.toString().replace(/\r\n/g, '\n');
const guardedLf = patchAndroidUpdateCheck(upstreamLf);
assert.equal(patchAndroidUpdateCheck(upstreamLf + '\n// unrelated upstream addition\n'), guardedLf + '\n// unrelated upstream addition\n');
assert.throws(() => patchAndroidUpdateCheck(upstreamLf + upstreamLf), /Ambiguous or drifted/);
assert.throws(() => patchAndroidUpdateCheck(guardedLf + upstreamLf), /Ambiguous or drifted/);
assert.throws(() => patchAndroidUpdateCheck(guardedLf.replace('if (!isNativeApp)', 'if (isNativeApp)')), /Ambiguous or drifted/);
assert.throws(() => patchAndroidUpdateCheck(upstreamLf.replace('rphub:update-available', 'rphub:changed')), /Ambiguous or drifted/);

// Execute the generated script: browsers notify once; Android delegates to its
// native updater. Timer and visibility cleanup stay in upstream's implementation.
for (const native of [true, false, undefined]) {
  let mounted, unmounted, tick;
  let removed = 0, cleared = 0;
  const events = [];
  const window = {
    RPHubLatestUpdate: { id: 10903 },
    ...(native === undefined ? {} : { platformAdapter: { isNative: () => native } }),
    dispatchEvent: event => events.push(event),
  };
  vm.runInNewContext(updateOutput.toString(), {
    window,
    Vue: { onMounted: fn => { mounted = fn; }, onBeforeUnmount: fn => { unmounted = fn; } },
    document: { querySelector: () => ({ content: 'https://example.invalid' }), hidden: false,
      addEventListener() {}, removeEventListener() { removed++; } },
    fetch: async () => ({ ok: true, json: async () => ({ updateAvailable: true, latestVersionId: 10904 }) }),
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setInterval: fn => { tick = fn; return 123; },
    clearInterval: id => { assert.equal(id, 123); cleared++; },
  });
  window.RPHubUpdateCheck.useUpdateCheck();
  mounted();
  await new Promise(resolve => setImmediate(resolve));
  await tick();
  assert.equal(events.length, native === true ? 0 : 1);
  if (events.length) {
    assert.equal(events[0].type, 'rphub:update-available');
    assert.equal(events[0].detail.versionId, 10904);
  }
  unmounted();
  assert.equal(removed, 1);
  assert.equal(cleared, 1);
}

// Reject output deletion outside the disposable workspace, before touching a file.
assert.match(cli('scripts/web/build-web.mjs', ['--output-dir', path.dirname(repositoryRoot)], false).stderr, /Custom output/);
assert.match(cli('scripts/web/build-web.mjs', ['--output-dir', repositoryRoot], false).stderr, /Custom output/);
assert.match(cli('scripts/web/build-web.mjs', ['--source-root', path.join(work, 'same'), '--output-dir', path.join(work, 'same')], false).stderr, /must not equal/);

const officialBefore = await digest(path.join(repositoryRoot, 'dist'));
const assetsBefore = await digest(path.join(repositoryRoot, 'assets'));
const first = await candidate();
const firstBefore = await digest(first.run);
const second = await candidate();
assert.equal(first.report.status, 'verified-candidate');
assert.equal(second.report.outputSha256, first.report.outputSha256);
assert.equal(await digest(first.run), firstBefore, 'new runs must not change an earlier candidate');
assert.equal(first.report.comparison.length, (await filesIn(path.join(repositoryRoot, 'dist'))).length);
for (const entry of first.report.comparison) {
  assert.ok(entry.result === 'exact'
    || (entry.result === 'eol-only' && recipe.allowedBaselineEolDifferences.includes(entry.file)));
}
assert.equal(first.report.files.filter(entry => entry.kind === 'legacy-override').length, recipe.legacyOverrides.length);

// Independent composition must work after the old upstream-facing checkout and
// baseline dist are absent. Use a disposable clone, never the user's checkout.
const isolated = path.join(await mkdtemp(path.join(work, 'independent-test-')), 'repo');
git(repositoryRoot, ['clone', '--shared', '--quiet', repositoryRoot, isolated]);
await cp(path.join(repositoryRoot, 'scripts/compose/build-candidate.mjs'), path.join(isolated, 'scripts/compose/build-candidate.mjs'));
// Git checkout may convert CRLF; preserve the exact registered extension inputs.
for (const file of recipe.localFiles) await cp(path.join(repositoryRoot, file), path.join(isolated, file));
await symlink(path.join(repositoryRoot, 'node_modules'), path.join(isolated, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const tracked = git(isolated, ['ls-files', '-z']).toString().split('\0').filter(Boolean);
for (const file of tracked) {
  if (!recipe.publishRoots.includes(file.split('/')[0]) || recipe.localFiles.includes(file)) continue;
  safeRelative(file);
  await unlink(path.join(isolated, file));
}
await assert.rejects(access(path.join(isolated, 'index.html')));
await assert.rejects(access(path.join(isolated, 'assets/js/app.js')));
await assert.rejects(access(path.join(isolated, 'dist')));
const independentBuild = spawnSync(process.execPath, ['scripts/compose/build-candidate.mjs', '--independent'], {
  cwd: isolated, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
assert.equal(independentBuild.status, 0, independentBuild.stdout + independentBuild.stderr);
const isolatedWork = path.join(isolated, '.work/compose');
const independentRun = path.join(isolatedWork, (await readdir(isolatedWork))[0]);
const independentReport = JSON.parse(await readFile(path.join(independentRun, 'report.json')));
assert.equal(independentReport.status, 'verified-candidate');
assert.equal(independentReport.buildMode, 'independent');
assert.equal(independentReport.outputSha256, first.report.outputSha256);
assert.ok(independentReport.comparison.every(entry => entry.result === 'not-compared' && entry.baselineSha256 === null));
const independentBehavior = spawnSync(process.execPath, ['scripts/compose/check-candidate.mjs', '--run-dir', independentRun], {
  cwd: isolated, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
assert.equal(independentBehavior.status, 0, independentBehavior.stdout + independentBehavior.stderr);
const comparisonWithoutCheckout = spawnSync(process.execPath, ['scripts/compose/build-candidate.mjs'], {
  cwd: isolated, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
assert.notEqual(comparisonWithoutCheckout.status, 0);
assert.match(comparisonWithoutCheckout.stderr, /ENOENT/);
console.log('Independent composition: PASS (old web sources and dist absent; identical artifact; candidate behavior passed)');

cli('scripts/compose/check-candidate.mjs', ['--run-dir', first.run]);
const behavior = JSON.parse(await readFile(path.join(first.run, 'behavior-report.json')));
assert.equal(behavior.status, 'passed');
assert.equal(behavior.outputSha256, first.report.outputSha256);
assert.equal(behavior.tests.length, 10);
assert.ok(behavior.tests.every(test => test.status === 'passed'));

// Prove the selected artifact is used, with no checkout fallback on missing or
// broken modules. Only disposable copies are changed.
const negative = await mkdtemp(path.join(work, 'behavior-negative-'));
await cp(path.join(first.run, 'dist'), path.join(negative, 'dist'), { recursive: true });
await cp(path.join(first.run, 'report.json'), path.join(negative, 'report.json'));
const cacheFile = path.join(negative, 'dist/assets/js/text-filter-cache.js');
const cache = await readFile(cacheFile, 'utf8');
assert.ok(cache.includes('return cache.get(source)'));
await writeFile(cacheFile, cache.replace('return cache.get(source)', "return 'BROKEN_CANDIDATE'"));
const brokenBehavior = spawnSync(process.execPath, ['scripts/tests/test-app-filter-cache.mjs'], {
  cwd: repositoryRoot, encoding: 'utf8',
  env: { ...process.env, RPHUB_TEST_WEB_ROOT: path.join(negative, 'dist') },
});
assert.notEqual(brokenBehavior.status, 0);
assert.match(brokenBehavior.stderr, /BROKEN_CANDIDATE/);
assert.match(cli('scripts/compose/check-candidate.mjs', ['--run-dir', negative], false).stderr, /artifact differs/);
const rejected = JSON.parse(await readFile(path.join(negative, 'behavior-report.json')));
assert.equal(rejected.status, 'failed');
assert.equal(rejected.tests.length, 0);
const missingBehavior = spawnSync(process.execPath, ['scripts/tests/test-app-filter-cache.mjs'], {
  cwd: repositoryRoot, encoding: 'utf8',
  env: { ...process.env, RPHUB_TEST_WEB_ROOT: path.join(negative, 'missing') },
});
assert.notEqual(missingBehavior.status, 0);
assert.match(missingBehavior.stderr, /ENOENT/);

// A candidate-only class must be scanned; scanning the root checkout would miss it.
const cssTest = await mkdtemp(path.join(work, 'css-test-'));
const cssSource = path.join(cssTest, 'source');
await cp(path.join(second.run, 'source'), cssSource, { recursive: true });
await appendFile(path.join(cssSource, 'index.html'), '\n<div class="z-[12345]"></div>\n');
cli('scripts/web/build-css.mjs', ['--source-root', cssSource]);
assert.match(await readFile(path.join(cssSource, 'assets/generated/main.css'), 'utf8'), /z-index:12345/);
assert.doesNotMatch(await readFile(path.join(repositoryRoot, 'assets/generated/main.css'), 'utf8'), /z-index:12345/);

// A broken candidate/source comparison fails without changing the official output.
await appendFile(path.join(cssSource, 'assets/js/api-utils.js'), '\n// injected mismatch\n');
assert.match(cli('scripts/web/verify-dist.mjs', ['--source-root', cssSource, '--output-dir', path.join(second.run, 'dist')], false).stderr, /Source and dist content differ/);
assert.equal(await digest(path.join(repositoryRoot, 'dist')), officialBefore);
assert.equal(await digest(path.join(repositoryRoot, 'assets')), assetsBefore);
const exact = first.report.comparison.filter(entry => entry.result === 'exact').length;
console.log(`Composition: PASS (two fresh builds, ${exact} exact + ${first.report.comparison.length - exact} EOL-only, drift rejection, isolated CSS, official output preserved)`);
