import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the committed baseline against EOL/whitespace churn that was already
// staged and therefore invisible to eol-churn-guard.mjs. It compares the
// working tree (staged and unstaged) against the nearest available upstream
// reference: `git diff --numstat` counts line-ending-only changes while
// `--ignore-space-at-eol` folds them away, so the per-file delta is the pure
// EOL/trailing-whitespace noise that would make future upstream merges
// conflict for no reason.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Existing P0-1 follow-up noise, measured from upstream/main..HEAD. These files
// still need cleanup; this guard pins today's exact amount and fails as soon as
// any file moves away from it or any unlisted file appears.
const EOL_NOISE_ALLOWANCE = {
  // P0-1 follow-up: local data-services.js still carries legacy EOL churn.
  'assets/js/data-services.js': 512,
  // P0-1 follow-up: local core-utils.js still carries legacy EOL churn.
  'assets/js/core-utils.js': 80,
  // P0-1 follow-up: README.md still carries legacy EOL churn.
  'README.md': 58,
  // P0-1 follow-up: novel/index.html still carries legacy EOL churn.
  'novel/index.html': 24,
  // P0-1 follow-up: character/index.html still carries legacy EOL churn.
  'character/index.html': 14,
  // P0-1 follow-up: runtime-services.js still carries legacy EOL churn.
  'assets/js/runtime-services.js': 10,
  // P0-1 follow-up: index.html still carries legacy EOL churn.
  'index.html': 4,
  // P0-1 follow-up: ui-components.js still carries legacy EOL churn.
  'assets/js/ui-components.js': 4
};

function probeGit(args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
}

function resolveBaseline() {
  // During a real --no-commit upstream merge, HEAD is still the local parent.
  // Compare against the pending upstream parent so its own whitespace changes
  // are not mistaken for local EOL churn before the merge commit is created.
  try {
    const oid = probeGit(['rev-parse', '--verify', 'MERGE_HEAD^{commit}']);
    if (oid) return { ref: 'MERGE_HEAD', oid };
  } catch {
    // Not an in-progress merge; resolve the normal upstream baseline below.
  }

  for (const candidate of ['upstream/main', 'upstream/master', 'upstream/releases/latest']) {
    try {
      const oid = probeGit(['rev-parse', '--verify', `${candidate}^{commit}`]);
      if (oid) {
        try {
          const mergeBase = probeGit(['merge-base', oid, 'HEAD']);
          if (mergeBase) {
            return { ref: `${candidate} (merge-base ${mergeBase})`, oid: mergeBase };
          }
        } catch {
          // No common ancestor; fall back to the upstream ref itself.
        }
        return { ref: candidate, oid };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function numstatByFile(args) {
  const out = execFileSync('git', ['diff', '--numstat', '--no-renames', ...args], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  const result = new Map();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [addedText, deletedText, ...fileParts] = line.split('\t');
    // Binary files report "-" for both counts; skip them (they are not text EOL churn).
    if (addedText === '-' || deletedText === '-') continue;
    result.set(fileParts.join('\t'), {
      added: Number(addedText),
      deleted: Number(deletedText)
    });
  }
  return result;
}

const baseline = resolveBaseline();
if (!baseline) {
  if (process.env.CI) {
    throw new Error(
      'EOL baseline guard: no upstream ref found in CI; run `git fetch upstream` before this test'
    );
  }
  console.log('EOL baseline guard: SKIP (no upstream ref found; run `git fetch upstream` first)');
  process.exit(0);
}

const plain = numstatByFile([baseline.oid]);
const ignored = numstatByFile(['--ignore-space-at-eol', baseline.oid]);

const violations = [];
for (const [file, p] of plain) {
  const i = ignored.get(file) ?? { added: 0, deleted: 0 };
  const noise = p.added + p.deleted - i.added - i.deleted;
  const allowed = EOL_NOISE_ALLOWANCE[file] ?? 0;
  if (noise !== allowed) {
    violations.push(`${file}: ${noise} EOL/whitespace noise lines, expected ${allowed}`);
  }
}

assert.deepEqual(
  violations,
  [],
  `EOL/whitespace baseline churn detected vs ${baseline.ref}:\n${violations.join('\n')}`
);

console.log(`EOL baseline guard: PASS (baseline ${baseline.oid})`);
