import { countOccurrences, editText, ensureBefore, replaceOnce, requireContains } from '../lib.mjs';

const category = 'webview-layout-safe-area';

function patchViewportMeta(source, file, includeInteractiveWidget) {
  const headEnd = source.indexOf('</head>');
  const matches = [...source.matchAll(/<meta name="viewport"\s+content="([^"]*)">/g)]
    .filter(match => headEnd < 0 || match.index < headEnd);
  if (matches.length !== 1) throw new Error(`Expected one viewport meta for ${file}, found ${matches.length}`);
  const content = matches[0][1];
  const tokens = content.split(',').map(token => token.trim()).filter(Boolean);
  if (tokens.filter(token => token === 'viewport-fit=cover').length > 1) {
    throw new Error(`Duplicate viewport-fit anchor in ${file}`);
  }
  if (includeInteractiveWidget && tokens.filter(token => token === 'interactive-widget=resizes-content').length > 1) {
    throw new Error(`Duplicate interactive-widget anchor in ${file}`);
  }
  if (!tokens.includes('viewport-fit=cover')) {
    const index = tokens.indexOf('interactive-widget=resizes-content');
    if (index >= 0) tokens.splice(index, 0, 'viewport-fit=cover');
    else tokens.push('viewport-fit=cover');
  }
  if (includeInteractiveWidget && !tokens.includes('interactive-widget=resizes-content')) {
    tokens.push('interactive-widget=resizes-content');
  }
  const replacement = matches[0][0].replace(content, tokens.join(', '));
  return source.slice(0, matches[0].index) + replacement + source.slice(matches[0].index + matches[0][0].length);
}

function patchStylesheet(source, href, file) {
  const insertion = `    <link href="${href}" rel="stylesheet">\n`;
  const insertionCount = source.split(insertion).length - 1;
  if (insertionCount === 1) return source;
  if (insertionCount > 1) throw new Error(`Duplicate hook detected: ${file} safe-area stylesheet`);
  const bodyStart = source.indexOf('<body');
  const headRegion = bodyStart < 0 ? source : source.slice(0, bodyStart);
  const headEndCount = headRegion.split('</head>').length - 1;
  if (headEndCount !== 1) throw new Error(`Expected one anchor for ${file} safe-area stylesheet, found ${headEndCount}`);
  const headEnd = headRegion.indexOf('</head>');
  return `${source.slice(0, headEnd)}${insertion}${source.slice(headEnd)}`;
}

function patchInsetFallback(source, file) {
  // The anchor is allowed once per upstream page. Once wrapped, return as-is;
  // otherwise a nested env() inside var() would be mistaken for a new anchor.
  const replacement = 'var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))';
  if (source.includes('var(--safe-area-inset-bottom')) return source;
  const target = /env\(safe-area-inset-bottom(?:,\s*0px)?\)/g;
  const matches = source.match(target) || [];
  if (matches.length > 1) throw new Error(`Duplicate direct bottom inset anchors in ${file}`);
  if (matches.length === 0) return source;
  return source.replace(target, replacement);
}

const expandedSidebarHeaderPadding = `    .safe-sidebar-header.px-6 {
        padding-right: calc(1.5rem + var(--safe-right));
        padding-left: calc(1.5rem + var(--safe-left));
    }
`;

// Preserve the upstream px-6/px-0 state distinction while adding the system
// inset to the expanded mobile sidebar header's original horizontal padding.
export function patchSidebarHeaderPadding(source) {
  if (source.includes('.safe-sidebar-header.px-6 {')) return source;
  const mobileMediaStart = source.indexOf('@media (max-width: 768px) {');
  if (mobileMediaStart < 0) {
    throw new Error('Missing mobile media anchor for expanded sidebar header safe-area padding');
  }
  const footerAnchor = source.indexOf('    .safe-sidebar-footer {', mobileMediaStart);
  if (footerAnchor < 0) {
    throw new Error('Missing mobile sidebar footer anchor for expanded sidebar header safe-area padding');
  }
  return source.slice(0, footerAnchor) + expandedSidebarHeaderPadding + source.slice(footerAnchor);
}

const workshopInputPanelRule = `#app .workshop-input-panel {
    padding-right: calc(1rem + var(--safe-right));
    padding-bottom: calc(1rem + var(--safe-bottom-effective));
    padding-left: calc(1rem + var(--safe-left));
}`;

