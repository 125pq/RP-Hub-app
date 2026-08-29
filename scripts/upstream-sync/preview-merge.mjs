// preview-merge.mjs — read-only preview of merging upstream main into local HEAD.
//
// Exit code semantics:
//   0  — no conflicts: upstream main merges cleanly into local HEAD.
//   2  — conflicts detected: at least one file conflicts between the two sides.
//   1  — operational error: git fetch / rev-parse / merge-tree failed, or the
//        upstream ref could not be resolved. (Distinct from "conflicts exist".)
//
// This script NEVER merges, commits, or pushes. It only:
//   1. fetches the upstream default branch (refs/heads/main) into a local ref,
//   2. resolves local HEAD and upstream main,
//   3. runs `git merge-tree --write-tree` with those two commits to dry-run the
//      merge in memory,
//   4. prints the conflicted file list, and — when a conflict hits an upstream
//      file (index.html, assets/**, character/**, novel/**) — prints a patch
//      skeleton suggestion modeled on scripts/upstream-sync/patches/*.mjs.
//
// The working tree and index are left untouched.

import { spawn } from 'node:child_process';
import process from 'node:process';
import { projectRoot as defaultProjectRoot } from './lib.mjs';

const projectRoot = process.env.RPHUB_PREVIEW_MERGE_PROJECT_ROOT || defaultProjectRoot;
const UPSTREAM_URL = process.env.RPHUB_PREVIEW_MERGE_UPSTREAM_URL || 'https://github.com/STA1N156/RP-Hub.git';
const UPSTREAM_MAIN_REF = 'refs/remotes/upstream/main';
const UPSTREAM_FETCH_SPEC = 'refs/heads/main:refs/remotes/upstream/main';

// Upstream-owned paths. A conflict on any of these means the local patch layer
// will need to be re-derived against the new upstream content.
const UPSTREAM_PATHS = [
  'index.html',
  'assets/**',
  'character/**',
  'novel/**'
];

function run(command, commandArgs = [], options = {}) {
  return new Promise((resolve, reject) => {
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

// Convert a glob like "assets/**" into a RegExp that matches a relative path.
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

const upstreamMatchers = UPSTREAM_PATHS.map(globToRegExp);

function isUpstreamPath(relativePath) {
  return upstreamMatchers.some(matcher => matcher.test(relativePath));
}

// Parse `git merge-tree --write-tree` output. The first line is the resulting
// tree OID; every subsequent line of the form "<mode> <blob> <stage>\t<path>"
// (stage 2 = ours, stage 3 = theirs) names a conflicted file.
function parseConflictedFiles(output) {
  const files = [];
  for (const line of output.split('\n')) {
    const match = /^\d+ [0-9a-f]{40} [23]\t(.+)$/.exec(line);
    if (match) files.push(match[1]);
  }
  return [...new Set(files)];
}

function printPatchSkeleton(conflictedUpstreamFiles) {
  console.log('\n=== PATCH SKELETON SUGGESTION (not applied) ===');
  console.log('Conflicts hit upstream-owned files. The local patch layer in');
  console.log('scripts/upstream-sync/patches/ will need to be re-derived against');
  console.log('the new upstream content. Suggested skeleton (mirrors existing');
  console.log('patch files, e.g. patch-chat-layout.mjs / patch-performance.mjs):');
  console.log('');
  console.log('  import { editText, replaceOnce } from \'../lib.mjs\';');
  console.log('');
  console.log('  const category = \'<your-category>\';');
  console.log('');
  console.log('  // <why this patch exists: upstream commit + behavior change>');
  console.log('  export function patch<Name>(source) {');
  console.log('    const before = `<old upstream snippet>`;');
  console.log('    const after = `<new local snippet>`;');
  console.log('    return replaceOnce(source, before, after, \'<description>\');');
  console.log('  }');
  console.log('');
  console.log('  export async function apply<Name>Hooks() {');
  console.log('    const changes = [];');
  for (const file of conflictedUpstreamFiles) {
    console.log(`    changes.push(await editText('${file}', category, patch<Name>));`);
  }
  console.log('    return changes.filter(Boolean);');
  console.log('  }');
  console.log('');
  console.log('Then register the new hook in scripts/upstream-sync/reapply-hooks.mjs');
  console.log('and add a regression test under scripts/upstream-sync/tests/.');
  console.log('============================================================');
}

async function main() {
  // 1. Ensure the upstream remote exists and fetch its default branch (read-only).
  const remote = await git(['remote', 'get-url', 'upstream'], { capture: true, allowFailure: true });
  if (remote.code !== 0) {
    await git(['remote', 'add', 'upstream', UPSTREAM_URL]);
    console.log(`Added upstream remote: ${UPSTREAM_URL}`);
  } else if (remote.stdout.replace(/\/$/, '') !== UPSTREAM_URL.replace(/\/$/, '')) {
    throw new Error(`Remote upstream points to ${remote.stdout}, expected ${UPSTREAM_URL}`);
  }

  const fetchResult = await git(['fetch', 'upstream', '--force', UPSTREAM_FETCH_SPEC], { capture: true, allowFailure: true });
  if (fetchResult.code !== 0) {
    console.error(`Failed to fetch upstream main: ${fetchResult.stderr}`);
    process.exit(1);
  }

  const upstreamHead = await gitText(['rev-parse', `${UPSTREAM_MAIN_REF}^{commit}`]);
  const localHead = await gitText(['rev-parse', 'HEAD']);
  console.log(`LOCAL_HEAD=${localHead}`);
  console.log(`UPSTREAM_MAIN=${upstreamHead}`);

  // 2. Dry-run the actual merge in memory (no working-tree / index changes).
  const mergeResult = await git(['merge-tree', '--write-tree', localHead, upstreamHead], { capture: true, allowFailure: true });
  if (mergeResult.code !== 0 && mergeResult.code !== 1) {
    console.error(`git merge-tree failed: ${mergeResult.stderr}`);
    process.exit(1);
  }

  const conflictedFiles = parseConflictedFiles(mergeResult.stdout);

  if (mergeResult.code === 0 && conflictedFiles.length === 0) {
    console.log('RESULT=clean');
    console.log('No conflicts: upstream main merges cleanly into local HEAD.');
    process.exit(0);
  }

  if (mergeResult.code !== 1 || conflictedFiles.length === 0) {
    console.error('git merge-tree returned an inconsistent result; refusing to report a clean merge.');
    process.exit(1);
  }

  console.log(`RESULT=conflicts (${conflictedFiles.length} file(s))`);
  console.log('\n=== CONFLICTED FILES ===');
  for (const file of conflictedFiles) console.log(`  - ${file}`);

  const conflictedUpstreamFiles = conflictedFiles.filter(isUpstreamPath);
  if (conflictedUpstreamFiles.length > 0) {
    console.log('\nUpstream-owned files affected:');
    for (const file of conflictedUpstreamFiles) console.log(`  - ${file}`);
    printPatchSkeleton(conflictedUpstreamFiles);
  } else {
    console.log('\nNo conflicts hit upstream-owned files (index.html, assets/**, character/**, novel/**).');
  }

  process.exit(2);
}

main().catch(error => {
  console.error(`preview-merge failed: ${error.message}`);
  process.exit(1);
});
