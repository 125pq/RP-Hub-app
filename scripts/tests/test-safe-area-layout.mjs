import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  patchSidebarHeaderPadding,
  patchWorkshopInputPanelSafeArea
} from '../upstream-sync/patches/patch-safe-area.mjs';
import { dominantEol, rebuildWithOriginalEol } from '../upstream-sync/lib.mjs';

const css = await readFile(new URL('../../assets/css/safe-area.css', import.meta.url), 'utf8');
const index = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const character = await readFile(new URL('../../character/index.html', import.meta.url), 'utf8');
const gradle = await readFile(new URL('../../android/app/build.gradle', import.meta.url), 'utf8');

const wideLayout = css.match(/@media \(min-width: 769px\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(wideLayout, /\.safe-sidebar-header[\s\S]*padding-top:\s*var\(--safe-top\)/);
assert.match(wideLayout, /\.chat-header-controls[\s\S]*padding-top:\s*var\(--safe-top\)/);
assert.match(wideLayout, /\.chat-header-controls[\s\S]*padding-right:\s*calc\(1rem \+ var\(--safe-right\)\)/);
assert.match(wideLayout, /\.chat-header-controls[\s\S]*padding-left:\s*calc\(1rem \+ var\(--safe-left\)\)/);
assert.match(wideLayout, /\.input-area-mobile[\s\S]*bottom:\s*calc\(var\(--keyboard-inset, 0px\) \+ var\(--safe-bottom-effective\)\)/);
assert.match(wideLayout, /\.input-area-mobile[\s\S]*padding-right:\s*calc\(0\.75rem \+ var\(--safe-right\)\)/);
assert.match(wideLayout, /\.input-area-mobile[\s\S]*padding-left:\s*calc\(0\.75rem \+ var\(--safe-left\)\)/);

const expandedSidebarHeader = css.match(/\.safe-sidebar-header\.px-6 \{([\s\S]*?)\n\s*\}/)?.[1] || '';
assert.match(expandedSidebarHeader, /padding-right:\s*calc\(1\.5rem \+ var\(--safe-right\)\)/);
assert.match(expandedSidebarHeader, /padding-left:\s*calc\(1\.5rem \+ var\(--safe-left\)\)/);
assert.equal((css.match(/\.safe-sidebar-header\.px-6\s*\{/g) || []).length, 1);
assert.doesNotMatch(css, /\.safe-sidebar-header\.px-0\s*\{/);

const sidebarCssFixture = `@media (max-width: 768px) {
    .safe-sidebar-footer {
        padding: 0;
    }
}`;
const patchedSidebarCssFixture = patchSidebarHeaderPadding(sidebarCssFixture);
assert.match(patchedSidebarCssFixture, /\.safe-sidebar-header\.px-6\s*\{[\s\S]*padding-right:\s*calc\(1\.5rem \+ var\(--safe-right\)\)[\s\S]*padding-left:\s*calc\(1\.5rem \+ var\(--safe-left\)\)/);
assert.equal(patchSidebarHeaderPadding(patchedSidebarCssFixture), patchedSidebarCssFixture);

// Upstream 1.9.3 dropped md:pb-24 from the panel class; the bottom inset is
// owned by the registered #app .workshop-input-panel rule in safe-area.css.
const upstreamWorkshopClass = 'workshop-input-panel bg-base-100/95 backdrop-blur-lg border-t border-base-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-4px_20px_rgba(0,0,0,0.05)] z-30 shrink-0';
assert.equal((character.match(/class="workshop-input-panel [^"]+"/g) || []).length, 1);
assert.match(character, new RegExp(`class="${upstreamWorkshopClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
assert.doesNotMatch(character, /class="workshop-input-panel [^"]*--safe-area-inset-bottom/);

const workshopRule = css.match(/^#app \.workshop-input-panel \{([\s\S]*?)^\}/m)?.[1] || '';
assert.match(workshopRule, /padding-bottom:\s*calc\(1rem \+ var\(--safe-bottom-effective\)\)/);
const mediumWorkshopRule = css.match(/@media \(min-width: 768px\) \{\s*#app \.workshop-input-panel \{([\s\S]*?)\n\s*\}\s*\}/)?.[1] || '';
assert.match(mediumWorkshopRule, /padding-bottom:\s*max\(6rem, calc\(1rem \+ var\(--safe-bottom-effective\)\)\)/);

const legacyWorkshopCss = `#app .workshop-input-panel {
    padding-right: calc(1rem + var(--safe-right));
    padding-bottom: calc(1rem + var(--safe-bottom-effective));
    padding-left: calc(1rem + var(--safe-left));
}`;
const patchedWorkshopCss = patchWorkshopInputPanelSafeArea(legacyWorkshopCss);
assert.match(patchedWorkshopCss, /@media \(min-width: 768px\)/);
assert.equal(patchWorkshopInputPanelSafeArea(patchedWorkshopCss), patchedWorkshopCss);
assert.match(
  patchWorkshopInputPanelSafeArea(`${legacyWorkshopCss}\n/* unrelated upstream rule drift */`),
  /unrelated upstream rule drift/,
  'unrelated CSS drift must survive workshop safe-area migration'
);
assert.throws(
  () => patchWorkshopInputPanelSafeArea(`${patchedWorkshopCss}\n${legacyWorkshopCss}`),
  /character workshop input CSS rules/,
  'duplicate workshop CSS selectors must fail closed'
);
assert.throws(
  () => patchWorkshopInputPanelSafeArea(legacyWorkshopCss.replace('var(--safe-bottom-effective)', 'var(--drifted-bottom)')),
  /legacy character workshop input CSS rule/,
  'drifted workshop CSS rule must fail closed'
);
const driftedWorkshopCss = legacyWorkshopCss.replace('var(--safe-bottom-effective)', 'var(--drifted-bottom)');
assert.throws(
  () => patchWorkshopInputPanelSafeArea(`/* ${legacyWorkshopCss} */\n${driftedWorkshopCss}`),
  /legacy character workshop input CSS rule/,
  'commented legacy rule with drifted real rule must fail closed'
);
const patchWorkshopCssBlob = source => rebuildWithOriginalEol(
  source,
  patchWorkshopInputPanelSafeArea(source.replace(/\r\n/g, '\n')),
  dominantEol(source)
);
for (const fixture of [
  `${legacyWorkshopCss}\n`,
  `${legacyWorkshopCss.replace(/\n/g, '\r\n')}\r\n`,
  `${legacyWorkshopCss.split('\n').map((line, index) => `${line}${index % 2 ? '\n' : '\r\n'}`).join('')}`
]) {
  const once = patchWorkshopCssBlob(fixture);
  assert.equal(
    once.replace(/\r\n/g, '\n'),
    `${patchedWorkshopCss}\n`,
    'workshop CSS migration must preserve semantics for LF, CRLF, and mixed EOL input'
  );
  assert.equal(patchWorkshopCssBlob(once), once, 'workshop CSS migration must be byte-idempotent');
}

assert.equal((index.match(/data-safe-area="square-frame"/g) || []).length, 1);
assert.match(index, /currentView === 'square'[^>]*data-safe-area="square-frame"/);
assert.doesNotMatch(index, /currentView === '(?:generator|novel)'[^>]*data-safe-area="square-frame"/);
const squareFrame = css.match(/\[data-safe-area="square-frame"\] iframe \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(squareFrame, /top:\s*var\(--safe-top\)/);
assert.match(squareFrame, /right:\s*var\(--safe-right\)/);
assert.match(squareFrame, /left:\s*var\(--safe-left\)/);
assert.match(squareFrame, /bottom:\s*calc\(var\(--safe-area-keyboard-inset, var\(--keyboard-inset, 0px\)\) \+ var\(--safe-bottom-effective\)\)/);
assert.doesNotMatch(squareFrame, /width:\s*auto/);
assert.doesNotMatch(squareFrame, /height:\s*auto/);
assert.match(squareFrame, /width:\s*calc\(100% - var\(--safe-left\) - var\(--safe-right\)\)/);
assert.match(squareFrame, /height:\s*calc\(100% - var\(--safe-top\) - var\(--safe-area-keyboard-inset, var\(--keyboard-inset, 0px\)\) - var\(--safe-bottom-effective\)\)/);

assert.match(gradle, /debug\s*\{[\s\S]*applicationIdSuffix\s+'\.debug'/);
assert.doesNotMatch(gradle, /releaseCandidate|applicationIdSuffix\s+'\.rc'/);

console.log('Tablet safe-area layout and Android package variants: PASS');
