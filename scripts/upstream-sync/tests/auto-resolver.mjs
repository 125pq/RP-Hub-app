import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dominantEol, projectRoot, rebuildWithOriginalEol } from '../lib.mjs';
import { resolveAutoConflicts } from '../auto-resolver.mjs';
import { mergeWithAutoResolver } from '../sync-orchestration.mjs';
import { transformOverlayBlob, transformOverlayText } from '../overlay-transformers.mjs';
import { patchAndroidCharacter } from '../patches/patch-android-hooks.mjs';
import { resolveAppConflictBlob } from '../patches/patch-app-conflict.mjs';
import { patchBackupCharacter } from '../patches/patch-backup.mjs';
import { patchOfflineCharacter } from '../patches/patch-offline-assets.mjs';
import { removeAppDiagnostics } from '../patches/patch-performance.mjs';
import {
  patchSafeAreaCharacter,
  patchSquareHostSafeArea,
  patchWorkshopInputPanelSafeArea
} from '../patches/patch-safe-area.mjs';

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
const preMergeAppRevision = '700e776';
const legacyChatImporterDeclaration = [
  '        const importCharacterChatJsonl = window.RPHubChatImport.createChatImporter({',
  '            currentCharacterIndex,',
  '            currentCharacter,',
  '            showToast,',
  '            stopCurrentCharacterWork,',
  '            getCurrentStoryBranchScopeId,',
  '            setApplyingCharacterScopedData: (value) => { _isApplyingCharacterScopedData = value; },',
  '            storyBranches,',
  '            activeStoryBranchId,',
  '            selectedStoryBranchId,',
  '            resetChatRenderWindow,',
  '            chatHistory,',
  '            prepareLoadedChatHistoryForDisplay,',
  '            createInitialChatHistory,',
  '            loadCharacterMemories,',
  '            loadGlobalUiTemplateRuntimeForCharacter,',
  '            clearStoryBranchTransientContext,',
  '            finishApplyingCharacterScopedData,',
  '            currentView,',
  '            scrollChatToBottom,',
  '            updateCurrentStoryBranchSummary,',
  '            saveStoryBranchesForCharacter',
  '        });'
].join('\n');
const upstreamImageTailLine = `                if (!imageTail.includes('###') && !/[\\r\\n]/.test(imageTail)) mainText = mainText.slice(0, imageStart);`;
function buildRelocatedAppFromPreMergeRevision() {
  const source = sourceText(preMergeAppRevision, 'assets/js/app.js');
  const normalized = normalize(source);
  assert.equal(normalized.split(legacyChatImporterDeclaration).length - 1, 1, 'pre-merge app has one reviewed importer declaration');
  const withoutDeclaration = normalized.replace(`${legacyChatImporterDeclaration}\n\n`, '');
  const returnAnchor = '\n        return {\n';
  assert.equal(withoutDeclaration.split(returnAnchor).length - 1, 1, 'pre-merge app has one setup return anchor');
  const relocated = withoutDeclaration.replace(returnAnchor, `\n${legacyChatImporterDeclaration}\n${returnAnchor}`);
  assert.notEqual(relocated, normalized, 'pre-merge app importer declaration relocation changes the fixture');
  return rebuildWithOriginalEol(source, relocated, dominantEol(source));
}
function buildImageCleanAppFromPreMergeRevision() {
  const source = buildRelocatedAppFromPreMergeRevision();
  let normalized = normalize(source);
  assert.equal(
    normalized.split('getImageTagRegex(isTruncationEnabled.value)').length - 1,
    3,
    'relocated app has three truncation-dependent image regex calls'
  );
  normalized = normalized.replaceAll('getImageTagRegex(isTruncationEnabled.value)', 'getImageTagRegex()');
  const replaceExpectedOnce = (before, after, label) => {
    assert.equal(normalized.split(before).length - 1, 1, label);
    normalized = normalized.replace(before, after);
  };
  replaceExpectedOnce(
    'watch(() => [settings.disableImages, settings.styleFilterEnabled, isTruncationEnabled.value, regexScripts.value, user.name],',
    'watch(() => [settings.disableImages, settings.styleFilterEnabled, regexScripts.value, user.name],',
    'relocated app has one image truncation render-cache dependency'
  );
  replaceExpectedOnce(
    `        // Keep the shared cached renderer while preserving upstream's
        // prevent-truncation handling for incomplete image markers.`,
    '        // 解析并截断生成的包含 HTML UI 的正文，避免闪屏问题',
    'relocated app has one local main-content processor comment'
  );
  replaceExpectedOnce(
    `                if (!imageTail.includes('###')
                    && (isTruncationEnabled.value || !/[\\r\\n]/.test(imageTail))) {
                    const lineBreak = imageTail.search(/[\\r\\n]/);
                    mainText = mainText.slice(0, imageStart)
                        + (lineBreak >= 0 ? imageTail.slice(lineBreak) : '');
                }`,
    `                if (!imageTail.includes('###') && !/[\\r\\n]/.test(imageTail)) mainText = mainText.slice(0, imageStart);`,
    'relocated app has one local image-tail handling block'
  );
  const rebuilt = rebuildWithOriginalEol(source, normalized, dominantEol(source));
  const upstreamApp = sourceText('4aef0bb46c9b3370faba174a20435e5989799727', 'assets/js/app.js');
  assert.ok(upstreamApp.includes(`${upstreamImageTailLine}\n`), '1.9.3 image-tail line uses LF');
  assert.ok(!upstreamApp.includes(`${upstreamImageTailLine}\r\n`), '1.9.3 image-tail line is not CRLF');
  assert.equal(rebuilt.split(upstreamImageTailLine).length - 1, 1, 'rebuilt app has one upstream image-tail line');
  return rebuilt.replace(`${upstreamImageTailLine}\r\n`, `${upstreamImageTailLine}\n`);
}
const squareFrameAnchor = `<div v-if="currentView === 'square'" class="h-full overflow-hidden flex flex-col bg-gray-50 relative">`;
const squareFrameExpected = `<div v-if="currentView === 'square'" data-safe-area="square-frame"
                class="h-full overflow-hidden flex flex-col bg-gray-50 relative">`;

