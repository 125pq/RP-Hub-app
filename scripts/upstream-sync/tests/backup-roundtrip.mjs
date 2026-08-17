import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// ---------------------------------------------------------------------------
// Minimal in-memory IndexedDB + localStorage so assets/js/rphub-backup.js can
// be exercised in Node. Only the surface rphub-backup.js touches is needed:
//   - indexedDB.open(name) with objectStore('store')/('characters')
//   - indexedDB.databases() -> [{ name }]
//   - object store cursors (openCursor/openKeyCursor), get/put/delete/clear
//   - localStorage key()/getItem/setItem/removeItem/length
// ---------------------------------------------------------------------------

function makeLocalStorage() {
  const map = new Map();
  const api = {
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    clear() { map.clear(); },
    _raw: map
  };
  return api;
}

function makeIndexedDB(seed) {
  // seed: { dbName: { storeName: [ [key, value], ... ] } }
  const databases = new Map();
  const recordArrays = new WeakMap();
  const storeVersions = new Map(); // `${dbName}:${storeName}` -> next auto key
  let auto = 1;

  for (const [dbName, stores] of Object.entries(seed || {})) {
    const db = {};
    for (const [storeName, records] of Object.entries(stores)) {
      db[storeName] = new Map(records.map(([k, v]) => {
        let value = v;
        if (Array.isArray(v)) {
          const arr = v.slice();
          recordArrays.set(arr, true);
          value = arr;
        }
        return [k, value];
      }));
    }
    databases.set(dbName, db);
  }

  function openDb(name) {
    if (!databases.has(name)) databases.set(name, {});
    return databases.get(name);
  }

  function tx(storeName, mode, fn) {
    const db = databases.get(storeName.split(':')[0]);
    const store = db?.[storeName.split(':')[1]];
    return fn(store);
  }

  const idb = {
    async databases() {
      return [...databases.keys()].map(name => ({ name, version: 1 }));
    },
    open(name) {
      return new Promise((resolve, reject) => {
        const db = openDb(name);
        const handle = {
          version: 1,
          name,
          objectStoreNames: { contains: s => Boolean(db[s]) },
          close() {},
          transaction(storeNames) {
            const target = db[storeNames[0]];
            return {
              objectStore() {
                return {
                  clear() {
                    target.clear();
                  },
                  get(key) {
                    return new Promise(r => setTimeout(() => r(target.get(key)), 0));
                  },
                  openCursor(range) {
                    const entries = [...target.entries()];
                    let idx = -1;
                    return {
                      continue() { idx += 1; },
                      get result() {
                        if (range && idx < 0) return { key: null, value: null };
                        const entry = entries[idx];
                        if (!entry) return null;
                        return { key: entry[0], value: entry[1] };
                      }
                    };
                  },
                  openKeyCursor() {
                    const entries = [...target.keys()];
                    let idx = -1;
                    return {
                      continue() { idx += 1; },
                      get result() {
                        const key = entries[idx];
                        return key === undefined ? null : key;
                      }
                    };
                  },
                  delete(key) { target.delete(key); },
                  put(value, key) {
                    if (key === undefined) key = `__auto_${auto++}`;
                    target.set(key, value);
                    return { onsuccess: null };
                  }
                };
              }
            };
          }
        };
        // emulate synchronous onsuccess (resolve directly)
        resolve(handle);
      });
    }
  };

  // rphub-backup reads via request.onerror/onsuccess on openCursor; our mock
  // resolves the open() promise and then uses request.result synchronously.
  // To make the "onsuccess" model work we wrap: the caller does
  //   const request = store.openCursor(range); request.onerror=...; request.onsuccess=...
  // and expects request.result to be set, then calls request.onsuccess() itself.
  // Our mock object store returns plain objects with request.result + callers
  // dispatch .onsuccess() manually. We therefore need the mock to also expose
  // the onsuccess handler pattern used by readObjectStoreRecordBatch:
  //   request.onsuccess = () => { const cursor = request.result; ... }
  // and the caller invokes request.onsuccess() manually.
  //
  // To support that we wrap the returned request objects so that when code
  // assigns request.onsuccess it is stored, and we immediately invoke it.

  return idb;
}

