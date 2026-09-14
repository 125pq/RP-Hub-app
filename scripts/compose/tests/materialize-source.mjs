// The retained root files prove the 1.9.3 migration only. New locked versions
// may differ from that frozen baseline; their cache must match fresh composition.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../../web/paths.mjs';
import { filesIn } from '../compose-lib.mjs';
import { materializeComposedSource, composedSourceRoot } from '../materialize-source.mjs';

const recipe = JSON.parse(await readFile(path.join(repositoryRoot, 'scripts/compose/recipe.json'), 'utf8'));
const allowedEol = new Set(recipe.allowedBaselineEolDifferences);
const work = path.join(repositoryRoot, '.work/compose');
await mkdir(work, { recursive: true });
const lock = JSON.parse(await readFile(path.join(repositoryRoot, 'upstream.lock.json'), 'utf8'));
const migrationBaseline = lock.commit === '4aef0bb46c9b3370faba174a20435e5989799727';
const scratch = await mkdtemp(path.join(work, 'materialize-test-'));

try {
  materializeComposedSource({ output: scratch });
  const files = await filesIn(scratch);
  assert.ok(files.length > 0, 'composed source must not be empty');

  // Root files are a frozen 1.9.3 migration baseline, not the current upstream.
  if (migrationBaseline) {
    let exact = 0;
    let eolOnly = 0;
    for (const file of files) {
      const composed = await readFile(path.join(scratch, file));
      let rootBytes;
      try {
        rootBytes = await readFile(path.join(repositoryRoot, file));
      } catch (error) {
        if (error.code === 'ENOENT') continue; // local-only file not committed at root
        throw error;
      }
      if (composed.equals(rootBytes)) { exact += 1; continue; }
      const composedLf = composed.toString('utf8').replace(/\r\n/g, '\n');
      const rootLf = rootBytes.toString('utf8').replace(/\r\n/g, '\n');
      assert.equal(composedLf, rootLf, `composed source differs from root: ${file}`);
      assert.ok(allowedEol.has(file), `unregistered EOL-only difference: ${file}`);
      eolOnly += 1;
    }
    assert.ok(exact > 0, 'expected exact matches between composed source and root');
    console.log(`Composed source vs root: PASS (${exact} exact, ${eolOnly} EOL-only)`);

  }

  // The cached composed source is content-addressed by lock + recipe and is
  // stable across calls for a given input.
  const cached = composedSourceRoot({ root: repositoryRoot });
  const cachedFiles = (await filesIn(cached)).filter(file => file !== '.complete');
  assert.deepEqual(cachedFiles, files, 'cache must contain exactly the materialized files');
  for (const file of files) {
    assert.deepEqual(await readFile(path.join(cached, file)), await readFile(path.join(scratch, file)),
      `cached source differs from fresh materialization: ${file}`);
  }
  const cachedAgain = composedSourceRoot({ root: repositoryRoot });
  assert.equal(cached, cachedAgain, 'composed source root must be stable for a given lock + recipe');
  console.log(`Composed source cache: PASS (${path.relative(repositoryRoot, cached)})`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
