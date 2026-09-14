// Compatibility-failure gate for the isolated adjacent replay.
//
// Real stable tags all transform cleanly, so this suite proves the *failure*
// behavior with synthetic incompatible upstreams built from the locked commit:
// missing, duplicated, and semantically drifted anchors must stop the replay at
// the composition stage, a behavior-only defect must stop it at the behavior
// stage, and no failure may touch the source lock or dist.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../../web/paths.mjs';
import { hash } from '../compose-lib.mjs';
import { runAdjacentReplay } from '../adjacent-replay.mjs';

const work = path.join(repositoryRoot, '.work/compose/adjacent-tests');
await mkdir(work, { recursive: true });

function git(cwd, args, options = {}) {
  const { input, ...rest } = options;
  // hash-object --stdin needs a real stdin pipe; everything else keeps stdin
  // closed so a stray prompt cannot hang the run.
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    ...rest,
  });
}

async function digest(directory) {
  const files = [];
  async function walk(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) files.push(next);
    }
  }
  await walk('');
  files.sort();
  const entries = [];
  for (const file of files) entries.push([file, hash(await readFile(path.join(directory, file)))]);
  return hash(JSON.stringify(entries));
}

// A disposable source clone with the locked tag available to build synthetic
// incompatible releases from. The source clone is never the user's checkout.
async function syntheticSource() {
  const base = await mkdtemp(path.join(work, 'source-'));
  const repo = path.join(base, 'repo');
  git(repositoryRoot, ['clone', '--shared', '--quiet', repositoryRoot, repo]);
  const lock = JSON.parse(await readFile(path.join(repo, 'upstream.lock.json'), 'utf8'));
  // A --shared clone checks out the committed HEAD, so it would exercise the
  // last committed build/behavior code, not the working tree under review.
  // Overlay the current scripts and registered local files so "run after edit"
  // tests this batch's code, matching what runAdjacentReplay copies into the
  // clone it builds from.
  const recipe = JSON.parse(await readFile(path.join(repositoryRoot, 'scripts/compose/recipe.json'), 'utf8'));
  // Replace, not merge: cp alone would leave files the working tree deleted.
  await rm(path.join(repo, 'scripts'), { recursive: true, force: true });
  await cp(path.join(repositoryRoot, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  for (const file of recipe.localFiles) await cp(path.join(repositoryRoot, file), path.join(repo, file));
  // The replay links the real node_modules; mirror that so a future passing
  // composition case would not fail spuriously at the Tailwind CLI.
  await symlink(path.join(repositoryRoot, 'node_modules'), path.join(repo, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await seedDist(repo);
  // A --shared clone carries the source tags, so the locked commit is normally
  // already present; only reach the network when it is missing.
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${lock.tag}^{commit}`]);
  } catch {
    git(repo, ['remote', 'add', 'upstream', 'https://github.com/STA1N156/RP-Hub.git']);
    git(repo, ['fetch', '--quiet', 'upstream', `refs/tags/${lock.tag}:refs/tags/${lock.tag}`]);
  }
  return { repo, base, lock, commit: git(repo, ['rev-parse', `${lock.tag}^{commit}`]).trim() };
}

// Build a synthetic release whose tree equals the locked tree except for the
// supplied file edits. Git plumbing only: the working tree is never changed.
function buildSyntheticTag(repo, base, baseCommit, edits, tag) {
  const tree = git(repo, ['rev-parse', `${baseCommit}^{tree}`]).trim();
  const index = path.join(base, `index-${tag}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  git(repo, ['read-tree', tree], { env });
  for (const [file, transform] of Object.entries(edits)) {
    let original;
    try {
      original = git(repo, ['show', `${baseCommit}:${file}`]).toString();
    } catch {
      original = null; // the synthetic release adds a new file
    }
    const changed = transform(original);
    if (original !== null) assert.notEqual(changed, original, `synthetic edit did not apply: ${file}`);
    const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: changed }).trim();
    // Guard the stdin path: if hash-object ever stops receiving the content it
    // would write an empty blob and the negative case would pass vacuously.
    assert.equal(git(repo, ['cat-file', '-p', blob]).toString(), changed, `synthetic blob did not round-trip: ${file}`);
    git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
  }
  const newTree = git(repo, ['write-tree'], { env }).trim();
  // commit-tree needs an author/committer identity. Supply a test-scoped one in
  // the environment instead of relying on the developer machine's Git config
  // (CI runners and clean checkouts have none).
  const identity = {
    ...env,
    GIT_AUTHOR_NAME: 'RP-Hub compat gate', GIT_AUTHOR_EMAIL: 'compat-gate@localhost',
    GIT_COMMITTER_NAME: 'RP-Hub compat gate', GIT_COMMITTER_EMAIL: 'compat-gate@localhost',
  };
  const commit = git(repo, ['commit-tree', newTree, '-p', baseCommit, '-m', `synthetic ${tag}`], { env: identity }).trim();
  git(repo, ['tag', tag, commit]);
  return commit;
}

// A fresh --shared clone has no dist (git-ignored), so a bare digest comparison
// would be null === null and prove nothing. Seed a sentinel dist before each
// run so "the replay must not touch the source dist" is actually exercised.
async function seedDist(repo) {
  await mkdir(path.join(repo, 'dist'), { recursive: true });
  await writeFile(path.join(repo, 'dist/index.html'), '<!doctype html><title>source sentinel</title>\n');
}

async function snapshot(repo) {
  return {
    lock: await readFile(path.join(repo, 'upstream.lock.json')),
    dist: await digest(path.join(repo, 'dist')),
  };
}

async function assertSourcePreserved(repo, before) {
  assert.ok((await readFile(path.join(repo, 'upstream.lock.json'))).equals(before.lock), 'source lock changed');
  assert.equal(await digest(path.join(repo, 'dist')), before.dist, 'source dist changed');
}

const cases = [
  {
    name: 'missing anchor',
    tag: '1.9.90',
    edits: { 'assets/js/api-utils.js': source => source.replace('const requestChatCompletion = async options => {', 'const renamedRetryWrapper = async options => {') },
    error: /Expected 1 stable 1\.9\.3 retry wrapper, found 0/,
  },
  {
    name: 'duplicated anchor',
    tag: '1.9.91',
    edits: { 'assets/js/api-utils.js': source => source + source.slice(source.indexOf('const requestChatCompletionOnce =')) },
    error: /Expected 1 upstream fixed stream interval, found 2/,
  },
  {
    // The declaration anchor stays intact; only the verified transport behavior
    // changes (the 60 ms flush interval). A gate that only matched text would
    // accept this, so this case proves the behavior invariants are enforced.
    name: 'semantic drift (transport interval)',
    tag: '1.9.92',
    edits: { 'assets/js/api-utils.js': source => source.replace('setInterval(flush, 60)', 'setInterval(flush, 100)') },
    error: /Expected 1 upstream fixed stream interval, found 0/,
  },
  {
    // Same class of drift at the app transform: the call-site text keeps its
    // anchor but the count-only contract changes.
    name: 'semantic drift (count-only contract)',
    tag: '1.9.93',
    edits: {
      'assets/js/app.js': source => source.replaceAll(
        'getPostprocessedChatMessages(chatHistory.value, { includeSystem: false }).length',
        'getPostprocessedChatMessages(chatHistory.value, { includeSystem: true }).length'),
    },
    error: /Count-only call sites drifted/,
  },
  {
    name: 'unregistered upstream path',
    tag: '1.9.94',
    edits: { 'brand-new-page/index.html': () => '<!doctype html><title>new</title>' },
    error: /Unclassified upstream path/,
  },
];

let passed = 0;
for (const testCase of cases) {
  const { repo, base, commit } = await syntheticSource();
  buildSyntheticTag(repo, base, commit, testCase.edits, testCase.tag);
  const before = await snapshot(repo);
  const report = await runAdjacentReplay({ tag: testCase.tag, repository: repo });
  assert.equal(report.status, 'failed', `${testCase.name}: incompatible upstream must fail`);
  assert.equal(report.stage, 'composition', `${testCase.name}: must stop at the composition stage`);
  assert.match(report.error || '', testCase.error, `${testCase.name}: unexpected diagnostic`);
  assert.equal(report.capabilities.includes('behavior'), true);
  assert.equal(report.behaviorStatus, null, `${testCase.name}: behavior gate must not run`);
  await assertSourcePreserved(repo, before);
  console.log(`Compat FAIL-CLOSED (composition): ${testCase.name} :: ${report.error}`);
  passed += 1;
}

// Behavior-stage isolation: identical upstream (no incompatible edit), but a
// poisoned registered local extension. Composition copies the local file
// verbatim and succeeds; the behavior gate must catch the semantic defect.
{
  const base = await mkdtemp(path.join(work, 'behavior-source-'));
  const repo = path.join(base, 'repo');
  git(repositoryRoot, ['clone', '--shared', '--quiet', repositoryRoot, repo]);
  // Test the working-tree scripts under review, not the committed HEAD.
  const recipe = JSON.parse(await readFile(path.join(repositoryRoot, 'scripts/compose/recipe.json'), 'utf8'));
  await rm(path.join(repo, 'scripts'), { recursive: true, force: true });
  await cp(path.join(repositoryRoot, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  for (const file of recipe.localFiles) await cp(path.join(repositoryRoot, file), path.join(repo, file));
  await symlink(path.join(repositoryRoot, 'node_modules'), path.join(repo, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const cachePath = path.join(repo, 'assets/js/text-filter-cache.js');
  const cache = await readFile(cachePath, 'utf8');
  const marker = 'return cache.get(source)';
  assert.ok(cache.includes(marker), 'behavior probe anchor missing');
  await writeFile(cachePath, cache.replace(marker, "return 'BROKEN_CANDIDATE'"));
  await seedDist(repo);
  const before = await snapshot(repo);
  const report = await runAdjacentReplay({ tag: JSON.parse(await readFile(path.join(repo, 'upstream.lock.json'), 'utf8')).tag, repository: repo });
  assert.equal(report.status, 'failed', 'poisoned local extension must fail the gate');
  assert.equal(report.stage, 'behavior', 'defect must stop at the behavior stage');
  assert.equal(report.behaviorStatus, 'failed');
  // Distinguish a real behavior-suite failure from an infrastructure crash that
  // would also write behavior-report.json with status 'failed' but tests:[].
  assert.match(report.error || '', /Adjacent behavior gate failed: /, 'failure must be a behavior suite, not an infra error');
  assert.ok(report.tests.some(test => test.status !== 'passed'), 'at least one suite must be reported as failing');
  await assertSourcePreserved(repo, before);
  console.log(`Compat FAIL-CLOSED (behavior): poisoned local extension :: ${report.error}`);
  passed += 1;
}

// Malformed tag and out-of-repo workspace are rejected before any clone/build.
await assert.rejects(runAdjacentReplay({ tag: 'main' }), /stable release tag/);
await assert.rejects(runAdjacentReplay({ tag: 'v1.9.4-rc1' }), /stable release tag/);
await assert.rejects(runAdjacentReplay({ tag: '1.9.4', workParent: path.dirname(repositoryRoot) }), /inside the source repository/);
passed += 1;

console.log(`Adjacent replay compatibility gate: PASS (${passed} fail-closed cases, source preserved)`);
