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
import { patchSquareHostSafeArea } from '../patches/patch-safe-area.mjs';

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
const squareFrameAnchor = `<div v-if="currentView === 'square'" class="h-full overflow-hidden flex flex-col bg-gray-50 relative">`;
const squareFrameExpected = `<div v-if="currentView === 'square'" data-safe-area="square-frame"
                class="h-full overflow-hidden flex flex-col bg-gray-50 relative">`;

function addExpectedSquareFrame(source, label) {
  assert.equal((source.match(/data-safe-area="square-frame"/g) || []).length, 0, `${label} fixture already contains square safe-area marker`);
  assert.equal(source.split(squareFrameAnchor).length - 1, 1, `${label} square safe-area anchor count`);
  return source.replace(squareFrameAnchor, squareFrameExpected);
}

function assertBlobProof(relativePath) {
  const stage1 = sourceText('5739165', relativePath);
  const stage2 = sourceText('ddc8f75', relativePath);
  const stage3 = sourceText('bc2d201', relativePath);
  const expected = sourceText('b8c42ce', relativePath);
  const expectedStage2 = relativePath === 'index.html' ? addExpectedSquareFrame(stage2, `${relativePath} stage2`) : stage2;
  const expectedStage3 = relativePath === 'index.html' ? addExpectedSquareFrame(expected, `${relativePath} stage3`) : expected;
  assert.equal(normalize(transformOverlayBlob(relativePath, stage1)), normalize(expectedStage2), `${relativePath} stage1 replay proof`);
  assert.equal(normalize(transformOverlayBlob(relativePath, stage3)), normalize(expectedStage3), `${relativePath} stage3 replay proof`);
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

async function createRealUpstreamConflictFixture() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'rphub-real-upstream-1.8.9-'));
  const paths = ['assets/js/core-utils.js', 'assets/js/data-services.js'];
  const refs = [
    ['0562644', 1],
    ['6003529', 2],
    ['b409ca6', 3]
  ];
  git(fixture, ['init', '-q', '-b', 'main']);
  git(fixture, ['config', 'user.name', 'Resolver Test']);
  git(fixture, ['config', 'user.email', 'resolver@example.test']);
  git(fixture, ['read-tree', '--empty']);
  await mkdir(path.join(fixture, 'assets', 'js'), { recursive: true });

  const indexRecords = [];
  for (const relativePath of paths) {
    for (const [ref, stage] of refs) {
      const bytes = repoBlob(ref, relativePath);
      const objectId = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: fixture,
        input: bytes,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      indexRecords.push(`100644 ${objectId} ${stage}\t${relativePath}`);
    }
  }
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: fixture,
    input: `${indexRecords.join('\n')}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return { fixture, paths };
}

for (const relativePath of ['index.html', 'novel/index.html']) assertBlobProof(relativePath);

const squareFrameSource = sourceText('bc2d201', 'index.html');
const squareFramePatched = patchSquareHostSafeArea(squareFrameSource);
assert.equal((squareFramePatched.match(/data-safe-area="square-frame"/g) || []).length, 1, 'square safe-area marker must be inserted exactly once');
assert.equal(patchSquareHostSafeArea(squareFramePatched), squareFramePatched, 'square safe-area patch must be idempotent');
assert.throws(
  () => patchSquareHostSafeArea(squareFrameSource.replace(
    squareFrameAnchor,
    squareFrameAnchor.replace('class="h-full overflow-hidden flex flex-col bg-gray-50 relative"', 'class="drifted-square-host"')
  )),
  /main square host safe area/,
  'square safe-area anchor drift must fail closed'
);

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
    'index.html': addExpectedSquareFrame(sourceText('ddc8f75', 'index.html'), 'successful fixture local'),
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

const realUpstreamFixture = await createRealUpstreamConflictFixture();
try {
  const { fixture, paths } = realUpstreamFixture;
  assert.deepEqual(
    gitText(fixture, ['diff', '--name-only', '--diff-filter=U']).split('\n'),
    paths,
    'real upstream 1.8.9 fixture must expose both content conflicts'
  );
  for (const relativePath of paths) {
    const base = sourceText('0562644', relativePath);
    const local = sourceText('6003529', relativePath);
    const upstream = sourceText('b409ca6', relativePath);
    assert.equal(
      normalize(transformOverlayBlob(relativePath, base)),
      normalize(local),
      `${relativePath} real upstream stage1 -> stage2 proof`
    );
  }
  assert.throws(
    () => transformOverlayText(
      'assets/js/core-utils.js',
      normalize(sourceText('0562644', 'assets/js/core-utils.js'))
        .replace('const compressImage = ', 'const driftedCompressImage = ')
    ),
    /replacement anchor/,
    'core-utils anchor drift must fail closed'
  );
  assert.throws(
    () => transformOverlayText(
      'assets/js/data-services.js',
      normalize(sourceText('0562644', 'assets/js/data-services.js'))
        .replace('    const buildExecutableHtmlDocument = ', '    const driftedBuildExecutableHtmlDocument = ')
    ),
    /local iframe asset URL/,
    'data-services anchor drift must fail closed'
  );
  const patchedCore = transformOverlayText(
    'assets/js/core-utils.js',
    normalize(sourceText('0562644', 'assets/js/core-utils.js'))
  );
  assert.throws(
    () => transformOverlayText(
      'assets/js/core-utils.js',
      patchedCore.replace('const parseCotImpl = (text) => {', 'const parseCotImpl = (text) => {\nconst parseCotImpl = (text) => {')
    ),
    /exactly one parseCot implementation/,
    'duplicate core-utils marker must fail closed'
  );
  const patchedData = transformOverlayText(
    'assets/js/data-services.js',
    normalize(sourceText('0562644', 'assets/js/data-services.js'))
  );
  assert.throws(
    () => transformOverlayText(
      'assets/js/data-services.js',
      patchedData.replace(
        'const processMainContentImpl = (mainText, isGeneratingState) => {',
        'const processMainContentImpl = (mainText, isGeneratingState) => {\nconst processMainContentImpl = (mainText, isGeneratingState) => {'
      )
    ),
    /exactly one streaming main-content processing/,
    'duplicate data-services marker must fail closed'
  );
  const resolved = await resolveAutoConflicts({ cwd: fixture });
  assert.deepEqual(resolved, paths, 'real upstream 1.8.9 resolver paths');
  assert.equal(gitText(fixture, ['diff', '--name-only', '--diff-filter=U']), '');
  for (const relativePath of paths) {
    const actual = await readFile(path.join(fixture, relativePath), 'utf8');
    const upstream = sourceText('b409ca6', relativePath);
    assert.equal(actual, transformOverlayBlob(relativePath, upstream), `${relativePath} real upstream output`);
    assert.equal(transformOverlayText(relativePath, normalize(actual)), normalize(actual), `${relativePath} real upstream reapply idempotence`);
  }
  const resolvedCore = await readFile(path.join(fixture, 'assets/js/core-utils.js'), 'utf8');
  const resolvedData = await readFile(path.join(fixture, 'assets/js/data-services.js'), 'utf8');
  assert.match(resolvedCore, /\(thinking\|think\|cot\)/, 'core upstream thinking support must survive resolution');
  assert.match(resolvedData, /const parseUiTemplateUpdates = \(rawContent\)/, 'data upstream parser must survive resolution');
  console.log('Real upstream 1.8.9 (b409ca6) two-conflict resolver + reapply proof: PASS');
} finally {
  await rm(realUpstreamFixture.fixture, { recursive: true, force: true });
}

console.log('Auto-resolver transformer, proof, EOL, and isolated merge fixtures: PASS');
