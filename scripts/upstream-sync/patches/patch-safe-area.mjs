import { editText, ensureBefore, replaceOnce, requireContains } from '../lib.mjs';

const category = 'webview-layout-safe-area';

const addViewportFit = source => source.replace(
  /content="([^"]*user-scalable=no)(?![^\"]*viewport-fit=cover)([^"]*)"/,
  'content="$1, viewport-fit=cover$2"'
);

export async function applySafeAreaHooks() {
  const changes = [];
  for (const [file, href] of [
    ['index.html', 'assets/css/safe-area.css'],
    ['character/index.html', '../assets/css/safe-area.css'],
    ['novel/index.html', '../assets/css/safe-area.css']
  ]) {
    changes.push(await editText(file, category, source => {
      source = addViewportFit(source);
      source = ensureBefore(source, '</head>', `    <link href="${href}" rel="stylesheet">\n`, `${file} safe-area stylesheet`);
      return source;
    }));
  }

  changes.push(await editText('index.html', category, source => {
    if (!source.includes('class="chat-header-controls ')) {
      source = replaceOnce(source, 'class="relative h-12 flex items-center justify-between px-4 pointer-events-auto"', 'class="chat-header-controls relative h-12 flex items-center justify-between px-4 pointer-events-auto"', 'main chat header safe area');
    }
    requireContains(source, 'data-safe-area="toast"', 'main safe-area toast');
    requireContains(source, 'input-area-mobile', 'main safe composer hook');
    return source;
  }));

  changes.push(await editText('assets/js/ui-components.js', category, source => {
    requireContains(source, 'safe-sidebar-header', 'main safe sidebar header');
    return source;
  }));

  for (const file of ['assets/css/safe-area.css', 'assets/js/safe-area.js']) {
    changes.push(await editText(file, category, source => source));
  }
  return changes.filter(Boolean);
}
