// Offline contract for the compose-based sync core. Injected git/run/pin keep
// the bind/verify/rollback path exercised without a network remote, a real
// clone, or the Android toolchain.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runComposeSync } from '../compose-sync.mjs';
import { releaseInputFiles } from '../release-inputs.mjs';

const release = {
  tagName: '1.9.4',
  commitSha: 'd312bd4b2798dad3f30307afdbd704aac1f80f1a',
};

async function seedInputs(root) {
  for (const file of releaseInputFiles) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `original ${file}\n`);
  }
}

async function assertRestored(root) {
  for (const file of releaseInputFiles) {
    assert.equal(await readFile(path.join(root, file), 'utf8'), `original ${file}\n`, `not restored: ${file}`);
  }
}

// Happy path: fetch tag -> pin -> prepare -> compose, keeping the bound inputs.
{
  const root = await mkdtemp(path.join(os.tmpdir(), 'rphub-compose-sync-ok-'));
  try {
    await seedInputs(root);
    const calls = [];
    const git = async args => { calls.push(['git', ...args]); };
    const run = async (command, args) => { calls.push(['run', command, ...args]); };
    const pin = (pinRoot, tag, commit) => {
      calls.push(['pin', tag, commit]);
      assert.equal(pinRoot, root);
      return { tag, commit };
    };
    const result = await runComposeSync({ projectRoot: root, release, revision: 3, git, run, pin });
    assert.deepEqual(result, { dryRun: false, restored: false });
    assert.deepEqual(calls[0], ['git', 'fetch', 'upstream', 'refs/tags/1.9.4:refs/tags/1.9.4']);
    assert.deepEqual(calls[1], ['pin', '1.9.4', release.commitSha]);
    assert.ok(calls.some(call => call[0] === 'run' && call.join(' ').includes('prepare-android-release.mjs 1.9.4 3')));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    assert.ok(calls.some(call => call.join(' ') === `run ${npm} run build:web`));
    assert.ok(calls.some(call => call.join(' ') === `run ${npm} run verify:dist`));
    assert.deepEqual(calls.filter(call => call[0] === 'run' && call[1] === npm).map(call => call[3]),
      ['test:upstream-sync', 'test:platform', 'test:performance', 'build:web', 'verify:dist']);
    // The real production code path never mutates these here, so they stay put.
    await assertRestored(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Dry run: everything runs, then the inputs are restored so the preview is
// read-only and the next real run starts from the prior state.
{
  const root = await mkdtemp(path.join(os.tmpdir(), 'rphub-compose-sync-dry-'));
  try {
    await seedInputs(root);
    const prepare = async () => writeFile(path.join(root, 'upstream.lock.json'), 'preview lock\n');
    const compose = async () => writeFile(path.join(root, 'package.json'), 'preview version\n');
    const result = await runComposeSync({
      projectRoot: root, release, revision: 1, git: async () => {}, run: async () => {},
      pin: () => {}, prepare, compose, dryRun: true,
    });
    assert.deepEqual(result, { dryRun: true, restored: true });
    await assertRestored(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A failure at any step rolls the bound inputs back and re-throws, so a new
// lock is never left with a half-applied version.
for (const failing of ['prepare', 'compose']) {
  const root = await mkdtemp(path.join(os.tmpdir(), `rphub-compose-sync-${failing}-`));
  try {
    await seedInputs(root);
    const bound = () => writeFile(path.join(root, 'upstream.lock.json'), 'bound lock\n');
    const prepare = async () => { await bound(); if (failing === 'prepare') throw new Error('prepare failed'); };
    const compose = async () => { await writeFile(path.join(root, 'package.json'), 'new version\n'); if (failing === 'compose') throw new Error('compose failed'); };
    await assert.rejects(
      () => runComposeSync({ projectRoot: root, release, revision: 2, git: async () => {}, run: async () => {}, pin: () => {}, prepare, compose }),
      /failed/
    );
    await assertRestored(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// The default compose step must resolve the npm shim on Windows, or spawn fails
// with ENOENT. Exercise the real default applyCompose with a spy run.
{
  const root = await mkdtemp(path.join(os.tmpdir(), 'rphub-compose-sync-npm-'));
  try {
    await seedInputs(root);
    const commands = [];
    const run = async (command, args) => { commands.push([command, ...args]); };
    await runComposeSync({ projectRoot: root, release, revision: 0, git: async () => {}, run, pin: () => {} });
    const expectedNpm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    assert.ok(commands.some(call => call.join(' ') === `${expectedNpm} run build:web`),
      `build:web must use the platform npm (${expectedNpm}): ${JSON.stringify(commands)}`);
    assert.ok(commands.some(call => call.join(' ') === `${expectedNpm} run verify:dist`),
      `verify:dist must use the platform npm (${expectedNpm}): ${JSON.stringify(commands)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log('Compose sync core: fetch/pin/prepare/compose ordering, dry-run restore, failure rollback and platform npm resolution PASS');
