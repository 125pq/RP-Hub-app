import { readFile, mkdir, mkdtemp, realpath, writeFile, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repositoryRoot, publishRoots } from '../web/paths.mjs';
import {
  hash, git, filesIn, write, safeRelative, transform, transformedFiles,
  classifyUpstream, assertLegacy, compareBytes, readLocal,
} from './compose-lib.mjs';

const args = process.argv.slice(2);
const independent = args.length === 1 && args[0] === '--independent';
if (args.length && !independent) throw new Error('Only --independent is supported; edit the reviewed lock/recipe to change inputs');
const lockBytes = await readFile(path.join(repositoryRoot, 'upstream.lock.json'));
const recipeBytes = await readFile(path.join(repositoryRoot, 'scripts/compose/recipe.json'));
const lock = JSON.parse(lockBytes);
const recipe = JSON.parse(recipeBytes);
if (independent && recipe.legacyOverrides.length) throw new Error('Independent builds cannot use full-file legacy overrides');
if (JSON.stringify(recipe.publishRoots) !== JSON.stringify(publishRoots)) {
  throw new Error('Recipe publish roots must match the shared web build policy');
}
if (lock.schemaVersion !== 1 || recipe.schemaVersion !== 1
  || lock.repository !== 'https://github.com/STA1N156/RP-Hub.git'
  || !/^[0-9a-f]{40}$/.test(lock.commit) || !/^\d+\.\d+\.\d+$/.test(lock.tag)) {
  throw new Error('Unsupported upstream lock or composition recipe');
}
const resolved = git(repositoryRoot, ['rev-parse', `${lock.tag}^{commit}`]).toString().trim();
if (resolved !== lock.commit) throw new Error('Locked tag does not resolve to the pinned upstream commit');

// Each run gets fresh directories. Never delete/promote dist, nor replace an earlier candidate.
const workParent = path.join(repositoryRoot, '.work/compose');
await mkdir(workParent, { recursive: true });
const realParent = await realpath(workParent);
const realRepository = await realpath(repositoryRoot);
if (path.relative(realRepository, realParent) !== path.join('.work', 'compose')) {
  throw new Error('Composition workspace must not be redirected outside .work/compose');
}
const run = await mkdtemp(path.join(workParent, 'run-'));
const pristine = path.join(run, 'upstream');
const source = path.join(run, 'source');
const output = path.join(run, 'dist');
const report = {
  status: 'building', buildMode: independent ? 'independent' : 'checkout-comparison',
  upstream: lock, recipeSha256: hash(recipeBytes), lockSha256: hash(lockBytes),
  extensionCommit: git(repositoryRoot, ['rev-parse', 'HEAD']).toString().trim(),
  workingTreeStatus: git(repositoryRoot, ['status', '--porcelain']).toString(),
  dependencyLockSha256: hash(await readFile(path.join(repositoryRoot, 'package-lock.json'))),
  files: [], buildInputs: [], comparison: [],
  limitations: ['Parallel candidate only; official sync/build unchanged.',
    'Registered adaptations still require compatibility checks for new upstream versions.',
    'Byte comparison is not device or runtime behavior validation.'],
};

