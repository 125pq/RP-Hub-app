import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectRoot } from '../lib.mjs';
import { resolveAutoConflicts } from '../auto-resolver.mjs';
import { mergeWithAutoResolver } from '../sync-orchestration.mjs';
import { transformOverlayBlob, transformOverlayText } from '../overlay-transformers.mjs';
import { patchOfflineCharacter } from '../patches/patch-offline-assets.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
const gitText = (cwd, args) => git(cwd, args).toString('utf8').trim();
async function fixtureGit(cwd, args, options = {}) {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    return { code: 0, stdout: output, stderr: '' };
  } catch (error) {
    if (!options.allowFailure) throw error;
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString('utf8') || '',
      stderr: error.stderr?.toString('utf8') || ''
    };
  }
}

function fixtureLogger() {
  const output = [];
  return {
    output,
    log: (...args) => output.push(args.join(' ')),
    error: (...args) => output.push(args.join(' '))
  };
}
const repoBlob = (commit, relativePath) => git(projectRoot, ['cat-file', 'blob', `${commit}:${relativePath}`]);
const sourceText = (commit, relativePath) => repoBlob(commit, relativePath).toString('utf8');
const normalize = value => value.replace(/\r\n/g, '\n');

function assertBlobProof(relativePath) {
  const stage1 = sourceText('5739165', relativePath);
  const stage2 = sourceText('ddc8f75', relativePath);
  const stage3 = sourceText('bc2d201', relativePath);
  const expected = sourceText('b8c42ce', relativePath);
  assert.equal(normalize(transformOverlayBlob(relativePath, stage1)), normalize(stage2), `${relativePath} stage1 replay proof`);
  assert.equal(normalize(transformOverlayBlob(relativePath, stage3)), normalize(expected), `${relativePath} stage3 replay proof`);
  const once = transformOverlayText(relativePath, normalize(stage3));
  assert.equal(transformOverlayText(relativePath, once), once, `${relativePath} transformer must be idempotent`);

  const lf = normalize(stage3);
  const crlf = lf.replace(/\n/g, '\r\n');
  const mixed = lf.split('\n').map((line, index) => `${line}${index % 2 ? '\n' : '\r\n'}`).join('');
  for (const variant of [lf, crlf, mixed]) {
    assert.equal(normalize(transformOverlayBlob(relativePath, variant)), transformOverlayText(relativePath, normalize(variant)), `${relativePath} EOL variant semantic result`);
  }
}

async function createConflictFixture({ localFiles, upstreamFiles, baseFiles = localFiles, startMerge = true }) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'rphub-auto-resolver-'));
  const config = [['user.name', 'Resolver Test'], ['user.email', 'resolver@example.test']];
  git(fixture, ['init', '-q', '-b', 'main']);
  for (const [key, value] of config) git(fixture, ['config', key, value]);
  const initialFiles = Object.keys(baseFiles).length > 0 ? baseFiles : { '.fixture-base': '' };
  const writeFixtureFiles = async files => {
    for (const [relativePath, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(fixture, relativePath)), { recursive: true });
      await writeFile(path.join(fixture, relativePath), content);
    }
  };
  await writeFixtureFiles(initialFiles);
  git(fixture, ['add', '--', ...Object.keys(initialFiles)]);
  git(fixture, ['commit', '-qm', 'base']);
  git(fixture, ['checkout', '-qb', 'local']);
  await writeFixtureFiles(localFiles);
  git(fixture, ['add', '--', ...Object.keys(localFiles)]);
  git(fixture, ['commit', '-qm', 'local']);
  git(fixture, ['checkout', '-qb', 'upstream', 'main']);
  await writeFixtureFiles(upstreamFiles);
  git(fixture, ['add', '--', ...Object.keys(upstreamFiles)]);
  git(fixture, ['commit', '-qm', 'upstream']);
  git(fixture, ['checkout', '-q', 'local']);
  if (startMerge) {
    try {
      git(fixture, ['merge', '--no-ff', '--no-commit', 'upstream']);
    } catch {
      // Expected for conflict fixtures; stages are inspected by the resolver.
    }
  }
  return fixture;
}