function assertBlobProof(relativePath) {
  const upstream = sourceText('4aef0bb46c9b3370faba174a20435e5989799727', relativePath);
  const current = readFileSync(path.join(projectRoot, relativePath), 'utf8');
  assert.equal(normalize(transformOverlayBlob(relativePath, upstream)), normalize(current), `${relativePath} current tree is the registered overlay of stable upstream 1.9.3`);
  const once = transformOverlayText(relativePath, normalize(upstream));
  assert.equal(transformOverlayText(relativePath, once), once, `${relativePath} transformer must be idempotent`);

  const lf = normalize(upstream);
  const crlf = lf.replace(/\n/g, '\r\n');
  const mixed = lf.split('\n').map((line, index) => `${line}${index % 2 ? '\n' : '\r\n'}`).join('');
  for (const variant of [lf, crlf, mixed]) {
    assert.equal(normalize(transformOverlayBlob(relativePath, variant)), transformOverlayText(relativePath, normalize(variant)), `${relativePath} EOL variant semantic result`);
  }
}

async function createConflictFixture({ localFiles, upstreamFiles, baseFiles = localFiles, startMerge = true, preserveEol = false }) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'rphub-auto-resolver-'));
  const config = [['user.name', 'Resolver Test'], ['user.email', 'resolver@example.test']];
  git(fixture, ['init', '-q', '-b', 'main']);
  for (const [key, value] of config) git(fixture, ['config', key, value]);
  if (preserveEol) {
    // Preserve upstream blob bytes so CRLF/LF fixtures exercise the same
    // conflict shape as the real repository (global autocrlf must not rewrite it).
    git(fixture, ['config', 'core.autocrlf', 'false']);
  }
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
  git(fixture, ['init', '-q', '-b', 'main']);
  git(fixture, ['config', 'user.name', 'Resolver Test']);
  git(fixture, ['config', 'user.email', 'resolver@example.test']);
  git(fixture, ['read-tree', '--empty']);
  await mkdir(path.join(fixture, 'assets', 'js'), { recursive: true });

  const indexRecords = [];
  for (const relativePath of paths) {
    const base = repoBlob('0562644', relativePath);
    const stages = [
      [base, 1],
      [Buffer.from(transformOverlayBlob(relativePath, base.toString('utf8'))), 2],
      [repoBlob('b409ca6', relativePath), 3]
    ];
    for (const [bytes, stage] of stages) {
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

for (const relativePath of ['index.html', 'character/index.html', 'novel/index.html']) assertBlobProof(relativePath);

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
const stableCharacter192 = normalize(sourceText('a83d907497106e401f0988b29b653422159e4c7f', 'character/index.html'));
const upstreamWorkshopUtility = 'pb-[max(1rem,env(safe-area-inset-bottom))]';
const localWorkshopUtility = 'pb-[max(1rem,var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))]';
const patchedSafeAreaCharacter192 = patchSafeAreaCharacter(stableCharacter192);
assert.equal((patchedSafeAreaCharacter192.match(new RegExp(upstreamWorkshopUtility.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
assert.doesNotMatch(patchedSafeAreaCharacter192, /class="workshop-input-panel [^"]*--safe-area-inset-bottom/);
assert.equal(patchSafeAreaCharacter(patchedSafeAreaCharacter192), patchedSafeAreaCharacter192, 'canonical character safe-area patch is idempotent');
const reorderedWorkshopPanel = patchedSafeAreaCharacter192.replace(
  'class="workshop-input-panel bg-base-100/95',
  'class="workshop-input-panel md:shadow-none bg-base-100/95'
);
assert.notEqual(reorderedWorkshopPanel, patchedSafeAreaCharacter192, 'unrelated panel class fixture must differ before patching');
assert.equal(
  patchSafeAreaCharacter(reorderedWorkshopPanel),
  reorderedWorkshopPanel,
  'unrelated character panel class drift remains untouched'
);
assert.equal(
  patchSafeAreaCharacter(`${patchedSafeAreaCharacter192}\n<!-- class="workshop-input-panel ${upstreamWorkshopUtility}" -->`),
  `${patchedSafeAreaCharacter192}\n<!-- class="workshop-input-panel ${upstreamWorkshopUtility}" -->`,
  'unrelated commented character markup remains untouched'
);
const legacySafeAreaCharacter = patchedSafeAreaCharacter192.replace(upstreamWorkshopUtility, localWorkshopUtility);
assert.equal(patchSafeAreaCharacter(legacySafeAreaCharacter), patchedSafeAreaCharacter192, 'legacy character utility migrates back to the upstream token');
const leadingCommentLegacyCharacter = `<!-- ${localWorkshopUtility} -->\n${legacySafeAreaCharacter}`;
const leadingCommentMigratedCharacter = patchSafeAreaCharacter(leadingCommentLegacyCharacter);
assert.match(leadingCommentMigratedCharacter, new RegExp(`^<!-- ${localWorkshopUtility.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -->`));
assert.equal((leadingCommentMigratedCharacter.match(new RegExp(localWorkshopUtility.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
assert.equal((leadingCommentMigratedCharacter.match(new RegExp(upstreamWorkshopUtility.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
assert.equal(
  patchSafeAreaCharacter(leadingCommentMigratedCharacter),
  leadingCommentMigratedCharacter,
  'leading comment utility remains unchanged and character migration is byte-idempotent'
);
assert.throws(
  () => patchSafeAreaCharacter(`${patchedSafeAreaCharacter192}\n<div class="${upstreamWorkshopUtility}"></div>`),
  /Expected one character workshop input utility/,
  'duplicate character workshop utility must fail closed'
);
assert.throws(
  () => patchSafeAreaCharacter(`${patchedSafeAreaCharacter192}\n<div class="aux workshop-input-panel ${upstreamWorkshopUtility}"></div>`),
  /Expected one character workshop input panel class/,
  'duplicate character workshop panel selector must fail closed'
);
assert.throws(
  () => patchSafeAreaCharacter(patchedSafeAreaCharacter192.replace(upstreamWorkshopUtility, 'pb-[drifted-safe-area]')),
  /Expected one character workshop input utility/,
  'drifted character workshop utility must fail closed'
);
assert.throws(
  () => patchSafeAreaCharacter(stableCharacter192.replace(
    '                    padding-bottom: max(1rem, env(safe-area-inset-bottom));',
    '                    padding-bottom: max(1rem, env(safe-area-inset-bottom));\n' +
      '                    padding-bottom: max(1rem, env(safe-area-inset-bottom));'
  )),
  /Expected one character workshop input safe area anchor/,
  'duplicate character workshop input CSS anchor must fail closed'
);
assert.throws(
  () => patchBackupCharacter(`${stableCharacter192}\nflushData.type !== 'RPHUB_BACKUP_FLUSH'\n`),
  /Partial character backup hook detected/,
  'character backup marker injection must fail closed'
);
const androidCharacter192 = patchAndroidCharacter(stableCharacter192);
const androidReplacementStart = androidCharacter192.indexOf('                const downloadFile = async (data, filename, mimeType) => {');
const androidReplacementEnd = androidCharacter192.indexOf('\n\n                const exportPNG = async () => {', androidReplacementStart);
assert.ok(androidReplacementStart >= 0 && androidReplacementEnd > androidReplacementStart, 'character Android replacement fixture boundaries');
assert.throws(
  () => patchAndroidCharacter(`${stableCharacter192}\n${androidCharacter192.slice(androidReplacementStart, androidReplacementEnd)}\n`),
  /Partial Android character export hook state/,
  'misplaced complete Android hook with old implementation must fail closed'
);
const offlineCharacter192 = patchOfflineCharacter(stableCharacter192);
assert.throws(
  () => patchOfflineCharacter(`${offlineCharacter192}\n<script src="../assets/vendor/vue/vue.global.prod.js"></script>\n`),
  /Expected exactly one character\/index\.html offline asset \.\.\/assets\/vendor\/vue\/vue\.global\.prod\.js, found 2/,
  'duplicate local character runtime must fail closed'
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
    'index.html': transformOverlayBlob('index.html', sourceText('5739165', 'index.html')),
    'novel/index.html': transformOverlayBlob('novel/index.html', sourceText('5739165', 'novel/index.html'))
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
  baseFiles: { 'unregistered.js': 'base\n' },
  localFiles: { 'unregistered.js': 'local\n' },
  upstreamFiles: { 'unregistered.js': 'upstream\n' },
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
    const local = git(fixture, ['show', `:2:${relativePath}`]).toString('utf8');
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
        .replace('    window.RPHubCardUtils = {', '    window.DriftedCardUtils = {')
    ),
    /card file adapter helpers/,
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
      patchedCore.replace('    const getPlatformAdapter = () => {', '    const getPlatformAdapter = () => {\n    const getPlatformAdapter = () => {')
    ),
    /exactly one card file adapter helper/,
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
  assert.doesNotMatch(
    resolvedData,
    /createDetailedJsonSyntaxError/,
    'removed legacy JSON parser helper must not be restored over the 1.8.9 simplified parser'
  );
  console.log('Real upstream 1.8.9 (b409ca6) two-conflict resolver + reapply proof: PASS');
} finally {
  await rm(realUpstreamFixture.fixture, { recursive: true, force: true });
}

const real191Paths = ['assets/js/app.js', 'assets/js/core-utils.js', 'assets/js/data-services.js'];
const real191ConflictPaths = ['assets/js/app.js', 'assets/js/data-services.js'];
const pre191LocalParent = '8829214408fe7fcc53a5b960e4e7512dc787d9e0';
const real191Fixture = await createConflictFixture({
  baseFiles: Object.fromEntries(real191Paths.map(relativePath => [relativePath, repoBlob('b409ca6', relativePath)])),
  localFiles: Object.fromEntries(real191Paths.map(relativePath => [relativePath, relativePath === 'assets/js/app.js'
    ? repoBlob(pre191LocalParent, relativePath)
    : transformOverlayBlob(relativePath, sourceText('b409ca6', relativePath))])),
  upstreamFiles: Object.fromEntries(real191Paths.map(relativePath => [relativePath, repoBlob('9c0611964a39ff8cca8831d97ecf18b04abb1990', relativePath)]))
});
try {
  assert.deepEqual(
    gitText(real191Fixture, ['diff', '--name-only', '--diff-filter=U']).split('\n'),
    real191ConflictPaths,
    'real upstream 1.9.1 fixture must expose both canonical content conflicts'
  );
  const mergedApp = await readFile(path.join(real191Fixture, 'assets/js/app.js'), 'utf8');
  const appStages = {
    base: git(real191Fixture, ['show', ':1:assets/js/app.js']).toString('utf8'),
    local: git(real191Fixture, ['show', ':2:assets/js/app.js']).toString('utf8'),
    upstream: git(real191Fixture, ['show', ':3:assets/js/app.js']).toString('utf8')
  };
  const injectedOursApp = mergedApp.replace(
    /^<<<<<<< [^\n]+\n/m,
    match => `${match}const injectedLocalStatement = true;\n`
  );
  const injectedTheirsApp = mergedApp.replace(
    /^=======\r?\n/m,
    match => `${match}const injectedUpstreamStatement = true;\n`
  );
  assert.notEqual(injectedOursApp, mergedApp, 'ours-side injection fixture must mutate the conflict block');
  assert.notEqual(injectedTheirsApp, mergedApp, 'theirs-side injection fixture must mutate the conflict block');
  assert.throws(
    () => resolveAppConflictBlob({
      ...appStages,
      merged: injectedOursApp
    }),
    /Unexpected app conflict block normalized summary/,
    'app resolver must reject an extra statement on the reviewed ours side'
  );
  assert.throws(
    () => resolveAppConflictBlob({
      ...appStages,
      merged: injectedTheirsApp
    }),
    /Unexpected app conflict block normalized summary/,
    'app resolver must reject an extra statement on the reviewed theirs side'
  );
  assert.throws(
    () => resolveAppConflictBlob({ ...appStages, merged: `${mergedApp}\n<<<<<<< extra\nlocal\n=======\nupstream\n>>>>>>> extra\n` }),
    /exactly two app conflict blocks/,
    'app resolver must reject additional conflict blocks'
  );
  const resolved = await resolveAutoConflicts({ cwd: real191Fixture });
  assert.deepEqual(resolved, real191ConflictPaths, 'real upstream 1.9.1 resolver paths');
  assert.equal(gitText(real191Fixture, ['diff', '--name-only', '--diff-filter=U']), '');
  const appNumstat = args => gitText(real191Fixture, ['diff', '--numstat', ...args, 'upstream', '--', 'assets/js/app.js'])
    .split('\t')
    .slice(0, 2)
    .reduce((total, value) => total + Number(value || 0), 0);
  assert.equal(
    appNumstat([]),
    appNumstat(['--ignore-space-at-eol']),
    'resolved app must not add EOL-only noise against the upstream blob'
  );
  const resolvedApp = normalize(await readFile(path.join(real191Fixture, 'assets/js/app.js'), 'utf8'));
  for (const marker of [
    'processMainContent: processMainContentCached',
    'return processMainContentCached(mainText, isGeneratingState);',
    'let removePlatformBackListener = () => {};',
    '// Wanxiang Square mirror preference hook.',
    '// Backup flush bridges (local full-backup export/restore).',
    'window.RPHubOffscreenIframeLifecycle?.attach(container);'
  ]) assert.match(resolvedApp, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `resolved app marker: ${marker}`);
  assert.doesNotMatch(resolvedApp, /exportMemories: async \(\) => \{|importMemories: \(event\) =>|hasVectorEmbedding/);
  for (const relativePath of ['assets/js/core-utils.js', 'assets/js/data-services.js']) {
    const actual = await readFile(path.join(real191Fixture, relativePath), 'utf8');
    assert.equal(
      normalize(actual),
      normalize(transformOverlayBlob(relativePath, sourceText('9c0611964a39ff8cca8831d97ecf18b04abb1990', relativePath))),
      `${relativePath} real upstream 1.9.1 output`
    );
  }
  console.log('Real upstream 1.9.1 (9c06119) canonical conflict resolver proof: PASS');
} finally {
  await rm(real191Fixture, { recursive: true, force: true });
}

const stable192 = 'a83d907497106e401f0988b29b653422159e4c7f';
const pre192Local = 'cc32094b03cd9fd452d7aca586d3d4594381fb78';
const real192Paths = [
  'assets/js/app.js',
  'assets/js/core-utils.js',
  'assets/js/runtime-services.js',
  'assets/js/ui-components.js',
  'character/index.html',
  'index.html',
  'novel/index.html'
];
// Upstream-owned files are intentionally mixed-EOL (CRLF + bare LF). With
// core.autocrlf=false git treats the terminators as content, so this replay
// also conflicts on ui-components.js and character/index.html; pin autocrlf
// off so the conflict set is identical on Windows and Linux CI.
const real192ConflictPaths = ['assets/js/app.js', 'assets/js/ui-components.js', 'character/index.html', 'index.html', 'novel/index.html'];
const real192Fixture = await createConflictFixture({
  baseFiles: Object.fromEntries(real192Paths.map(relativePath => [relativePath, repoBlob('9c0611964a39ff8cca8831d97ecf18b04abb1990', relativePath)])),
  localFiles: Object.fromEntries(real192Paths.map(relativePath => [relativePath, relativePath === 'assets/js/app.js'
    ? repoBlob(pre192Local, relativePath)
    : transformOverlayBlob(relativePath, sourceText('9c0611964a39ff8cca8831d97ecf18b04abb1990', relativePath))])),
  upstreamFiles: Object.fromEntries(real192Paths.map(relativePath => [relativePath, repoBlob(stable192, relativePath)])),
  preserveEol: true
});
try {
  assert.deepEqual(
    gitText(real192Fixture, ['diff', '--name-only', '--diff-filter=U']).split('\n'),
    real192ConflictPaths,
    'retired legacy stream scheduler removes the runtime-services 1.9.2 conflict'
  );
  for (const relativePath of real192Paths.filter(relativePath => relativePath !== 'assets/js/app.js')) {
    assert.equal(
      normalize(transformOverlayBlob(relativePath, sourceText('9c0611964a39ff8cca8831d97ecf18b04abb1990', relativePath))),
      normalize(git(real192Fixture, ['show', `local:${relativePath}`]).toString('utf8')),
      `${relativePath} real upstream 1.9.2 stage1 -> stage2 proof`
    );
  }

  const mergedApp192 = await readFile(path.join(real192Fixture, 'assets/js/app.js'), 'utf8');
  const appStages192 = {
    base: git(real192Fixture, ['show', ':1:assets/js/app.js']).toString('utf8'),
    local: git(real192Fixture, ['show', ':2:assets/js/app.js']).toString('utf8'),
    upstream: git(real192Fixture, ['show', ':3:assets/js/app.js']).toString('utf8')
  };
  assert.throws(
    () => resolveAppConflictBlob({
      ...appStages192,
      merged: mergedApp192.replace(/^<<<<<<< [^\n]+\n/m, match => `${match}const injected192 = true;\n`)
    }),
    /Unexpected app conflict block normalized summary/,
    '1.9.2 app resolver must reject ours-side injection'
  );
  assert.throws(
    () => resolveAppConflictBlob({ ...appStages192, merged: `${mergedApp192}\n<<<<<<< extra\nlocal\n=======\nupstream\n>>>>>>> extra\n` }),
    /exactly one app conflict block/,
    '1.9.2 app resolver must reject additional conflict blocks'
  );

  const resolved192 = await resolveAutoConflicts({ cwd: real192Fixture });
  assert.deepEqual(resolved192, real192ConflictPaths, 'real upstream 1.9.2 resolver paths');
  assert.equal(gitText(real192Fixture, ['diff', '--name-only', '--diff-filter=U']), '');
  for (const relativePath of real192ConflictPaths.filter(relativePath => relativePath !== 'assets/js/app.js')) {
    const actual = await readFile(path.join(real192Fixture, relativePath), 'utf8');
    const expected = transformOverlayBlob(relativePath, sourceText(stable192, relativePath));
    assert.equal(normalize(actual), normalize(expected), `${relativePath} real upstream 1.9.2 output`);
    assert.equal(transformOverlayBlob(relativePath, actual), actual, `${relativePath} real upstream 1.9.2 second reapply`);
  }
  const resolvedApp192 = normalize(await readFile(path.join(real192Fixture, 'assets/js/app.js'), 'utf8'));
  for (const marker of [
    'const uiTokens = ',
    'let removePlatformBackListener = () => {};',
    '// Wanxiang Square mirror preference hook.',
    '// Backup flush bridges (local full-backup export/restore).',
    'window.__RPH_PERF__?.attachApp?.(appInstance);'
  ]) assert.ok(resolvedApp192.includes(marker), `resolved 1.9.2 app marker: ${marker}`);
  assert.doesNotMatch(resolvedApp192, /processMainContentCached|<<<<<<<|=======|>>>>>>>/);

  const upstreamApi192 = normalize(sourceText(stable192, 'assets/js/api-utils.js'));
  const patchedApi192 = transformOverlayText('assets/js/api-utils.js', upstreamApi192);
  assert.equal(patchedApi192, upstreamApi192, '1.9.2 API overlay is identity');
  const currentApiRuntime = normalize(readFileSync(path.join(projectRoot, 'assets/js/api-utils.js'), 'utf8'));
  assert.equal(currentApiRuntime, normalize(sourceText('4aef0bb46c9b3370faba174a20435e5989799727', 'assets/js/api-utils.js')), 'current API runtime is canonical stable 1.9.3');
  assert.equal(transformOverlayText('assets/js/api-utils.js', patchedApi192), patchedApi192, '1.9.2 API identity overlay idempotence');
  assert.throws(
    () => transformOverlayText('assets/js/api-utils.js', upstreamApi192.replace('const accept = data => {', 'const acceptDrifted = data => {')),
    /stable 1\.9\.2 stream accept handler/,
    '1.9.2 API request anchor drift must fail closed'
  );
  const patchedCore192 = transformOverlayText('assets/js/core-utils.js', normalize(sourceText(stable192, 'assets/js/core-utils.js')));
  assert.doesNotMatch(patchedCore192, /__RPH_PERF__|clearParseCotCache|parseCotImpl/, '1.9.2 core overlay must omit benchmark seams');
  assert.throws(
    () => transformOverlayText(
      'assets/js/ui-components.js',
      `${normalize(sourceText(stable192, 'assets/js/ui-components.js'))}\n<div class="safe-sidebar-footer"></div>\n`
    ),
    /safe sidebar footer/,
    '1.9.2 UI duplicate marker must fail closed'
  );
  console.log('Real upstream 1.9.2 (a83d907) canonical conflict resolver + native API identity + second reapply proof: PASS');
} finally {
  await rm(real192Fixture, { recursive: true, force: true });
}

const upstream193 = '4aef0bb46c9b3370faba174a20435e5989799727';
const upstreamCharacter193 = sourceText(upstream193, 'character/index.html');
const legacyCharacter193Fixture = await createConflictFixture({
  baseFiles: { 'character/index.html': repoBlob(stable192, 'character/index.html') },
  localFiles: {
    'character/index.html': transformOverlayBlob('character/index.html', sourceText(stable192, 'character/index.html'))
      .replace(upstreamWorkshopUtility, localWorkshopUtility)
  },
  upstreamFiles: { 'character/index.html': repoBlob(upstream193, 'character/index.html') }
});
try {
  assert.equal(
    gitText(legacyCharacter193Fixture, ['diff', '--name-only', '--diff-filter=U']),
    'character/index.html',
    'legacy local workshop utility reproduces the real 1.9.3 character conflict'
  );
} finally {
  await rm(legacyCharacter193Fixture, { recursive: true, force: true });
}
const character193Fixture = await createConflictFixture({
  baseFiles: { 'character/index.html': repoBlob(stable192, 'character/index.html') },
  localFiles: { 'character/index.html': transformOverlayBlob('character/index.html', sourceText(stable192, 'character/index.html')) },
  upstreamFiles: { 'character/index.html': repoBlob(upstream193, 'character/index.html') }
});
try {
  assert.equal(
    gitText(character193Fixture, ['diff', '--name-only', '--diff-filter=U']),
    '',
    'migrated workshop safe-area utility creates no real 1.9.3 character conflict'
  );
  const mergedCharacter193 = await readFile(path.join(character193Fixture, 'character/index.html'), 'utf8');
  assert.equal(
    normalize(mergedCharacter193),
    normalize(transformOverlayBlob('character/index.html', upstreamCharacter193)),
    'clean character merge retains upstream 1.9.3 plus registered fork hooks'
  );
  assert.doesNotMatch(
    mergedCharacter193,
    /class="workshop-input-panel [^"]*--safe-area-inset-bottom/,
    'real 1.9.3 character merge must not restore the retired local utility'
  );
  assert.equal(
    transformOverlayBlob('character/index.html', mergedCharacter193),
    mergedCharacter193,
    'real 1.9.3 character merge second reapply'
  );
  console.log('Real upstream 1.9.3 character safe-area clean merge + second reapply proof: PASS');
} finally {
  await rm(character193Fixture, { recursive: true, force: true });
}

let reviewedMergedApp193 = '';
const app193Fixture = await createConflictFixture({
  baseFiles: { 'assets/js/app.js': repoBlob(stable192, 'assets/js/app.js') },
  localFiles: { 'assets/js/app.js': buildImageCleanAppFromPreMergeRevision() },
  upstreamFiles: { 'assets/js/app.js': repoBlob(upstream193, 'assets/js/app.js') },
  preserveEol: true
});
try {
  assert.equal(gitText(app193Fixture, ['diff', '--name-only', '--diff-filter=U']), '', 'relocated importer cleanly merges with upstream 1.9.3');
  reviewedMergedApp193 = await readFile(path.join(app193Fixture, 'assets/js/app.js'), 'utf8');
  const mergedApp193 = normalize(reviewedMergedApp193);
  assert.equal((mergedApp193.match(/importCharacterChatJsonl/g) || []).length, 2, 'merged app keeps one importer declaration and call');
  assert.match(
    mergedApp193,
    /if \(file\.name\.toLowerCase\(\)\.endsWith\('\.jsonl'\)\) \{\n\s+importCharacterChatJsonl\(file\)\.catch\(/,
    'merged app delegates JSONL import to the existing streaming module'
  );
  assert.doesNotMatch(
    mergedApp193,
    /const records = String\(e\.target\.result \|\| ''\)[\s\S]*?reader\.readAsText\(file\);/,
    'merged app does not retain the upstream whole-file JSONL reader'
  );
  for (const marker of [
    'CharacterDeck',
    'const importCharacterData = async',
    'WORKSHOP_IMPORT_AND_PLAY',
    'syncNativeActiveToolUis(assistantMessage, toolCalls, requestToolUis, requestTools);'
  ]) assert.ok(mergedApp193.includes(marker), `clean-merged 1.9.3 app marker: ${marker}`);
  console.log('Real upstream 1.9.3 app importer relocation: PASS (clean merge; JSONL branch delegated)');
} finally {
  await rm(app193Fixture, { recursive: true, force: true });
}

const legacyDiagnosticBaseline = '9ce9ef0ff93fa4816fea309cfd541b5b33fca338';
const endpointOnlyApi = normalize(sourceText('9c0611964a39ff8cca8831d97ecf18b04abb1990', 'assets/js/api-utils.js'));
assert.equal(transformOverlayText('assets/js/api-utils.js', endpointOnlyApi), endpointOnlyApi, 'endpoint-only API overlay is identity');
const endpointWithChangedHeader = endpointOnlyApi.replace(
  '// Shared API endpoint helpers used by the main app and the novel page.',
  '// Endpoint construction shared by browser entry points.'
);
assert.equal(
  transformOverlayText('assets/js/api-utils.js', endpointWithChangedHeader),
  endpointWithChangedHeader,
  'endpoint-only API overlay allows header wording changes'
);
const endpointWithTransportComment = endpointOnlyApi.replace(
  '// Shared API endpoint helpers used by the main app and the novel page.',
  '// requestChatCompletion is intentionally absent; window.RPHubApiClient is provided by later versions.'
);
assert.equal(
  transformOverlayText('assets/js/api-utils.js', endpointWithTransportComment),
  endpointWithTransportComment,
  'endpoint-only API overlay ignores transport names in comments'
);
assert.throws(
  () => transformOverlayText('assets/js/api-utils.js', endpointOnlyApi.replace('const apiRoot =', 'const changedApiRoot =')),
  /endpoint helper implementation/,
  'endpoint helper implementation drift is rejected'
);
assert.throws(
  () => transformOverlayText('assets/js/api-utils.js', endpointOnlyApi.replace(
    '    window.RPHubApiUtils = Object.freeze({ buildApiEndpoint });',
    '    window.RPHubApiUtils = Object.freeze({ buildApiEndpoint });\n    window.RPHubApiUtils = Object.freeze({ buildApiEndpoint });'
  )),
  /Expected 1 endpoint helper export, found 2/,
  'duplicate endpoint helper export is rejected'
);
assert.throws(
  () => transformOverlayText(
    'assets/js/api-utils.js',
    endpointOnlyApi.replace('    window.RPHubApiUtils = Object.freeze({ buildApiEndpoint });\n', '')
  ),
  /Expected 1 endpoint helper export, found 0/,
  'missing endpoint helper export is rejected'
);
assert.throws(
  () => transformOverlayText(
    'assets/js/api-utils.js',
    `${endpointOnlyApi}\nconst requestChatCompletion = async options => options;\n`
  ),
  /endpoint-only chat transport declarations/,
  'endpoint-only API rejects a real chat transport declaration'
);
assert.throws(
  () => transformOverlayText(
    'assets/js/api-utils.js',
    `${endpointOnlyApi}\nwindow.RPHubApiClient = Object.freeze({});\n`
  ),
  /endpoint-only API client exports/,
  'endpoint-only API rejects a real API client export'
);
assert.throws(
  () => transformOverlayText('assets/js/api-utils.js', `${endpointOnlyApi}\nconst schedulePublish = () => {};\n`),
  /Retired local stream scheduler marker remains/,
  'endpoint-only API rejects retired local scheduler markers'
);
const legacyDiagnosticApp = normalize(sourceText(legacyDiagnosticBaseline, 'assets/js/app.js'));
const cleanDiagnosticApp = removeAppDiagnostics(legacyDiagnosticApp);
const currentAppBytes = readFileSync(path.join(projectRoot, 'assets/js/app.js'), 'utf8');
const currentApp = normalize(currentAppBytes);
assert.equal(cleanDiagnosticApp, normalize(sourceText(preMergeAppRevision, 'assets/js/app.js')), 'complete legacy app diagnostics are removed exactly');
assert.equal(currentApp, normalize(reviewedMergedApp193), 'current app matches the reviewed 1.9.3 merge replay');
assert.ok(currentAppBytes.includes(`${upstreamImageTailLine}\n`), 'current app adopts upstream LF on the image-tail line');
assert.ok(!currentAppBytes.includes(`${upstreamImageTailLine}\r\n`), 'current app does not retain local CRLF on the adopted image-tail line');
assert.equal(removeAppDiagnostics(cleanDiagnosticApp), cleanDiagnosticApp, 'clean app diagnostic removal is idempotent');
assert.throws(
  () => removeAppDiagnostics(legacyDiagnosticApp.replace('                        perfObservedRevealElements?.add(el);\n', '')),
  /scroll reveal diagnostic observation/,
  'partial legacy app diagnostics are rejected'
);
assert.throws(
  () => removeAppDiagnostics(legacyDiagnosticApp.replace(
    '            __perfLoadEarlierChatMessages: batchSize => window.__RPH_PERF__?.enabled\n',
    '            __perfLoadEarlierChatMessages: batchSize => window.__RPH_PERF__?.enabled\n            functionalInsertionMustSurvive: true,\n'
  )),
  /benchmark app exports/,
  'drift inside the reviewed diagnostic export block is rejected'
);
assert.throws(
  () => removeAppDiagnostics(legacyDiagnosticApp.replace(
    '        const perfObservedRevealElements = window.__RPH_PERF__?.enabled ? new WeakSet() : null;\n',
    '        const perfObservedRevealElements = window.__RPH_PERF__?.enabled ? new WeakSet() : null;\n        const perfObservedRevealElements = window.__RPH_PERF__?.enabled ? new WeakSet() : null;\n'
  )),
  /scroll reveal diagnostic set, found 2/,
  'duplicate legacy app diagnostics are rejected'
);
const upstreamApi193 = sourceText(upstream193, 'assets/js/api-utils.js');
const patchedApi193 = transformOverlayBlob('assets/js/api-utils.js', upstreamApi193);
const retiredScheduledApi = sourceText('a96467eaa27412dae4d3443b5db5b654bc23fcd0', 'assets/js/api-utils.js');
assert.throws(
  () => transformOverlayBlob('assets/js/api-utils.js', retiredScheduledApi),
  /Retired local stream scheduler marker remains/,
  'retired paragraph scheduler is not accepted as a canonical API transport'
);
assert.equal(patchedApi193, upstreamApi193, '1.9.3 API overlay is byte-for-byte identity');
assert.match(patchedApi193, /const requestChatCompletionOnce = async \(options, attempt\) => \{/, '1.9.3 retry implementation survives overlay');
assert.match(patchedApi193, /toolCalls: toolSnapshot\(\)/, '1.9.3 streamed tool calls survive overlay');
assert.match(patchedApi193, /const interval = setInterval\(flush, 60\)/, '1.9.3 upstream fixed stream interval survives overlay');
assert.doesNotMatch(patchedApi193, /__RPH_PERF__/, '1.9.3 overlay omits retired diagnostics');
assert.equal(transformOverlayBlob('assets/js/api-utils.js', patchedApi193), patchedApi193, '1.9.3 API overlay second pass');
assert.throws(
  () => transformOverlayBlob('assets/js/api-utils.js', upstreamApi193.replace('                const flush = () => {', '                const flush = async () => {')),
  /stable 1\.9\.3 stream flush implementation/,
  '1.9.3 upstream stream implementation drift is rejected'
);
assert.throws(
  () => transformOverlayBlob('assets/js/api-utils.js', upstreamApi193.replace(
    '                const interval = setInterval(flush, 60);',
    '                const interval = setInterval(flush, 60);\n                const interval = setInterval(flush, 60);'
  )),
  /Expected 1 upstream fixed stream interval, found 2/,
  'duplicate upstream timer anchor is rejected'
);
for (const variant of [
  upstreamApi193.replace(/\r\n/g, '\n'),
  upstreamApi193.replace(/\r?\n/g, '\r\n')
]) {
  assert.equal(
    normalize(transformOverlayBlob('assets/js/api-utils.js', variant)),
    normalize(patchedApi193),
    '1.9.3 API overlay EOL semantic result'
  );
}

const api193FixtureOptions = {
  baseFiles: { 'assets/js/api-utils.js': repoBlob(stable192, 'assets/js/api-utils.js') },
  localFiles: { '.local-marker': 'fork-only change\n' },
  upstreamFiles: { 'assets/js/api-utils.js': repoBlob(upstream193, 'assets/js/api-utils.js') }
};
const api193Fixture = await createConflictFixture(api193FixtureOptions);
try {
  assert.equal(gitText(api193Fixture, ['diff', '--name-only', '--diff-filter=U']), '', 'retired local API delta creates no 1.9.3 conflict');
  const actual = await readFile(path.join(api193Fixture, 'assets/js/api-utils.js'), 'utf8');
  assert.equal(normalize(actual), normalize(upstreamApi193), 'clean merge takes the real 1.9.3 API transport unchanged');
} finally {
  await rm(api193Fixture, { recursive: true, force: true });
}

const unregisteredApi193Fixture = await createConflictFixture({
  baseFiles: api193FixtureOptions.baseFiles,
  upstreamFiles: api193FixtureOptions.upstreamFiles,
  localFiles: {
    'assets/js/api-utils.js': sourceText(stable192, 'assets/js/api-utils.js')
      .replace(
        '    const requestChatCompletion = async (options) => {',
        '    const requestChatCompletionUnregistered = async (options) => {'
      )
  }
});
try {
  await assert.rejects(
    resolveAutoConflicts({ cwd: unregisteredApi193Fixture }),
    /transform\(stage1\) != stage2/,
    'real 1.9.3 API resolver rejects unregistered local changes'
  );
} finally {
  await rm(unregisteredApi193Fixture, { recursive: true, force: true });
}

console.log('Auto-resolver transformer, proof, EOL, and isolated merge fixtures: PASS');
