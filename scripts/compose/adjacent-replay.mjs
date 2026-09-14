// Isolated adjacent-version replay.
//
// Phase 4 needs to prove that a *new* stable upstream can be composed and pass
// the behavior gate before the lock is moved. This helper clones the repository
// into a disposable workspace, redirects the lock to the requested tag *inside
// the clone only*, runs the independent composition and the candidate behavior
// gate, and returns a machine-readable report. The caller's lock and dist are
// never touched; the clone is kept under .work/compose for diagnosis.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../web/paths.mjs';
import { filesIn, hash } from './compose-lib.mjs';

// A run is only as trustworthy as the deepest gate it passed. Composition and
// behavior are required; the full-page browser check and the candidate APK build
// need a browser / Android toolchain, so they are opt-in and recorded per run.
export const REQUIRED_CAPABILITIES = Object.freeze(['composition', 'behavior']);
export const OPTIONAL_CAPABILITIES = Object.freeze(['browser', 'android-apk']);

const STABLE_TAG = /^v?\d+\.\d+\.\d+$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(script, args, cwd) {
  return execFileSync(process.execPath, [path.join(cwd, script), ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 32 * 1024 * 1024,
  });
}

// The Android build leaves a Gradle daemon holding the inherited stdout handle,
// so capturing through a pipe never reaches EOF. Stream to a log file and settle
// on the *direct* process exit instead; this mirrors build-and-install.ps1's
// Invoke-Native contract and captures the emitted APK_SHA256 line.
function runStreamedToFile(command, args, cwd, logPath, timeout) {
  return new Promise((resolve, reject) => {
    const log = openSync(logPath, 'w');
    const child = spawn(command, args, { cwd, stdio: ['ignore', log, log], windowsHide: true });
    let timedOut = false;
    let settled = false;
    let logClosed = false;
    const closeLog = () => { if (!logClosed) { logClosed = true; closeSync(log); } };
    const finish = (error, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeLog();
      if (error) reject(error); else resolve(text);
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.on('error', error => finish(error));
    // 'exit' fires on direct-process exit even while grandchildren (the Gradle
    // daemon) keep the inherited handle open, so this never waits for pipe EOF.
    child.on('exit', code => {
      readFile(logPath, 'utf8').catch(() => '').then(text => {
        if (timedOut) { finish(new Error(`${command} timed out after ${timeout}ms`)); return; }
        if (code === 0) { finish(null, text); return; }
        const error = new Error(`${command} failed (exit ${code})\n${text}`);
        error.stdout = text;
        finish(error);
      });
    });
  });
}

// build-candidate prints the composition report path on its final line. Read
// that path instead of guessing from a lexicographic directory sort, so the
// replay always inspects the run it just created.
function compositionRunDirectory(output) {
  const match = output.match(/^Composition report: (.+)$/m);
  assert.ok(match, 'Could not locate the composition report path in build output');
  return path.dirname(match[1].trim());
}

// Reduce an exec/spawn failure to the meaningful diagnostic line, skipping the
// Node stack frames and the child's informational report-path chatter.
function failureReason(error) {
  const text = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n');
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
    .filter(line => !/^\s*at\s/.test(line) && !/^Composition report:/.test(line) && !/^>/.test(line));
  const marker = lines.reverse().find(line => /(?:Error|drift|Unsupported|Expected|ambiguous|refusing|failed|mismatch)/i.test(line));
  return marker || error.message || String(error);
}

async function digest(directory) {
  const entries = [];
  for (const file of await filesIn(directory)) entries.push([file, hash(await readFile(path.join(directory, file)))]);
  return hash(JSON.stringify(entries));
}

export async function runAdjacentReplay({
  tag, repository = repositoryRoot, workParent = null, browser = null, androidApk = false,
} = {}) {
  assert.match(tag, STABLE_TAG, `Adjacent tag must be a stable release tag: ${tag}`);
  if (browser !== null) assert.ok(typeof browser === 'string' && browser.trim(), 'Browser path must be a non-empty string');
  if (androidApk) assert.equal(process.platform, 'win32', 'The candidate APK gate currently requires Windows');
  const realRepository = await realpath(repository);
  const lock = JSON.parse(await readFile(path.join(realRepository, 'upstream.lock.json'), 'utf8'));
  assert.equal(lock.schemaVersion, 1, 'Unsupported upstream lock schema');
  assert.match(lock.commit, FULL_COMMIT, 'Repository lock must pin a full commit');
  assert.match(lock.repository, /^(https:\/\/|git@)/, 'Repository lock must name a Git URL');

  const parent = workParent || path.join(realRepository, '.work', 'compose', 'adjacent');
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const realRoot = await realpath(path.join(realRepository));
  const relative = path.relative(realRoot, realParent);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Adjacent replay workspace must stay inside the source repository');
  }

  const before = {
    lockBytes: await readFile(path.join(realRepository, 'upstream.lock.json')),
    dist: await digest(path.join(realRepository, 'dist')).catch(() => null),
  };

  const base = await mkdtemp(path.join(realParent, `${tag}-`));
  const repo = path.join(base, 'repo');
  git(realRepository, ['clone', '--shared', '--quiet', realRepository, repo]);

  let upstreamUrl = null;
  try {
    upstreamUrl = git(repo, ['remote', 'get-url', 'upstream']);
  } catch {
    upstreamUrl = null;
  }
  if (upstreamUrl === null) {
    git(repo, ['remote', 'add', 'upstream', lock.repository]);
  } else if (upstreamUrl.replace(/\/$/, '') !== lock.repository.replace(/\/$/, '')) {
    throw new Error(`Adjacent replay upstream remote mismatch: ${upstreamUrl}`);
  }

  let commit = null;
  try {
    commit = git(repo, ['rev-parse', `refs/tags/${tag}^{commit}`]);
  } catch {
    commit = null;
  }
  let fetched = false;
  if (commit === null) {
    git(repo, ['fetch', '--quiet', 'upstream', `refs/tags/${tag}:refs/tags/${tag}`]);
    commit = git(repo, ['rev-parse', `refs/tags/${tag}^{commit}`]);
    fetched = true;
  }
  assert.match(commit, FULL_COMMIT, `Adjacent tag ${tag} did not resolve to a commit`);

  await writeFile(path.join(repo, 'upstream.lock.json'),
    JSON.stringify({ schemaVersion: 1, repository: lock.repository, tag, commit }, null, 2) + '\n');

  const recipe = JSON.parse(await readFile(path.join(realRepository, 'scripts', 'compose', 'recipe.json'), 'utf8'));
  await cp(path.join(realRepository, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  for (const file of recipe.localFiles) await cp(path.join(realRepository, file), path.join(repo, file));
  await symlink(path.join(realRepository, 'node_modules'), path.join(repo, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');

  const report = {
    schema: 1, status: 'failed', stage: 'prepare', tag, commit, fetched,
    baseCommit: lock.commit, baseTag: lock.tag,
    buildMode: null, outputSha256: null, behaviorStatus: null,
    tests: [], capabilities: [...REQUIRED_CAPABILITIES], workDir: repo,
    limitations: [
      'Isolated gate; not release acceptance.',
      browser === null ? 'Browser mount not checked (pass --browser).' : 'Browser mount checked on a fresh headless profile.',
      androidApk ? 'Candidate APK assets checked; not device behavior acceptance.' : 'Candidate APK not built (pass --android-apk).',
    ].join(' '),
  };
  try {
    report.stage = 'composition';
    const buildOutput = run('scripts/compose/build-candidate.mjs', ['--independent'], repo);
    const runDirectory = compositionRunDirectory(buildOutput);
    const build = JSON.parse(await readFile(path.join(runDirectory, 'report.json'), 'utf8'));
    assert.equal(build.status, 'verified-candidate', 'Adjacent composition did not verify');
    report.buildMode = build.buildMode;
    report.outputSha256 = build.outputSha256;

    report.stage = 'behavior';
    let behaviorError = null;
    try {
      run('scripts/compose/check-candidate.mjs', ['--run-dir', runDirectory], repo);
    } catch (error) {
      behaviorError = error;
    }
    // check-candidate always writes its report, even on failure; capture the
    // per-suite result before deciding, so the report localizes the defect.
    const behavior = JSON.parse(await readFile(path.join(runDirectory, 'behavior-report.json'), 'utf8'));
    report.behaviorStatus = behavior.status;
    report.upstreamCommit = behavior.upstreamCommit;
    report.tests = behavior.tests.map(({ file, status }) => ({ file, status }));
    if (behavior.status !== 'passed') {
      const failed = behavior.tests.filter(test => test.status !== 'passed').map(test => test.file);
      throw new Error(`Adjacent behavior gate failed: ${failed.length ? failed.join(', ') : failureReason(behaviorError || '')}`);
    }
    assert.equal(behavior.upstreamCommit, commit, 'Behavior gate must replay against the adjacent commit');
    report.stage = 'verified';

    if (browser !== null) {
      report.stage = 'browser';
      // Full-page offline startup against the adjacent candidate. run() uses
      // spawnSync, so a fresh Node process avoids re-entering the browser's
      // async event loop and keeps this gate isolated.
      run('scripts/compose/check-browser.mjs', ['--run-dir', runDirectory, '--browser', browser], repo);
      const browserDir = (await filesIn(runDirectory))
        .map(file => file.split(path.sep).join('/'))
        .filter(file => file.startsWith('browser-') && file.endsWith('report.json'))
        .sort()
        .at(-1);
      assert.ok(browserDir, 'Browser gate did not write a report');
      const browserReport = JSON.parse(await readFile(path.join(runDirectory, browserDir), 'utf8'));
      assert.equal(browserReport.status, 'passed', 'Adjacent browser gate did not pass');
      report.browserStatus = browserReport.status;
      report.browserPages = browserReport.pages.map(({ entry }) => entry);
      report.capabilities.push('browser');
      report.stage = 'verified';
    }

    if (androidApk) {
      report.stage = 'android-apk';
      // sync-candidate-android verifies the whole candidate set inside the APK
      // web assets; the PowerShell wrapper then builds and verifies the APK.
      run('scripts/compose/sync-candidate-android.mjs', ['--run-dir', runDirectory], repo);
      const apkLog = path.join(runDirectory, 'android-apk.log');
      const apk = await runStreamedToFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(repo, 'scripts/android/build-android-debug.ps1'), '-CandidateRun', runDirectory],
      repo, apkLog, 1800000);
      const match = apk.match(/^APK_SHA256=([0-9a-f]{64})$/m);
      assert.ok(match, 'Candidate APK build did not report a verified SHA-256');
      report.apkSha256 = match[1];
      report.capabilities.push('android-apk');
      console.log(`Candidate APK verified: ${path.join(runDirectory, 'android-debug')}`);
      report.stage = 'verified';
    }

    report.status = 'passed';
  } catch (error) {
    report.error = failureReason(error);
  } finally {
    // The replay must never touch the source checkout, successful or not.
    report.sourceLockUnchanged = (await readFile(path.join(realRepository, 'upstream.lock.json'))).equals(before.lockBytes);
    report.sourceDistUnchanged = await digest(path.join(realRepository, 'dist')).catch(() => null) === before.dist;
    if (!report.sourceLockUnchanged || !report.sourceDistUnchanged) {
      report.status = 'failed';
      report.error = `${report.error ? report.error + '\n' : ''}Adjacent replay mutated the source checkout`;
    }
  }
  return report;
}
