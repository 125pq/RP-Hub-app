import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Cross-compatibility with the third-party 魔改版/DB/bootstrap.js V5 snapshot.
//
// We cannot run the full bootstrap.js in Node (it touches DOM/modals/network),
// but we CAN replicate its serializer and restorer exactly from the source and
// prove both directions:
//   1. A snapshot serialized by bootstrap.js's V5 algorithm imports correctly
//      through our rphub-backup importer.
//   2. A snapshot our rphub-backup exports is accepted by a faithful
//      reproduction of bootstrap.js's StreamSnapshotRestorer (validate-only).

const SNAPSHOT_FORMAT = 'rp-sync-jsonl-v1';
const SNAPSHOT_SCHEMA_VERSION = 5;
const knownDatabases = [
  { name: 'RPHubDB', stores: ['store'] },
  { name: 'AICharGen', stores: ['characters'] }
];
const localStoragePrefixes = ['rp_hub_', 'ai_chargen_'];

function isAppLocalStorageKey(key) {
  return !key.startsWith('rp_hub_sync_') && localStoragePrefixes.some(p => key.startsWith(p));
}
function serializeSnapshotLine(value) {
  return `${JSON.stringify(value)}\n`;
}

// ---- bootstrap.js serializer (mirrors iterateSnapshotLines) ----------------
function bootstrapSerialize(stores) {
  // stores: { localStorage: [[key,value],...], databases: { RPHubDB: { store: [[k,v],...] }, ... } }
  const lines = [];
  let recordCount = 0;
  lines.push(serializeSnapshotLine({ type:'snapshot', format: SNAPSHOT_FORMAT, schemaVersion: SNAPSHOT_SCHEMA_VERSION }));
  const ls = stores.localStorage.filter(([k]) => isAppLocalStorageKey(k)).sort((a,b)=>a[0].localeCompare(b[0]));
  for (const [k,v] of ls) { lines.push(serializeSnapshotLine({ type:'localStorage', key:k, value:v })); recordCount += 1; }
  lines.push(serializeSnapshotLine({ type:'localStorageEnd' }));
  for (const dbName of ['RPHubDB', 'AICharGen']) {
    const dbStores = stores.databases[dbName];
    if (!dbStores) continue;
    const storeNames = Object.keys(dbStores);
    if (!storeNames.length) continue;
    lines.push(serializeSnapshotLine({ type:'database', name: dbName, version: 1,
      stores: storeNames.map(name => ({ name, keyPath: null, autoIncrement: false })) }));
    for (const storeName of storeNames) {
      for (const [key, value] of dbStores[storeName]) {
        recordCount += 1;
        if (Array.isArray(value)) {
          lines.push(serializeSnapshotLine({ type:'recordArrayStart', database:dbName, store:storeName, key, length: value.length }));
          value.forEach((item, index) => lines.push(serializeSnapshotLine({ type:'recordArrayItem', database:dbName, store:storeName, index, value: item === undefined ? null : item })));
          lines.push(serializeSnapshotLine({ type:'recordArrayEnd', database:dbName, store:storeName }));
        } else {
          lines.push(serializeSnapshotLine({ type:'record', database:dbName, store:storeName, key, value }));
        }
      }
      lines.push(serializeSnapshotLine({ type:'storeEnd', database:dbName, store:storeName }));
    }
    lines.push(serializeSnapshotLine({ type:'databaseEnd', name:dbName }));
  }
  lines.push(serializeSnapshotLine({ type:'snapshotEnd', recordCount }));
  return lines;
}

// ---- bootstrap.js restorer (mirrors StreamSnapshotRestorer, validate only) --
function bootstrapValidate(lines) {
  let snapshotStarted = false, snapshotEnded = false, localStorageEnded = false;
  let currentDb = null;
  let recordCount = 0;
  const seenDatabases = new Set();
  for (const raw of lines) {
    const line = JSON.parse(raw);
    switch (line.type) {
      case 'snapshot':
        assert.equal(line.format, SNAPSHOT_FORMAT);
        assert.equal(Number(line.schemaVersion), SNAPSHOT_SCHEMA_VERSION);
        snapshotStarted = true;
        break;
      case 'localStorage':
        assert.ok(snapshotStarted && !localStorageEnded && !currentDb);
        assert.ok(isAppLocalStorageKey(line.key));
        recordCount += 1;
        break;
      case 'localStorageEnd':
        assert.ok(snapshotStarted && !localStorageEnded && !currentDb);
        localStorageEnded = true;
        break;
      case 'database':
        assert.ok(localStorageEnded && !currentDb && typeof line.name === 'string');
        currentDb = { name: line.name, stores: {} };
        seenDatabases.add(line.name);
        break;
      case 'record':
        assert.ok(currentDb && line.database === currentDb.name && typeof line.store === 'string');
        recordCount += 1;
        break;
      case 'recordArrayStart':
        assert.ok(currentDb && line.database === currentDb.name);
        assert.ok(Number.isInteger(Number(line.length)) && Number(line.length) >= 0);
        currentDb.stores[line.store] = { length: Number(line.length), nextIndex: 0 };
        break;
      case 'recordArrayItem':
        assert.ok(currentDb && line.database === currentDb.name);
        assert.equal(Number(line.index), currentDb.stores[line.store].nextIndex);
        currentDb.stores[line.store].nextIndex += 1;
        break;
      case 'recordArrayEnd':
        assert.ok(currentDb && line.database === currentDb.name);
        assert.equal(currentDb.stores[line.store].nextIndex, currentDb.stores[line.store].length);
        recordCount += 1;
        delete currentDb.stores[line.store];
        break;
      case 'storeEnd':
        assert.ok(currentDb && line.database === currentDb.name && typeof line.store === 'string');
        break;
      case 'databaseEnd':
        assert.ok(currentDb && line.name === currentDb.name);
        currentDb = null;
        break;
      case 'snapshotEnd':
        assert.ok(snapshotStarted && !snapshotEnded && localStorageEnded && !currentDb);
        assert.equal(Number(line.recordCount), recordCount);
        snapshotEnded = true;
        break;
      default:
        throw new Error(`unknown type ${line.type}`);
    }
  }
  assert.ok(snapshotEnded, 'snapshot must end');
}

