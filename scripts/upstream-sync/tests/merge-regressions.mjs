import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectRoot } from '../lib.mjs';
import { patchSidebarComponentTemplate } from '../patches/patch-sidebar-rendering.mjs';
import path from 'node:path';

const read = relative => readFile(path.join(projectRoot, relative), 'utf8');

// This test guards the semantic contract of the upstream 1.8.4 merge into the
// RP-Hub-app branch. It does NOT try to re-verify every algorithm — it asserts
// that the pieces we promised to preserve are all present, so a future upstream
// sync that drops them fails loudly instead of silently regressing.

function assertAll(source, needles, label) {
  const missing = needles.filter(needle => !source.includes(needle));
  assert.deepEqual(missing, [], `${label}: missing ${JSON.stringify(missing)}`);
}

// ---- assets/js/app.js ----
const app = await read('assets/js/app.js');
assertAll(app, [
  // 1.8.4 quoted-dialogue protection + local filter cache
  'quotedDialoguePattern',
  '.split(quotedDialoguePattern)',
  'filteredContentCache',
  'FILTERED_CONTENT_CACHE_MAX',
  // countOnly fast path (local performance overlay)
  'countOnly',
  // UI template update block finder (imported from data-services)
  'findUiTemplateUpdateBlock',
  // Android lifecycle / adapters (local platform overlay)
  'initializePlatformAdapters',
  'removePlatformBackListener',
  'removePlatformStateListener',
  'RPHubOffscreenIframeLifecycle'
], 'app.js contract');

// ---- assets/js/core-utils.js ----
const core = await read('assets/js/core-utils.js');
assertAll(core, [
  'findLastUnprotectedMatch',
  'getPlatformAdapter',
  'saveGeneratedFile',
  'Symbol.asyncIterator'
], 'core-utils.js contract');

// 1.8.4 streaming unclosed-content protection (anomaly-filter fix)
for (const tag of ['<!DOCTYPE html>[\\s\\S]*$', '<html\\b[^>]*>[\\s\\S]*$', '<script\\b[^>]*>[\\s\\S]*$', '<style\\b[^>]*>[\\s\\S]*$', '```[\\s\\S]*$']) {
  assert.ok(core.includes(tag), `core-utils.js must protect unclosed streaming content: ${tag}`);
}

// ---- assets/js/data-services.js ----
const data = await read('assets/js/data-services.js');
assertAll(data, [
  // 1.8.4 secondary-memory compression runtime model
  'normalizeClassicMemoryForRuntime',
  'secondaryCompressed',
  'turnStart',
  'turnEnd',
  'sourceMemories',
  // UI template parsing (1.8.4)
  'findUiTemplateUpdateBlock',
  'createDetailedJsonSyntaxError',
  // local processMainContent cache
  'processMainContent',
  'processMainContentCache'
], 'data-services.js contract');

// ---- assets/js/ui-components.js ----
const ui = await read('assets/js/ui-components.js');
assertAll(ui, [
  'rphub:update-available',
  'remoteUpdateId',
  'safe-sidebar-header'
], 'ui-components.js contract');

// ---- assets/js/presence.js ----
const presence = await read('assets/js/presence.js');
assertAll(presence, [
  'versionId',
  'latestVersionId',
  'updateAvailable',
  // Native guard: suppress the web "refresh to update" prompt in the APK
  "window.platformAdapter?.isNative?.() === true"
], 'presence.js contract');

// ---- index.html script loading order (platform adapter before app.js) ----
const index = await read('index.html');
const platformIdx = index.indexOf('platform-services.js');
const adapterIdx = index.indexOf('rphub-android-adapter.js');
const appIdx = index.indexOf('assets/js/app.js');
assert.ok(platformIdx !== -1, 'index.html must load platform-services.js');
assert.ok(adapterIdx !== -1, 'index.html must load rphub-android-adapter.js');
assert.ok(appIdx !== -1, 'index.html must load app.js');
assert.ok(platformIdx < adapterIdx, 'platform-services.js must load before rphub-android-adapter.js');
assert.ok(adapterIdx < appIdx, 'rphub-android-adapter.js must load before app.js');


// ---- assets/css/styles.css (.app-sidebar rendering stability) ----
const css = await read('assets/css/styles.css');
assert.ok(css.includes('.app-sidebar'), 'styles.css must define .app-sidebar');

