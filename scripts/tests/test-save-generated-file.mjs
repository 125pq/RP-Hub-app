import { webFixturePath } from './web-fixture.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 覆盖 core-utils.saveGeneratedFile 的三条导出路径契约:
//  1) 原生 adapter.exportFile(分块桥,不动 saveGeneratedFile 主体)
//  2) 非原生 + File System Access API 可用 → 真流式写出,不聚合 Blob
//  3) FSA 取消 → cancelled:true(不显示成功);FSA 不可用 → 聚合 fallback;FSA 写失败 → 抛错不静默回退

const coreUtilsSource = await readFile(webFixturePath('assets/js/core-utils.js'), 'utf8');

function makeWindow(overrides = {}) {
  const listeners = {};
  const win = {
    Blob,
    Uint8Array,
    TextEncoder,
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    // core-utils IIFE 顶层依赖的最小桩
    RPHubBuiltinContent: { imageStyleArtists: [], activeTools: [] },
    RPHubLatestUpdate: {},
    document: {
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement: () => ({ style: {}, click: () => {}, remove: () => {}, setAttribute: () => {} }),
      hidden: false,
      addEventListener: (n, h) => { listeners[n] = h; },
      removeEventListener: () => {},
      documentElement: {},
      head: { appendChild: () => {} },
    },
    navigator: {},
    location: new URL('https://app.example/index.html'),
    setTimeout,
    clearTimeout,
    console,
    ...overrides,
  };
  win.window = win;
  win.parent = win;
  return win;
}

function loadCoreUtils(windowOverrides = {}) {
  const window = makeWindow(windowOverrides);
  const context = vm.createContext({
    Blob, Uint8Array, TextEncoder, URL,
    window,
    document: window.document, // core-utils 通过裸全局 document 引用
    navigator: window.navigator,
    location: window.location,
    console, setTimeout, clearTimeout,
  });
  vm.runInContext(coreUtilsSource, context, { filename: 'core-utils.js' });
  return { window, utils: window.RPHubCardUtils };
}

async function* makeStream(pieces) {
  for (const p of pieces) yield p;
}

// 1) 有原生 adapter(isNative=true)→ 一律走 adapter,saveGeneratedFile 不做聚合、不调 FSA、不调 downloadBlob
{
  let adapterCalled = 0;
  let pickerCalled = 0;
  const { window, utils } = loadCoreUtils({
    showSaveFilePicker: async () => { pickerCalled += 1; throw new Error('must not be called'); },
  });
  window.platformAdapter = {
    isNative: () => true,
    exportFile: async ({ filename, mimeType }) => {
      adapterCalled += 1;
      return { supported: true, cancelled: false, chunkCount: 3, bytesWritten: 128 };
    },
  };
  window.RPHubCardUtils = window.RPHubCardUtils || {};
  const result = await utils.saveGeneratedFile(makeStream(['{"a":1}\n', '{"a":2}\n']), 'chat.jsonl', { mimeType: 'application/jsonl' });
  assert.equal(adapterCalled, 1, 'native adapter must receive the stream');
  assert.equal(pickerCalled, 0, 'FSA picker must not be consulted on native');
  assert.equal(result.cancelled, false);
  assert.equal(result.chunkCount, 3);
}

// 2) 非原生 + FSA 可用 → 真流式写出,聚合 downloadBlob 不被调用,内容顺序完整、UTF-8 字节计长
{
  const written = [];
  const { window, utils } = loadCoreUtils({
    showSaveFilePicker: async () => ({
      createWritable: async () => ({
        write: async (chunk) => {
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(await chunk.arrayBuffer());
          written.push(new TextDecoder().decode(bytes));
        },
        close: async () => {},
        abort: async () => {},
      }),
    }),
  });
  const pieces = ['{"line":"一条','😺记录"}\n', '{"line":"中文"}\n'];
  const result = await utils.saveGeneratedFile(makeStream(pieces), 'chat.jsonl', { mimeType: 'application/jsonl' });
  assert.equal(result.cancelled, false);
  assert.equal(result.supported, true);
  assert.equal(written.join(''), pieces.join(''), 'streamed pieces must be written in order, intact');
  const expectedBytes = new TextEncoder().encode(pieces.join('')).byteLength;
  assert.equal(result.bytesWritten, expectedBytes, 'bytesWritten must reflect UTF-8 byte length');
}

// 3) 非原生 + FSA 取消(AbortError)→ cancelled:true,不聚合、不抛错
{
  const { window, utils } = loadCoreUtils({
    showSaveFilePicker: async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; },
  });
  const result = await utils.saveGeneratedFile(makeStream(['x']), 'a.json');
  assert.equal(result.supported, true);
  assert.equal(result.cancelled, true, 'FSA user cancel must surface as cancelled, not success, not error');
}

// 4) 非原生 + FSA 不可用 → 聚合 fallback(downloadBlob 路径),内容完整
{
  const downloads = [];
  const { window, utils } = loadCoreUtils({}); /* no showSaveFilePicker */
  window.RPHubCardUtils.downloadBlob = (blob, filename) => downloads.push({ blob, filename });
  // downloadBlob 在 IIFE 闭包内,外部不可替换;改断言其返回契约即可
  const pieces = ['part-1', 'part-2'];
  const result = await utils.saveGeneratedFile(makeStream(pieces), 'f.json', { mimeType: 'application/json' });
  assert.equal(result.cancelled, false);
  assert.equal(result.supported, true);
  assert.equal(result.bytesWritten, new Blob(['part-1part-2']).size, 'fallback must aggregate full content');
}

// 5) 非原生 + FSA 中途写失败 → 向上抛错,abort 被调用,不静默包装为 cancelled、不二次写入
{
  let aborts = 0;
  let writes = 0;
  const { window, utils } = loadCoreUtils({
    showSaveFilePicker: async () => ({
      createWritable: async () => ({
        write: async () => { writes += 1; if (writes === 2) throw new Error('disk write failed'); },
        close: async () => {},
        abort: async () => { aborts += 1; },
      }),
    }),
  });
  await assert.rejects(
    () => utils.saveGeneratedFile(makeStream(['a', 'b', 'c']), 'big.jsonl'),
    /disk write failed/,
    'FSA write failure must propagate, not be disguised as cancel/success',
  );
  assert.equal(aborts, 1, 'writable must be aborted on failure (best-effort cleanup)');
  assert.equal(writes, 2, 'writing must stop at first failure (no silent retry / no aggregate re-write)');
}

console.log('saveGeneratedFile streaming contract: native adapter, FSA true-stream, cancel, aggregate fallback, error propagation: PASS');
