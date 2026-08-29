import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: options.env || process.env
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const git = (cwd, ...args) => run('git', args, cwd);

function runGuard(guardPath, fixtureRoot) {
  return run(process.execPath, [guardPath], fixtureRoot, {
    allowFailure: true,
    env: {
      ...process.env,
      RPHUB_EOL_CHURN_PROJECT_ROOT: fixtureRoot,
      RPHUB_EOL_CHURN_SKIP_BEHAVIOR_TESTS: '1'
    }
  });
}

export async function runEolChurnGuardBehaviorTests(guardPath) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rphub-eol-churn-'));
  try {
    const readmePath = join(fixtureRoot, 'README.md');
    const original = '# Fixture\r\nVersion: old\r\nFooter\r\n';
    await writeFile(readmePath, original);

    git(fixtureRoot, 'init', '--initial-branch=main');
    git(fixtureRoot, 'config', 'core.autocrlf', 'false');
    git(fixtureRoot, 'config', 'user.name', 'EOL Guard Test');
    git(fixtureRoot, 'config', 'user.email', 'eol-guard@example.invalid');
    git(fixtureRoot, 'add', 'README.md');
    git(fixtureRoot, 'commit', '-m', 'fixture baseline');

    await writeFile(readmePath, original.replace('Version: old', 'Version: new'));
    const anchorEdit = runGuard(guardPath, fixtureRoot);
    assert.equal(anchorEdit.status, 0, anchorEdit.stderr);
    assert.match(anchorEdit.stdout, /EOL churn guard: PASS/);

    await writeFile(readmePath, original.replaceAll('\r\n', '\n'));
    const eolRewrite = runGuard(guardPath, fixtureRoot);
    assert.equal(eolRewrite.status, 1, 'whole-file README EOL rewrite must fail closed');
    assert.match(eolRewrite.stderr, /EOL\/whitespace churn detected/);

    console.log('EOL churn README behavior: PASS (anchor edit accepted, whole-file EOL rewrite rejected)');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
