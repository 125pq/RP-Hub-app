import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_FILES, projectRoot } from '../lib.mjs';

// Guards against whole-file EOL/whitespace churn: a patch that rewrites line
// endings (or trailing whitespace) inflates `git diff --stat` without changing
// the real content. `--ignore-space-at-eol` folds those lines away, so the two
// numstat totals diverge. This test fails loudly when that happens, instead of
// letting a 2-line logic change silently balloon into hundreds of diff lines.
//
// Locally-maintained files (see LOCAL_FILES in lib.mjs) are skipped entirely:
// their EOL is ours to manage and never conflicts with an upstream merge.

function numstatTotals(args) {
  const out = execFileSync('git', ['diff', '--numstat', ...args], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  let added = 0;
  let deleted = 0;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...fileParts] = line.split('\t');
    // Binary files report "-" for both counts; skip them (they are not text EOL churn).
    if (a === '-' || d === '-') continue;
    // Locally-maintained files are exempt from the EOL churn guard.
    if (LOCAL_FILES.has(fileParts.join('\t'))) continue;
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
