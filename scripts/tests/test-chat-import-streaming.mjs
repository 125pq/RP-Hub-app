import { webFixturePath } from './web-fixture.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 阶段 2:聊天 JSONL 导入(assets/js/chat-import-streaming.js)的真实调用路径与失败处理。
// 通过 createChatImporter() 工厂(即 app.js:importCharacterChatJsonl 的实际入口)驱动,
// 覆盖:legacy / 分支导入成功、损坏与截断回滚、取消(abort)、以及去掉全量 clone 后
// 的存储契约(存储引用与展示准备一致)。

const ioSource = await readFile(webFixturePath('assets/js/rphub-io.js'), 'utf8');
const chatSource = await readFile(webFixturePath('assets/js/chat-import-streaming.js'), 'utf8');

const STORY_BRANCH_CHAT_EXPORT_TYPE = 'rp-hub-story-branch-chat';
const STORY_BRANCH_CHAT_EXPORT_VERSION = 1;
const STORY_BRANCH_MAIN_ID = 'main';

function makeStorage() {
  const store = new Map();
  const deletes = [];
  const cloneCalls = [];
  return {
    store,
    deletes,
    cloneCalls,
    async setScopedStoredValue(name, id, value) { store.set(`${name}:${id}`, value); },
    async getScopedStoredValue(name, id) { return store.get(`${name}:${id}`); },
    // Destructured by the importer, so these must not rely on `this`.
    async deleteScopedStoredValue(name, id) { deletes.push(`${name}:${id}`); store.delete(`${name}:${id}`); },
    cloneForStorage(value) { cloneCalls.push(value); return JSON.parse(JSON.stringify(value)); },
    getMainDb() { return {}; },
    async initDB() {}
  };
}

const storyBranchesUtil = Object.freeze({
  STORY_BRANCH_CHAT_EXPORT_TYPE,
  STORY_BRANCH_CHAT_EXPORT_VERSION,
  STORY_BRANCH_MAIN_ID,
  normalizeStoryBranches: (char, state) => (state?.branches || []).map(branch => ({
    id: String(branch.id),
    name: branch.name || String(branch.id)
  })),
  getStoryBranchScopeId: (uuid, branchId) => `${uuid}::${branchId}`
});

function loadFactory() {
  const win = {};
  win.window = win;
  const sandbox = { window: win, TextDecoder, TextEncoder, setTimeout, clearTimeout, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ioSource, sandbox, { filename: 'rphub-io.js' });
  vm.runInContext(chatSource, sandbox, { filename: 'chat-import-streaming.js' });
  const storage = makeStorage();
  win.RPHubBackup = {
    async createRecoveryBackup() {
      storage.recoveryCalls = (storage.recoveryCalls || 0) + 1;
      storage.recoverySnapshot = structuredClone([...storage.store]);
      return storage.cancelRecovery ? null : { filename: 'recovery-test.jsonl' };
    }
  };
  win.RPHubStorage = storage;
  win.RPHubStoryBranches = storyBranchesUtil;
  return { storage, createImporter: win.RPHubChatImport.createChatImporter };
}

function makeDeps(char) {
  const toasts = [];
  return {
    toasts,
    deps: {
      currentCharacterIndex: { value: 0 },
      currentCharacter: { value: char },
      showToast: (message, type) => toasts.push({ message, type }),
      stopCurrentCharacterWork: async () => true,
      getCurrentStoryBranchScopeId: () => `${char.uuid}::main`,
      setApplyingCharacterScopedData: () => {},
      storyBranches: { value: [] },
      activeStoryBranchId: { value: 'main' },
      selectedStoryBranchId: { value: 'main' },
      resetChatRenderWindow: () => {},
      chatHistory: { value: [] },
      // Mirrors the real app.js prepare: mutates messages in place and returns a filtered array.
      prepareLoadedChatHistoryForDisplay: (messages = []) => {
        messages.forEach(message => {
          if (message.isSelf === undefined) message.isSelf = message.role === 'user';
        });
        return messages.filter(message => message !== null && message !== undefined);
      },
      createInitialChatHistory: () => [],
      loadCharacterMemories: async () => {},
      loadGlobalUiTemplateRuntimeForCharacter: () => {},
      clearStoryBranchTransientContext: () => {},
      finishApplyingCharacterScopedData: () => {},
      currentView: { value: '' },
      scrollChatToBottom: async () => {},
      updateCurrentStoryBranchSummary: () => {},
      saveStoryBranchesForCharacter: async () => {}
    }
  };
}

