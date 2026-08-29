import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testDir = dirname(fileURLToPath(import.meta.url));
const previewScript = resolve(testDir, '..', 'preview-merge.mjs');
const cleanupRoots = [];

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: options.env || process.env
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const git = (cwd, ...args) => run('git', args, cwd).stdout.trim();

async function write(relativeRoot, relativePath, contents) {
  const target = join(relativeRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function createFixture(name, conflictPath = 'assets/conflict.txt') {
  const root = await mkdtemp(join(tmpdir(), `rphub-preview-${name}-`));
  cleanupRoots.push(root);
  const seed = join(root, 'seed');
  const upstream = join(root, 'upstream.git');
  const local = join(root, 'local');

  await mkdir(seed);
  git(seed, 'init', '--initial-branch=main');
  git(seed, 'config', 'user.name', 'Preview Test');
  git(seed, 'config', 'user.email', 'preview@example.invalid');
  await write(seed, conflictPath, 'base\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'base');
  git(root, 'clone', '--bare', seed, upstream);
  git(root, 'clone', upstream, local);
  git(local, 'config', 'user.name', 'Preview Test');
  git(local, 'config', 'user.email', 'preview@example.invalid');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(seed, 'remote', 'add', 'origin', upstream);

  return { root, seed, upstream, local, conflictPath };
}

async function divergeWithConflict(fixture) {
  await write(fixture.local, fixture.conflictPath, 'local\n');
  git(fixture.local, 'add', fixture.conflictPath);
  git(fixture.local, 'commit', '-m', 'local change');

  await write(fixture.seed, fixture.conflictPath, 'upstream\n');
  git(fixture.seed, 'add', fixture.conflictPath);
  git(fixture.seed, 'commit', '-m', 'upstream change');
  git(fixture.seed, 'push', 'origin', 'main');
}

function preview(fixture, upstreamUrl = fixture.upstream) {
  const beforeHead = git(fixture.local, 'rev-parse', 'HEAD');
  const beforeStatus = git(fixture.local, 'status', '--porcelain=v1');
  const result = run(process.execPath, [previewScript], fixture.local, {
    allowFailure: true,
    env: {
      ...process.env,
      RPHUB_PREVIEW_MERGE_PROJECT_ROOT: fixture.local,
      RPHUB_PREVIEW_MERGE_UPSTREAM_URL: upstreamUrl
    }
  });
  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), beforeHead, 'preview must not move local HEAD');
  assert.equal(git(fixture.local, 'status', '--porcelain=v1'), beforeStatus, 'preview must not touch the worktree or index');
  return result;
}

try {
  const upstreamConflict = await createFixture('upstream-conflict');
  await divergeWithConflict(upstreamConflict);
  const conflictResult = preview(upstreamConflict);
  assert.equal(conflictResult.status, 2, conflictResult.stderr);
  assert.match(conflictResult.stdout, /RESULT=conflicts \(1 file\(s\)\)/);
  assert.match(conflictResult.stdout, /assets\/conflict\.txt/);
  assert.match(conflictResult.stdout, /PATCH SKELETON SUGGESTION/);

  const isolatedConflict = await createFixture('isolated-conflict', 'docs/conflict.txt');
  await divergeWithConflict(isolatedConflict);
  const isolatedResult = preview(isolatedConflict);
  assert.equal(isolatedResult.status, 2, isolatedResult.stderr);
  assert.match(isolatedResult.stdout, /docs\/conflict\.txt/);
  assert.match(isolatedResult.stdout, /No conflicts hit upstream-owned files/);
  assert.doesNotMatch(isolatedResult.stdout, /PATCH SKELETON SUGGESTION/);

  const clean = await createFixture('clean');
  await write(clean.local, 'local-only.txt', 'local\n');
  git(clean.local, 'add', 'local-only.txt');
  git(clean.local, 'commit', '-m', 'local-only change');
  await write(clean.seed, 'upstream-only.txt', 'upstream\n');
  git(clean.seed, 'add', 'upstream-only.txt');
  git(clean.seed, 'commit', '-m', 'upstream-only change');
  git(clean.seed, 'push', 'origin', 'main');
  const cleanResult = preview(clean);
  assert.equal(cleanResult.status, 0, cleanResult.stderr);
  assert.match(cleanResult.stdout, /RESULT=clean/);

  const failedFetch = await createFixture('git-failure');
  const missingUpstream = join(failedFetch.root, 'missing-upstream.git');
  git(failedFetch.local, 'remote', 'set-url', 'upstream', missingUpstream);
  const failureResult = preview(failedFetch, missingUpstream);
  assert.equal(failureResult.status, 1);
  assert.match(failureResult.stderr, /Failed to fetch upstream main:/);
  assert.doesNotMatch(failureResult.stdout, /RESULT=clean/);

  console.log('Preview merge behavior: PASS (upstream conflict, isolated conflict, clean merge, git failure)');
} finally {
  await Promise.all(cleanupRoots.map(root => rm(root, { recursive: true, force: true })));
}