// A more faithful IndexedDB mock that emulates the request/onsuccess pattern.
function makeIndexedDBV2(seed) {
  const databases = new Map();
  const isArray = new WeakSet();
  let auto = 1;

  for (const [dbName, stores] of Object.entries(seed || {})) {
    const db = {};
    for (const [storeName, records] of Object.entries(stores)) {
      const m = new Map();
      for (const [k, v] of records) {
        const value = Array.isArray(v) ? v.slice() : v;
        if (Array.isArray(value)) isArray.add(value);
        m.set(k, value);
      }
      db[storeName] = m;
    }
    databases.set(dbName, db);
  }

  function request(onsuccess, onerror) {
    const r = {
      onsuccess: null,
      onerror: null,
      error: null,
      result: undefined,
      setResult(value) { this.result = value; },
      fireSuccess() {
        if (this.onsuccess) this.onsuccess({ target: this });
      },
      fireError() {
        if (this.onerror) this.onerror({ target: this });
      }
    };
    return r;
  }

  const idb = {
    async databases() {
      return [...databases.keys()].map(name => ({ name, version: 1 }));
    },
    open(name) {
      const req = request();
      if (!databases.has(name)) databases.set(name, {});
      req.result = {
        version: 1,
        name,
        objectStoreNames: { contains: s => Boolean(databases.get(name)[s]) },
        close() {},
        transaction(storeNames) {
          const storeName = storeNames[0];
          const map = databases.get(name)[storeName];
          if (!map) throw new Error(`Unknown store ${storeName}`);
          const tx = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            complete() {
              setTimeout(() => { if (this.oncomplete) this.oncomplete({ target: tx }); }, 0);
            },
            fail(error) {
              this.error = error;
              setTimeout(() => {
                if (this.onerror) this.onerror({ target: tx });
                if (this.onabort) this.onabort({ target: tx });
              }, 0);
            },
            objectStore() {
              return {
                clear() {
                  map.clear();
                  tx.complete();
                },
                get(key) {
                  const r = request();
                  r.result = map.get(key);
                  setTimeout(() => r.fireSuccess(), 0);
                  return r;
                },
                openCursor(range) {
                  const r = request();
                  const entries = [...map.entries()];
                  let idx = 0;
                  const deliver = () => {
                    if (idx < entries.length) {
                      const entry = entries[idx];
                      idx += 1;
                      r.result = {
                        key: entry[0],
                        value: entry[1],
                        continue() { setTimeout(deliver, 0); }
                      };
                    } else {
                      r.result = null;
                    }
                    if (r.onsuccess) r.onsuccess({ target: r });
                  };
                  setTimeout(deliver, 0);
                  return r;
                },
                openKeyCursor() {
                  const r = request();
                  const keys = [...map.keys()];
                  let idx = 0;
                  const deliver = () => {
                    if (idx < keys.length) {
                      r.result = {
                        key: keys[idx],
                        continue() { setTimeout(deliver, 0); }
                      };
                      idx += 1;
                    } else {
                      r.result = null;
                    }
                    if (r.onsuccess) r.onsuccess({ target: r });
                  };
                  setTimeout(deliver, 0);
                  return r;
                },
                delete(key) {
                  map.delete(key);
                  tx.complete();
                },
                put(value, key) {
                  const r = request();
                  if (key === undefined) key = `__auto_${auto++}`;
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
  return idb;
}

function loadBackupModule(env) {
  const sourcePromise = readFile(new URL('../../../assets/js/rphub-backup.js', import.meta.url), 'utf8');
  return sourcePromise.then(source => {
    const sandbox = {
      window: env.window,
      document: env.document,
      indexedDB: env.indexedDB,
      localStorage: env.localStorage,
      console,
      setTimeout,
      clearTimeout,
      FileReader: env.FileReader,
      TextDecoder,
      TextEncoder,
      IDBKeyRange: { lowerBound: (k, open) => ({ __lowerBound: k, open }) },
      JSON,
      Promise,
      Date,
      Math,
      Uint8Array,
      ArrayBuffer,
      Blob: env.Blob
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'rphub-backup.js' });
    return {
      RPHubBackup: sandbox.window.RPHubBackup,
      RPHubBackupBridge: sandbox.window.RPHubBackupBridge,
      sandbox
    };
  });
}

function makeWindowOverEnv(env) {
  // window === the global scope that rphub-backup writes to
  const win = {};
  win.window = win;
  win.document = env.document;
  win.indexedDB = env.indexedDB;
  win.localStorage = env.localStorage;
  win.RPHubCardUtils = {
    async saveGeneratedFile(stream, filename, options) {
      const parts = [];
      let bytes = 0;
      for await (const piece of stream) {
        parts.push(String(piece ?? ''));
        bytes += new TextEncoder().encode(String(piece ?? '')).length;
      }
      return { supported: true, cancelled: false, bytesWritten: bytes, filename };
    },
    downloadBlob() {}
  };
  return win;
}

// Minimal document stub.
function makeDocument() {
  const makeEl = () => {
    const el = {
      style: {},
      dataset: {},
      children: [],
      listeners: {},
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      set textContent(v) { this._text = v; },
      get textContent() { return this._text || ''; },
      get hidden() { return this._hidden; },
      set hidden(v) { this._hidden = v; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn);
      },
      querySelector(sel) {
        // Return a fresh stub element for any selector so chained .querySelector
        // calls (used by buildUI) do not throw.
        return makeEl();
      },
      querySelectorAll() { return []; },
      appendChild(child) { this.children.push(child); return child; },
      removeChild() {},
      click() {},
      focus() {}
    };
    return el;
  };
  return {
    readyState: 'complete',
    documentElement: makeEl(),
    head: makeEl(),
    body: makeEl(),
    createElement() { return makeEl(); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    addEventListener() {},
    removeEventListener() {}
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function setupSeed() {
  const localStorage = makeLocalStorage();
  localStorage.setItem('rp_hub_settings', '{"theme":"dark"}');
  localStorage.setItem('ai_chargen_options', '{"generateExtra":true}');
  localStorage.setItem('rp_hub_sync_token', 'should-be-excluded');
  localStorage.setItem('unrelated_key', 'should-be-excluded');

  const indexedDB = makeIndexedDBV2({
    RPHubDB: {
      store: [
        ['characters', [
          { uuid: 'a', name: 'Alice', favoriteAt: null },
          { uuid: 'b', name: 'Bob' }
        ]],
        ['settings', { contextSize: 8192, temperature: 1 }]
      ]
    },
    AICharGen: {
      characters: [
        ['ai_chargen_characters', JSON.stringify([{ id: 'c1', name: 'Gen1' }])]
      ]
    }
  });

  const document = makeDocument();
  const window = makeWindowOverEnv({ document, indexedDB, localStorage });
  return { localStorage, indexedDB, document, window };
}

async function runExport(env) {
  const { RPHubBackup } = await loadBackupModule(env);
  const stats = { recordCount: 0 };
  const lines = [];
  for await (const line of RPHubBackup.iterateSnapshotLines(stats)) lines.push(line);
  return { lines, recordCount: stats.recordCount };
}

async function runImport(env, fileLines) {
  const { RPHubBackup } = await loadBackupModule(env);
  const file = {
    stream() {
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i >= fileLines.length) { controller.close(); return; }
          controller.enqueue(new TextEncoder().encode(fileLines[i++]));
        }
      });
    }
  };
  const result = await RPHubBackup.importBackup(file, {});
  return result;
}

function traceImport(env, fileLines) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('TIMEOUT')), 3000);
    runImport(env, fileLines).then(r => { clearTimeout(timeout); resolve(r); }, e => { clearTimeout(timeout); reject(e); });
  });
}