function runWeb(script, args) {
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'scripts/web', script), ...args], {
    cwd: repositoryRoot, encoding: 'utf8', stdio: 'pipe',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed (exit ${result.status})`);
}

try {
  const tree = git(repositoryRoot, ['ls-tree', '-rz', lock.commit]).toString().split('\0').filter(Boolean);
  const upstream = new Map();
  for (const row of tree) {
    const match = row.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/s);
    if (!match) throw new Error(`Unsupported upstream tree entry: ${row}`);
    const [, , oid, file] = match;
    classifyUpstream(file, recipe); // New top-level paths cannot silently disappear.
    const bytes = git(repositoryRoot, ['cat-file', 'blob', oid]);
    upstream.set(file, bytes);
    await write(pristine, file, bytes);
  }
  for (const file of transformedFiles) {
    if (!upstream.has(file)) throw new Error(`Required transform input missing: ${file}`);
  }
  const legacy = new Map(recipe.legacyOverrides.map(entry => [safeRelative(entry.file), entry]));
  if (legacy.size !== recipe.legacyOverrides.length || new Set(recipe.localFiles).size !== recipe.localFiles.length) {
    throw new Error('Duplicate recipe entries');
  }
  for (const file of legacy.keys()) {
    if (!upstream.has(file) || transformedFiles.includes(file)) throw new Error(`Invalid legacy override: ${file}`);
  }
  for (const [file, bytes] of upstream) {
    if (classifyUpstream(file, recipe) === 'excluded') {
      report.files.push({ file, kind: 'excluded', upstreamSha256: hash(bytes) });
      continue;
    }
    let result;
    let kind;
    if (legacy.has(file)) {
      result = await readLocal(repositoryRoot, file);
      assertLegacy(legacy.get(file), bytes, result);
      kind = 'legacy-override';
    } else {
      result = transform(file, bytes);
      kind = transformedFiles.includes(file) ? 'overlay' : 'upstream';
      if (!transform(file, result).equals(result)) throw new Error(`Non-idempotent transform: ${file}`);
    }
    // Full comparison catches local changes absent from the composition recipe.
    const comparison = independent ? 'not-compared' : compareBytes(file, result,
      await readLocal(repositoryRoot, file), recipe.allowedBaselineEolDifferences);
    await write(source, file, result);
    report.files.push({ file, kind, upstreamSha256: hash(bytes), sourceSha256: hash(result), comparison });
  }
  for (const file of recipe.localFiles) {
    if (upstream.has(file)) throw new Error(`Local extension collides with upstream: ${file}`);
    if (classifyUpstream(file, recipe) !== 'publish') throw new Error(`Non-published local file: ${file}`);
    const bytes = await readLocal(repositoryRoot, file);
    await write(source, file, bytes);
    report.files.push({ file, kind: 'local-extension', sourceSha256: hash(bytes) });
  }
  // No unregistered local asset additions, even if the existing dist is stale.
  for (const root of independent ? [] : recipe.publishRoots) {
    const info = await lstat(path.join(repositoryRoot, root));
    if (info.isSymbolicLink()) throw new Error(`Publish root must not be a symlink: ${root}`);
    const actual = info.isDirectory() ? (await filesIn(path.join(repositoryRoot, root))).map(file => `${root}/${file}`) : [root];
    for (const file of actual) {
      if (file.startsWith('assets/generated/') || file.startsWith('assets/vendor/')) continue;
      if (!report.files.some(entry => entry.file === file && entry.kind !== 'excluded')) {
        throw new Error(`Unregistered local publish input: ${file}`);
      }
    }
  }
  for (const directory of ['scripts/web', 'scripts/compose', 'scripts/upstream-sync']) {
    for (const relative of await filesIn(path.join(repositoryRoot, directory))) {
      if (!/\.(mjs|json)$/.test(relative)) continue;
      const file = `${directory}/${relative}`;
      report.buildInputs.push({ file, sha256: hash(await readLocal(repositoryRoot, file)) });
    }
  }
  for (const file of ['tailwind.main.config.cjs', 'tailwind.character.config.cjs', 'tailwind.novel.config.cjs']) {
    report.buildInputs.push({ file, sha256: hash(await readLocal(repositoryRoot, file)) });
  }
  runWeb('prepare-vendor.mjs', ['--source-root', source]);
  runWeb('build-css.mjs', ['--source-root', source]);
  runWeb('build-web.mjs', ['--source-root', source, '--output-dir', output]);
  runWeb('verify-dist.mjs', ['--source-root', source, '--output-dir', output]);

  const baseline = path.join(repositoryRoot, 'dist');
  const candidateFiles = await filesIn(output);
  const baselineFiles = independent ? null : await filesIn(baseline);
  if (!independent && JSON.stringify(candidateFiles) !== JSON.stringify(baselineFiles)) {
    throw new Error('Candidate and baseline file lists differ; rebuild the baseline with npm run build:web and review new resources');
  }
  for (const file of candidateFiles) {
    const bytes = await readFile(path.join(output, file));
    const reference = independent ? null : await readFile(path.join(baseline, file));
    const comparison = independent ? 'not-compared' : compareBytes(file, bytes, reference, recipe.allowedBaselineEolDifferences);
    report.comparison.push({ file, result: comparison, sha256: hash(bytes), baselineSha256: reference === null ? null : hash(reference) });
  }
  for (const [file, bytes] of upstream) {
    if (!(await readFile(path.join(pristine, file))).equals(bytes)) throw new Error(`Pristine input modified: ${file}`);
  }
  report.outputSha256 = hash(JSON.stringify(report.comparison.map(({ file, sha256 }) => ({ file, sha256 }))));
  report.status = 'verified-candidate';
  console.log(`Candidate verified: ${output}`);
  console.log(`Output SHA-256: ${report.outputSha256}`);
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  throw error;
} finally {
  await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Composition report: ${path.join(run, 'report.json')}`);
}
