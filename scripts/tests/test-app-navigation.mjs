import { webFixturePath } from './web-fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { patchAndroidApp } from '../upstream-sync/patches/patch-android-hooks.mjs';
const previous = execFileSync('git', ['show', '6d66da9:assets/js/app.js'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
// Ignore the retired panel in the legacy oracle; it no longer exists in upstream setup.
const legacy = previous.slice(previous.indexOf('        const closeBooleanPanel ='), previous.indexOf('        const initializePlatformAdapters =')).replace('                showInstructionPanel,\n', '');
const current = readFileSync(webFixturePath('assets/js/app.js'), 'utf8').replace(/\r\n/g, '\n');
const bindingStart = current.indexOf('        const handlePlatformBackButton =');
const binding = current.slice(bindingStart, current.indexOf('        const initializePlatformAdapters =', bindingStart));
// Verify bindings against declarations, before constructing any fake state.
const declared = new Set([...current.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]));
for (const match of current.matchAll(/\b(?:const|let)\s*\{([^}]+)\}\s*=/g)) {
  for (const name of match[1].split(',')) declared.add(name.trim());
}
const boundNames = binding.match(/handleBack\(\{([\s\S]*?)\}\)/)[1].split(',').map(name => name.trim());
const assertDeclared = names => {
  for (const name of names) assert.ok(declared.has(name), 'Back binding references undeclared app state: ' + name);
};
assertDeclared(boundNames);
assert.throws(() => assertDeclared([...boundNames, 'showInstructionPanel']), /undeclared app state/);
assert.ok(!binding.includes('showInstructionPanel'));
const moduleSource = readFileSync(webFixturePath('assets/js/app-back-navigation.js'), 'utf8');
const names = [...new Set(legacy.match(/\b(?:show\w+|globalConfirmModal|settingsHelpTopic)\b/g))];
const upstream = execFileSync('git', ['show', '4aef0bb:assets/js/app.js'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
for (const source of [previous, upstream]) {
  const changed = patchAndroidApp(source);
  assert.equal(patchAndroidApp(changed), changed);
  assert.equal((changed.match(/const handlePlatformBackButton =/g) || []).length, 1);
  assert.ok(changed.includes('window.RPHubAppNavigation.handleBack'));
}
assert.throws(() => patchAndroidApp(previous.replace('modalPanels.some(closeBooleanPanel)', 'modalPanels.every(closeBooleanPanel)')), /drifted/);
assert.throws(() => patchAndroidApp(upstream.replace('const confirmCharacterExport =', 'const renamedExport =')), /anchor/);

async function run(active, useNew, cancel = true, listbox = false, sidebar = false) {
  const effects = [];
  const state = Object.fromEntries(names.map(name => [name, { value: active.includes(name) }]));
  state.globalConfirmModal.value = { show: active.includes('globalConfirmModal'), onCancel: cancel ? () => effects.push('cancelGlobal') : null };
  state.settingsHelpTopic.value = active.includes('settingsHelpTopic') ? 'help' : '';
  Object.assign(state, {
    handleCancel: () => effects.push('cancel'), isMobileSidebarOpen: sidebar,
    closeMobileMenu: () => effects.push('closeSidebar'), setMobileSidebarOpen: value => effects.push(['openSidebar', value])
  });
  const document = { querySelector: () => listbox, dispatchEvent: event => effects.push(['key', event.key]) };
  const KeyboardEvent = function (_, options) { Object.assign(this, options); };
  const context = vm.createContext({ ...state, document, KeyboardEvent, window: { document, KeyboardEvent } });
  let result;
  if (useNew) {
    vm.runInContext(moduleSource, context);
    result = await vm.runInContext(binding + '\nhandlePlatformBackButton();', context);
  } else {
    result = await vm.runInContext(legacy + '\nhandlePlatformBackButton();', context);
  }
  return JSON.parse(JSON.stringify({ result, effects, state }));
}
// Pairwise open panels verifies precedence, not just independent panel closure.
for (const first of [null, ...names]) {
  for (const second of [null, ...names]) {
    const active = [first, second].filter(Boolean);
    assert.deepEqual(await run(active, true), await run(active, false), active.join(','));
  }
}
for (const active of [[], ['globalConfirmModal'], ['showUserSetupModal'], ['showProfileDropdown']]) {
  for (const listbox of [false, true]) for (const sidebar of [false, true]) {
    assert.deepEqual(await run(active, true, false, listbox, sidebar), await run(active, false, false, listbox, sidebar));
  }
}
console.log('App navigation: legacy behavior parity, precedence, pristine upstream replay and drift rejection PASS');