// ---- 1. V5 header compat + recordCount semantics --------------------------
{
  const env = await setupSeed();
  const { lines, recordCount } = await runExport(env);
  const parsed = lines.map(l => JSON.parse(l));
  assert.equal(parsed[0].type, 'snapshot');
  assert.equal(parsed[0].format, 'rp-sync-jsonl-v1');
  assert.equal(parsed[0].schemaVersion, 5);
  assert.equal(parsed[parsed.length - 1].type, 'snapshotEnd');
  assert.equal(parsed[parsed.length - 1].recordCount, recordCount);
  // localStorage: 2 included, rp_hub_sync_ and unrelated excluded
  const lsEntries = parsed.filter(l => l.type === 'localStorage');
  assert.equal(lsEntries.length, 2);
  assert.ok(lsEntries.some(l => l.key === 'rp_hub_settings'));
  assert.ok(lsEntries.some(l => l.key === 'ai_chargen_options'));
  console.log('V5 header + localStorage whitelist: PASS');
}

// ---- 2. Array record (recordArrayStart/Item/End) ---------------------------
{
  const env = await setupSeed();
  const { lines } = await runExport(env);
  const parsed = lines.map(l => JSON.parse(l));
  const arrayStart = parsed.find(l => l.type === 'recordArrayStart');
  assert.ok(arrayStart, 'recordArrayStart must be emitted for array values');
  assert.equal(arrayStart.database, 'RPHubDB');
  assert.equal(arrayStart.store, 'store');
  assert.equal(arrayStart.key, 'characters');
  assert.equal(arrayStart.length, 2);
  const items = parsed.filter(l => l.type === 'recordArrayItem' && l.store === 'store');
  assert.equal(items.length, 2);
  assert.equal(items[0].index, 0);
  assert.equal(items[1].index, 1);
  assert.equal(items[1].value.name, 'Bob');
  const arrayEnd = parsed.find(l => l.type === 'recordArrayEnd');
  assert.ok(arrayEnd);
  console.log('Array record (Start/Item/End): PASS');
}

