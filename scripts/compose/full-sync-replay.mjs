// Isolated full compose-sync replay (phase 6 validation).
//
// The adjacent replay proves a new upstream composes and passes the behavior
// gate. This goes further and exercises the *whole* sync sequence the CLI and
// workflow now run, inside a disposable clone so the source lock/dist are never
// touched:
//
//   pin lock + apply Android version metadata -> build:web -> verify:dist
//
// It then proves the two safety properties that matter for an automated update:
// a dry run leaves the prior inputs untouched, and a failure restores them
// byte-for-byte (no new lock paired with uncommitted metadata).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../web/paths.mjs';
import { filesIn, hash } from './compose-lib.mjs';
import { runComposeSync } from '../upstream-sync/compose-sync.mjs';
import { pinUpstream } from './pin-upstream.mjs';
import { releaseInputFiles } from '../upstream-sync/release-inputs.mjs';

const STABLE_TAG = /^v?\d+\.\d+\.\d+$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/;

function git(root, args, { allowFailure = false, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0 && !allowFailure) {
        reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
      } else resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// The Android build leaves a Gradle daemon holding the inherited stdout handle,
// so stream to a file and settle on direct-process exit.
function runToFile(command, args, cwd, logPath, timeout) {
  return new Promise((resolve, reject) => {
    const log = openSync(logPath, 'w');
    // Only shell wrappers need a shell; a real .exe path must not, or Windows
    // splits the space in "C:\Program Files\...".
    const needsShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
    const child = spawn(command, args, { cwd, stdio: ['ignore', log, log], windowsHide: true, shell: needsShell });
    let timedOut = false;
    let settled = false;
    let closed = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!closed) { closed = true; closeSync(log); }
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.on('error', finish);
    child.on('exit', code => {
      if (timedOut) { finish(new Error(`${command} timed out after ${timeout}ms`)); return; }
      if (code === 0) { finish(null); return; }
      finish(new Error(`${command} ${args.join(' ')} failed (exit ${code}); see ${logPath}`));
    });
  });
}

function makeRun(cwd, logDir) {
  let sequence = 0;
  return (command, args) => {
    sequence += 1;
    // Windows resolves npm/npx through .cmd shims.
    const resolved = process.platform === 'win32' && ['npm', 'npx'].includes(command) ? `${command}.cmd` : command;
    const base = path.basename(String(resolved)).replace(/[^\w.-]/g, '_');
    const detail = (args || []).join('_').replace(/[^\w.-]/g, '_').slice(0, 50);
    const name = `${String(sequence).padStart(2, '0')}-${base}-${detail}.log`;
    return runToFile(resolved, args || [], cwd, path.join(logDir, name), 600000);
  };
}

async function digest(directory) {
  try {
    const entries = [];
    for (const file of await filesIn(directory)) entries.push([file, hash(await readFile(path.join(directory, file)))]);
    return hash(JSON.stringify(entries));
  } catch {
    return null;
  }
}

async function snapshotInputs(root) {
  const result = new Map();
  for (const file of releaseInputFiles) {
    try { result.set(file, await readFile(path.join(root, file))); } catch { result.set(file, null); }
  }
  return result;
}

async function restoreInputBytes(root, snapshot) {
  for (const [file, bytes] of snapshot) {
    if (bytes === null) await rm(path.join(root, file), { force: true });
    else await writeFile(path.join(root, file), bytes);
  }
}

function summarizeInputs(snapshot) {
  const out = {};
  for (const [file, bytes] of snapshot) out[file] = bytes === null ? null : hash(bytes);
  return out;
}

