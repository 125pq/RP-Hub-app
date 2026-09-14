// Materialize the composed upstream source from the locked commit.
//
// Phase 6 makes the lock the single source of truth; the root working-tree
// upstream files are retired in phase 7. Consumers that used to read those root
// files (verification, behavior fixtures) read this composed source instead, so
// they track the lock rather than a directory a sync no longer rewrites.
//
// This is the same input set build-candidate composes: every upstream publish
// file run through the registered transforms, plus the registered local files.
// It deliberately stops before vendor preparation, CSS generation and the web
// build, so it is cheap and side-effect free outside the target directory.
//
// Synchronous on purpose: scripts/tests/web-fixture.mjs is imported
// synchronously by every behavior test and resolves paths at import time.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, existsSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from '../web/paths.mjs';
import { transform, classifyUpstream, safeRelative } from './compose-lib.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}

// Read only regular files, including every parent, to keep local inputs in the
// repository. Mirrors compose-lib.readLocal for the synchronous path.
function readLocalSync(root, file) {
  safeRelative(file);
  let current = root;
  const parts = file.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Local input must be a regular repository file: ${file}`);
    }
  }
  return readFileSync(current);
}

export function materializeComposedSource({ root = repositoryRoot, output } = {}) {
  if (!output) throw new Error('materializeComposedSource requires an output directory');
  const lock = JSON.parse(readFileSync(path.join(root, 'upstream.lock.json'), 'utf8'));
  const recipe = JSON.parse(readFileSync(path.join(root, 'scripts/compose/recipe.json'), 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(lock.commit)) throw new Error('Locked upstream commit must be a full Git commit id');

  const tree = git(root, ['ls-tree', '-rz', lock.commit]).toString().split('\0').filter(Boolean);
  for (const row of tree) {
    const match = row.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/s);
    if (!match) throw new Error(`Unsupported upstream tree entry: ${row}`);
    const [, , oid, file] = match;
    safeRelative(file);
    if (classifyUpstream(file, recipe) === 'excluded') continue;
    const target = path.join(output, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, transform(file, git(root, ['cat-file', 'blob', oid])));
  }
  for (const file of recipe.localFiles) {
    const target = path.join(output, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readLocalSync(root, file));
  }
  return { lock, recipe };
}

// Cached, content-addressed composed source under .work/compose/source/<key>.
// Keyed by the lock bytes plus the recipe bytes, so a changed lock or recipe
// rebuilds while repeat reads within one process tree are cheap. This is the
// default source root for consumers that must track the lock instead of the
// root working tree.
// The composed bytes depend on the lock + recipe AND on the transform code
// itself. Hash the transform/build modules too, so editing a patch invalidates
// the cache instead of silently serving stale transformed output locally.
function transformFingerprint(root) {
  const hash = createHash('sha256');
  const roots = ['scripts/compose', 'scripts/upstream-sync/patches'];
  const files = [];
  const collect = relative => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) collect(next);
      else if (/\.(?:mjs|json)$/.test(entry.name)) files.push(next);
    }
  };
  for (const relative of roots) collect(relative);
  // overlay-transformers + lib + app-transform live outside the two roots.
  for (const extra of [
    'scripts/upstream-sync/overlay-transformers.mjs',
    'scripts/upstream-sync/lib.mjs',
    'scripts/compose/app-transform.mjs',
  ]) files.push(extra);
  files.sort();
  for (const file of files) hash.update(file).update('\0').update(readFileSync(path.join(root, file)));
  return hash.digest('hex');
}

export function composedSourceRoot({ root = repositoryRoot, workParent = null } = {}) {
  const lockBytes = readFileSync(path.join(root, 'upstream.lock.json'));
  const recipeBytes = readFileSync(path.join(root, 'scripts/compose/recipe.json'));
  const recipe = JSON.parse(recipeBytes);
  // Local extensions are copied verbatim at materialization time, so their
  // bytes are part of the output and must be part of the key.
  const localHash = createHash('sha256');
  for (const file of [...recipe.localFiles].sort()) {
    localHash.update(file).update('\0').update(readFileSync(path.join(root, file)));
  }
  const key = createHash('sha256')
    .update(lockBytes).update('\0').update(recipeBytes).update('\0').update(transformFingerprint(root))
    .update('\0').update(localHash.digest('hex'))
    .digest('hex').slice(0, 16);
  const parent = workParent || path.join(root, '.work', 'compose', 'source');
  const output = path.join(parent, key);
  const marker = path.join(output, '.complete');
  if (!existsSync(marker)) {
    rmSync(output, { recursive: true, force: true });
    materializeComposedSource({ root, output });
    writeFileSync(marker, `${key}\n`);
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  if (outputIndex === -1 || !args[outputIndex + 1]) throw new Error('Expected --output <directory>');
  const { lock } = materializeComposedSource({ output: path.resolve(args[outputIndex + 1]) });
  console.log(`Composed source materialized from ${lock.tag} ${lock.commit}`);
}