// Extract all .app-sidebar rule blocks
const sidebarMatches = [...css.matchAll(/(?:^|\n)[ \t]*\.app-sidebar\s*\{([\s\S]*?)\n[ \t]*\}/g)];
assert.ok(sidebarMatches.length > 0, 'Must find at least one .app-sidebar CSS rule');

for (const match of sidebarMatches) {
  const block = match[1];
  assert.ok(!block.includes('contain: layout paint style'), '.app-sidebar must not have contain: layout paint style');
  assert.ok(!block.includes('will-change: transform'), '.app-sidebar must not have will-change: transform');
  assert.ok(!block.includes('backface-visibility: hidden'), '.app-sidebar must not have backface-visibility: hidden');
}

// ---- assets/js/ui-components.js (.app-sidebar width class collision) ----
// The sidebar element must not carry a static desktop expanded width that
// collides with the dynamic collapsed width; the two branches must be mutually
// exclusive so the offline precompiled CSS cascade cannot keep it at 288px.
const uiComponents = await read('assets/js/ui-components.js');
assert.doesNotMatch(uiComponents, /class="app-sidebar[^"]*\bw-72\b[^"]*\bmd:w-72\b/, 'app-sidebar must not carry static w-72 md:w-72');
assert.match(uiComponents, /:class="collapsed \? 'w-16 md:w-16' : 'w-72 md:w-72'"/, 'app-sidebar width must switch between w-16 md:w-16 and w-72 md:w-72');

// Patch unit checks: idempotent, and fails loudly when the upstream snippet
// has drifted instead of silently matching nothing.
const upstreamSnippet = `            <div class="app-sidebar fixed inset-y-0 left-0 z-50 w-72 md:w-72 bg-white/95 border-r border-gray-200/80 transform transition-all duration-300 md:relative md:translate-x-0 flex flex-col shadow-2xl md:shadow-sm md:rounded-none rounded-r-3xl overflow-hidden"
                :class="collapsed ? 'md:w-16' : 'md:w-72'">`;
const patched = patchSidebarComponentTemplate(upstreamSnippet);
assert.ok(!patched.includes('z-50 w-72 md:w-72 bg-white'), 'patch must remove static w-72 md:w-72');
assert.ok(patched.includes(":class=\"collapsed ? 'w-16 md:w-16' : 'w-72 md:w-72'\""), 'patch must produce mutually exclusive width classes');
assert.equal(patchSidebarComponentTemplate(patched), patched, 'patch must be idempotent');
assert.throws(() => patchSidebarComponentTemplate(upstreamSnippet.replace('md:w-72 bg-white', 'md:w-72 CHANGED')), /app-sidebar width classes/, 'patch must fail on drifted upstream snippet');

const syncUpstreamSource = await read('scripts/upstream-sync/sync-upstream.mjs');
assert.match(syncUpstreamSource, /git\(\s*\['merge',\s*'--no-ff',\s*'--no-commit',\s*upstreamHead\],\s*\{\s*allowFailure:\s*true,\s*capture:\s*true\s*\}\s*\)/);
assert.match(syncUpstreamSource, /if\s*\(\s*conflicts\s*\)\s*\{[\s\S]*MERGE_CONFLICTS=\\n[\s\S]*Upstream merge conflicted and was aborted/);
assert.match(syncUpstreamSource, /Upstream git merge failed without content conflicts/);
assert.doesNotMatch(syncUpstreamSource, /MERGE_CONFLICTS=\\n\$\{conflicts\s*\|\|\s*'\(unknown\)'\}/);

const appSource = await read('assets/js/app.js');
assert.match(appSource, /normalizeClassicMemoryConcurrency\(memorySettings\.classicConcurrency\)/);
assert.match(appSource, /compressEligibleClassicMemories\s*=\s*async\s*\(totalTurns,\s*signal,\s*interactive\s*=\s*false\)/);
assert.match(appSource, /showVueConfirmModal/);
assert.match(appSource, /总结模式补录遇到错误/);
assert.match(appSource, /getClassicSecondaryMemoryMarker\(memory\)\.length/);
assert.match(appSource, /batchController\.signal,\s*manual/);
const presenceServerSource = await read('presence-server/server.js');
assert.match(presenceServerSource, /if\s*\(versionRefreshPromise\)\s*return\s*versionRefreshPromise;/);
assert.match(presenceServerSource, /latestVersionId\s*=\s*Math\.max\(latestVersionId,\s*versionId\);/);
console.log('Upstream 1.8.4 merge regression contract: PASS');
