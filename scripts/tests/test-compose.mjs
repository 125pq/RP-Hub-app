import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, cp, mkdtemp, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
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
