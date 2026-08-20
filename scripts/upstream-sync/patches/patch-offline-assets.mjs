import { editText, replaceOnce, requireContains } from '../lib.mjs';

const category = 'offline-assets';

const indexRemoteFonts = `    <link rel="preconnect" href="https://fonts.googleapis.com">\n    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n    <link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">`;
const indexLocalFonts = '    <link href="assets/vendor/fonts/fonts.css" rel="stylesheet">';
const novelRemoteFonts = `    <!-- Google Fonts -->\n    <link rel="preconnect" href="https://fonts.googleapis.com">\n    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n    <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;600;700&family=Ma+Shan+Zheng&display=swap" rel="stylesheet">`;
const novelLocalFonts = `    <!-- Local web fonts -->\n    <link href="../assets/vendor/fonts/fonts.css" rel="stylesheet">`;

const script = (src, prefix = '') => `${prefix}<script src="${src}"></script>`;

function assertNoRemoteRuntime(source, file) {
  const remoteScript = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i;
  const remoteStylesheet = /<link\b[^>]*\bhref\s*=\s*["']https?:\/\//i;
  if (remoteScript.test(source) || remoteStylesheet.test(source)) {
    throw new Error(`Remote runtime dependency returned in ${file}; update patch-offline-assets.mjs`);
  }
}

function assertLocalIndexAssets(source) {
  for (const anchor of [
    'assets/vendor/fonts/fonts.css',
    'assets/generated/main.css',
    'assets/vendor/vue/vue.global.prod.js',
    'assets/vendor/marked/marked.min.js',
    'assets/vendor/dompurify/purify.min.js',
    'assets/vendor/sortablejs/Sortable.min.js'
  ]) requireContains(source, anchor, `index.html offline asset ${anchor}`);
}

function assertLocalNovelAssets(source) {
  for (const anchor of [
    '../assets/generated/novel.css',
    '../assets/vendor/vue/vue.global.prod.js',
    '../assets/vendor/marked/marked.min.js',
    '../assets/vendor/fonts/fonts.css'
  ]) requireContains(source, anchor, `novel/index.html offline asset ${anchor}`);
}

function replaceIndexTailwind(source) {
  const localStyleScript = `    <script>\n        document.write('<link rel="stylesheet" href="assets/css/styles.css?v=' + new Date().getTime() + '">');\n    </script>`;
  if (source.includes(localStyleScript) && !source.includes('tailwind.config')) return source;

  const start = source.indexOf('    <script>\n        tailwind.config = {');
  if (start < 0) throw new Error('Missing sync anchor: index.html Tailwind config block');
  const firstEnd = source.indexOf('    </script>', start);
  if (firstEnd < 0) throw new Error('Missing sync anchor: index.html Tailwind config end');
  const secondStart = source.indexOf('    <script>', firstEnd + '    </script>'.length);
  if (secondStart < 0) throw new Error('Missing sync anchor: index.html styles loader');
  const secondEnd = source.indexOf('    </script>', secondStart);
  if (secondEnd < 0) throw new Error('Missing sync anchor: index.html styles loader end');
  if (!source.slice(secondStart, secondEnd).includes("document.write('<link rel=\"stylesheet\" href=\"assets/css/styles.css?v=")) {
    throw new Error('Missing sync anchor: index.html styles loader body');
  }
  return `${source.slice(0, start)}${localStyleScript}${source.slice(secondEnd + '    </script>'.length)}`;
}

export function patchOfflineIndex(source) {
  source = replaceOnce(source, indexRemoteFonts, indexLocalFonts, 'index.html local fonts');
  source = replaceOnce(
    source,
    '    <script src="https://cdn.tailwindcss.com"></script>\n',
    '    <link href="assets/generated/main.css" rel="stylesheet">\n',
    'index.html Tailwind runtime'
  );
  source = replaceIndexTailwind(source);
  for (const [remote, local] of [
    ['https://unpkg.com/vue@3/dist/vue.global.prod.js', 'assets/vendor/vue/vue.global.prod.js'],
    ['https://cdn.jsdelivr.net/npm/marked/marked.min.js', 'assets/vendor/marked/marked.min.js'],
    ['https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js', 'assets/vendor/dompurify/purify.min.js'],
    ['https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js', 'assets/vendor/sortablejs/Sortable.min.js']
  ]) {
    source = replaceOnce(source, script(remote, '    '), script(local, '    '), `index.html ${remote}`);
  }
  assertLocalIndexAssets(source);
  assertNoRemoteRuntime(source, 'index.html');
  return source;
}

export function patchOfflineNovel(source) {
  source = replaceOnce(source, script('https://unpkg.com/vue@3/dist/vue.global.prod.js', '    '), script('../assets/vendor/vue/vue.global.prod.js', '    '), 'novel Vue runtime');
  if (!source.includes('../assets/generated/novel.css')) {
    source = replaceOnce(
      source,
      `    <!-- Tailwind CSS -->\n    <script src="https://cdn.tailwindcss.com"></script>\n`,
      `    <!-- Precompiled Tailwind CSS -->\n    <link href="../assets/generated/novel.css" rel="stylesheet">\n`,
      'novel Tailwind runtime'
    );
  } else {
    source = replaceOnce(source, script('https://cdn.tailwindcss.com', '    '), '    ', 'novel Tailwind runtime');
  }
  source = replaceOnce(source, script('https://cdn.jsdelivr.net/npm/marked/marked.min.js', '    '), script('../assets/vendor/marked/marked.min.js', '    '), 'novel Marked runtime');
  source = replaceOnce(source, novelRemoteFonts, novelLocalFonts, 'novel local fonts');
  assertLocalNovelAssets(source);
  assertNoRemoteRuntime(source, 'novel/index.html');
  return source;
}

export function patchOfflineCharacter(source) {
  const requirements = [
    '../assets/generated/character.css',
    '../assets/vendor/vue/vue.global.prod.js',
    '../assets/vendor/localforage/localforage.min.js'
  ];
  for (const anchor of requirements) requireContains(source, anchor, `character/index.html offline asset ${anchor}`);
  if (/https?:\/\/(?:cdn\.tailwindcss\.com|unpkg\.com\/vue|cdn\.jsdelivr\.net\/npm\/daisyui)/i.test(source)) {
    throw new Error('Remote runtime dependency returned in character/index.html; update patch-offline-assets.mjs');
  }
  assertNoRemoteRuntime(source, 'character/index.html');
  return source;
}

export async function applyOfflineAssetHooks() {
  const changes = [];
  changes.push(await editText('index.html', category, patchOfflineIndex));
  changes.push(await editText('character/index.html', category, patchOfflineCharacter));
  changes.push(await editText('novel/index.html', category, patchOfflineNovel));
  return changes.filter(Boolean);
}
