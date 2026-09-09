import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../lib.mjs';
import { runEolChurnGuardBehaviorTests } from './eol-churn-guard-behavior.mjs';

// Guards against EOL/whitespace churn in upstream-owned files: a patch that
// rewrites line endings (or trailing whitespace) inflates `git diff --stat`
// without changing the real content. `--ignore-space-at-eol` folds those lines
// away, so the two numstat totals diverge. Keep generated metadata, scripts,
// and docs out of this guard; their own tests use their own EOL contracts.

const guardRoot = process.env.RPHUB_EOL_CHURN_PROJECT_ROOT || projectRoot;
const upstreamOwnedPathspec = ['index.html', 'assets/**', 'character/**', 'novel/**'];

function numstatTotals(args) {
  const out = execFileSync('git', ['diff', '--numstat', ...args, '--', ...upstreamOwnedPathspec], {
    cwd: guardRoot,
    encoding: 'utf8'
  });
  let added = 0;
  let deleted = 0;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [a, d] = line.split('\t');
    // Binary files report "-" for both counts; skip them (they are not text EOL churn).
    if (a === '-' || d === '-') continue;
    added += Number(a);
    deleted += Number(d);
  }
  return { added, deleted };
}

const plain = numstatTotals([]);
const ignored = numstatTotals(['--ignore-space-at-eol']);

assert.deepEqual(
  ignored,
  plain,
  `EOL/whitespace churn detected: plain diff ${plain.added}+/${plain.deleted}- vs ` +
    `ignore-space-at-eol ${ignored.added}+/${ignored.deleted}-. ` +
    'A change rewrote line endings or trailing whitespace; redo it with an EOL-preserving edit.'
);

console.log('EOL churn guard: PASS');

if (!process.env.RPHUB_EOL_CHURN_SKIP_BEHAVIOR_TESTS) {
  await runEolChurnGuardBehaviorTests(fileURLToPath(import.meta.url));
}
