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
  const win = {
    indexedDB: overrides.indexedDB,
    localStorage: overrides.localStorage,
    platformAdapter: overrides.platformAdapter,
    RPHubCardUtils: overrides.RPHubCardUtils,
    document: overrides.document || { querySelectorAll: () => [] },
    console,
    setTimeout,
    clearTimeout,
    addEventListener: (n, h) => { listeners.set(n, h); },
    removeEventListener: (n, h) => { if (listeners.get(n) === h) listeners.delete(n); },
    postMessage: () => {},
    ...overrides,
  };
  win.window = win;
  const context = vm.createContext({ window: win, document: win.document, console, setTimeout, clearTimeout });
  vm.runInContext(backupSource, context, { filename: 'rphub-backup.js' });
  return { window: win, bridge: win.RPHubBackupBridge, listeners, context };
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

// 6) P2 负向:iframe 回执 ok:false(落盘失败)→ 必须 reject,不能当成功继续备份
{
  const posts = [];
  const frameWindow = {};
  const document = {
    querySelectorAll: () => [
      { getAttribute: () => 'pages/novel.html', contentWindow: { postMessage: (msg) => posts.push(msg) } },
    ],
  };
  const { bridge, listeners } = loadBridge({ document });
  const p = bridge.flushEmbeddedFrame('novel');
  const handler = listeners.get('message');
  handler({ data: { type: 'RPHUB_BACKUP_FLUSHED', requestId: posts[0].requestId, ok: false } });
  await assert.rejects(() => p, /落盘失败/, 'ok:false ack must reject (no silent success on failed iframe flush)');
  assert.equal(listeners.has('message'), false, 'message listener must be cleaned up on failure');
}

// 7) P2 负向:postMessage 发送抛错 → reject(不把消息失败当成功)
{
  const document = {
    querySelectorAll: () => [{
      getAttribute: () => 'pages/character.html',
      contentWindow: { postMessage: () => { throw new Error('cross-origin blocked'); } },
    }],
  };
  const { bridge } = loadBridge({ document });
  await assert.rejects(() => bridge.flushEmbeddedFrame('character'), /发送失败/, 'postMessage error must reject');
}

// 8) P2 负向:不回 ack → 超时 reject(不悬挂、不把超时当成功)。用短超时桩加速。
{
  const posts = [];
  const document = {
    querySelectorAll: () => [{
      getAttribute: () => 'pages/novel.html',
      contentWindow: { postMessage: (msg) => posts.push(msg) },
    }],
  };
  const { bridge } = loadBridge({ document });
  const start = Date.now();
  await assert.rejects(() => bridge.flushEmbeddedFrame('novel'), /超时/, 'iframe flush timeout must reject');
  assert.ok(Date.now() - start < 12000, 'timeout reject must fire around the configured deadline');
}

console.log('RPHubBackupBridge flush contract: register/unregister, all-flush, failure aggregation, iframe ack, iframe-missing, iframe ok:false reject, postMessage-fail reject, timeout reject: PASS');
