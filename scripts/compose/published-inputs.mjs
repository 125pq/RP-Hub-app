import assert from 'node:assert/strict';
import { hash, readLocal } from './compose-lib.mjs';
import { repositoryRoot } from '../web/paths.mjs';

export async function assertCurrentInputs(receipt) {
  assert.deepEqual(receipt.upstream, JSON.parse(await readLocal(repositoryRoot, 'upstream.lock.json')), 'Upstream lock changed; rebuild composed dist');
  assert.equal(receipt.recipeSha256, hash(await readLocal(repositoryRoot, 'scripts/compose/recipe.json')), 'Recipe changed; rebuild composed dist');
  assert.equal(receipt.dependencyLockSha256, hash(await readLocal(repositoryRoot, 'package-lock.json')), 'Dependencies changed; rebuild composed dist');
  for (const { file, sha256 } of receipt.inputs) {
    assert.equal(hash(await readLocal(repositoryRoot, file)), sha256, `Composition input changed; rebuild: ${file}`);
  }
}