export async function runFullSyncReplay({ tag, repository = repositoryRoot, revision = 0 } = {}) {
  assert.match(tag, STABLE_TAG, `Full-sync tag must be a stable release tag: ${tag}`);
  const realRepository = await realpath(repository);
  const lock = JSON.parse(await readFile(path.join(realRepository, 'upstream.lock.json'), 'utf8'));
  assert.match(lock.commit, FULL_COMMIT, 'Repository lock must pin a full commit');

  const parent = path.join(realRepository, '.work', 'compose', 'full-sync');
  await mkdir(parent, { recursive: true });
  const sourceLockBefore = await readFile(path.join(realRepository, 'upstream.lock.json'));
  // Seed a sentinel so "the replay must not touch the source dist" is a real
  // comparison, not null === null (dist is git-ignored and may be absent).
  const sourceDist = path.join(realRepository, 'dist');
  const distSentinel = path.join(sourceDist, 'index.html');
  const hadDist = await stat(sourceDist).then(() => true, () => false);
  if (!hadDist) {
    await mkdir(sourceDist, { recursive: true });
    await writeFile(distSentinel, '<!doctype html><title>source sentinel</title>\n');
  }
  const sourceDistBefore = await digest(sourceDist);

  const base = await mkdtemp(path.join(parent, `${tag}-`));
  const repo = path.join(base, 'repo');
  const logs = path.join(base, 'logs');
  await mkdir(logs, { recursive: true });
  await git(realRepository, ['clone', '--shared', '--quiet', realRepository, repo]);

  await git(repo, ['remote', 'add', 'upstream', lock.repository]);
  let commit = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { allowFailure: true })).stdout;
  if (!FULL_COMMIT.test(commit)) {
    await git(repo, ['fetch', '--quiet', 'upstream', `refs/tags/${tag}:refs/tags/${tag}`]);
    commit = (await git(repo, ['rev-parse', `refs/tags/${tag}^{commit}`])).stdout;
  }
  assert.match(commit, FULL_COMMIT, `Tag ${tag} did not resolve to a commit`);

  const recipe = JSON.parse(await readFile(path.join(realRepository, 'scripts/compose/recipe.json'), 'utf8'));
  await rm(path.join(repo, 'scripts'), { recursive: true, force: true });
  await cp(path.join(realRepository, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  for (const file of releaseInputFiles) await cp(path.join(realRepository, file), path.join(repo, file));
  await cp(path.join(realRepository, '.github'), path.join(repo, '.github'), { recursive: true });
  for (const file of recipe.localFiles) await cp(path.join(realRepository, file), path.join(repo, file));
  await symlink(path.join(realRepository, 'node_modules'), path.join(repo, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');

  const release = { tagName: tag, commitSha: commit };
  const realGit = (args, options) => git(repo, args, options);
  const run = makeRun(repo, logs);
  const pin = (root, pinTag, pinCommit) => pinUpstream(root, pinTag, pinCommit);

  const report = { schema: 1, status: 'failed', tag, commit, baseCommit: lock.commit, baseTag: lock.tag, revision, workDir: repo, checks: [] };
  try {
    // 1. Full real run: pin + version metadata + compose + verify.
    const initialInputs = await snapshotInputs(repo);
    await runComposeSync({ projectRoot: repo, release, revision, git: realGit, run, pin });
    const boundLock = JSON.parse(await readFile(path.join(repo, 'upstream.lock.json'), 'utf8'));
    assert.equal(boundLock.tag, tag, 'lock tag must be bound to the release');
    assert.equal(boundLock.commit, commit, 'lock commit must be bound to the release');
    const pkg = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
    assert.notEqual(pkg.version, JSON.parse(await readFile(path.join(realRepository, 'package.json'), 'utf8')).version,
      'version metadata must advance for a new upstream base');
    assert.equal(await digest(path.join(repo, 'dist')).then(d => d !== null), true, 'dist must be composed and verified');
    report.checks.push({ name: 'full-compose', version: pkg.version, boundTag: boundLock.tag,
      gates: ['test:upstream-sync', 'test:platform', 'test:performance', 'build:web', 'verify:dist'] });

    // 2. Dry run: binds, previews, then restores the prior inputs exactly.
    await restoreInputBytes(repo, initialInputs);
    await runComposeSync({ projectRoot: repo, release, revision, dryRun: true, git: realGit, run, pin });
    assert.deepEqual(summarizeInputs(await snapshotInputs(repo)), summarizeInputs(initialInputs), 'dry run must restore release inputs');
    report.checks.push({ name: 'dry-run-restore' });

    // 3. Failure injection: a compose failure restores the inputs (no new lock
    //    paired with uncommitted metadata).
    await restoreInputBytes(repo, initialInputs);
    await assert.rejects(
      runComposeSync({
        projectRoot: repo, release, revision, git: realGit, run, pin,
        compose: async () => { throw new Error('injected compose failure'); },
      }),
      /injected compose failure/
    );
    assert.deepEqual(summarizeInputs(await snapshotInputs(repo)), summarizeInputs(initialInputs), 'failed compose must restore release inputs');
    report.checks.push({ name: 'failure-restore' });

    // The source repository must be untouched throughout. The dist comparison
    // is non-vacuous because a sentinel was seeded above when dist was absent.
    assert.ok((await readFile(path.join(realRepository, 'upstream.lock.json'))).equals(sourceLockBefore),
      'source lock changed during full-sync replay');
    assert.equal(await digest(sourceDist), sourceDistBefore,
      'source dist changed during full-sync replay');
    report.sourceLockUnchanged = true;
    report.sourceDistUnchanged = true;
    report.status = 'passed';
  } catch (error) {
    report.error = String(error.stdout || error.message || error);
  } finally {
    // Remove only the sentinel we created; leave any pre-existing dist alone.
    if (!hadDist) await rm(sourceDist, { recursive: true, force: true });
  }
  return report;
}

export { STABLE_TAG, git as runReplayGit };