function streamBytes(chunks) {
  return {
    stream() {
      let index = 0;
      return new ReadableStream({
        pull(controller) {
          if (index >= chunks.length) { controller.close(); return; }
          controller.enqueue(chunks[index++]);
        }
      });
    }
  };
}

function textFile(text) {
  return streamBytes([new TextEncoder().encode(text)]);
}

function byteChunkedFile(text) {
  const chunks = [];
  for (const byte of new TextEncoder().encode(text)) chunks.push(Uint8Array.of(byte));
  return streamBytes(chunks);
}

// 1) Legacy format success: stored reference is display-prepared and no full clone is made.
{
  const { storage, createImporter } = loadFactory();
  const char = { uuid: 'u1', name: 'Alice' };
  const { deps, toasts } = makeDeps(char);
  await createImporter(deps)(textFile('{"role":"user","content":"hi"}\n{"role":"assistant","content":"yo"}\n'));
  assert.equal(storage.cloneCalls.length, 0, 'legacy chat import must not clone the whole message array');
  const stored = storage.store.get('chat:u1::main');
  assert.ok(Array.isArray(stored) && stored.length === 2, 'legacy messages must be stored');
  assert.equal(stored[0].isSelf, true, 'stored reference must reflect display preparation (same array)');
  assert.equal(stored[1].isSelf, false);
  assert.match(toasts.at(-1).message, /Alice/);
  assert.equal(storage.deletes.length, 0);
}

// 2) Branch format success, fed one byte at a time to exercise the shared reader end-to-end.
{
  const { storage, createImporter } = loadFactory();
  const char = { uuid: 'u2', name: 'Bob' };
  const { deps, toasts } = makeDeps(char);
  const manifest = { type: STORY_BRANCH_CHAT_EXPORT_TYPE, version: 1, branches: [{ id: 'main', name: '主线' }, { id: 'b2', name: '支线' }], activeBranchId: 'b2' };
  const text = [
    JSON.stringify(manifest),
    JSON.stringify({ branchId: 'main', messages: [{ role: 'user', content: 'm0' }] }),
    JSON.stringify({ branchId: 'b2', messages: [{ role: 'user', content: 'm1' }, { role: 'assistant', content: 'm2' }] })
  ].join('\n') + '\n';
  await createImporter(deps)(byteChunkedFile(text));
  assert.ok(storage.store.has('chat:u2::main'), 'main branch stored');
  assert.ok(storage.store.has('chat:u2::b2'), 'second branch stored');
  assert.ok(storage.store.has('branches:u2'), 'branch metadata stored');
  assert.equal(deps.activeStoryBranchId.value, 'b2');
  assert.ok(storage.cloneCalls.length >= 1, 'branch metadata is still cloned for storage isolation');
  assert.equal(storage.deletes.length, 0);
  assert.match(toasts.at(-1).message, /2 个分支/);
}

// 3) Corrupt branch record: reject before writing any branch.
{
  const { storage, createImporter } = loadFactory();
  const char = { uuid: 'u3', name: 'Carol' };
  const { deps } = makeDeps(char);
  const manifest = { type: STORY_BRANCH_CHAT_EXPORT_TYPE, version: 1, branches: [{ id: 'main', name: '主线' }], activeBranchId: 'main' };
  const text = [
    JSON.stringify(manifest),
    JSON.stringify({ branchId: 'main', messages: [{ role: 'user', content: 'm0' }] }),
    'not-json'
  ].join('\n') + '\n';
  await assert.rejects(() => createImporter(deps)(textFile(text)), /分支聊天数据不完整/);
  assert.equal(storage.deletes.length, 0, 'validation must never delete existing chat');
  assert.equal(storage.recoveryCalls || 0, 0, 'invalid files must not ask for a recovery export');
  assert.equal(storage.store.has('branches:u3'), false, 'no branch metadata on failed import');
}

