import { recoveryFixture } from '../../tests/recovery-fixture.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 阶段 2:备份格式(最大数据量格式)的大样本往返、异常与导入失败处理证据。
// 覆盖:
//   1) 大样本(数千条消息 + 数组记录)导出→导入→再导出字节一致(确定性);
//   2) 导出生成器惰性(首个 yield 前不打开任何 IndexedDB),证明不是先整体物化;
//   3) 截断/记录数不符 → 校验阶段拒绝且不写入;
//   4) 恢复写入中断 → 明确反馈 partialWrite + 指向恢复备份(不再谎称数据未修改)。

const LOCAL_STORAGE_COUNT = 150;
const MESSAGE_COUNT = 30000;
const SCALAR_RECORD_COUNT = 400;

// ---------------------------------------------------------------------------
// In-memory IndexedDB with instrumentation (open count + injectable put failure)
// ---------------------------------------------------------------------------
function makeIdb(seed, { failPut } = {}) {
  const dbs = new Map();
  const maps = {};
  for (const [dbName, stores] of Object.entries(seed || {})) {
    const db = {};
    for (const [storeName, records] of Object.entries(stores)) {
      const map = new Map(records.map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]));
      db[storeName] = map;
      maps[`${dbName}:${storeName}`] = map;
    }
    dbs.set(dbName, db);
  }
  const stats = { openCalls: 0 };
  const makeRequest = () => ({
    onsuccess: null, onerror: null, error: null, result: undefined,
    fireSuccess() { if (this.onsuccess) this.onsuccess({ target: this }); },
    fireError() { if (this.onerror) this.onerror({ target: this }); }
  });
  return {
    stats,
    maps,
    async databases() { return [...dbs.keys()].map(name => ({ name, version: 1 })); },
    open(name) {
      stats.openCalls += 1;
      if (!dbs.has(name)) dbs.set(name, {});
      const req = makeRequest();
      req.result = {
        version: 1,
        name,
        objectStoreNames: { contains: store => Boolean(dbs.get(name)[store]) },
        close() {},
        transaction(storeNames) {
          const storeName = Array.isArray(storeNames) ? storeNames[0] : storeNames;
          const map = dbs.get(name)[storeName];
          const tx = {
            oncomplete: null, onerror: null, onabort: null, error: null,
            complete() { setTimeout(() => { if (this.oncomplete) this.oncomplete({ target: tx }); }, 0); },
            fail(error) {
              this.error = error;
              setTimeout(() => {
                if (this.onerror) this.onerror({ target: tx });
                if (this.onabort) this.onabort({ target: tx });
              }, 0);
            },
            objectStore() {
              return {
                keyPath: null,
                autoIncrement: false,
                clear() { map.clear(); tx.complete(); },
                get(key) { const r = makeRequest(); r.result = map.get(key); setTimeout(() => r.fireSuccess(), 0); return r; },
                openCursor(range) {
                  const r = makeRequest();
                  const all = [...map.entries()];
                  // Honour IDBKeyRange.lowerBound(afterKey, open) so batched reads
                  // actually advance instead of re-reading the first batch forever.
                  const entries = range && 'key' in range
                    ? all.filter(([key]) => (range.open ? key > range.key : key >= range.key))
                    : all;
                  let index = 0;
                  const deliver = () => {
                    if (index < entries.length) {
                      const entry = entries[index];
                      index += 1;
                      r.result = { key: entry[0], value: entry[1], continue() { setTimeout(deliver, 0); } };
                    } else {
                      r.result = null;
                    }
                    if (r.onsuccess) r.onsuccess({ target: r });
                  };
                  setTimeout(deliver, 0);
                  return r;
                },
                openKeyCursor() {
                  const r = makeRequest();
                  const keys = [...map.keys()];
                  let index = 0;
                  const deliver = () => {
                    if (index < keys.length) {
                      r.result = { key: keys[index], continue() { setTimeout(deliver, 0); } };
                      index += 1;
                    } else {
                      r.result = null;
                    }
                    if (r.onsuccess) r.onsuccess({ target: r });
                  };
                  setTimeout(deliver, 0);
                  return r;
                },
                delete(key) { map.delete(key); tx.complete(); },
                put(value, key) {
                  const r = makeRequest();
                  if (failPut && failPut(name, storeName, value, key)) {
                    // Real IndexedDB surfaces write failures through the
                    // transaction error event with tx.error populated, not a
                    // synchronous throw. Reproduce that shape so the module's
                    // reject(tx.error) path (rphub-backup.js writeObjectStoreRecordBatch)
                    // is actually exercised.
                    tx.fail(new Error('simulated quota failure'));
                    return r;
                  }
                  if (key === undefined) key = `__auto_${map.size}_${Date.now()}`;
                  map.set(key, value);
                  r.result = key;
                  setTimeout(() => r.fireSuccess(), 0);
                  tx.complete();
                  return r;
                }
              };
            }
          };
          return tx;
        }
      };
      setTimeout(() => req.fireSuccess(), 0);
      return req;
    }
  };
}

