import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { projectRoot } from './lib.mjs';
import { reapplyHooks } from './reapply-hooks.mjs';

const UPSTREAM_URL = 'https://github.com/STA1N156/RP-Hub.git';
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const prepareOnly = args.has('--prepare-only');
const noCommit = args.has('--no-commit') || prepareOnly;
const known = new Set(['--dry-run', '--prepare-only', '--no-commit']);
for (const arg of args) if (!known.has(arg)) throw new Error(`Unknown option: ${arg}`);
if (dryRun && prepareOnly) throw new Error('--dry-run and --prepare-only cannot be combined');

function commandName(base) {
  return process.platform === 'win32' && ['npm', 'npx'].includes(base) ? `${base}.cmd` : base;
}

function run(command, commandArgs = [], options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`> ${command} ${commandArgs.join(' ')}`);
    const child = spawn(command, commandArgs, {
      cwd: projectRoot,
      env: options.env || process.env,
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0 || options.allowFailure) resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${code}`));
    });
  });
}

const git = (gitArgs, options = {}) => run('git', gitArgs, options);
const gitText = async gitArgs => (await git(gitArgs, { capture: true })).stdout;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchUpstream() {
  let lastFailure = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await git(['fetch', 'upstream', 'main', '--prune'], { allowFailure: true });
    if (result.code === 0) return;
    lastFailure = result;
    console.warn(`Upstream fetch attempt ${attempt}/3 failed`);
    if (attempt < 3) await delay(attempt * 1000);
  }

  const localUpstream = await gitText(['rev-parse', 'upstream/main']);
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'RP-Hub-upstream-sync'
  };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch('https://api.github.com/repos/STA1N156/RP-Hub/commits/main', { headers });
  if (!response.ok) {
    throw new Error(`git fetch failed and GitHub HEAD verification returned HTTP ${response.status}: ${lastFailure?.stderr || ''}`);
  }
  const remoteUpstream = String((await response.json()).sha || '');
  if (!/^[0-9a-f]{40}$/.test(remoteUpstream) || remoteUpstream !== localUpstream) {
    throw new Error(`git fetch failed and local upstream/main is stale (local ${localUpstream}, GitHub ${remoteUpstream || 'unknown'})`);
  }
  console.warn(`FETCH_FALLBACK=PASS (GitHub API confirms unchanged upstream ${localUpstream})`);
}

async function mergeInProgress() {
  return (await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { capture: true, allowFailure: true })).code === 0;
}

async function ensureCleanStart() {
  const status = await gitText(['status', '--porcelain']);
  if (status) throw new Error(`Upstream sync requires a clean working tree:\n${status}`);
}

async function ensureUpstreamRemote() {
  const remote = await git(['remote', 'get-url', 'upstream'], { capture: true, allowFailure: true });
  if (remote.code !== 0) {
    await git(['remote', 'add', 'upstream', UPSTREAM_URL]);
    console.log(`Added upstream remote: ${UPSTREAM_URL}`);
    return;
  }
  if (remote.stdout.replace(/\/$/, '') !== UPSTREAM_URL.replace(/\/$/, '')) {
    throw new Error(`Remote upstream points to ${remote.stdout}, expected ${UPSTREAM_URL}`);
  }
}

function resolveAndroidEnvironment() {
  const env = { ...process.env };
  const parent = path.dirname(projectRoot);
  const toolchain = path.join(parent, '.android-toolchain');

  if (!env.JAVA_HOME || !existsSync(path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
    const jdkRoot = path.join(toolchain, 'jdk');
    const candidate = existsSync(jdkRoot)
      ? readdirSync(jdkRoot, { withFileTypes: true }).find(entry => entry.isDirectory())
      : null;
    if (candidate) env.JAVA_HOME = path.join(jdkRoot, candidate.name);
  }

  const bundledSdk = path.join(toolchain, 'android-sdk');
  if (!env.ANDROID_HOME && existsSync(bundledSdk)) env.ANDROID_HOME = bundledSdk;
  if (!env.ANDROID_SDK_ROOT && env.ANDROID_HOME) env.ANDROID_SDK_ROOT = env.ANDROID_HOME;
  env.JAVA_TOOL_OPTIONS = String(env.JAVA_TOOL_OPTIONS || '')
    .replace(/-Djavax\.net\.ssl\.trustStoreType=Windows-ROOT\s*/g, '')
    .trim();
  if (!/javax\.net\.ssl\.trustStoreType=/.test(env.JAVA_TOOL_OPTIONS)) {
    env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS} -Djavax.net.ssl.trustStoreType=JKS`.trim();
  }
  return env;
}

