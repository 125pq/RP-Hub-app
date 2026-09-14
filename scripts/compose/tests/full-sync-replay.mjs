// Fast guard for the isolated full-sync replay harness: argument validation and
// workspace containment, without running a real compose build. The full run is
// exercised by `npm run verify:full-sync`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../../web/paths.mjs';

const harness = await readFile(path.join(repositoryRoot, 'scripts/compose/full-sync-replay.mjs'), 'utf8');
const cli = await readFile(path.join(repositoryRoot, 'scripts/compose/verify-full-sync.mjs'), 'utf8');

// Non-release tags are rejected before any clone/build.
const { runFullSyncReplay, runReplayGit } = await import('../../compose/full-sync-replay.mjs');
await assert.rejects(runFullSyncReplay({ tag: 'main' }), /stable release tag/);
await assert.rejects(runFullSyncReplay({ tag: 'v1.9.4-rc1' }), /stable release tag/);

// The harness must keep the work inside .work/compose and prove source
// preservation; it must not fall back to the legacy merge path.
assert.match(harness, /\.work['"], ['"]compose['"], ['"]full-sync/);
assert.match(harness, /runComposeSync/);
assert.match(harness, /sourceLockUnchanged/);
assert.match(harness, /sourceDistUnchanged/);
assert.match(harness, /dryRun: true/);
assert.match(harness, /injected compose failure/);
assert.doesNotMatch(harness, /mergeWithAutoResolver|reapplyHooks/);

// The CLI requires --tag and writes a report; no silent default target.
assert.match(cli, /Expected --tag/);
assert.match(cli, /full-sync-report\.json/);
console.log('Full-sync replay guard: argument validation, workspace containment and source-preservation wiring PASS');

// Failed Git commands must stop replay; only explicit probes may return a failure.
await assert.rejects(runReplayGit(repositoryRoot, ['rev-parse', '--verify', 'refs/heads/rphub-missing-replay-fixture']), /failed/);
const absent = await runReplayGit(repositoryRoot, ['rev-parse', '--verify', 'refs/heads/rphub-missing-replay-fixture'], { allowFailure: true });
assert.notEqual(absent.code, 0);
console.log('Replay Git failure propagation: PASS');