async function createRenameConflictFixture({ startMerge = true } = {}) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'rphub-auto-resolver-rename-'));
  const baseText = `${Array.from({ length: 20 }, (_, index) => `line${index}`).join('\n')}\n`;
  git(fixture, ['init', '-q', '-b', 'main']);
  git(fixture, ['config', 'user.name', 'Resolver Test']);
  git(fixture, ['config', 'user.email', 'resolver@example.test']);
  await writeFile(path.join(fixture, 'index.html'), baseText);
  git(fixture, ['add', '--', 'index.html']);
  git(fixture, ['commit', '-qm', 'base']);
  git(fixture, ['checkout', '-qb', 'local']);
  git(fixture, ['mv', 'index.html', 'local-index.html']);
  await writeFile(path.join(fixture, 'local-index.html'), baseText.replace('line3', 'local3'));
  git(fixture, ['add', '--', 'local-index.html']);
  git(fixture, ['commit', '-qm', 'local rename']);
  git(fixture, ['checkout', '-qb', 'upstream', 'main']);
  git(fixture, ['mv', 'index.html', 'upstream-index.html']);
  await writeFile(path.join(fixture, 'upstream-index.html'), baseText.replace('line4', 'upstream4'));
  git(fixture, ['add', '--', 'upstream-index.html']);
  git(fixture, ['commit', '-qm', 'upstream rename']);
  git(fixture, ['checkout', '-q', 'local']);
  if (startMerge) {
    try {
      git(fixture, ['merge', '--no-ff', '--no-commit', 'upstream']);
    } catch {
      // Expected rename/rename conflict; orchestration must reject and abort.
    }
  }
  return fixture;
}

for (const relativePath of ['index.html', 'novel/index.html']) assertBlobProof(relativePath);

assert.throws(
  () => transformOverlayText('index.html', `${normalize(sourceText('bc2d201', 'index.html'))}\n<script src="https://unknown.example/runtime.js"></script>\n`),
  /Remote runtime dependency returned/,
  'unknown remote runtime must fail closed'
);
assert.throws(
  () => transformOverlayText('novel/index.html', normalize(sourceText('bc2d201', 'novel/index.html')).replace('class="fixed md:static inset-y-0 left-0', 'class="drifted-sidebar')),
  /novel sidebar/,
  'safe-area anchor drift must fail closed'
);
const localCharacter = normalize(sourceText('ddc8f75', 'character/index.html'));
assert.equal(patchOfflineCharacter(localCharacter), localCharacter, 'localized character assets remain idempotent');
for (const remote of [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/vue@3/dist/vue.global.prod.js',
  'https://cdn.jsdelivr.net/npm/daisyui@4.7.2/dist/full.min.css',
  'https://unknown.example/runtime.js'
]) {
  assert.throws(
    () => patchOfflineCharacter(`${localCharacter}\n<script src="${remote}"></script>\n`),
    /Remote runtime dependency returned/,
    `character remote runtime must fail closed: ${remote}`
  );
}
assert.throws(
  () => patchOfflineCharacter(sourceText('5739165', 'character/index.html')),
  /offline asset/,
  'raw character upstream runtime must not pass local asset validation'
);
const registeredIndexReplay = transformOverlayText('index.html', normalize(sourceText('5739165', 'index.html')));
const unregisteredIndexLocal = normalize(sourceText('ddc8f75', 'index.html'))
  .replace('<!-- GitHub Pages rebuild marker', '<!-- unregistered delta -->\n    <!-- GitHub Pages rebuild marker');
assert.notEqual(registeredIndexReplay, unregisteredIndexLocal, 'unregistered local logic must not be silently normalized');

const successfulFixture = await createConflictFixture({
  baseFiles: {
    'index.html': repoBlob('5739165', 'index.html'),
    'novel/index.html': repoBlob('5739165', 'novel/index.html')
  },
  localFiles: {
    'index.html': repoBlob('ddc8f75', 'index.html'),
    'novel/index.html': repoBlob('ddc8f75', 'novel/index.html')
  },
  upstreamFiles: {
    'index.html': repoBlob('bc2d201', 'index.html'),
    'novel/index.html': repoBlob('bc2d201', 'novel/index.html')
  },
  startMerge: false
});
try {
  const beforeHead = gitText(successfulFixture, ['rev-parse', 'HEAD']);
  const logger = fixtureLogger();
  let reapplyCalls = 0;
  const result = await mergeWithAutoResolver({
    cwd: successfulFixture,
    upstreamRef: 'upstream',
    git: (args, options) => fixtureGit(successfulFixture, args, options),
    reapply: async ({ cwd }) => {
      reapplyCalls += 1;
      for (const relativePath of ['index.html', 'novel/index.html']) {
        const actual = await readFile(path.join(cwd, relativePath), 'utf8');
        assert.equal(transformOverlayBlob(relativePath, actual), actual, `${relativePath} reapply idempotence`);
      }
    },
    log: logger
  });
  assert.equal(result.resolved, true);
  assert.equal(reapplyCalls, 1, 'successful orchestration must reapply hooks once');
  assert.ok(logger.output.some(line => line.includes('MERGE_CONFLICTS=')));
  assert.ok(logger.output.some(line => line.includes('AUTO_RESOLVER=PASS')));
  assert.equal(gitText(successfulFixture, ['rev-parse', 'HEAD']), beforeHead, 'successful no-commit merge keeps HEAD');
  assert.equal(gitText(successfulFixture, ['diff', '--name-only', '--diff-filter=U']), '');
  for (const relativePath of ['index.html', 'novel/index.html']) {
    const actual = await readFile(path.join(successfulFixture, relativePath), 'utf8');
    const upstreamBlob = git(successfulFixture, ['show', `upstream:${relativePath}`]).toString('utf8');
    const expected = transformOverlayBlob(relativePath, upstreamBlob);
    assert.equal(actual, expected, `${relativePath} resolver output`);
  }
} finally {
  await rm(successfulFixture, { recursive: true, force: true });
}

