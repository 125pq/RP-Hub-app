import { editText } from '../lib.mjs';

const category = 'webview-sidebar-rendering';

/**
 * Transforms CSS text to remove rendering-hazard properties from `.app-sidebar` rule(s).
 * Specifically removes:
 *  - `contain: layout paint style;`
 *  - `will-change: transform;`
 *  - `backface-visibility: hidden;`
 *
 * Scoped strictly to `.app-sidebar { ... }` block inside media query / rules.
 * Fails fast if `.app-sidebar` rule cannot be found.
 * Idempotent: returns original source if already clean.
 */
export function patchSidebarRenderingCss(source) {
  // Matches `.app-sidebar` rule blocks precisely (handling selectors like `.app-sidebar { ... }`)
  // Avoids sub-selectors like `.app-sidebar.mobile-sidebar-open` or `.app-sidebar:not(...)`
  const sidebarBlockRegex = /(^|\n)([ \t]*\.app-sidebar\s*\{[\s\S]*?\n[ \t]*\})/g;

  let found = false;
  let changed = false;

  const result = source.replace(sidebarBlockRegex, (match, prefix, block) => {
    found = true;

    // Remove the 3 problematic properties if present inside this block
    const cleanedBlock = block
      .replace(/[ \t]*contain:\s*layout\s+paint\s+style\s*;\r?\n?/g, '')
      .replace(/[ \t]*will-change:\s*transform\s*;\r?\n?/g, '')
      .replace(/[ \t]*backface-visibility:\s*hidden\s*;\r?\n?/g, '');

    if (cleanedBlock !== block) {
      changed = true;
      return `${prefix}${cleanedBlock}`;
    }
    return match;
  });

  if (!found) {
    throw new Error('Missing target CSS rule: .app-sidebar');
  }

  // Double check that no .app-sidebar block still retains any of the 3 properties
  for (const match of result.matchAll(/(^|\n)([ \t]*\.app-sidebar\s*\{[\s\S]*?\n[ \t]*\})/g)) {
    const block = match[2];
    if (
      block.includes('contain: layout paint style') ||
      block.includes('will-change: transform') ||
      block.includes('backface-visibility: hidden')
    ) {
      throw new Error('Failed to fully strip rendering stability properties from .app-sidebar');
    }
  }

  return changed ? result : source;
}

export async function applySidebarRenderingHooks() {
  const changes = [];
  const editResult = await editText('assets/css/styles.css', category, patchSidebarRenderingCss);
  if (editResult) {
    changes.push(editResult);
  }
  return changes;
}
