import { editText, ensureBefore, replaceOnce, requireContains } from '../lib.mjs';

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
  return ensureBefore(source, '</head>', `    <link href="${href}" rel="stylesheet">\n`, `${file} safe-area stylesheet`);
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

export function patchSafeAreaCharacter(source) {
  source = patchViewportMeta(source, 'character/index.html', false);
  source = patchStylesheet(source, '../assets/css/safe-area.css', 'character/index.html');
  return patchInsetFallback(source, 'character/index.html');
}

export async function applySafeAreaHooks() {
  const changes = [];
  changes.push(await editText('index.html', category, patchSafeAreaIndex));
  changes.push(await editText('character/index.html', category, patchSafeAreaCharacter));
  changes.push(await editText('novel/index.html', category, patchSafeAreaNovel));
  changes.push(await editText('assets/js/ui-components.js', category, source => {
    requireContains(source, 'safe-sidebar-header', 'main safe sidebar header');
    return source;
  }));
  for (const file of ['assets/css/safe-area.css', 'assets/js/safe-area.js']) {
    changes.push(await editText(file, category, source => source));
  }
  return changes.filter(Boolean);
}