const unknownFixture = await createConflictFixture({
  baseFiles: { 'app.js': 'base\n' },
  localFiles: { 'app.js': 'local\n' },
  upstreamFiles: { 'app.js': 'upstream\n' },
  startMerge: false
});
try {
  const beforeHead = gitText(unknownFixture, ['rev-parse', 'HEAD']);
  const logger = fixtureLogger();
  await assert.rejects(
    mergeWithAutoResolver({
      cwd: unknownFixture,
      upstreamRef: 'upstream',
      git: (args, options) => fixtureGit(unknownFixture, args, options),
      reapply: async () => { throw new Error('reapply must not run after resolver rejection'); },
      log: logger
    }),
    /aborted; auto-resolver refused.*manifest/
  );
  assert.ok(logger.output.some(line => line.includes('MERGE_CONFLICTS=')));
  assert.ok(logger.output.some(line => line.includes('AUTO_RESOLVER=FAIL')));
  assert.equal(gitText(unknownFixture, ['rev-parse', 'HEAD']), beforeHead, 'unknown conflict abort restores HEAD');
  assert.equal(gitText(unknownFixture, ['status', '--porcelain']), '');
  assert.equal(gitText(unknownFixture, ['diff', '--name-only', '--diff-filter=U']), '');
} finally {
  await rm(unknownFixture, { recursive: true, force: true });
}

const renameFixture = await createRenameConflictFixture({ startMerge: false });
try {
  const beforeHead = gitText(renameFixture, ['rev-parse', 'HEAD']);
  const logger = fixtureLogger();
  await assert.rejects(
    mergeWithAutoResolver({
      cwd: renameFixture,
      upstreamRef: 'upstream',
      git: (args, options) => fixtureGit(renameFixture, args, options),
      reapply: async () => { throw new Error('reapply must not run after rename rejection'); },
      log: logger
    }),
    /aborted; auto-resolver refused.*manifest|stage shape rejected/
  );
  assert.ok(logger.output.some(line => /rename\/rename/.test(line)), 'fixture must exercise Git rename/rename conflict');
  assert.ok(logger.output.some(line => line.includes('MERGE_CONFLICTS=')));
  assert.ok(logger.output.some(line => line.includes('AUTO_RESOLVER=FAIL')));
  assert.equal(gitText(renameFixture, ['rev-parse', 'HEAD']), beforeHead, 'rename abort restores HEAD');
  assert.equal(gitText(renameFixture, ['status', '--porcelain']), '', 'rename abort restores worktree');
  assert.equal(gitText(renameFixture, ['diff', '--name-only', '--diff-filter=U']), '');
} finally {
  await rm(renameFixture, { recursive: true, force: true });
}

const shapeFixture = await createConflictFixture({
  baseFiles: {},
  localFiles: { 'index.html': sourceText('ddc8f75', 'index.html') },
  upstreamFiles: { 'index.html': sourceText('bc2d201', 'index.html') }
});
try {
  await assert.rejects(resolveAutoConflicts({ cwd: shapeFixture }), /stage shape rejected/);
  assert.match(gitText(shapeFixture, ['diff', '--name-only', '--diff-filter=U']), /index\.html/);
  git(shapeFixture, ['merge', '--abort']);
} finally {
  await rm(shapeFixture, { recursive: true, force: true });
}

console.log('Auto-resolver transformer, proof, EOL, and isolated merge fixtures: PASS');
