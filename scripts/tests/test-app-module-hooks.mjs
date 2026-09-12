import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { patchAppChatImport } from '../upstream-sync/patches/patch-app-chat-import.mjs';
import { patchBackupApp } from '../upstream-sync/patches/patch-backup.mjs';
import { patchAppOffscreen } from '../upstream-sync/patches/patch-app-offscreen.mjs';
const current = readFileSync('assets/js/app.js', 'utf8').replace(/\r\n/g, '\n');
const upstream = execFileSync('git', ['show', '4aef0bb:assets/js/app.js'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
for (const transform of [patchAppChatImport, patchBackupApp, patchAppOffscreen]) {
  assert.equal(transform(current), current);
  const rebuilt = transform(upstream);
  assert.equal(transform(rebuilt), rebuilt);
  assert.equal(transform(upstream + '\n// new upstream code'), rebuilt + '\n// new upstream code');
}
assert.throws(() => patchAppChatImport(upstream.replace("if (records.some(message", "if (records.every(message")), /importer changed/);
assert.throws(() => patchAppChatImport(upstream + "\n            if (file.name.toLowerCase().endsWith('.jsonl')) {\n"), /ambiguous/);
assert.throws(() => patchAppOffscreen(upstream.replace('watch(chatContainer, (container)', 'watch(otherContainer, (container)')), /anchor/);
assert.throws(() => patchAppOffscreen(current.replace('            window.RPHubOffscreenIframeLifecycle?.attach(container);\n', '') + '\n            window.RPHubOffscreenIframeLifecycle?.attach(container);\n'), /moved/);
const branchStart = "            if (file.name.toLowerCase().endsWith('.jsonl')) {\n";
const branchEnd = "            } else if (file.type === 'application/json'";
const branch = source => source.slice(source.indexOf(branchStart) + branchStart.length, source.indexOf(branchEnd));
assert.equal(branch(patchAppChatImport(upstream)), branch(current));
for (const failure of [false, true]) {
  const events = [];
  const context = vm.createContext({ file: { name: 'chat.jsonl' }, _isApplyingCharacterScopedData: true,
    importCharacterChatJsonl: async file => { events.push(file.name); if (failure) throw new Error('bad file'); },
    showToast: (...args) => events.push(args), console: { error() {} }
  });
  await vm.runInContext(branch(current), context);
  assert.equal(context._isApplyingCharacterScopedData, !failure);
  assert.equal(events[0], 'chat.jsonl');
  if (failure) assert.deepEqual(events[1], ['聊天记录解析失败: bad file', 'error']);
}
const marker = '        // Backup flush bridges (local full-backup export/restore).';
const registration = source => source.slice(source.indexOf(marker), source.indexOf('        onBeforeUnmount(() => {', source.indexOf(marker)));
assert.equal(registration(patchBackupApp(upstream)), registration(current));
for (const failSave of [false, true]) {
  const events = [], callbacks = new Map();
  const bridge = { register: (name, callback) => { callbacks.set(name, callback); return bridge; }, flushEmbeddedFrame: name => events.push(name) };
  const context = vm.createContext({ window: { RPHubBackupBridge: bridge }, _memorySettingsSaveTimer: 42,
    clearTimeout: value => events.push(['clear', value]), saveData: async options => { events.push(['save', { ...options }]); if (failSave) throw new Error('flush failed'); },
    flushPendingChatHistorySave: async () => events.push('chat'), saveStoryBranchesForCharacter: async () => events.push('branches'), saveTokenUsageHistoryNow: async () => events.push('tokens')
  });
  vm.runInContext(registration(current), context);
  assert.deepEqual([...callbacks.keys()], ['main-app', 'character-frame', 'novel-frame']);
  if (failSave) await assert.rejects(callbacks.get('main-app')(), /flush failed/);
  else {
    await callbacks.get('main-app')(); await callbacks.get('character-frame')(); await callbacks.get('novel-frame')();
    assert.deepEqual(events.slice(2), ['chat', 'branches', 'tokens', 'character', 'novel']);
  }
  assert.equal(context._memorySettingsSaveTimer, null);
}
console.log('App module hooks: pure upstream replay, unchanged current source, importer error routing and backup flush ordering PASS');
