// Official local Web build entry.
//
// Builds dist/ from the locked upstream input and the registered local
// extensions, runs the candidate behavior checks, then atomically promotes the
// verified output and writes the publication receipt. A failure at any step
// leaves the previous dist untouched; the promoted candidate is kept under
// .work/compose/run-* for diagnosis and rollback.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../web/paths.mjs';

function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, script), ...args], {
    cwd: repositoryRoot, stdio: 'inherit', timeout: 600000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${script} failed (exit ${result.status})`);
}

const work = path.join(repositoryRoot, '.work/compose');
await mkdir(work, { recursive: true });
const realWork = await realpath(work);
const realRepository = await realpath(repositoryRoot);
assert.equal(path.relative(realRepository, realWork), path.join('.work', 'compose'),
  'Composition workspace must not be redirected outside .work/compose');

run('scripts/compose/ensure-lock-tag.mjs', []);
const runDirectory = await mkdtemp(path.join(work, 'run-'));
run('scripts/compose/build-candidate.mjs', ['--official', '--run-dir', runDirectory]);
run('scripts/compose/publish-candidate.mjs', ['--run-dir', runDirectory]);
run('scripts/compose/verify-published.mjs', []);
console.log(`Official composition published to dist from ${runDirectory}`);