function makeLocalStorage(entries = []) {
  const map = new Map(entries);
  return {
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    clear() { map.clear(); }
  };
}

function makeDocument() {
  const makeEl = () => ({
    style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    appendChild() {}, removeChild() {}, click() {}, focus() {}, remove() {},
    setAttribute() {}, removeAttribute() {},
    set textContent(value) { this._text = value; }, get textContent() { return this._text || ''; },
    hidden: false
  });
  return {
    readyState: 'complete', documentElement: makeEl(), head: makeEl(), body: makeEl(),
    createElement() { return makeEl(); }, querySelector() { return makeEl(); },
    querySelectorAll() { return []; }, getElementById() { return null; },
    addEventListener() {}, removeEventListener() {}
  };
}

function makeSeed() {
  const localStorageEntries = [];
  for (let i = 0; i < LOCAL_STORAGE_COUNT; i += 1) {
    localStorageEntries.push([`rp_hub_k${String(i).padStart(3, '0')}`, JSON.stringify({ i })]);
  }
  const messages = [];
  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i} 你好🌍 ${'x'.repeat(i % 40)}`,
      isSelf: i % 2 === 0
    });
  }
  const storeRecords = [['messages', messages]];
  for (let i = 0; i < SCALAR_RECORD_COUNT; i += 1) {
    storeRecords.push([`rec${String(i).padStart(4, '0')}`, { index: i, label: `r${i}` }]);
  }
  return {
    localStorageEntries,
    databases: {
      RPHubDB: { store: storeRecords },
      AICharGen: { characters: [['ai_chargen_characters', JSON.stringify([{ id: 'c1' }])]] }
    }
  };
}

const ioSource = await readFile(new URL('../../../assets/js/rphub-io.js', import.meta.url), 'utf8');
const backupSource = await readFile(new URL('../../../assets/js/rphub-backup.js', import.meta.url), 'utf8');

function loadBackup({ indexedDB, localStorage, saveGeneratedFile, saveRecovery }) {
  const win = {};
  win.RPHubRecoveryStore = recoveryFixture(saveRecovery);
  win.window = win;
  win.RPHubCardUtils = {
    saveGeneratedFile: saveGeneratedFile || (async (stream) => {
      for await (const _ of stream) { /* drain */ }
      return { supported: true, cancelled: false, bytesWritten: 0 };
    }),
    downloadBlob() {}
  };
  const sandbox = {
    window: win,
    document: makeDocument(),
    indexedDB,
    localStorage,
    console,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    IDBKeyRange: { lowerBound: (key, open) => ({ key, open }) },
    JSON,
    Promise,
    Date,
    Math,
    Uint8Array,
    ArrayBuffer,
    FileReader: class {
      readAsText(file) { this.result = file && file._text; if (typeof this.onload === 'function') this.onload(); }
      readAsArrayBuffer() { this.result = new ArrayBuffer(0); if (typeof this.onload === 'function') this.onload(); }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ioSource, sandbox, { filename: 'rphub-io.js' });
  vm.runInContext(backupSource, sandbox, { filename: 'rphub-backup.js' });
  return win.RPHubBackup;
}

function fileFromLines(lines) {
  return {
    stream() {
      let index = 0;
      return new ReadableStream({
        pull(controller) {
          if (index >= lines.length) { controller.close(); return; }
          controller.enqueue(new TextEncoder().encode(lines[index++]));
        }
      });
    }
  };
}

function fileFromText(text) {
  return {
    stream() {
      return new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }
      });
    }
  };
}

const seed = makeSeed();
const expectedRecordCount = LOCAL_STORAGE_COUNT + 1 + SCALAR_RECORD_COUNT + 1;

// ---- 1. Large export + laziness (no IndexedDB opened before the first yield) ----
let exportedLines;
{
  const indexedDB = makeIdb(seed.databases);
  const backup = loadBackup({ indexedDB, localStorage: makeLocalStorage(seed.localStorageEntries) });
  const generator = backup.iterateSnapshotLines({ recordCount: 0 });
  const first = await generator.next();
  assert.equal(JSON.parse(first.value).type, 'snapshot', 'first line is the snapshot header');
  assert.equal(indexedDB.stats.openCalls, 0, 'export must not open IndexedDB before yielding the header (lazy/streaming)');
  // Drain the rest and keep the raw lines for the round-trip.
  exportedLines = [first.value];
  for await (const line of generator) exportedLines.push(line);
  const parsed = exportedLines.map(line => JSON.parse(line));
  assert.equal(parsed[parsed.length - 1].recordCount, expectedRecordCount, 'snapshotEnd recordCount matches');
  const arrayStart = parsed.find(line => line.type === 'recordArrayStart');
  assert.equal(arrayStart.length, MESSAGE_COUNT, 'large array record is streamed item by item');
  const payloadBytes = exportedLines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0);
  console.log(`Large backup export: ${expectedRecordCount} records, ${(payloadBytes / 1024 / 1024).toFixed(2)} MiB streamed`);
}

// ---- 2. Round-trip determinism into a fresh env ----
{
  const freshIdb = makeIdb({ RPHubDB: { store: [] }, AICharGen: { characters: [] } });
  const backup = loadBackup({ indexedDB: freshIdb, localStorage: makeLocalStorage() });
  await backup.importBackup(fileFromLines(exportedLines), {});
  const messages = freshIdb.maps['RPHubDB:store'].get('messages');
  assert.equal(messages.length, MESSAGE_COUNT, 'array record restored intact');
  const reexported = [];
  for await (const line of backup.iterateSnapshotLines({ recordCount: 0 })) reexported.push(line);
  assert.deepEqual(reexported, exportedLines, 'import then re-export must be byte-identical');
}

// ---- 3. Truncated file: rejected in validation, nothing written ----
{
  const freshIdb = makeIdb({ RPHubDB: { store: [] }, AICharGen: { characters: [] } });
  const localStorage = makeLocalStorage([['rp_hub_existing', 'keep-me']]);
  const backup = loadBackup({ indexedDB: freshIdb, localStorage });
  const text = exportedLines.join('\n');
  const cut = Math.floor(text.length * 0.6);
  await assert.rejects(() => backup.importBackup(fileFromText(text.slice(0, cut)), {}));
  assert.equal(localStorage.getItem('rp_hub_existing'), 'keep-me', 'validation failure must not write');
}

// ---- 4. Wrong recordCount: rejected, nothing written ----
{
  const freshIdb = makeIdb({ RPHubDB: { store: [] }, AICharGen: { characters: [] } });
  const localStorage = makeLocalStorage([['rp_hub_existing', 'keep-me']]);
  const backup = loadBackup({ indexedDB: freshIdb, localStorage });
  const tampered = exportedLines.slice();
  const last = JSON.parse(tampered[tampered.length - 1]);
  last.recordCount += 1;
  tampered[tampered.length - 1] = JSON.stringify(last);
  await assert.rejects(() => backup.importBackup(fileFromLines(tampered), {}), /记录数量校验失败/, 'wrong recordCount must be rejected');
  assert.equal(localStorage.getItem('rp_hub_existing'), 'keep-me', 'count failure must not write');
}

// ---- 5. Mid-restore write failure: honest partial-write feedback + recovery pointer ----
{
  const failPut = (dbName, storeName) => dbName === 'RPHubDB' && storeName === 'store';
  const freshIdb = makeIdb({ RPHubDB: { store: [] }, AICharGen: { characters: [] } }, { failPut });
  const localStorage = makeLocalStorage([['rp_hub_existing', 'keep-me']]);
  let savedParts = null;
  const backup = loadBackup({
    indexedDB: freshIdb,
    localStorage,
    saveRecovery: async (stream, filename) => {
      const parts = [];
      for await (const part of stream) parts.push(String(part));
      savedParts = parts;
      return { supported: true, cancelled: false, bytesWritten: parts.join('').length, filename };
    }
  });
  let caught = null;
  try {
    await backup.importBackup(fileFromLines(exportedLines), {});
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'mid-restore write failure must reject');
  assert.equal(caught.partialWrite, true, 'error must be flagged as a partial write');
  assert.match(caught.message, /部分本地数据可能已被覆盖/, 'message must not claim data was untouched');
  assert.match(caught.message, /rp-hub-recovery-\d{8}-\d{6}\.jsonl/, 'message must point at the recovery backup');
  assert.ok(caught.recovery?.filename, 'error must carry the recovery backup metadata');
  assert.ok(Array.isArray(savedParts) && savedParts.length > 0, 'recovery backup was actually streamed before the failed restore');
  assert.equal(localStorage.getItem('rp_hub_k000'), JSON.stringify({ i: 0 }), 'pre-DB localStorage batches were already written (partial overwrite is real)');
}

console.log('Backup large-file format: deterministic round-trip, lazy streaming, truncation/count rejection, partial-write feedback: PASS');