// 4) Truncated branch file: reject without touching the existing branches.
{
  const { storage, createImporter } = loadFactory();
  const char = { uuid: 'u4', name: 'Dave' };
  const { deps } = makeDeps(char);
  const manifest = { type: STORY_BRANCH_CHAT_EXPORT_TYPE, version: 1, branches: [{ id: 'main', name: '主线' }, { id: 'b2', name: '支线' }], activeBranchId: 'main' };
  const text = [
    JSON.stringify(manifest),
    JSON.stringify({ branchId: 'main', messages: [{ role: 'user', content: 'm0' }] })
  ].join('\n') + '\n';
  await assert.rejects(() => createImporter(deps)(textFile(text)), /缺少分支/);
  assert.equal(storage.deletes.length, 0, 'truncation must not write or delete chat');
  assert.equal(storage.recoveryCalls || 0, 0);
}

// 5) Corrupt legacy JSON: reject with no writes.
{
  const { storage, createImporter } = loadFactory();
  const char = { uuid: 'u5', name: 'Erin' };
  const { deps } = makeDeps(char);
  await assert.rejects(() => createImporter(deps)(textFile('{"role":"user"}\nnot-json\n')), /无效 JSON/);
  assert.equal(storage.store.size, 0, 'nothing must be stored for corrupt legacy data');
}

// 6) Abort via stopCurrentCharacterWork: no writes, no rollback deletes.
{
  const { storage, createImporter } = loadFactory();
  const char = { uuid: 'u6', name: 'Frank' };
  const { deps } = makeDeps(char);
  deps.stopCurrentCharacterWork = async () => false;
  const manifest = { type: STORY_BRANCH_CHAT_EXPORT_TYPE, version: 1, branches: [{ id: 'main', name: '主线' }], activeBranchId: 'main' };
  await createImporter(deps)(textFile(JSON.stringify(manifest) + '\n' + JSON.stringify({ branchId: 'main', messages: [] }) + '\n'));
  assert.equal(storage.store.size, 0, 'aborted import must not write');
  assert.equal(storage.deletes.length, 0, 'abort is not an error rollback');
}

// Existing data is the essential fixture: a failed import must not erase it.
for (const mode of ['truncated', 'corrupt', 'cancel', 'write', 'metadata']) {
  const { storage, createImporter } = loadFactory();
  const { deps } = makeDeps({ uuid: 'old', name: 'Existing' });
  storage.store.set('chat:old::main', [{ role: 'user', content: 'original main' }]);
  storage.store.set('chat:old::b2', [{ role: 'user', content: 'original branch' }]);
  storage.store.set('branches:old', { branches: [{ id: 'main' }, { id: 'b2' }] });
  const before = structuredClone([...storage.store]);
  const manifest = { type: STORY_BRANCH_CHAT_EXPORT_TYPE, version: 1, branches: [{ id: 'main' }, { id: 'b2' }], activeBranchId: 'main' };
  const records = [manifest, { branchId: 'main', messages: [{ role: 'user', content: 'new' }] }];
  if (mode !== 'truncated') records.push({ branchId: 'b2', messages: [] });
  let text = records.map(record => JSON.stringify(record)).join('\n');
  if (mode === 'corrupt') text += '\nnot-json';
  storage.cancelRecovery = mode === 'cancel';
  const put = storage.setScopedStoredValue;
  storage.setScopedStoredValue = async (name, id, value) => {
    if ((mode === 'write' && id === 'old::b2') || (mode === 'metadata' && name === 'branches')) throw new Error('injected storage failure');
    return put(name, id, value);
  };
  if (mode === 'cancel') await createImporter(deps)(textFile(text));
  else await assert.rejects(() => createImporter(deps)(textFile(text)), error => {
    if (mode === 'write' || mode === 'metadata') {
      assert.equal(error.partialWrite, true);
      assert.match(error.message, /recovery-test.jsonl/);
      assert.deepEqual(storage.recoverySnapshot, before, 'recovery must contain the old data before any overwrite');
    }
    return true;
  });
  assert.equal(storage.deletes.length, 0, 'deletion is not rollback');
  if (['truncated', 'corrupt', 'cancel'].includes(mode)) assert.deepEqual([...storage.store], before);
}

console.log('chat JSONL import: success, full validation, existing-data preservation, recovery cancellation and write failure: PASS');
