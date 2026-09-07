import { countOccurrences, editText, replaceOnce, requireContains } from '../lib.mjs';

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
  source = replaceOnce(
    source,
    `    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/daisyui@4.7.2/dist/full.min.css" rel="stylesheet" type="text/css" />
    <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/localforage@1.10.0/dist/localforage.min.js"></script>`,
    `    <link href="../assets/vendor/fonts/fonts.css" rel="stylesheet">
    <link href="../assets/generated/character.css" rel="stylesheet">
    <script src="../assets/vendor/vue/vue.global.prod.js"></script>
    <script src="../assets/vendor/localforage/localforage.min.js"></script>`,
    'character offline assets'
  );
  const characterTailwindConfig = `    <script>
        tailwind.config = {
            future: {
                hoverOnlyWhenSupported: true,
            },
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['var(--app-font-family)', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Microsoft YaHei', 'Noto Sans SC', 'Arial', 'sans-serif'],
                        serif: ['var(--app-font-serif)', 'Lora', 'Noto Serif SC', 'Source Han Serif SC', 'Source Han Serif CN', 'STSong', 'SimSun', 'Georgia', 'Cambria', 'Times New Roman', 'Times', 'serif']
                    },
                    colors: {
                        primary: '#65c3c8',
                        secondary: '#ef9fbc',
                        accent: '#eeaf3a',
                    }
                }
            }
        }
    </script>
`;
  if (source.includes(characterTailwindConfig)) {
    const count = source.split(characterTailwindConfig).length - 1;
    if (count !== 1) throw new Error(`Expected one character Tailwind runtime config, found ${count}`);
    source = source.replace(characterTailwindConfig, '');
  } else if (source.includes('tailwind.config = {')) {
    throw new Error('Character Tailwind runtime config drifted');
  }
  source = replaceOnce(
    source,
    `        #app {
            font-family: var(--app-font-family) !important;
            height: var(--app-visual-height, 100%);
            min-height: 0;
        }

        .workshop-layout,`,
    `        #app {
            font-family: var(--app-font-family) !important;
            height: var(--app-visual-height, 100%);
            min-height: 0;
        }


        .workshop-layout,`,
    'character generated stylesheet separation'
  );
  source = replaceOnce(
    source,
    '                const getWorkshopFontCss = (value = document.documentElement.dataset.appFont) => fontFamilyCssMap[normalizeFontFamily(value)];',
    `                const getWorkshopFontCss = (value = document.documentElement.dataset.appFont) => fontFamilyCssMap[normalizeFontFamily(value)];
                const getLocalAssetUrl = (relativePath) => new URL(relativePath, window.location.href).href;
                const previewTailwindRuntimeUrl = getLocalAssetUrl('../assets/vendor/tailwind-preview/tailwind-runtime.min.js');`,
    'character local preview runtime URL'
  );
  const previewFallback = `                        const tailwindRuntime = \`
                            <script src="\${previewTailwindRuntimeUrl}"><\\/script>
                            <script>
                                (function () {
                                    window.tailwind = window.tailwind || {};

                                    function startTailwindRuntime() {
                                        if (typeof window.createTailwindcss !== 'function') {
                                            console.error('Local Tailwind preview runtime failed to load.');
                                            return;
                                        }

                                        var compiler = window.createTailwindcss({
                                            tailwindConfig: window.tailwind.config || {}
                                        });
                                        var style = document.createElement('style');
                                        style.id = 'rp-hub-preview-tailwind';
                                        document.head.appendChild(style);

                                        var timer = null;
                                        var compiling = false;
                                        var rerun = false;

                                        async function compilePreviewStyles() {
                                            if (compiling) {
                                                rerun = true;
                                                return;
                                            }

                                            compiling = true;
                                            try {
                                                compiler.setTailwindConfig(window.tailwind.config || {});
                                                style.textContent = await compiler.generateStylesFromContent(
                                                    '@tailwind base;\\\\n@tailwind components;\\\\n@tailwind utilities;',
                                                    [document.documentElement.outerHTML]
                                                );
                                            } catch (error) {
                                                console.error('Failed to compile preview Tailwind styles:', error);
                                            } finally {
                                                compiling = false;
                                                if (rerun) {
                                                    rerun = false;
                                                    scheduleCompile();
                                                }
                                            }
                                        }

                                        function scheduleCompile() {
                                            if (timer !== null) clearTimeout(timer);
                                            timer = setTimeout(function () {
                                                timer = null;
                                                compilePreviewStyles();
                                            }, 0);
                                        }

                                        var observer = new MutationObserver(function (mutations) {
                                            var needsCompile = mutations.some(function (mutation) {
                                                if (mutation.type === 'attributes') return true;
                                                return Array.prototype.some.call(mutation.addedNodes, function (node) {
                                                    return node.nodeType === Node.ELEMENT_NODE
                                                        && node.id !== 'rp-hub-preview-tailwind';
                                                });
                                            });
                                            if (needsCompile) scheduleCompile();
                                        });

                                        observer.observe(document.documentElement, {
                                            attributes: true,
                                            attributeFilter: ['class'],
                                            childList: true,
                                            subtree: true
                                        });
                                        scheduleCompile();
                                    }

                                    if (document.readyState === 'loading') {
                                        document.addEventListener('DOMContentLoaded', startTailwindRuntime, { once: true });
                                    } else {
                                        startTailwindRuntime();
                                    }
                                })();
                            <\\/script>
                        \`;
                        uiHTML = \`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">\${tailwindRuntime}</head><body class="bg-base-100 p-4"></body></html>\`;`;
  source = replaceOnce(
    source,
    '                        uiHTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"><script src="https://cdn.tailwindcss.com"></` + `script></head><body class="bg-base-100 p-4"></body></html>`;',
    previewFallback,
    'character local Tailwind preview runtime'
  );
  const requirements = [
    '../assets/vendor/fonts/fonts.css',
    '../assets/generated/character.css',
    '../assets/vendor/vue/vue.global.prod.js',
    '../assets/vendor/localforage/localforage.min.js'
  ];
  requirements.push('../assets/vendor/tailwind-preview/tailwind-runtime.min.js');
  for (const anchor of requirements) {
    const count = countOccurrences(source, anchor);
    if (count !== 1) throw new Error(`Expected exactly one character/index.html offline asset ${anchor}, found ${count}`);
  }
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
