import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../web/paths.mjs';
import { filesIn, hash } from './compose-lib.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--run-dir') throw new Error('Expected --run-dir <candidate run directory>');
const work = await realpath(path.join(repositoryRoot, '.work/compose'));
const run = await realpath(path.resolve(args[1]));
const relative = path.relative(work, run);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Candidate must be inside .work/compose');
const dist = path.join(run, 'dist');
if ((await lstat(dist)).isSymbolicLink()) throw new Error('Candidate dist must not be a symlink/junction');
const tests = [
  'scripts/tests/test-app-filter-cache.mjs',
  'scripts/tests/test-app-module-hooks.mjs',
  'scripts/tests/test-app-file-export.mjs',
  'scripts/tests/test-chat-export-streaming.mjs',
  'scripts/tests/test-app-navigation.mjs',
  'scripts/tests/test-rphub-io.mjs',
  'scripts/tests/test-platform-services.mjs',
  'scripts/tests/test-save-generated-file.mjs',
  'scripts/tests/test-chat-import-streaming.mjs',
  'scripts/upstream-sync/tests/backup-roundtrip.mjs',
];
const result = {
  schema: 1, status: 'failed', outputSha256: null, tests: [],
  limitations: 'Node/VM behavior checks with simulated platform services; not browser mount or Android device acceptance.',
};
async function snapshot() {
  const entries = [];
  for (const file of await filesIn(dist)) entries.push({ file, sha256: hash(await readFile(path.join(dist, file))) });
  return entries;
}
try {
  const build = JSON.parse(await readFile(path.join(run, 'report.json'), 'utf8'));
  assert.equal(build.status, 'verified-candidate', 'Build must be verified first');
  const expected = build.comparison.map(({ file, sha256 }) => ({ file, sha256 }));
  assert.equal(hash(JSON.stringify(expected)), build.outputSha256, 'Invalid build output hash');
  assert.deepEqual(await snapshot(), expected, 'Candidate artifact differs from build report');
  result.outputSha256 = build.outputSha256;
  result.fixtureSha256 = hash(await readFile(path.join(repositoryRoot, 'scripts/tests/web-fixture.mjs')));
  result.recoveryFixtureSha256 = hash(await readFile(path.join(repositoryRoot, 'scripts/tests/recovery-fixture.mjs')));
  result.runnerSha256 = hash(await readFile(new URL(import.meta.url)));
  for (const file of tests) {
    const test = { file, sha256: hash(await readFile(path.join(repositoryRoot, file))) };
    const child = spawnSync(process.execPath, [path.join(repositoryRoot, file)], {
      cwd: repositoryRoot, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, RPHUB_TEST_WEB_ROOT: dist },
    });
    test.status = child.status === 0 && !child.error ? 'passed' : 'failed';
    result.tests.push(test);
    if (test.status !== 'passed') throw new Error(`${file}: ${child.error || ''}\n${child.stdout}\n${child.stderr}`);
    console.log(`Candidate PASS: ${file}`);
  }
  assert.deepEqual(await snapshot(), expected, 'Behavior tests changed candidate artifacts');
  result.status = 'passed';
} catch (error) {
  result.error = String(error.stack || error);
  process.exitCode = 1;
  console.error(result.error);
} finally {
  await writeFile(path.join(run, 'behavior-report.json'), JSON.stringify(result, null, 2) + '\n');
}