async function runValidation() {
  const npm = commandName('npm');
  await run(process.execPath, ['scripts/upstream-sync/verify.mjs']);
  await run(process.execPath, ['scripts/upstream-sync/tests/reapply-idempotence.mjs']);
  await run(npm, ['run', 'test:platform']);
  await run(npm, ['run', 'test:performance']);
  await run(npm, ['run', 'build:web']);
  await run(npm, ['run', 'verify:dist']);
  await run(commandName('npx'), ['cap', 'sync', 'android']);

  const gradle = path.join(projectRoot, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  await run(gradle, ['--project-dir', path.join(projectRoot, 'android'), 'testDebugUnitTest', 'assembleRelease'], {
    env: resolveAndroidEnvironment()
  });
  await git(['diff', '--check']);
  await git(['diff', '--cached', '--check']);
}

let completed = false;
let beforeHead = '';
try {
  await ensureCleanStart();
  beforeHead = await gitText(['rev-parse', 'HEAD']);
  console.log(`SYNC_BEFORE_HEAD=${beforeHead}`);
  await ensureUpstreamRemote();
  await fetchUpstream();
  const upstreamHead = await gitText(['rev-parse', 'upstream/main']);
  const upstreamShort = await gitText(['rev-parse', '--short', 'upstream/main']);
  const incoming = await gitText(['log', '--oneline', 'HEAD..upstream/main']);
  console.log(`UPSTREAM_HEAD=${upstreamHead}`);
  console.log(incoming ? `INCOMING_COMMITS=\n${incoming}` : 'INCOMING_COMMITS=none');

  const merge = await git(['merge', '--no-ff', '--no-commit', 'upstream/main'], { allowFailure: true });
  if (merge.code !== 0) {
    const conflicts = await gitText(['diff', '--name-only', '--diff-filter=U']);
    console.error(`MERGE_CONFLICTS=\n${conflicts || '(unknown)'}`);
    if (await mergeInProgress()) await git(['merge', '--abort']);
    throw new Error('Upstream merge conflicted and was aborted; no ours/theirs resolution was attempted');
  }

  await reapplyHooks();
  if (!prepareOnly) await runValidation();

  if (dryRun) {
    if (await mergeInProgress()) await git(['merge', '--abort']);
    const restored = await gitText(['rev-parse', 'HEAD']);
    const status = await gitText(['status', '--porcelain']);
    if (restored !== beforeHead || status) throw new Error('Dry-run rollback did not restore the original clean state');
    console.log('DRY_RUN_ROLLBACK=PASS');
  } else if (!noCommit) {
    const status = await gitText(['status', '--porcelain']);
    if (!status) {
      console.log('SYNC_COMMIT=none (no changes)');
    } else {
      await git(['add', '-A']);
      await git(['commit', '-m', `chore(sync): merge upstream RP-Hub ${upstreamShort} and reapply local patches`]);
      console.log(`SYNC_COMMIT=${await gitText(['rev-parse', 'HEAD'])}`);
    }
  }
  completed = true;
} finally {
  if (!completed && await mergeInProgress()) {
    await git(['merge', '--abort'], { allowFailure: true });
  }
}