// ---------------------------------------------------------------------------
// Test environment (Node vm) for rphub-backup.js
// ---------------------------------------------------------------------------
function makeLocalStorage() {
  const m = new Map();
  return { get length(){return m.size}, key(i){return [...m.keys()][i]??null}, getItem(k){return m.has(String(k))?m.get(String(k)):null}, setItem(k,v){m.set(String(k),String(v))}, removeItem(k){m.delete(String(k))}, clear(){m.clear()} };
}
function mkEl(){return{style:{},dataset:{},classList:{toggle(){},add(){},remove(){},contains(){return false}},addEventListener(){},removeEventListener(){},querySelector(){return mkEl()},querySelectorAll(){return[]},appendChild(){},click(){},focus(){}}}
function makeDoc(){return{readyState:'complete',documentElement:mkEl(),head:mkEl(),body:mkEl(),createElement(){return mkEl()},querySelector(){return mkEl()},querySelectorAll(){return[]},getElementById(){return null},addEventListener(){},removeEventListener(){}}}
function makeIdb(seed) {
  const dbs = new Map();
  for (const [dn, stores] of Object.entries(seed || {})) {
    const db = {};
    for (const [sn, recs] of Object.entries(stores)) db[sn] = new Map(recs.map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]));
    dbs.set(dn, db);
  }
  let auto = 1;
  const mk = () => ({ onsuccess:null, onerror:null, error:null, result:undefined, fireSuccess(){ if (this.onsuccess) this.onsuccess({ target: this }); } });
  return {
    async databases() {
      return [...dbs.keys()].map(n => ({ name:n, version:1 }));
    },
    open(name) {
      const req = mk();
      if (!dbs.has(name)) dbs.set(name, {});
      req.result = {
        version: 1,
        name,
        objectStoreNames: { contains: s => Boolean(dbs.get(name)[s]) },
        close() {},
        transaction(storeNames) {
          const sn = storeNames[0];
          const map = dbs.get(name)[sn];
          const tx = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            complete() {
              setTimeout(() => { if (this.oncomplete) this.oncomplete({ target: tx }); }, 0);
            },
            objectStore() {
              return {
                clear() { map.clear(); tx.complete(); },
                get(key) {
                  const r = mk();
                  r.result = map.get(key);
                  setTimeout(() => r.fireSuccess(), 0);
                  return r;
                },
                openCursor() {
                  const r = mk();
                  const entries = [...map.entries()];
                  let idx = 0;
                  const d = () => {
                    if (idx < entries.length) {
                      const e = entries[idx];
                      idx += 1;
                      r.result = { key:e[0], value:e[1], continue(){ setTimeout(d, 0); } };
                    } else {
                      r.result = null;
                    }
                    if (r.onsuccess) r.onsuccess({ target: r });
                  };
                  setTimeout(d, 0);
                  return r;
                },
                openKeyCursor() {
                  const r = mk();
                  const keys = [...map.keys()];
                  let idx = 0;
                  const d = () => {
                    if (idx < keys.length) {
                      r.result = { key: keys[idx], continue(){ setTimeout(d, 0); } };
                      idx += 1;
                    } else {
                      r.result = null;
                    }
                    if (r.onsuccess) r.onsuccess({ target: r });
                  };
                  setTimeout(d, 0);
                  return r;
                },
                delete(key) { map.delete(key); tx.complete(); },
                put(value, key) {
                  const r = mk();
                  if (key === undefined) key = '__auto_' + (auto++);
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
async function loadBackup(env){
  const src=await readFile(new URL('../../../assets/js/rphub-backup.js',import.meta.url),'utf8');
  const win={window:null,document:env.document,indexedDB:env.indexedDB,localStorage:env.localStorage,RPHubCardUtils:{async saveGeneratedFile(stream){for await(const p of stream){}return{supported:true,cancelled:false,bytesWritten:0}}}};
  win.window=win;
  const sb={window:win,document:env.document,indexedDB:env.indexedDB,localStorage:env.localStorage,console,setTimeout,clearTimeout,TextDecoder,TextEncoder,IDBKeyRange:{lowerBound:()=>({})},JSON,Promise,Date,Math,Uint8Array,ArrayBuffer};sb.globalThis=sb;
  vm.createContext(sb);vm.runInContext(src,sb,{filename:'rphub-backup.js'});
  return win.RPHubBackup;
}

// ---- Test 1: bootstrap.js V5 snapshot -> our importer ----------------------
{
  const v5Lines = bootstrapSerialize({
    localStorage: [
      ['rp_hub_settings', '{"theme":"dark","lang":"zh"}'],
      ['ai_chargen_options', '{"generateExtra":true}'],
      ['rp_hub_sync_token', 'must-not-import'],
      ['unrelated', 'must-not-import']
    ],
    databases: {
      RPHubDB: {
        store: [
          ['characters', [{ uuid:'a', name:'Alice' }, { uuid:'b', name:'Bob' }]],
          ['settings', { contextSize: 8192, temperature: 1.0 }]
        ]
      },
      AICharGen: {
        characters: [
          ['ai_chargen_characters', JSON.stringify([{ id:'c1', name:'Gen' }])]
        ]
      }
    }
  });

  const ls = makeLocalStorage();
  const idb = makeIdb({ RPHubDB:{store:[]}, AICharGen:{characters:[]} });
  const doc = makeDoc();
  const backup = await loadBackup({ localStorage:ls, indexedDB:idb, document:doc });
  const file = { stream(){ let i=0; return new ReadableStream({ pull(c){ if(i>=v5Lines.length){c.close();return;} c.enqueue(new TextEncoder().encode(v5Lines[i++])); } }); } };
  const result = await backup.importBackup(file, {});
  assert.equal(result.recordCount, 5);
  assert.equal(ls.getItem('rp_hub_settings'), '{"theme":"dark","lang":"zh"}');
  assert.equal(ls.getItem('rp_hub_sync_token'), null, 'bootstrap V5 sync token must stay excluded');
  assert.equal(ls.getItem('unrelated'), null);
  console.log('V5 compat: bootstrap.js snapshot imports via our importer: PASS');
}

// ---- Test 2: our exporter -> bootstrap.js restorer (validate) -------------
{
  const ls = makeLocalStorage();
  ls.setItem('rp_hub_settings', '{"theme":"dark"}');
  ls.setItem('ai_chargen_active_index', '2');
  ls.setItem('rp_hub_sync_token', 'excluded');
  const idb = makeIdb({
    RPHubDB:{ store: [['characters',[{uuid:'x'}]] , ['worldinfo',{entries:[]}]] },
    AICharGen:{ characters:[['ai_chargen_characters','[]']] }
  });
  const doc = makeDoc();
  const backup = await loadBackup({ localStorage:ls, indexedDB:idb, document:doc });
  const stats = { recordCount:0 };
  const lines = [];
  for await (const l of backup.iterateSnapshotLines(stats)) lines.push(l);
  // Must be parseable and valid per bootstrap.js's restorer.
  bootstrapValidate(lines);
  // localStorage: exactly the 2 whitelisted entries (sync excluded).
  const parsed = lines.map(l => JSON.parse(l));
  const lsEntries = parsed.filter(l => l.type === 'localStorage');
  assert.deepEqual(lsEntries.map(l => l.key).sort(), ['ai_chargen_active_index', 'rp_hub_settings']);
  assert.equal(parsed[parsed.length-1].recordCount, stats.recordCount);
  console.log('V5 compat: our exporter accepted by bootstrap.js restorer: PASS');
}

// ---- Test 3: round-trip our export then re-export (byte-equivalence) -------
{
  const ls = makeLocalStorage();
  ls.setItem('rp_hub_emoji', '你好🌍世界');
  const idb = makeIdb({ RPHubDB:{store:[['big', [1,2,3]]] } });
  const doc = makeDoc();
  const backup = await loadBackup({ localStorage:ls, indexedDB:idb, document:doc });
  const s1 = { recordCount:0 }; const l1=[];
  for await (const l of backup.iterateSnapshotLines(s1)) l1.push(l);

  // Import into a fresh env, then re-export.
  const ls2 = makeLocalStorage(); const idb2 = makeIdb({ RPHubDB:{store:[]} }); const doc2 = makeDoc();
  const backup2 = await loadBackup({ localStorage:ls2, indexedDB:idb2, document:doc2 });
  const file = { stream(){ let i=0; return new ReadableStream({ pull(c){ if(i>=l1.length){c.close();return;} c.enqueue(new TextEncoder().encode(l1[i++])); } }); } };
  await backup2.importBackup(file, {});
  const s2 = { recordCount:0 }; const l2=[];
  for await (const l of backup2.iterateSnapshotLines(s2)) l2.push(l);
  assert.deepEqual(l2, l1, 're-export must match original snapshot');
  console.log('V5 compat: deterministic round-trip re-export: PASS');
}

console.log('\nV5 cross-compatibility: PASS');
