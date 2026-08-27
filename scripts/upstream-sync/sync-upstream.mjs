import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { projectRoot } from './lib.mjs';
import { reapplyHooks } from './reapply-hooks.mjs';
import { resolveLatestStableRelease } from './release-source.mjs';
import { mergeWithAutoResolver } from './sync-orchestration.mjs';
import { androidReleaseMetadata, deriveRevision, selectRevision } from './prepare-android-release.mjs';
import { assertReleaseTargetAncestry, determineSyncMode } from './sync-decision.mjs';

const UPSTREAM_URL = 'https://github.com/STA1N156/RP-Hub.git';
const RELEASE_REF = 'refs/remotes/upstream/releases/latest';
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

async function stageTrackedChangesPrecisely() {
  const paths = new Set();
  for (const args of [['diff', '--name-only'], ['diff', '--cached', '--name-only']]) {
    const output = await gitText(args);
    for (const relativePath of output.split('\n').map(value => value.trim()).filter(Boolean)) paths.add(relativePath);
  }
  for (const relativePath of paths) await git(['add', '--', relativePath]);
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchUpstreamRelease(release) {
  let lastFailure = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const refspec = `refs/tags/${release.tagName}:${RELEASE_REF}`;
    const result = await git(['fetch', 'upstream', '--force', refspec], { allowFailure: true });
    if (result.code === 0) {
      const fetched = await gitText(['rev-parse', `${RELEASE_REF}^{commit}`]);
      if (fetched !== release.commitSha) {
        throw new Error(`Fetched release ${release.tagName} resolved to ${fetched}, expected ${release.commitSha}`);
      }
      return;
    }
    lastFailure = result;
    console.warn(`Upstream release fetch attempt ${attempt}/3 failed`);
    if (attempt < 3) await delay(attempt * 1000);
  }

  const local = await git(['rev-parse', `${RELEASE_REF}^{commit}`], { capture: true, allowFailure: true });
  if (local.code !== 0 || local.stdout !== release.commitSha) {
    throw new Error(`git fetch failed and the cached release ref is stale (local ${local.stdout || 'missing'}, GitHub ${release.commitSha}): ${lastFailure?.stderr || ''}`);
  }
  console.warn(`FETCH_FALLBACK=PASS (GitHub API confirms cached release ${release.tagName} at ${release.commitSha})`);
}

function publishWorkflowOutputs(release, upstreamUpdated, mode, revision) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `release_tag=${release.tagName}\nupstream_sha=${release.commitSha}\nhas_updates=${upstreamUpdated}\nsync_mode=${mode}\nrevision=${revision}\n`,
    'utf8'
  );
}

async function publicationComplete(release) {
  if (process.env.RPHUB_CHECK_PUBLICATION !== 'true') return true;
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const rawRevision = String(process.env.RPHUB_ANDROID_REVISION || '').trim();
  const revision = rawRevision === '' ? deriveRevision(release.tagName, packageJson.version) : Number(rawRevision);
  const metadata = androidReleaseMetadata(release.tagName, revision);
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !process.env.GH_TOKEN) return false;
  const releaseCheck = await run('gh', [
    'release', 'view', metadata.androidTag,
    '--repo', repository,
    '--json', 'targetCommitish',
    '--jq', '.targetCommitish'
  ], { capture: true, allowFailure: true });
  if (releaseCheck.code !== 0) return false;
  const currentHead = await gitText(['rev-parse', 'HEAD']);
  const isAncestor = async (ancestor, descendant) => {
    const result = await git(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`Unable to verify release ancestry for ${metadata.androidTag}`);
    }
    return result.code === 0;
  };
  await assertReleaseTargetAncestry({
    androidTag: metadata.androidTag,
    upstreamSha: release.commitSha,
    targetCommitish: releaseCheck.stdout,
    headSha: currentHead,
    isAncestor
  });
  const mirrorCheck = await run('curl', ['--silent', '--show-error', '--fail', '--location', '--max-time', '30', 'https://gitee.com/pq125pq/rp-hub-app/raw/android-latest/android-update.json'], { capture: true, allowFailure: true });
  if (mirrorCheck.code !== 0) return false;
  try { return JSON.parse(mirrorCheck.stdout).tag === metadata.androidTag; } catch { return false; }
}

async function mergeInProgress() {
  return (await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { capture: true, allowFailure: true })).code === 0;
}

async function upstreamReleaseAlreadyIntegrated(upstreamHead) {
  const result = await git(['merge-base', '--is-ancestor', upstreamHead, 'HEAD'], { allowFailure: true });
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`Unable to determine whether upstream release ${upstreamHead} is already integrated`);
  }
  return result.code === 0;
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
  const release = await resolveLatestStableRelease();
  console.log(`UPSTREAM_RELEASE=${release.tagName}`);
  console.log(`UPSTREAM_RELEASE_URL=${release.url}`);
  console.log(`UPSTREAM_RELEASE_PUBLISHED_AT=${release.publishedAt}`);
  await fetchUpstreamRelease(release);
  const upstreamHead = await gitText(['rev-parse', `${RELEASE_REF}^{commit}`]);
  const upstreamShort = await gitText(['rev-parse', '--short', `${RELEASE_REF}^{commit}`]);
  const incoming = await gitText(['log', '--oneline', `HEAD..${upstreamHead}`]);
  console.log(`UPSTREAM_HEAD=${upstreamHead}`);
  console.log(incoming ? `INCOMING_COMMITS=\n${incoming}` : 'INCOMING_COMMITS=none');
  const alreadyIntegrated = await upstreamReleaseAlreadyIntegrated(upstreamHead);
  const complete = alreadyIntegrated ? await publicationComplete(release) : false;
  const mode = determineSyncMode({ alreadyIntegrated, publicationComplete: complete });
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const rawRevision = String(process.env.RPHUB_ANDROID_REVISION || '').trim();
  const revision = selectRevision({
    upstreamTag: release.tagName,
    currentVersion: packageJson.version,
    mode,
    explicitRevision: rawRevision === '' ? null : rawRevision
  });
  publishWorkflowOutputs(release, mode !== 'noop', mode, revision);

  if (mode === 'noop') {
    console.log(`UPSTREAM_HAS_UPDATES=false (release ${release.tagName} is already integrated)`);
    completed = true;
  } else if (mode === 'merge') {

    // Keep merge output/classification and the resolver/reapply/abort path in
    // one injectable helper so offline fixtures exercise the Action behavior.
    await mergeWithAutoResolver({
      cwd: projectRoot,
      upstreamRef: upstreamHead,
      git,
      reapply: async () => reapplyHooks()
    });
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
        await stageTrackedChangesPrecisely();
        await git(['commit', '-m', `chore(sync): merge upstream RP-Hub release ${release.tagName} (${upstreamShort}) and reapply local patches`]);
        console.log(`SYNC_COMMIT=${await gitText(['rev-parse', 'HEAD'])}`);
      }
    }
    completed = true;
  } else {
    console.log(`UPSTREAM_HAS_UPDATES=true (release ${release.tagName} is integrated but publication is incomplete)`);
    completed = true;
  }
} finally {
  if (!completed && await mergeInProgress()) {
    await git(['merge', '--abort'], { allowFailure: true });
  }
}
