import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectRoot } from '../lib.mjs';
import { releaseInputFiles, snapshotReleaseInputs, restoreReleaseInputs } from '../release-inputs.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'rphub-release-inputs-'));
try {
  for (const file of releaseInputFiles) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `original ${file}\n`);
  }
  const before = snapshotReleaseInputs(root);
  assert.equal(before.size, releaseInputFiles.length);

  // Simulate a sync binding a new release plus adding an input file.
  for (const file of releaseInputFiles) await writeFile(path.join(root, file), `new ${file}\n`);
  const added = path.join(root, 'upstream.lock.json.extra');
  await writeFile(added, 'scratch\n');

  restoreReleaseInputs(root, before);
  for (const file of releaseInputFiles) {
    assert.equal(await readFile(path.join(root, file), 'utf8'), `original ${file}\n`, `restore failed: ${file}`);
  }
  // Files not present at snapshot time are left alone; missing files are removed.
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), 'rphub-release-inputs-missing-'));
  try {
    const snapshot = snapshotReleaseInputs(missingRoot);
    for (const file of releaseInputFiles) {
      await mkdir(path.dirname(path.join(missingRoot, file)), { recursive: true });
      await writeFile(path.join(missingRoot, file), 'created\n');
    }
    restoreReleaseInputs(missingRoot, snapshot);
    for (const file of releaseInputFiles) {
      assert.equal(existsSync(path.join(missingRoot, file)), false, `absent-at-snapshot file must be removed: ${file}`);
    }
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }

  // The production sync must bind against the new upstream and restore on dry
  // run / failure rather than leaving a new lock with uncommitted metadata. The
  // default compose path delegates this to compose-sync; the explicit
  // legacy-merge path keeps validateReleaseInputs.
  const syncSource = await readFile(path.join(projectRoot, 'scripts/upstream-sync/sync-upstream.mjs'), 'utf8');
  assert.match(syncSource, /runComposeSync\(\{/);
  assert.match(syncSource, /validateReleaseInputs\(release, revision, \{ restoreOnSuccess: dryRun \}\)/);
  assert.match(syncSource, /snapshotReleaseInputs\(projectRoot\)/);
  assert.match(syncSource, /catch \(error\) \{\s*restoreReleaseInputs\(projectRoot, before\);\s*throw error;/);
  assert.doesNotMatch(syncSource, /if \(!dryRun\) await pinAndApplyRelease/);
  const composeSyncSource = await readFile(path.join(projectRoot, 'scripts/upstream-sync/compose-sync.mjs'), 'utf8');
  assert.match(composeSyncSource, /restoreReleaseInputs\(projectRoot, before\)/);
  assert.match(composeSyncSource, /if \(dryRun\) \{/);
  console.log('Release input binding: snapshot/restore and dry-run validation wiring PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
