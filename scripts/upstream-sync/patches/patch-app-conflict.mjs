import { createHash } from 'node:crypto';
import {
  countOccurrences,
  dominantEol,
  rebuildWithOriginalEol,
  replaceOnce
} from '../lib.mjs';
import { removeAppDiagnostics } from './patch-performance.mjs';

const relativePath = 'assets/js/app.js';
const characterDeckMarker = 'CharacterDeck';
const sharedProcessImport = `    stripUiTemplateUpdateBlock,
    processMainContent
} = window.RPHubUiTemplateUtils;`;
const aliasedProcessImport = `    stripUiTemplateUpdateBlock,
    processMainContent: processMainContentCached
} = window.RPHubUiTemplateUtils;`;
const upstreamProcessImport192 = `    stripUiTemplateUpdateBlock
} = window.RPHubUiTemplateUtils;`;
const cachedProcessWrapper191 = `        // Keep the shared cached renderer while preserving upstream's
        // prevent-truncation handling for incomplete image markers.
        const processMainContent = (mainText, isGeneratingState) => {
            let normalizedMainText = mainText;
            if (isGeneratingState && settings.preventTruncation) {
                const imageStart = normalizedMainText.lastIndexOf('image###');
                if (imageStart !== -1) {
                    const imageTail = normalizedMainText.slice(imageStart + 'image###'.length);
                    if (!imageTail.includes('###')) {
                        const lineBreak = imageTail.search(/[\\r\\n]/);
                        normalizedMainText = normalizedMainText.slice(0, imageStart)
                            + (lineBreak >= 0 ? imageTail.slice(lineBreak) : '');
                    }
                }
            }
            return processMainContentCached(normalizedMainText, isGeneratingState);
        };

`;

const b1Resolved193 = `                        if (toolCalls?.length) syncNativeActiveToolUis(assistantMessage, toolCalls, requestToolUis, requestTools);
                        if (window.__RPH_PERF__?.active) {
                            window.__RPH_PERF__.trackDomStabilization(
                                nextTick().then(() => new Promise(resolve => requestAnimationFrame(resolve)))
                            );
                        }
`;

const b2Resolved193 = `        const importCharacterChatJsonl = window.RPHubChatImport.createChatImporter({
            currentCharacterIndex,
            currentCharacter,
            showToast,
            stopCurrentCharacterWork,
            getCurrentStoryBranchScopeId,
            setApplyingCharacterScopedData: (value) => { _isApplyingCharacterScopedData = value; },
            storyBranches,
            activeStoryBranchId,
            selectedStoryBranchId,
            resetChatRenderWindow,
            chatHistory,
            prepareLoadedChatHistoryForDisplay,
            createInitialChatHistory,
            loadCharacterMemories,
            loadGlobalUiTemplateRuntimeForCharacter,
            clearStoryBranchTransientContext,
            finishApplyingCharacterScopedData,
            currentView,
            scrollChatToBottom,
            updateCurrentStoryBranchSummary,
            saveStoryBranchesForCharacter
        });

        const importCharacterData = async (rawData, avatarUrl, { askImageGeneration = true, activate = true } = {}) => {
            const imported = cardUtils.parseImportedCharacterCard(rawData);
            const char = {
                name: imported.name,
                description: imported.description,
                first_mes: imported.first_mes,
                avatar: avatarUrl || defaultAvatar,
                personality: imported.personality,
                creator_notes: imported.creator_notes,
                worldInfo: imported.worldInfoEntries
                    .map(entry => normalizeWorldInfoEntry({ ...entry, scope: 'character' }))
                    .filter(entry => entry.scope !== 'global'),
                regexScripts: imported.regexScripts
                    .map(script => cardUtils.normalizeImportedRegexScript(
                        { ...script, scope: 'character' },
                        { fallbackScope: 'character', systemNames: systemRegexNames }
                    ))
                    .filter(script => script.scope !== 'global'),
                uiTemplates: imported.uiTemplates.map(template => normalizeUiTemplate({
                    ...sanitizeUiTemplateImportEntry(template),
                    id: generateUUID(),
                    scope: 'character'
                })),
                recentGenerationTimes: [],
                uuid: generateUUID(),
                createdAt: Date.now()
            };
`

