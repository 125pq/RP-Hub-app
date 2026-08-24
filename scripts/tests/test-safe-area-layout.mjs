import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { patchSidebarHeaderPadding } from '../upstream-sync/patches/patch-safe-area.mjs';

const css = await readFile(new URL('../../assets/css/safe-area.css', import.meta.url), 'utf8');
const index = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
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
