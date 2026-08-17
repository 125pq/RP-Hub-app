import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../../assets/css/safe-area.css', import.meta.url), 'utf8');
const gradle = await readFile(new URL('../../android/app/build.gradle', import.meta.url), 'utf8');

const wideLayout = css.match(/@media \(min-width: 769px\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(wideLayout, /\.safe-sidebar-header[\s\S]*padding-top:\s*var\(--safe-top\)/);
assert.match(wideLayout, /\.chat-header-controls[\s\S]*padding-top:\s*var\(--safe-top\)/);
assert.match(wideLayout, /\.chat-header-controls[\s\S]*padding-right:\s*calc\(1rem \+ var\(--safe-right\)\)/);
assert.match(wideLayout, /\.chat-header-controls[\s\S]*padding-left:\s*calc\(1rem \+ var\(--safe-left\)\)/);
assert.match(wideLayout, /\.input-area-mobile[\s\S]*bottom:\s*calc\(var\(--keyboard-inset, 0px\) \+ var\(--safe-bottom-effective\)\)/);
assert.match(wideLayout, /\.input-area-mobile[\s\S]*padding-right:\s*calc\(0\.75rem \+ var\(--safe-right\)\)/);
assert.match(wideLayout, /\.input-area-mobile[\s\S]*padding-left:\s*calc\(0\.75rem \+ var\(--safe-left\)\)/);

assert.match(gradle, /debug\s*\{[\s\S]*applicationIdSuffix\s+'\.debug'/);
assert.doesNotMatch(gradle, /releaseCandidate|applicationIdSuffix\s+'\.rc'/);

console.log('Tablet safe-area layout and Android package variants: PASS');
