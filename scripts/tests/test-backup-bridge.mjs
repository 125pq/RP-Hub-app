import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 阶段 1 切片验收:保存前刷写桥(RPHubBackupBridge)行为契约。
// 覆盖:注册/注销幂等、flush 全部注册者、flush 失败聚合抛出可观察、
// iframe 刷写跨页消息(收到 ack 即 resolve)、iframe 超时兜底(不悬挂)。

const backupSource = await readFile(new URL('../../assets/js/rphub-backup.js', import.meta.url), 'utf8');
// vm context 内创建的对象跨 realm,assert.deepEqual 严格模式对数组引用敏感;JSON 归一化为原生对象再比较。
const toPlainObject = value => JSON.parse(JSON.stringify(value));

function loadBridge(overrides = {}) {
  const listeners = new Map();
  const window = {
    indexedDB: overrides.indexedDB,
    localStorage: overrides.localStorage,
    platformAdapter: overrides.platformAdapter,
    document: overrides.document || { querySelectorAll: () => [] },
    console,
    setTimeout,
    clearTimeout,
    addEventListener: (n, h) => { listeners.set(n, h); },
    removeEventListener: (n, h) => { if (listeners.get(n) === h) listeners.delete(n); },
    postMessage: () => {},
    ...overrides,
  };
  window.window = window;
  const context = vm.createContext({ window, document: window.document, console, setTimeout, clearTimeout });
  vm.runInContext(backupSource, context, { filename: 'rphub-backup.js' });
  return { window, bridge: window.RPHubBackupBridge, listeners, context };
}

// 1) register/unregister 幂等与 names 枚举
{
  const { bridge } = loadBridge();
  assert.equal(typeof bridge.register, 'function');
  const fn = async () => {};
  bridge.register('a', fn).register('b', async () => {});
  assert.deepEqual(toPlainObject(bridge.names().sort()), ['a', 'b']);
  assert.equal(bridge.register('c', 'not-a-function').names().includes('c'), false, 'non-function flushFn must be ignored');
  bridge.unregister('a').unregister('missing');
  assert.deepEqual(toPlainObject(bridge.names().sort()), ['b']);
}

// 2) flush 成功:所有注册者都被调用,无异常即 resolve
{
  const { bridge } = loadBridge();
  const calls = [];
  bridge.register('main', async () => calls.push('main'))
        .register('character-frame', async () => calls.push('char'));
  await bridge.flush();
  assert.deepEqual(toPlainObject(calls.sort()), ['char', 'main'], 'every registered flusher must run');
}

// 3) flush 失败:失败被收集并以单个 Error 向上抛(可观察),不因某项失败跳过其余
{
  const { bridge } = loadBridge();
  const ran = [];
  bridge.register('ok1', async () => ran.push('ok1'))
        .register('bad', async () => { ran.push('bad'); throw new Error('disk full'); })
        .register('ok2', async () => ran.push('ok2'));
  await assert.rejects(() => bridge.flush(), /数据落盘失败[\s\S]*disk full/, 'flush failure must be observable');
  assert.deepEqual(toPlainObject(ran.sort()), ['bad', 'ok1', 'ok2'], 'one failing flusher must not stop the others');
}

// 4) iframe flush:找到匹配 frame,postMessage 后收到 RPHUB_BACKUP_FLUSHED ack → resolve
{
  const posts = [];
  const frameWindow = {};
  const document = {
    querySelectorAll: () => [
      { getAttribute: () => 'pages/character.html', contentWindow: frameWindow },
      { getAttribute: () => 'pages/novel.html', contentWindow: { postMessage: (msg) => posts.push(msg) } },
    ],
  };
  const { bridge, listeners } = loadBridge({ document });
  const p = bridge.flushEmbeddedFrame('novel');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].type, 'RPHUB_BACKUP_FLUSH');
  const handler = listeners.get('message');
  assert.equal(typeof handler, 'function', 'must listen for ack message');
  // 模拟 iframe 回执同 requestId
  handler({ data: { type: 'RPHUB_BACKUP_FLUSHED', requestId: posts[0].requestId } });
  const result = await p;
  assert.equal(result, undefined, 'ack resolves the flush promise');
  assert.equal(listeners.has('message'), false, 'message listener must be removed after ack');
}

// 5) iframe flush:frame 缺失时立即 resolve(不悬挂、不报错)
{
  const { bridge } = loadBridge({ document: { querySelectorAll: () => [] } });
  const result = await bridge.flushEmbeddedFrame('character');
  assert.equal(result, undefined, 'missing frame resolves immediately (no dangling listener/promise)');
}

console.log('RPHubBackupBridge flush contract: register/unregister, all-flush, failure aggregation, iframe ack, iframe-missing: PASS');