const emptySummary = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const uiTokensMarker = 'const uiTokens = ';
// SHA-256 pairs are `trim(normalizeEol(ours)):trim(normalizeEol(theirs))`.
// Git places the shared mobile-menu return line inside the conflict in the
// full workflow merge, but outside it in the minimal three-file fixture; both
// exact, reviewed layouts produce the same resolved source.
const reviewedConflictSummaries = Object.freeze({
  mainContent: `${emptySummary}:2738435a690becd53bd92953f98405555c9e253cd908ca626d3a723ba1552d18`,
  mainContent192: 'ce5b03084bc801436b234434ec8d44bae45231115dc5307c8adb1cb5c7825e75:24c3ae7bcc48a5065a512384c2bff079a0c8ef10acf4cedf560132369e0928fe',
  memoryHandlersFullMerge: 'd2a265ee58ed7a521eb0968f757c8e3d2bdf5cc6441caf2273f7f6764b409737:aa45fadda4f104d4f8301d976ccc1a941888c3d205ac9bfdbca92ff6435dbc55',
  memoryHandlersIsolatedFixture: `ea3ef2198485c9e9c412cd81114dcad9d72deaa0b4375f1dae610163e14d4672:${emptySummary}`,
  domStabilizationAndToolUis193: '22ed6fc6be28e435d95abd86e7c53387b283f93066ec7b71c472feb970fa3da0:7a9e8c331c5b36107370c5564eec1e44b2ec1bc94b1d194a6bab8e06955416a2',
  chatImportAndCharacterData193: 'd80b3dbcbc0db3092448dfb5bf2712e4db9652ceb18506890f948427c362d288:6e50fb69e8db80e7842456548cff9bd8a3dbfed0d4617ca5f598dc7d2b7f3a87'
});

function requireCount(source, needle, expected, label) {
  const count = countOccurrences(source, needle);
  if (count !== expected) throw new Error(`Expected ${expected} ${label}, found ${count}`);
}

function validateStages(base, local, upstream) {
  const is193 = upstream.includes(characterDeckMarker);
  const is192 = !is193 && upstream.includes(uiTokensMarker);
  requireCount(base, 'const processMainContent = (mainText, isGeneratingState) => {', 1, 'base inline main-content processor');
  requireCount(upstream, 'const processMainContent = (mainText, isGeneratingState) => {', 1, 'upstream inline main-content processor');
  if (is193) {
    requireCount(local, characterDeckMarker, 0, 'local character deck component');
    requireCount(upstream, characterDeckMarker, 5, 'upstream character deck component');
    requireCount(upstream, 'syncNativeActiveToolUis(assistantMessage, toolCalls, requestToolUis, requestTools);', 1, 'upstream native tool uis');
  } else if (is192) {
    requireCount(local, aliasedProcessImport, 1, 'local aliased shared main-content import');
    requireCount(local, 'return processMainContentCached(normalizedMainText, isGeneratingState);', 1, 'local shared cached renderer');
    requireCount(local, uiTokensMarker, 0, 'local upstream UI parser');
    requireCount(upstream, '&& (isTruncationEnabled.value || !/[\\r\\n]/.test(imageTail))', 1, 'upstream UI-aware truncation behavior');
    requireCount(upstream, uiTokensMarker, 1, 'upstream UI-aware truncation parser');
    requireCount(base, '&& (settings.preventTruncation || !/[\\r\\n]/.test(imageTail))', 1, '1.9.1 base truncation behavior');
  } else {
    requireCount(local, sharedProcessImport, 1, 'local shared main-content import');
    requireCount(local, 'const processMainContent = (mainText, isGeneratingState) => {', 0, 'local inline main-content processor');
    requireCount(upstream, '&& (settings.preventTruncation || !/[\\r\\n]/.test(imageTail))', 1, 'upstream prevent-truncation behavior');
    requireCount(local, 'exportMemories: async () => {', 1, 'local memory export handler');
    requireCount(local, 'importMemories: (event) =>', 1, 'local memory import handler');
  }
  requireCount(upstream, 'exportMemories: async () => {', 0, 'upstream memory export handler');
  requireCount(upstream, 'importMemories: (event) =>', 0, 'upstream memory import handler');
  requireCount(upstream, 'hasVectorEmbedding', 0, 'removed upstream vector helper');
  return { is193, is192 };
}

function parseConflictBlocks(source, expectedBlocks = 2) {
  const blocks = [];
  const pattern = /^<<<<<<< [^\n]+\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]+\n?/gm;
  const skeleton = source.replace(pattern, (match, ours, theirs) => {
    const token = `__RPHUB_APP_CONFLICT_${blocks.length}__`;
    blocks.push({ ours, theirs, token });
    return token;
  });
  if (/^(?:<<<<<<<|=======|>>>>>>>)/m.test(skeleton)) {
    throw new Error('Malformed or nested app conflict markers');
  }
  if (blocks.length !== expectedBlocks) {
    const expectedLabel = expectedBlocks === 1 ? 'one' : expectedBlocks === 2 ? 'two' : String(expectedBlocks);
    throw new Error(`Expected exactly ${expectedLabel} app conflict blocks, found ${blocks.length}`);
  }
  return { blocks, skeleton };
}

function resolveBlock(block) {
  const summarize = value => createHash('sha256').update(value.trim()).digest('hex');
  const summary = `${summarize(block.ours)}:${summarize(block.theirs)}`;
  if (summary === reviewedConflictSummaries.mainContent) return cachedProcessWrapper191;
  if (summary === reviewedConflictSummaries.mainContent192) return block.theirs;
  if (summary === reviewedConflictSummaries.domStabilizationAndToolUis193) return b1Resolved193;
  if (summary === reviewedConflictSummaries.chatImportAndCharacterData193) return b2Resolved193;
  if (
    summary === reviewedConflictSummaries.memoryHandlersFullMerge
    || summary === reviewedConflictSummaries.memoryHandlersIsolatedFixture
  ) return block.theirs;
  throw new Error(`Unexpected app conflict block normalized summary: ${summary}`);
}