const workshopInputPanelRules = `${workshopInputPanelRule}

/* Preserve Tailwind's md:pb-24 baseline while keeping unusually large insets safe. */
@media (min-width: 768px) {
    #app .workshop-input-panel {
        padding-bottom: max(6rem, calc(1rem + var(--safe-bottom-effective)));
    }
}`;

function maskComments(source, pattern) {
  return source.replace(pattern, comment => comment.replace(/[^\r\n]/g, ' '));
}

export function patchWorkshopInputPanelSafeArea(source) {
  const commentPattern = /\/\*[\s\S]*?\*\//g;
  const anchorSource = maskComments(source, commentPattern);
  const selectorCount = (
    anchorSource.match(/#app \.workshop-input-panel\s*\{/g) || []
  ).length;
  if (anchorSource.includes(maskComments(workshopInputPanelRules, commentPattern))) {
    if (selectorCount !== 2) {
      throw new Error(`Expected two character workshop input CSS rules, found ${selectorCount}`);
    }
    return source;
  }
  const legacyCount = countOccurrences(anchorSource, workshopInputPanelRule);
  if (legacyCount !== 1 || selectorCount !== 1) {
    throw new Error(`Expected one legacy character workshop input CSS rule, found ${legacyCount}; selectors ${selectorCount}`);
  }
  const legacyIndex = anchorSource.indexOf(workshopInputPanelRule);
  return source.slice(0, legacyIndex) + workshopInputPanelRules + source.slice(legacyIndex + workshopInputPanelRule.length);
}

function patchIndexToast(source) {
  const target = `        <div\n            class="fixed top-6 left-1/2 transform -translate-x-1/2 z-[100] flex flex-col gap-2 pointer-events-none items-center">`;
  const replacement = `        <div data-safe-area="toast"\n            class="fixed top-6 left-1/2 transform -translate-x-1/2 z-[100] flex flex-col gap-2 pointer-events-none items-center">`;
  source = replaceOnce(source, target, replacement, 'main safe-area toast');
  requireContains(source, 'data-safe-area="toast"', 'main safe-area toast');
  return source;
}

function patchNovelClass(source, oldClass, newClass, label) {
  const existing = `class="${oldClass}`;
  const patched = `class="${newClass}`;
  source = replaceOnce(source, existing, patched, label);
  const count = (source.match(new RegExp(`class="${newClass}`, 'g')) || []).length;
  if (count !== 1) throw new Error(`Expected one safe-area class for ${label}, found ${count}`);
  return source;
}

export function patchSafeAreaIndex(source) {
  source = patchViewportMeta(source, 'index.html', true);
  source = patchStylesheet(source, 'assets/css/safe-area.css', 'index.html');
  source = patchIndexToast(source);
  source = replaceOnce(
    source,
    'class="relative h-12 flex items-center justify-between px-4 pointer-events-auto"',
    'class="chat-header-controls relative h-12 flex items-center justify-between px-4 pointer-events-auto"',
    'main chat header safe area'
  );
  requireContains(source, 'input-area-mobile', 'main safe composer hook');
  return source;
}

export function patchSafeAreaNovel(source) {
  source = patchViewportMeta(source, 'novel/index.html', true);
  source = patchStylesheet(source, '../assets/css/safe-area.css', 'novel/index.html');
  for (const [oldClass, newClass, label] of [
    ['fixed top-5 left-1/2', 'novel-toast fixed top-5 left-1/2', 'novel toast'],
    ['md:hidden absolute top-0 left-0', 'novel-mobile-header md:hidden absolute top-0 left-0', 'novel mobile header'],
    ['fixed md:static inset-y-0 left-0', 'novel-sidebar fixed md:static inset-y-0 left-0', 'novel sidebar'],
    ['flex-1 h-full overflow-y-auto relative scroll-smooth', 'novel-main-scroll flex-1 h-full overflow-y-auto relative scroll-smooth', 'novel main scroll'],
    ['sticky bottom-4 md:bottom-8 z-10', 'novel-bottom-controls sticky bottom-4 md:bottom-8 z-10', 'novel bottom controls'],
    ['fixed top-20 right-4 md:right-8', 'novel-review-button fixed top-20 right-4 md:right-8', 'novel review button'],
    ['fixed right-4 bottom-56 md:right-8 md:bottom-32', 'novel-floating-nav fixed right-4 bottom-56 md:right-8 md:bottom-32', 'novel floating navigation']
  ]) {
    source = patchNovelClass(source, oldClass, newClass, label);
  }
  source = patchInsetFallback(source, 'novel/index.html');
  return source;
}

export function patchSquareHostSafeArea(source) {
  source = replaceOnce(
    source,
    `<div v-if="currentView === 'square'" class="h-full overflow-hidden flex flex-col bg-gray-50 relative">`,
    `<div v-if="currentView === 'square'" data-safe-area="square-frame"
                class="h-full overflow-hidden flex flex-col bg-gray-50 relative">`,
    'main square host safe area'
  );
  requireContains(source, 'data-safe-area="square-frame"', 'main square host safe area');
  return source;
}

export function patchSafeAreaCharacter(source) {
  source = patchViewportMeta(source, 'character/index.html', false);
  source = patchStylesheet(source, '../assets/css/safe-area.css', 'character/index.html');
  for (const [before, after, label] of [
    [
      '                    padding-bottom: calc(7rem + env(safe-area-inset-bottom));',
      '                    padding-bottom: calc(7rem + var(--safe-bottom-effective));',
      'character workshop scroll safe area'
    ],
    [
      '                    padding-bottom: max(1rem, env(safe-area-inset-bottom));',
      '                    padding-bottom: calc(1rem + var(--safe-bottom-effective));',
      'character workshop input safe area'
    ]
  ]) {
    const beforeCount = countOccurrences(source, before);
    const afterCount = countOccurrences(source, after);
    if (beforeCount + afterCount !== 1) {
      throw new Error(`Expected one ${label} anchor, found upstream ${beforeCount}; patched ${afterCount}`);
    }
    if (beforeCount === 1) source = source.replace(before, after);
  }
  const localUtility = 'pb-[max(1rem,var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))]';
  const upstreamUtility = 'pb-[max(1rem,env(safe-area-inset-bottom))]';
  const anchorSource = maskComments(source, /<!--[\s\S]*?-->/g);
  const panelClasses = [...anchorSource.matchAll(/(?<!:)\bclass="([^"]*)"/g)]
    .filter(match => match[1].split(/\s+/).includes('workshop-input-panel'));
  if (panelClasses.length !== 1) {
    throw new Error(`Expected one character workshop input panel class, found ${panelClasses.length}`);
  }
  const panelClass = panelClasses[0];
  const localCount = countOccurrences(panelClass[1], localUtility);
  const upstreamCount = countOccurrences(panelClass[1], upstreamUtility);
  const globalUtilityCount = countOccurrences(anchorSource, localUtility) + countOccurrences(anchorSource, upstreamUtility);
  if (localCount + upstreamCount !== 1 || globalUtilityCount !== 1) {
    throw new Error(`Expected one character workshop input utility, found local ${localCount}; upstream ${upstreamCount}`);
  }
  if (localCount !== 1) return source;
  const classValueOffset = panelClass[0].indexOf(panelClass[1]);
  const utilityOffset = classValueOffset + panelClass[1].indexOf(localUtility);
  const utilityStart = panelClass.index + utilityOffset;
  return source.slice(0, utilityStart) + upstreamUtility + source.slice(utilityStart + localUtility.length);
}

export async function applySafeAreaHooks() {
  const changes = [];
  changes.push(await editText('index.html', category, source => patchSquareHostSafeArea(patchSafeAreaIndex(source))));
  changes.push(await editText('character/index.html', category, patchSafeAreaCharacter));
  changes.push(await editText('novel/index.html', category, patchSafeAreaNovel));
  changes.push(await editText('assets/js/ui-components.js', category, source => {
    requireContains(source, 'safe-sidebar-header', 'main safe sidebar header');
    return source;
  }));
  for (const file of ['assets/css/safe-area.css', 'assets/js/safe-area.js']) {
    changes.push(await editText(file, category, source => (
      file === 'assets/css/safe-area.css'
        ? patchWorkshopInputPanelSafeArea(patchSidebarHeaderPadding(source))
        : source
    )));
  }
  return changes.filter(Boolean);
}