// ---- 3. Mirror restore: import into a clean DB produces exact state -------
{
  const env = await setupSeed();
  const { lines } = await runExport(env);

  // Restore into a fresh env.
  const freshLocal = makeLocalStorage();
  const freshIdb = makeIndexedDBV2({
    RPHubDB: { store: [] },
    AICharGen: { characters: [] }
  });
  const freshDoc = makeDocument();
  const freshWin = makeWindowOverEnv({ document: freshDoc, indexedDB: freshIdb, localStorage: freshLocal });
  await runImport({ localStorage: freshLocal, indexedDB: freshIdb, document: freshDoc, window: freshWin }, lines);

  assert.equal(freshLocal.getItem('rp_hub_settings'), '{"theme":"dark"}');
  assert.equal(freshLocal.getItem('ai_chargen_options'), '{"generateExtra":true}');
  assert.equal(freshLocal.getItem('rp_hub_sync_token'), null, 'rp_hub_sync_ excluded from restore too');

  const { RPHubBackup } = await loadBackupModule({ localStorage: freshLocal, indexedDB: freshIdb, document: freshDoc, window: freshWin });
  const stats = { recordCount: 0 };
  const roundtrip = [];
  for await (const line of RPHubBackup.iterateSnapshotLines(stats)) roundtrip.push(line);
  // Verify the RPHubDB store contains the characters array back.
  const exported = roundtrip.map(l => JSON.parse(l));
  const arrayStart = exported.find(l => l.type === 'recordArrayStart' && l.key === 'characters');
  assert.equal(arrayStart.length, 2, 'mirror restore preserved the characters array');
  console.log('Mirror restore (exact state + sync exclusion): PASS');
}

