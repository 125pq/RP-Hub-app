import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { patchChatExport } from '../upstream-sync/patches/patch-chat-export.mjs';
const read = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const current = read('assets/js/app.js');
const old = execFileSync('git', ['show', '2780a81:assets/js/app.js'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
const upstream = execFileSync('git', ['show', '4aef0bb:assets/js/app.js'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
function extract(source) {
  return source.slice(source.indexOf('        const exportCharacterChat = async'), source.indexOf('        const exportCharacterPng = async'));
}
for (const source of [old, upstream, current]) {
  const patched = patchChatExport(source);
  assert.equal(patchChatExport(patched), patched);
  assert.equal(extract(patched), extract(current), 'real upstream/local export reconstructs the same implementation');
}
assert.equal(patchChatExport(upstream + '\n// unrelated change'), patchChatExport(upstream) + '\n// unrelated change');
assert.throws(() => patchChatExport(upstream.replace('floorCount: getPostprocessedChatMessages', 'floorCount: changedProcessor')), /drifted/);
assert.throws(() => patchChatExport(upstream + extract(upstream)), /ambiguous/);
const moduleSource = read('assets/js/chat-export-streaming.js');
const clone = data => JSON.parse(JSON.stringify(data));
async function run(source, scenario) {
  const toasts = [], saved = [], reads = [];
  let flushes = 0;
  const branches = [{ id: 'main', name: '主线', custom: '保留' }, { id: 'side', name: '支线' }];
  const main = scenario === 'empty' ? [] : [{ role: 'user', content: '你好😀' }, { role: 'assistant', content: '正文\n换行', tool_calls: [{ id: 't1' }], custom: { value: 1 } }];
  const side = scenario === 'empty' ? [] : [{ role: 'assistant', content: '支线' }];
  const context = vm.createContext({ window: {}, console: { error() {} }, Date: class extends Date { toISOString() { return '2026-09-12T00:00:00.000Z'; } },
    characters: { value: [{ uuid: scenario === 'legacy' ? '' : 'character', name: '测试' }] }, currentCharacterIndex: { value: scenario === 'inactive' ? 1 : 0 },
    storyBranches: { value: branches }, activeStoryBranchId: { value: scenario === 'legacy' ? 'side' : 'main' }, chatHistory: { value: main },
    getMainDb: () => ({}), initDB: async () => {}, flushPendingChatHistorySave: async () => { flushes++; },
    getScopedStoredValue: async (type, id) => { reads.push([type, id]); return type === 'branches' ? { branches, activeBranchId: 'side' } : id === 'character:side' ? side : main; },
    cloneForStorage: clone, normalizeStoryBranches: (_, stored) => stored.branches,
    getStoryBranchScopeId: (uuid, id) => `${uuid}:${id}`,
    getConversationBodyLength: messages => messages.reduce((n, message) => n + (message.content || '').length, 0),
    STORY_BRANCH_MAIN_ID: 'main', STORY_BRANCH_CHAT_EXPORT_TYPE: 'rp-hub-story-branch-chat', STORY_BRANCH_CHAT_EXPORT_VERSION: 1,
    showToast: (...args) => toasts.push(args), cardUtils: { saveGeneratedFile: async (stream, name, options) => {
      if (scenario === 'cancel') return { cancelled: true };
      if (scenario === 'failure') throw new Error('save failed');
      let text = ''; for await (const piece of stream) text += piece;
      saved.push({ name, options, text }); return { cancelled: false };
    } }
  });
  vm.runInContext(moduleSource, context);
  await vm.runInContext(extract(source) + `\nexportCharacterChat(${scenario === 'missing' ? 9 : 0});`, context);
  return JSON.parse(JSON.stringify({ toasts, saved, reads, flushes }));
}
for (const scenario of ['active', 'inactive', 'legacy', 'empty', 'missing', 'cancel', 'failure']) {
  const result = await run(current, scenario);
  assert.deepEqual(result, await run(old, scenario), scenario);
  if (scenario === 'cancel') assert.equal(result.toasts.length, 0);
  if (scenario === 'failure') assert.equal(result.toasts.at(-1)[1], 'error');
  if (scenario === 'active') {
    const records = result.saved[0].text.split('\n').map(JSON.parse);
    assert.equal(records.length, 3);
    assert.equal(records[0].branches[0].custom, '保留');
    assert.deepEqual(records[1].messages[1].custom, { value: 1 });
    assert.equal(records[0].branches[0].floorCount, 2);
  }
}
const context = vm.createContext({ window: {} }); vm.runInContext(moduleSource, context);
const api = context.window.RPHubChatExport;
let clones = 0;
const records = [{ branchId: 'main', messages: Array.from({ length: 10000 }, () => ({ content: '中😀'.repeat(100), role: 'assistant' })) }];
const stream = api.stream({ version: 1 }, records, value => { clones++; return clone(value); });
assert.equal(clones, 0);
let text = ''; for await (const chunk of stream) text += chunk;
assert.equal(clones, 10000);
assert.equal(text, [{ version: 1 }, ...records].map(JSON.stringify).join('\n'));
console.log('Chat export: final app path, all branches, legacy fallback, cancellation, errors, lazy byte parity and upstream reconstruction PASS');
