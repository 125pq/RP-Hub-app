import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    const upstreamOwnedPath = join(fixtureRoot, 'assets', 'fixture.js');
    const original = '# Fixture\r\nVersion: old\r\nFooter\r\n';
    const upstreamOwnedOriginal = 'const value = 1;\r\nconst label = "ok";\r\n';
    await mkdir(join(fixtureRoot, 'assets'), { recursive: true });
    await writeFile(readmePath, original);
    await writeFile(upstreamOwnedPath, upstreamOwnedOriginal);

    git(fixtureRoot, 'init', '--initial-branch=main');
    git(fixtureRoot, 'config', 'core.autocrlf', 'false');
    git(fixtureRoot, 'config', 'user.name', 'EOL Guard Test');
    git(fixtureRoot, 'config', 'user.email', 'eol-guard@example.invalid');
    git(fixtureRoot, 'add', 'README.md', 'assets/fixture.js');
    git(fixtureRoot, 'commit', '-m', 'fixture baseline');

    await writeFile(readmePath, original.replace('Version: old', 'Version: new'));
    const anchorEdit = runGuard(guardPath, fixtureRoot);
    assert.equal(anchorEdit.status, 0, anchorEdit.stderr);
    assert.match(anchorEdit.stdout, /EOL churn guard: PASS/);

    await writeFile(readmePath, original.replaceAll('\r\n', '\n'));
    const nonOwnedEolRewrite = runGuard(guardPath, fixtureRoot);
    assert.equal(nonOwnedEolRewrite.status, 0, 'non-upstream README EOL rewrite must be ignored');
    assert.match(nonOwnedEolRewrite.stdout, /EOL churn guard: PASS/);

    await writeFile(readmePath, original);
    await writeFile(upstreamOwnedPath, upstreamOwnedOriginal.replaceAll('\r\n', '\n'));
    const upstreamEolRewrite = runGuard(guardPath, fixtureRoot);
    assert.equal(upstreamEolRewrite.status, 1, 'upstream-owned EOL rewrite must fail closed');
    assert.match(upstreamEolRewrite.stderr, /EOL\/whitespace churn detected/);

    await writeFile(upstreamOwnedPath, upstreamOwnedOriginal.replace('const value = 1;', 'const value = 1;   '));
    const upstreamTrailingWhitespace = runGuard(guardPath, fixtureRoot);
    assert.equal(upstreamTrailingWhitespace.status, 1, 'upstream-owned trailing whitespace churn must fail closed');
    assert.match(upstreamTrailingWhitespace.stderr, /EOL\/whitespace churn detected/);

    await writeFile(readmePath, original.replaceAll('\r\n', '\n'));
    const mixedRewrite = runGuard(guardPath, fixtureRoot);
    assert.equal(mixedRewrite.status, 1, 'mixed non-owned and upstream-owned churn must fail closed');
    assert.match(mixedRewrite.stderr, /EOL\/whitespace churn detected/);

    console.log('EOL churn pathscope behavior: PASS (upstream-owned EOL/trailing churn fails; non-owned and mixed cases are scoped correctly)');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