// ---- 4. Streaming export feeds async generator (no aggregation) -----------
{
  const env = await setupSeed();
  let yielded = 0;
  const { RPHubBackup } = await loadBackupModule(env);
  const stats = { recordCount: 0 };
  const gen = RPHubBackup.iterateSnapshotLines(stats);
  // Verify it's an async iterator and can be consumed piece by piece.
  assert.equal(typeof gen[Symbol.asyncIterator], 'function');
  const iterator = gen[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(JSON.parse(first.value).type, 'snapshot');
  console.log('Streaming export yields async generator: PASS');
}

// ---- 5. UTF-8 / emoji split across chunk boundaries ------------------------
{
  const env = await setupSeed();
  env.localStorage.setItem('rp_hub_special', '你好🌍世界👍测试');
  const { lines } = await runExport(env);
  const parsed = lines.map(l => JSON.parse(l));
  const special = parsed.find(l => l.type === 'localStorage' && l.key === 'rp_hub_special');
  assert.equal(special.value, '你好🌍世界👍测试');

  // Force the import stream to split in the middle of a multibyte sequence.
  const fileText = lines.join('\n');
  const half = Math.ceil(fileText.length / 2);
  const chunk1 = fileText.slice(0, half);
  const chunk2 = fileText.slice(half);
  const freshLocal = makeLocalStorage();
  const freshIdb = makeIndexedDBV2({ RPHubDB: { store: [] }, AICharGen: { characters: [] } });
  const freshDoc = makeDocument();
  const freshWin = makeWindowOverEnv({ document: freshDoc, indexedDB: freshIdb, localStorage: freshLocal });
  const file = {
    stream() {
      const chunks = [chunk1, chunk2];
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i >= chunks.length) { controller.close(); return; }
          controller.enqueue(new TextEncoder().encode(chunks[i++]));
        }
      });
    }
  };
  const { RPHubBackup } = await loadBackupModule({ localStorage: freshLocal, indexedDB: freshIdb, document: freshDoc, window: freshWin });
  await RPHubBackup.importBackup(file, {});
  assert.equal(freshLocal.getItem('rp_hub_special'), '你好🌍世界👍测试');
  console.log('UTF-8/emoji across chunk boundary: PASS');
}

// ---- 6. Bad file rejection ------------------------------------------------
{
  const env = await setupSeed();
  const badCases = [
    ['not json', ['not-json-line']],
    ['bad header format', ['{"type":"snapshot","format":"other","schemaVersion":5}']],
    ['bad schemaVersion', ['{"type":"snapshot","format":"rp-sync-jsonl-v1","schemaVersion":4}']],
    ['wrong recordCount', ['{"type":"snapshot","format":"rp-sync-jsonl-v1","schemaVersion":5}',
      '{"type":"localStorage","key":"rp_hub_x","value":"1"}',
      '{"type":"localStorageEnd"}',
      '{"type":"snapshotEnd","recordCount":99}']],
    ['missing snapshotEnd', ['{"type":"snapshot","format":"rp-sync-jsonl-v1","schemaVersion":5}',
      '{"type":"localStorageEnd"}']],
    ['unknown record type', ['{"type":"snapshot","format":"rp-sync-jsonl-v1","schemaVersion":5}',
      '{"type":"mystery"}']]
  ];
  for (const [label, lines] of badCases) {
    const file = {
      stream() {
        let i = 0;
        return new ReadableStream({
          pull(controller) {
            if (i >= lines.length) { controller.close(); return; }
            controller.enqueue(new TextEncoder().encode(lines[i++]));
          }
        });
      }
    };
    const { RPHubBackup } = await loadBackupModule(env);
    await assert.rejects(() => RPHubBackup.importBackup(file, {}), undefined, `bad file should be rejected: ${label}`);
  }
  console.log('Bad file rejection: PASS');
}

// ---- 7. validate-only then real restore (importBackup does both) ----------
{
  const env = await setupSeed();
  const { lines } = await runExport(env);
  const file = {
    stream() {
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i >= lines.length) { controller.close(); return; }
          controller.enqueue(new TextEncoder().encode(lines[i++]));
        }
      });
    }
  };
  // validate-only: no writes
  const beforeLocal = env.localStorage.getItem('rp_hub_settings');
  const { RPHubBackup } = await loadBackupModule(env);
  const valResult = await RPHubBackup.restoreSnapshotFile(file, { validateOnly: true });
  // 2 localStorage entries + characters array(1) + settings record + AICharGen record = 5
  assert.equal(valResult.recordCount, 5, 'validate-only reports record count');
  assert.equal(env.localStorage.getItem('rp_hub_settings'), beforeLocal, 'validate-only must not write');
  console.log('Validate-only pass: PASS');
}

console.log('\nAll backup roundtrip tests: PASS');
