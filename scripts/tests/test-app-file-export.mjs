import { webFixturePath, readUpstreamSource } from './web-fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchAppFileExport } from '../upstream-sync/patches/patch-app-file-export.mjs';
const current = readFileSync(webFixturePath('assets/js/app.js'), 'utf8').replace(/\r\n/g, '\n');
const upstream = readUpstreamSource('assets/js/app.js');
const scopes = [
  ['        const downloadJsonFile =', '        const readJsonFileInput ='],
  ['        const exportCharacterJson =', '        const exportCharacterChat ='],
  ['        const exportCharacterPng =', '        // Preset Management'],
  ['            confirmExport:', '            importPresets:']
];
const scope = (source, [start, end]) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const rebuilt = patchAppFileExport(upstream);
assert.equal(patchAppFileExport(rebuilt), rebuilt);
assert.equal(patchAppFileExport(current), current);
for (const entry of scopes) assert.equal(scope(rebuilt, entry), scope(current, entry));
assert.equal(patchAppFileExport(upstream + '\n// new upstream logic'), rebuilt + '\n// new upstream logic');
assert.throws(() => patchAppFileExport(upstream.replace('downloadJsonFile(dataToExport, fileName);', 'differentSave(dataToExport, fileName);')), /drifted/);
assert.throws(() => patchAppFileExport(upstream + scope(upstream, scopes[0])), /ambiguous/);

const functions = scopes.slice(0, 3).map(entry => scope(current, entry)).join('\n');
const confirm = scope(current, scopes[3]).trim().replace(/^confirmExport:/, 'const confirmExport =').replace(/},$/, '};');
for (const operation of ['json', 'png', 'presets', 'regex', 'worldinfo', 'uitemplates']) {
  for (const outcome of ['success', 'cancel', 'failure']) {
    const toasts = [], calls = [];
    let settle;
    const pendingSave = new Promise((resolve, reject) => { settle = () => outcome === 'failure' ? reject(new Error('disk unavailable')) : resolve({ cancelled: outcome === 'cancel' }); });
    const modal = { value: true };
    const context = vm.createContext({ Blob, console: { error() {} },
      characters: { value: [{ name: '角色', avatar: 'avatar' }] }, currentCharacter: { value: { name: '角色' } },
      buildCharacterExportData: () => ({ spec: 'chara_card_v2', data: { name: '角色', unknown: '保留😀' } }),
      selectedExportIndices: { value: new Set([1, 0]) }, exportItems: { value: [{ id: 'first' }, { id: 'second' }] }, exportType: { value: operation }, showExportModal: modal,
      toRegexExportEntry: item => ({ regex: item.id }), toWorldInfoExportEntry: item => ({ world: item.id }), toUiTemplateExportEntry: item => ({ ui: item.id }),
      showToast: (...args) => toasts.push(args), cardUtils: {
        saveGeneratedFile: (data, name, options) => { calls.push({ data, name, options }); return pendingSave; },
        imageUrlToPngBytes: async () => new Uint8Array([1, 2]), encodeBase64Utf8: value => value,
        injectPngTextChunk: () => new Uint8Array([1, 2, 3])
      }
    });
    vm.runInContext(functions + '\n' + confirm, context);
    const task = vm.runInContext(operation === 'json' ? 'exportCharacterJson(0)' : operation === 'png' ? 'exportCharacterPng(0)' : 'confirmExport()', context);
    for (let i = 0; i < 10 && !calls.length; i++) await Promise.resolve();
    assert.equal(calls.length, 1, operation);
    assert.equal(toasts.length, 0, 'No success toast before save settles');
    assert.equal(modal.value, true);
    settle(); await task;
    if (outcome === 'cancel') { assert.equal(toasts.length, 0); assert.equal(modal.value, true); }
    else assert.equal(toasts.at(-1)[1], outcome === 'failure' ? 'error' : 'success');
    if (!['json', 'png'].includes(operation)) assert.equal(modal.value, outcome !== 'success');
    if (operation === 'json') assert.equal(JSON.parse(calls[0].data).data.unknown, '保留😀');
    if (operation === 'png') assert.deepEqual([...new Uint8Array(await calls[0].data.arrayBuffer())], [1, 2, 3]);
    if (operation === 'presets') assert.deepEqual(JSON.parse(calls[0].data), [{ id: 'first' }, { id: 'second' }]);
    if (operation === 'regex') assert.deepEqual(JSON.parse(calls[0].data), [{ regex: 'first' }, { regex: 'second' }]);
    if (operation === 'worldinfo') assert.deepEqual(JSON.parse(calls[0].data), { entries: [{ world: 'first' }, { world: 'second' }] });
    if (operation === 'uitemplates') assert.deepEqual(JSON.parse(calls[0].data), { type: 'rp-hub-ui-templates', templates: [{ ui: 'first' }, { ui: 'second' }] });
  }
}
console.log('App export save boundaries: upstream replay, unchanged output, delayed success, cancellation and failure PASS');