function validateResolved(source, { is193, is192 }) {
  const versionChecks = is193 ? [
    [characterDeckMarker, 5, 'upstream character deck component'],
    ['syncNativeActiveToolUis(assistantMessage, toolCalls, requestToolUis, requestTools);', 1, 'upstream native tool uis'],
    ['trackDomStabilization', 0, 'perf DOM stabilization'],
    ['importCharacterChatJsonl', 2, 'local JSONL streaming importer'],
    ['importCharacterData', 6, 'upstream character import data function'],
    ['getSquareFrame', 3, 'upstream square iframe resolver'],
    ['WORKSHOP_IMPORT_AND_PLAY', 1, 'upstream workshop import bridge']
  ] : is192 ? [
    [aliasedProcessImport, 0, 'obsolete aliased shared main-content import'],
    ['processMainContentCached', 0, 'obsolete shared main-content cache reference'],
    ['const processMainContent = (mainText, isGeneratingState) => {', 1, 'upstream inline main-content processor'],
    [uiTokensMarker, 1, 'upstream UI-aware truncation parser']
  ] : [
    [aliasedProcessImport, 1, 'aliased shared main-content import'],
    [cachedProcessWrapper191.trim(), 1, 'cached main-content wrapper'],
    [uiTokensMarker, 0, 'unexpected future UI parser']
  ];
  for (const [needle, expected, label] of [
    ...versionChecks,
    ['exportMemories: async () => {', 0, 'removed memory export handler'],
    ['importMemories: (event) =>', 0, 'removed memory import handler'],
    ['hasVectorEmbedding', 0, 'removed vector helper reference'],
    ['toggleMobileMenu, closeMobileMenu,', 1, 'mobile-menu return entry'],
    ['let removePlatformBackListener = () => {};', 1, 'Android back listener'],
    ['removePlatformBackListener = await adapter.onBackButton(handlePlatformBackButton);', 1, 'Android back registration'],
    ['removePlatformBackListener();', 1, 'Android back cleanup'],
    ['// Wanxiang Square mirror preference hook.', 1, 'Square mirror hook'],
    ['// Backup flush bridges (local full-backup export/restore).', 1, 'backup flush bridge'],
    ['window.RPHubOffscreenIframeLifecycle?.attach(container);', 1, 'offscreen iframe attach hook'],
    ['window.RPHubOffscreenIframeLifecycle?.detach();', 1, 'offscreen iframe cleanup hook'],
    ['window.__RPH_PERF__?.attachApp?.(appInstance);', is193 ? 0 : 1, 'performance app hook'],
    ['preventTruncation: false,', 1, 'upstream prevent-truncation setting']
  ]) {
    requireCount(source, needle, expected, label);
  }
  if (/^(?:<<<<<<<|=======|>>>>>>>)/m.test(source)) throw new Error('App conflict markers remain after resolution');
}

// Resolve only the reviewed 1.9.1/1.9.2 app.js conflict shapes. Git's normal
// merge result supplies all non-conflicting upstream and local edits; this
// function reconciles the overlapping semantic changes and rejects any drift.
export function resolveAppConflictBlob({ base, local, upstream, merged }) {
  const normalizedBase = base.replace(/\r\n/g, '\n');
  const normalizedLocal = local.replace(/\r\n/g, '\n');
  const normalizedUpstream = upstream.replace(/\r\n/g, '\n');
  const normalizedMerged = merged.replace(/\r\n/g, '\n');
  const version = validateStages(normalizedBase, normalizedLocal, normalizedUpstream);

  const expectedBlocks = version.is193 ? 2 : version.is192 ? 1 : 2;
  const { blocks, skeleton } = parseConflictBlocks(
    normalizedMerged,
    expectedBlocks
  );
  let resolved = skeleton;
  for (const block of blocks) resolved = resolved.replace(block.token, resolveBlock(block));
  if (version.is193) resolved = removeAppDiagnostics(resolved);
  if (version.is192) {
    resolved = replaceOnce(resolved, aliasedProcessImport, upstreamProcessImport192, 'removed 1.9.2 shared main-content import');
  } else if (!version.is193) {
    resolved = replaceOnce(resolved, sharedProcessImport, aliasedProcessImport, 'shared main-content alias');
  }
  validateResolved(resolved, version);
  // Rebuild against the upstream blob, not Git's conflict-marker worktree.
  // Marker lines can inherit checkout EOLs and otherwise turn an unchanged
  // upstream line next to a conflict into artificial whitespace noise.
  return rebuildWithOriginalEol(upstream, resolved, dominantEol(upstream));
}

export const appConflictPath = relativePath;
