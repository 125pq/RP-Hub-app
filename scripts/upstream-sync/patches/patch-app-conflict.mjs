import { createHash } from 'node:crypto';
import {
  countOccurrences,
  dominantEol,
  rebuildWithOriginalEol,
  replaceOnce
} from '../lib.mjs';

const relativePath = 'assets/js/app.js';
const sharedProcessImport = `    stripUiTemplateUpdateBlock,
    processMainContent
} = window.RPHubUiTemplateUtils;`;
const aliasedProcessImport = `    stripUiTemplateUpdateBlock,
    processMainContent: processMainContentCached
} = window.RPHubUiTemplateUtils;`;
const cachedProcessWrapper = `        // Keep the shared cached renderer while preserving upstream's
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

const emptySummary = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
// SHA-256 pairs are `trim(normalizeEol(ours)):trim(normalizeEol(theirs))`.
// Git places the shared mobile-menu return line inside the conflict in the
// full workflow merge, but outside it in the minimal three-file fixture; both
// exact, reviewed layouts produce the same resolved source.
const reviewedConflictSummaries = Object.freeze({
  mainContent: `${emptySummary}:2738435a690becd53bd92953f98405555c9e253cd908ca626d3a723ba1552d18`,
  memoryHandlersFullMerge: 'd2a265ee58ed7a521eb0968f757c8e3d2bdf5cc6441caf2273f7f6764b409737:aa45fadda4f104d4f8301d976ccc1a941888c3d205ac9bfdbca92ff6435dbc55',
  memoryHandlersIsolatedFixture: `ea3ef2198485c9e9c412cd81114dcad9d72deaa0b4375f1dae610163e14d4672:${emptySummary}`
});

function requireCount(source, needle, expected, label) {
  const count = countOccurrences(source, needle);
  if (count !== expected) throw new Error(`Expected ${expected} ${label}, found ${count}`);
}

function validateStages(base, local, upstream) {
  requireCount(base, 'const processMainContent = (mainText, isGeneratingState) => {', 1, 'base inline main-content processor');
  requireCount(local, sharedProcessImport, 1, 'local shared main-content import');
  requireCount(local, 'const processMainContent = (mainText, isGeneratingState) => {', 0, 'local inline main-content processor');
  requireCount(upstream, 'const processMainContent = (mainText, isGeneratingState) => {', 1, 'upstream inline main-content processor');
  requireCount(upstream, '&& (settings.preventTruncation || !/[\\r\\n]/.test(imageTail)))', 1, 'upstream prevent-truncation behavior');

  requireCount(base, 'exportMemories: async () => {', 1, 'base memory export handler');
  requireCount(local, 'exportMemories: async () => {', 1, 'local memory export handler');
  requireCount(local, 'importMemories: (event) =>', 1, 'local memory import handler');
  requireCount(upstream, 'exportMemories: async () => {', 0, 'upstream memory export handler');
  requireCount(upstream, 'importMemories: (event) =>', 0, 'upstream memory import handler');
  requireCount(upstream, 'hasVectorEmbedding', 0, 'removed upstream vector helper');
}

function parseConflictBlocks(source) {
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
  if (blocks.length !== 2) throw new Error(`Expected exactly two app conflict blocks, found ${blocks.length}`);
  return { blocks, skeleton };
}

function resolveBlock(block) {
  const summarize = value => createHash('sha256').update(value.trim()).digest('hex');
  const summary = `${summarize(block.ours)}:${summarize(block.theirs)}`;
  if (summary === reviewedConflictSummaries.mainContent) return cachedProcessWrapper;
  if (
    summary === reviewedConflictSummaries.memoryHandlersFullMerge
    || summary === reviewedConflictSummaries.memoryHandlersIsolatedFixture
  ) return block.theirs;
  throw new Error(`Unexpected app conflict block normalized summary: ${summary}`);
}

function validateResolved(source) {
  for (const [needle, expected, label] of [
    [aliasedProcessImport, 1, 'aliased shared main-content import'],
    [cachedProcessWrapper.trim(), 1, 'cached main-content wrapper'],
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
    ['window.__RPH_PERF__?.attachApp?.(appInstance);', 1, 'performance app hook'],
    ['preventTruncation: false,', 1, 'upstream prevent-truncation setting']
  ]) {
    requireCount(source, needle, expected, label);
  }
  if (/^(?:<<<<<<<|=======|>>>>>>>)/m.test(source)) throw new Error('App conflict markers remain after resolution');
}

// Resolve only the two reviewed 1.9.1 app.js conflict shapes. Git's normal
// merge result supplies all non-conflicting upstream and local edits; this
// function reconciles the overlapping semantic changes and rejects any drift.
export function resolveAppConflictBlob({ base, local, upstream, merged }) {
  const normalizedBase = base.replace(/\r\n/g, '\n');
  const normalizedLocal = local.replace(/\r\n/g, '\n');
  const normalizedUpstream = upstream.replace(/\r\n/g, '\n');
  const normalizedMerged = merged.replace(/\r\n/g, '\n');
  validateStages(normalizedBase, normalizedLocal, normalizedUpstream);

  const { blocks, skeleton } = parseConflictBlocks(normalizedMerged);
  let resolved = skeleton;
  for (const block of blocks) resolved = resolved.replace(block.token, resolveBlock(block));
  resolved = replaceOnce(resolved, sharedProcessImport, aliasedProcessImport, 'shared main-content alias');
  validateResolved(resolved);
  // Rebuild against the upstream blob, not Git's conflict-marker worktree.
  // Marker lines can inherit checkout EOLs and otherwise turn an unchanged
  // upstream line next to a conflict into artificial whitespace noise.
  return rebuildWithOriginalEol(upstream, resolved, dominantEol(upstream));
}

export const appConflictPath = relativePath;
