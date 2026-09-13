import assert from 'node:assert/strict';
import { cp, readFile, writeFile, rename, mkdtemp, lstat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repositoryRoot } from '../web/paths.mjs';
import { filesIn, hash } from './compose-lib.mjs';
import { assertCurrentInputs } from './published-inputs.mjs';

// Windows can briefly deny a directory rename while an indexer, antivirus or
// Explorer holds a handle. Retry only those transient sharing violations with
// a short backoff; every other error (and exhaustion) propagates so the
// existing rollback still restores the previous dist.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
async function renameWithRetry(source, destination, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rename(source, destination);
    } catch (error) {
      if (attempt >= attempts || !TRANSIENT_RENAME_CODES.has(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * attempt));
    }
  }
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--run-dir') throw new Error('Expected --run-dir <verified candidate>');
const run = path.resolve(args[1]);
assert.equal(path.relative(await realpath(repositoryRoot), await realpath(path.join(repositoryRoot, '.work/compose'))),
  path.join('.work', 'compose'), 'Composition workspace must not be redirected');
const checked = spawnSync(process.execPath, ['scripts/compose/check-candidate.mjs', '--run-dir', run], {
  cwd: repositoryRoot, stdio: 'inherit', timeout: 180000,
});
if (checked.error) throw checked.error;
assert.equal(checked.status, 0, 'Candidate behavior gate failed; dist was not touched');
const build = JSON.parse(await readFile(path.join(run, 'report.json')));
const expected = build.comparison.map(({ file, sha256 }) => ({ file, sha256 }));
assert.equal(hash(JSON.stringify(expected)), build.outputSha256);
const stage = await mkdtemp(path.join(run, 'publish-'));
const incoming = path.join(stage, 'incoming');
const previous = path.join(stage, 'previous-dist');
const output = path.join(repositoryRoot, 'dist');
await cp(path.join(run, 'dist'), incoming, { recursive: true });
const actual = [];
for (const file of await filesIn(incoming)) actual.push({ file, sha256: hash(await readFile(path.join(incoming, file))) });
assert.deepEqual(actual, expected, 'Candidate changed while preparing publication');
const receipt = {
  schema: 1, upstream: build.upstream, outputSha256: build.outputSha256,
  recipeSha256: build.recipeSha256, dependencyLockSha256: build.dependencyLockSha256,
  inputs: [...build.buildInputs, ...build.files.filter(entry => entry.kind === 'local-extension')
    .map(({ file, sourceSha256 }) => ({ file, sha256: sourceSha256 }))],
  files: expected, behaviorReport: JSON.parse(await readFile(path.join(run, 'behavior-report.json'))),
};
assert.equal(receipt.behaviorReport.outputSha256, build.outputSha256);
assert.equal(receipt.behaviorReport.status, 'passed');
await assertCurrentInputs(receipt);
const receiptSource = path.join(stage, 'receipt.json');
await writeFile(receiptSource, JSON.stringify(receipt, null, 2) + '\n');
let hadPrevious = false;
try {
  const info = await lstat(output);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'dist must be an ordinary directory');
  await filesIn(output); // Reject nested junctions/symlinks before moving it.
  hadPrevious = true;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
let movedPrevious = false, movedIncoming = false;
try {
  if (hadPrevious) { await renameWithRetry(output, previous); movedPrevious = true; }
  await renameWithRetry(incoming, output);
  movedIncoming = true;
  await renameWithRetry(receiptSource, path.join(repositoryRoot, '.work/compose/published.json'));
} catch (error) {
  if (movedIncoming) await renameWithRetry(output, incoming);
  if (movedPrevious) await renameWithRetry(previous, output);
  throw error;
}
// Keep the previous output in this disposable run for diagnosis/rollback.
console.log(`Composed dist published: ${output}`);
console.log(`Output SHA-256: ${build.outputSha256}`);
