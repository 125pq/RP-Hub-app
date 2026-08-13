import { editText, requireContains } from '../lib.mjs';

const category = 'offline-assets';

export async function applyOfflineAssetHooks() {
  const changes = [];
  const requirements = {
    'index.html': [
      'assets/generated/main.css',
      'assets/vendor/vue/vue.global.prod.js',
      'assets/vendor/marked/marked.min.js',
      'assets/vendor/dompurify/purify.min.js'
    ],
    'character/index.html': [
      '../assets/generated/character.css',
      '../assets/vendor/vue/vue.global.prod.js',
      '../assets/vendor/localforage/localforage.min.js'
    ],
    'novel/index.html': [
      '../assets/generated/novel.css',
      '../assets/vendor/vue/vue.global.prod.js',
      '../assets/vendor/marked/marked.min.js'
    ]
  };

  for (const [file, anchors] of Object.entries(requirements)) {
    changes.push(await editText(file, category, source => {
      for (const anchor of anchors) requireContains(source, anchor, `${file} offline asset ${anchor}`);
      if (/https?:\/\/(?:cdn\.tailwindcss\.com|unpkg\.com\/vue|cdn\.jsdelivr\.net\/npm\/daisyui)/.test(source)) {
        throw new Error(`Remote runtime dependency returned in ${file}; update patch-offline-assets.mjs`);
      }
      return source;
    }));
  }
  return changes.filter(Boolean);
}
