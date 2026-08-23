// RP-Hub: local full-backup export / restore.
//
// This is a self-contained local data backup module. It is fully compatible with
// the third-party "rp-sync-jsonl-v1" snapshot format (schemaVersion 5) used by
// 魔改版/DB/bootstrap.js: we reuse the exact same line types, ordering,
// recordArrayStart/Item/End shape, recordCount semantics, localStorage
// whitelist, and mirror-restore semantics. No new format is invented here.
//
// Scope of this stage: LOCAL export / import only. No cloud sync, encryption,
// compression, R2, Worker, or incremental sync.
//
// The main logic lives here (not in app.js). patch-backup.mjs only adds minimal,
// idempotent hooks into index.html / app.js / character/index.html / novel/index.html.
(function () {
    'use strict';

    if (window.__rphubBackupLoaded) return;
    window.__rphubBackupLoaded = true;

    // --- V5 snapshot constants (must match 魔改版/DB/bootstrap.js exactly) ---
    const SNAPSHOT_FORMAT = 'rp-sync-jsonl-v1';
    const SNAPSHOT_SCHEMA_VERSION = 5;

    const knownDatabases = [
        { name: 'RPHubDB', stores: ['store'] },
        { name: 'AICharGen', stores: ['characters'] }
    ];
    const localStoragePrefixes = ['rp_hub_', 'ai_chargen_'];
    const restoreBatchSize = 64;
    const readBatchSize = 64;

    // --- RPHubBackupBridge ----------------------------------------------------
    // Coordinates flushing of every pending/debounced writer (main app, character
    // iframe, novel iframe) so a snapshot is taken only after data really landed
    // in IndexedDB/localStorage. The individual registrants are wired by
    // patch-backup.mjs (app.js and the two iframes); the bridge itself lives here.
    const bridgeRegistrations = new Map();

    const RPHubBackupBridge = {
        register(name, flushFn) {
            if (typeof flushFn === 'function') bridgeRegistrations.set(name, flushFn);
            return this;
        },
        unregister(name) {
            bridgeRegistrations.delete(name);
            return this;
        },
        names() {
            return [...bridgeRegistrations.keys()];
        },
        async flush() {
            const failures = [];
            for (const [name, flushFn] of bridgeRegistrations) {
                try {
                    await flushFn();
                } catch (error) {
                    failures.push({ name, error });
                }
            }
            if (failures.length) {
                throw new Error('数据落盘失败：' + failures.map(item => `${item.name}(${item.error?.message || item.error})`).join('; '));
            }
        },
        // Ask an embedded iframe to flush its pending debounced writes. Resolves
        // when the frame acks (or after a timeout), so a snapshot is only taken
        // after the iframe's data has landed in its own storage.
        flushEmbeddedFrame(match) {
            const frame = Array.from(document.querySelectorAll('iframe'))
                .find(iframe => iframe && iframe.contentWindow && String(iframe.getAttribute('src') || '').includes(match));
            if (!frame?.contentWindow) return Promise.resolve();
            const requestId = `${match}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            return new Promise((resolve) => {
                const onMessage = (event) => {
                    if (event.data?.type !== 'RPHUB_BACKUP_FLUSHED' || event.data.requestId !== requestId) return;
                    window.removeEventListener('message', onMessage);
                    resolve();
                };
                window.addEventListener('message', onMessage);
                try {
                    frame.contentWindow.postMessage({ type: 'RPHUB_BACKUP_FLUSH', requestId }, '*');
                } catch (_) {
                    window.removeEventListener('message', onMessage);
                    resolve();
                }
                setTimeout(() => {
                    window.removeEventListener('message', onMessage);
                    resolve();
                }, 10000);
            });
        }
    };
    window.RPHubBackupBridge = RPHubBackupBridge;

    // --- Small helpers --------------------------------------------------------
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    function pad2(value) {
        return String(value).padStart(2, '0');
    }

    function timestampToken() {
        const d = new Date();
        return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    }

    function serializeSnapshotLine(value) {
        const json = JSON.stringify(value);
        if (typeof json !== 'string') throw new Error('本地数据包含无法序列化的内容。');
        return `${json}\n`;
    }

    function stableKeyToken(key) {
        return JSON.stringify(key);
    }

    function isAppLocalStorageKey(key) {
        return !key.startsWith('rp_hub_sync_')
            && localStoragePrefixes.some(prefix => key.startsWith(prefix));
    }

    // --- IndexedDB access -----------------------------------------------------
    function openDbByName(dbName, version) {
        return new Promise((resolve, reject) => {
            const request = typeof version === 'number'
                ? indexedDB.open(dbName, version)
                : indexedDB.open(dbName);
            request.onerror = () => reject(request.error || new Error('IndexedDB open failed.'));
            request.onsuccess = () => resolve(request.result);
        });
    }

    async function listIndexedDbNames() {
        const knownNames = knownDatabases.map(dbDef => dbDef.name);
        if (typeof indexedDB.databases === 'function') {
            try {
                const databases = await indexedDB.databases();
                const existingNames = new Set((databases || [])
                    .map(info => info?.name)
                    .filter(name => typeof name === 'string' && name));
                return knownNames.filter(name => existingNames.has(name));
            } catch (_) { /* some browsers reject indexedDB.databases */ }
        }
        return knownNames;
    }

    function readObjectStoreRecordBatch(db, storeName, afterKey, hasAfterKey) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readonly');
            const store = tx.objectStore(storeName);
            const range = hasAfterKey ? IDBKeyRange.lowerBound(afterKey, true) : null;
            const records = [];
            const request = store.openCursor(range);
            request.onerror = () => reject(request.error || new Error('IndexedDB cursor read failed.'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve({ records, done: true, lastKey: afterKey });
                    return;
                }
                records.push({ key: cursor.key, value: cursor.value });
                if (records.length >= readBatchSize) {
                    resolve({ records, done: false, lastKey: cursor.key });
                    return;
                }
                cursor.continue();
            };
        });
    }

    async function* iterateObjectStoreRecords(db, storeName) {
        let hasAfterKey = false;
        let afterKey;
        while (true) {
            const batch = await readObjectStoreRecordBatch(db, storeName, afterKey, hasAfterKey);
            for (const record of batch.records) yield record;
            if (batch.done) return;
            hasAfterKey = true;
            afterKey = batch.lastKey;
            await wait(0);
        }
    }

    function readStoreDefinitions(db, storeNames) {
        return storeNames.map(storeName => {
            const tx = db.transaction([storeName], 'readonly');
            const store = tx.objectStore(storeName);
            return {
                name: storeName,
                keyPath: store.keyPath,
                autoIncrement: Boolean(store.autoIncrement)
            };
        });
    }

    function readLocalStorageSnapshot() {
        const entries = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key === null || !isAppLocalStorageKey(key)) continue;
            entries.push({ key, value: localStorage.getItem(key) });
        }
        entries.sort((a, b) => a.key.localeCompare(b.key));
        return entries;
    }

    // --- Exporter: build the V5 JSONL stream as an async generator ------------
    // The generator is handed straight to cardUtils.saveGeneratedFile so it can be
    // streamed (Android native chunk writing) instead of being aggregated here.
    async function* iterateSnapshotLines(stats) {
        yield serializeSnapshotLine({
            type: 'snapshot',
            format: SNAPSHOT_FORMAT,
            schemaVersion: SNAPSHOT_SCHEMA_VERSION
        });

        for (const entry of readLocalStorageSnapshot()) {
            stats.recordCount += 1;
            yield serializeSnapshotLine({ type: 'localStorage', key: entry.key, value: entry.value });
        }
        yield serializeSnapshotLine({ type: 'localStorageEnd' });

        const dbNames = await listIndexedDbNames();
        for (const dbName of dbNames) {
            const knownDb = knownDatabases.find(dbDef => dbDef.name === dbName);
            if (!knownDb) continue;

            const db = await openDbByName(dbName);
            try {
                const storeNames = knownDb.stores.filter(name => db.objectStoreNames.contains(name));
                if (storeNames.length === 0) continue;
                const stores = readStoreDefinitions(db, storeNames);
                yield serializeSnapshotLine({ type: 'database', name: dbName, version: db.version, stores });

                for (const storeDef of stores) {
                    for await (const record of iterateObjectStoreRecords(db, storeDef.name)) {
                        stats.recordCount += 1;
                        if (Array.isArray(record.value)) {
                            yield serializeSnapshotLine({
                                type: 'recordArrayStart',
                                database: dbName,
                                store: storeDef.name,
                                key: record.key,
                                length: record.value.length
                            });
                            for (let index = 0; index < record.value.length; index += 1) {
                                const value = Object.prototype.hasOwnProperty.call(record.value, index)
                                    ? record.value[index]
                                    : null;
                                yield serializeSnapshotLine({
                                    type: 'recordArrayItem',
                                    database: dbName,
                                    store: storeDef.name,
                                    index,
                                    value: value === undefined ? null : value
                                });
                            }
                            yield serializeSnapshotLine({
                                type: 'recordArrayEnd',
                                database: dbName,
                                store: storeDef.name
                            });
                        } else {
                            yield serializeSnapshotLine({
                                type: 'record',
                                database: dbName,
                                store: storeDef.name,
                                key: record.key,
                                value: record.value
                            });
                        }
                    }
                    yield serializeSnapshotLine({ type: 'storeEnd', database: dbName, store: storeDef.name });
                }
                yield serializeSnapshotLine({ type: 'databaseEnd', name: dbName });
            } finally {
                db.close();
            }
        }

        yield serializeSnapshotLine({ type: 'snapshotEnd', recordCount: stats.recordCount });
    }

    function buildExportStream(stats) {
        return iterateSnapshotLines(stats);
    }

    // --- Restore-side IndexedDB helpers (mirror semantics) --------------------
    function createObjectStoreFromSnapshot(db, storeDef) {
        if (db.objectStoreNames.contains(storeDef.name)) return;
        const options = {};
        if (storeDef.keyPath !== null && typeof storeDef.keyPath !== 'undefined') {
            options.keyPath = storeDef.keyPath;
        }
        if (storeDef.autoIncrement) options.autoIncrement = true;
        db.createObjectStore(storeDef.name, options);
    }

    function openDbForRestore(dbDef) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(dbDef.name);
            request.onerror = () => reject(request.error || new Error('IndexedDB restore open failed.'));
            request.onupgradeneeded = () => {
                const db = request.result;
                for (const storeDef of dbDef.stores || []) createObjectStoreFromSnapshot(db, storeDef);
            };
            request.onsuccess = () => {
                const db = request.result;
                const missingStores = (dbDef.stores || [])
                    .filter(storeDef => !db.objectStoreNames.contains(storeDef.name));
                if (missingStores.length === 0) {
                    resolve(db);
                    return;
                }
                const nextVersion = db.version + 1;
                db.close();
                const upgradeRequest = indexedDB.open(dbDef.name, nextVersion);
                upgradeRequest.onerror = () => reject(upgradeRequest.error || new Error('IndexedDB restore upgrade failed.'));
                upgradeRequest.onupgradeneeded = () => {
                    const upgradedDb = upgradeRequest.result;
                    for (const storeDef of dbDef.stores || []) createObjectStoreFromSnapshot(upgradedDb, storeDef);
                };
                upgradeRequest.onsuccess = () => resolve(upgradeRequest.result);
            };
        });
    }

    function clearObjectStore(db, storeName) {
        return new Promise((resolve, reject) => {
            if (!db.objectStoreNames.contains(storeName)) {
                resolve();
                return;
            }
            const tx = db.transaction([storeName], 'readwrite');
            const store = tx.objectStore(storeName);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed.'));
            store.clear();
        });
    }

    async function deleteObjectStoreKeys(db, storeName, keys) {
        for (let start = 0; start < keys.length; start += restoreBatchSize) {
            const batch = keys.slice(start, start + restoreBatchSize);
            await new Promise((resolve, reject) => {
                const tx = db.transaction([storeName], 'readwrite');
                const store = tx.objectStore(storeName);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('IndexedDB cleanup failed.'));
                batch.forEach(key => store.delete(key));
            });
            await wait(0);
        }
    }

    function readObjectStoreKeys(db, storeName) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readonly');
            const store = tx.objectStore(storeName);
            const keys = [];
            const request = store.openKeyCursor();
            request.onerror = () => reject(request.error || new Error('IndexedDB key read failed.'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(keys);
                    return;
                }
                keys.push(cursor.key);
                cursor.continue();
            };
        });
    }

    async function deleteMissingObjectStoreRecords(db, storeName, incomingKeyTokens) {
        const existingKeys = await readObjectStoreKeys(db, storeName);
        const keysToDelete = existingKeys.filter(key => !incomingKeyTokens.has(stableKeyToken(key)));
        await deleteObjectStoreKeys(db, storeName, keysToDelete);
    }

    async function clearKnownIndexedDbStores(dbDef, storeNames) {
        const dbNames = await listIndexedDbNames();
        if (!dbNames.includes(dbDef.name)) return;
        const db = await openDbByName(dbDef.name);
        try {
            for (const storeName of storeNames) await clearObjectStore(db, storeName);
        } finally {
            db.close();
        }
    }

    function writeObjectStoreRecordBatch(db, storeDef, records) {
        if (!Array.isArray(records) || records.length === 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeDef.name], 'readwrite');
            const store = tx.objectStore(storeDef.name);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB restore failed.'));
            for (const record of records) {
                if (storeDef.keyPath !== null && typeof storeDef.keyPath !== 'undefined') {
                    store.put(record.value);
                } else {
                    store.put(record.value, record.key);
                }
            }
        });
    }

    // --- Line reader (streaming, chunk-safe incl. UTF-8/emoji across chunks) --
    class SnapshotLineReader {
        constructor(onLine) {
            this.onLine = onLine;
            this.pendingParts = [];
        }
        async push(text) {
            let start = 0;
            while (true) {
                const newlineIndex = text.indexOf('\n', start);
                if (newlineIndex === -1) break;
                const segment = text.slice(start, newlineIndex);
                let line;
                if (this.pendingParts.length > 0) {
                    this.pendingParts.push(segment);
                    line = this.pendingParts.join('');
                    this.pendingParts = [];
                } else {
                    line = segment;
                }
                if (line.endsWith('\r')) line = line.slice(0, -1);
                if (line) await this.onLine(line);
                start = newlineIndex + 1;
            }
            if (start < text.length) this.pendingParts.push(text.slice(start));
        }
        async finish() {
            if (this.pendingParts.length === 0) return;
            let line = this.pendingParts.join('');
            this.pendingParts = [];
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line) await this.onLine(line);
        }
    }

    // --- Restorer (mirror semantics, validate-only or real) -------------------
    class StreamSnapshotRestorer {
        constructor(expectedRecordCount, { validateOnly = false } = {}) {
            // Keep the raw expected count; null means "capture only" (no external
            // count comparison), used by the validate phase.
            this.expectedRecordCount = expectedRecordCount;
            this.validateOnly = validateOnly;
            this.recordCount = 0;
            this.snapshotStarted = false;
            this.snapshotEnded = false;
            this.localStorageEnded = false;
            this.localStorageKeys = new Set();
            this.seenDatabases = new Set();
            this.currentDatabase = null;
        }

        async consume(lineText) {
            let line;
            try {
                line = JSON.parse(lineText);
            } catch (error) {
                throw new Error('备份记录格式不正确。');
            }
            switch (line?.type) {
                case 'snapshot': this.startSnapshot(line); break;
                case 'localStorage': this.restoreLocalStorageEntry(line); break;
                case 'localStorageEnd': this.finishLocalStorage(); break;
                case 'database': await this.startDatabase(line); break;
                case 'record': await this.restoreRecord(line); break;
                case 'recordArrayStart': this.startArrayRecord(line); break;
                case 'recordArrayItem': this.restoreArrayRecordItem(line); break;
                case 'recordArrayEnd': await this.finishArrayRecord(line); break;
                case 'storeEnd': await this.finishStore(line); break;
                case 'databaseEnd': await this.finishDatabase(line); break;
                case 'snapshotEnd': await this.finishSnapshot(line); break;
                default: throw new Error('备份包含未知记录。');
            }
        }

        startSnapshot(line) {
            if (this.snapshotStarted || line.format !== SNAPSHOT_FORMAT || Number(line.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION) {
                throw new Error('备份头信息不正确。');
            }
            this.snapshotStarted = true;
        }

        restoreLocalStorageEntry(line) {
            if (!this.snapshotStarted || this.localStorageEnded || this.currentDatabase || typeof line.key !== 'string') {
                throw new Error('本地设置记录顺序不正确。');
            }
            if (!isAppLocalStorageKey(line.key)) throw new Error('备份包含无效的本地设置。');
            if (!this.validateOnly) localStorage.setItem(line.key, String(line.value ?? ''));
            this.localStorageKeys.add(line.key);
            this.recordCount += 1;
        }

        finishLocalStorage() {
            if (!this.snapshotStarted || this.localStorageEnded || this.currentDatabase) {
                throw new Error('本地设置结束标记不正确。');
            }
            if (!this.validateOnly) {
                for (const entry of readLocalStorageSnapshot()) {
                    if (!this.localStorageKeys.has(entry.key)) localStorage.removeItem(entry.key);
                }
            }
            this.localStorageEnded = true;
        }

        async startDatabase(line) {
            if (!this.localStorageEnded || this.currentDatabase || typeof line.name !== 'string') {
                throw new Error('数据库记录顺序不正确。');
            }
            const knownDb = knownDatabases.find(dbDef => dbDef.name === line.name);
            if (!knownDb) {
                this.currentDatabase = { name: line.name, ignored: true };
                return;
            }
            const seenStoreNames = new Set();
            const stores = (Array.isArray(line.stores) ? line.stores : []).filter(storeDef => {
                if (!storeDef || !knownDb.stores.includes(storeDef.name) || seenStoreNames.has(storeDef.name)) return false;
                seenStoreNames.add(storeDef.name);
                return true;
            }).map(storeDef => ({
                name: storeDef.name,
                keyPath: storeDef.keyPath,
                autoIncrement: Boolean(storeDef.autoIncrement)
            }));

            const db = !this.validateOnly && stores.length > 0
                ? await openDbForRestore({ name: line.name, stores })
                : null;
            this.currentDatabase = {
                name: line.name,
                db,
                knownDb,
                stores: new Map(stores.map(storeDef => [storeDef.name, {
                    definition: storeDef,
                    incomingKeys: new Set(),
                    batch: [],
                    arrayRecord: null,
                    finished: false
                }]))
            };
            this.seenDatabases.add(line.name);
        }

        getStoreState(line) {
            const current = this.currentDatabase;
            if (!current || line.database !== current.name || typeof line.store !== 'string') {
                throw new Error('数据库记录归属不正确。');
            }
            if (current.ignored) return null;
            const storeState = current.stores.get(line.store);
            if (!storeState || storeState.finished) throw new Error('对象存储记录顺序不正确。');
            return storeState;
        }

        async queueStoreRecord(storeState, record) {
            storeState.incomingKeys.add(stableKeyToken(record.key));
            storeState.batch.push(record);
            this.recordCount += 1;
            if (storeState.batch.length >= restoreBatchSize) await this.flushStore(storeState);
        }

        async restoreRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            if (storeState.arrayRecord) throw new Error('数组记录尚未结束。');
            const record = {
                key: line.key,
                value: Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : undefined
            };
            await this.queueStoreRecord(storeState, record);
        }

        startArrayRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            const length = Number(line.length);
            if (storeState.arrayRecord || !Number.isInteger(length) || length < 0) {
                throw new Error('数组记录头信息不正确。');
            }
            storeState.arrayRecord = {
                key: line.key,
                value: [],
                expectedLength: length,
                nextIndex: 0
            };
        }

        restoreArrayRecordItem(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            const arrayRecord = storeState.arrayRecord;
            if (!arrayRecord || Number(line.index) !== arrayRecord.nextIndex) {
                throw new Error('数组记录顺序不正确。');
            }
            if (!this.validateOnly) {
                arrayRecord.value.push(Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : null);
            }
            arrayRecord.nextIndex += 1;
        }

        async finishArrayRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            const arrayRecord = storeState.arrayRecord;
            if (!arrayRecord || arrayRecord.nextIndex !== arrayRecord.expectedLength) {
                throw new Error('数组记录数据不完整。');
            }
            storeState.arrayRecord = null;
            await this.queueStoreRecord(storeState, { key: arrayRecord.key, value: arrayRecord.value });
            await this.flushStore(storeState);
        }

        async flushStore(storeState) {
            if (storeState.batch.length === 0) return;
            const batch = storeState.batch;
            storeState.batch = [];
            if (!this.validateOnly) {
                await writeObjectStoreRecordBatch(this.currentDatabase.db, storeState.definition, batch);
                await wait(0);
            }
        }

        async finishStore(line) {
            const current = this.currentDatabase;
            if (!current || line.database !== current.name || typeof line.store !== 'string') {
                throw new Error('对象存储结束标记不正确。');
            }
            if (current.ignored) return;
            const storeState = current.stores.get(line.store);
            if (!storeState || storeState.finished) throw new Error('对象存储结束顺序不正确。');
            if (storeState.arrayRecord) throw new Error('数组记录尚未结束。');
            await this.flushStore(storeState);
            if (!this.validateOnly) {
                await deleteMissingObjectStoreRecords(current.db, line.store, storeState.incomingKeys);
            }
            storeState.incomingKeys.clear();
            storeState.finished = true;
        }

        async finishDatabase(line) {
            const current = this.currentDatabase;
            if (!current || line.name !== current.name) throw new Error('数据库结束标记不正确。');
            if (!current.ignored) {
                if ([...current.stores.values()].some(storeState => !storeState.finished)) {
                    throw new Error('对象存储数据不完整。');
                }
                if (current.db) current.db.close();
                const missingStores = current.knownDb.stores.filter(storeName => !current.stores.has(storeName));
                if (!this.validateOnly && missingStores.length > 0) {
                    await clearKnownIndexedDbStores(current.knownDb, missingStores);
                }
            }
            this.currentDatabase = null;
        }

        async finishSnapshot(line) {
            if (!this.snapshotStarted || this.snapshotEnded || !this.localStorageEnded || this.currentDatabase) {
                throw new Error('备份结束标记不正确。');
            }
            if (Number(line.recordCount) !== this.recordCount) {
                throw new Error('备份记录数量校验失败。');
            }
            // When expectedRecordCount is null/undefined this is a capture-only
            // pass (the validate phase): we record the count but do not compare
            // against an external expectation.
            if (this.expectedRecordCount !== null && typeof this.expectedRecordCount !== 'undefined') {
                if (this.recordCount !== this.expectedRecordCount) {
                    throw new Error('备份记录数量校验失败。');
                }
            }
            if (!this.validateOnly) {
                for (const knownDb of knownDatabases) {
                    if (!this.seenDatabases.has(knownDb.name)) {
                        await clearKnownIndexedDbStores(knownDb, knownDb.stores);
                    }
                }
            }
            this.snapshotEnded = true;
        }

        finish() {
            if (!this.snapshotEnded) throw new Error('备份数据不完整。');
        }

        abort() {
            if (this.currentDatabase?.db) this.currentDatabase.db.close();
            this.currentDatabase = null;
        }
    }

    // --- Streaming file line reading (no await file.text()) ------------------
    async function readTextFileLines(file, onLine) {
        if (typeof file?.stream === 'function') {
            const reader = file.stream().getReader();
            const decoder = new TextDecoder('utf-8', { fatal: false });
            const lineReader = new SnapshotLineReader(onLine);
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    await lineReader.push(decoder.decode(value, { stream: true }));
                }
                await lineReader.push(decoder.decode());
                await lineReader.finish();
            } finally {
                try { reader.releaseLock(); } catch (_) { }
            }
            return;
        }
        const text = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
            reader.readAsText(file);
        });
        const lineReader = new SnapshotLineReader(onLine);
        await lineReader.push(text);
        await lineReader.finish();
    }

    async function parseSnapshotFile(file, consumer, options = {}) {
        let linesSeen = 0;
        await readTextFileLines(file, async (line) => {
            linesSeen += 1;
            if (typeof options.onLine === 'function') options.onLine(linesSeen);
            await consumer.consume(line);
        });
        consumer.finish();
    }

    // --- Public import (validate-only then mirror restore) --------------------
    async function restoreSnapshotFile(file, { validateOnly = false, onProgress } = {}) {
        // First pass always validates structure fully. expectedRecordCount is
        // null here so the capture pass only reads the count (no external
        // comparison); the authoritative count comes from snapshotEnd/recordCount.
        const validator = new StreamSnapshotRestorer(null, { validateOnly: true });
        let expectedRecordCount = 0;
        await readTextFileLines(file, async (line) => {
            await validator.consume(line);
        });
        validator.finish();
        expectedRecordCount = validator.recordCount;

        if (validateOnly) return { recordCount: expectedRecordCount };

        const restorer = new StreamSnapshotRestorer(expectedRecordCount);
        try {
            await parseSnapshotFile(file, restorer, { onProgress });
        } catch (error) {
            restorer.abort();
            throw error;
        }
        return { recordCount: expectedRecordCount };
    }

    // --- Top-level operations -------------------------------------------------
    async function exportBackup({ onStatus } = {}) {
        await RPHubBackupBridge.flush();
        const stats = { recordCount: 0, totalBytes: 0 };
        const filename = `rp-hub-backup-${timestampToken()}.jsonl`;
        onStatus?.(`正在导出 ${filename} ...`);
        const cardUtils = window.RPHubCardUtils;
        if (!cardUtils?.saveGeneratedFile) throw new Error('文件保存接口不可用。');
        const result = await cardUtils.saveGeneratedFile(
            buildExportStream(stats),
            filename,
            { mimeType: 'application/jsonl' }
        );
        if (result?.supported === false) throw new Error('当前平台不支持文件保存。');
        return { filename, recordCount: stats.recordCount };
    }

    async function createRecoveryBackup({ onStatus } = {}) {
        try {
            await RPHubBackupBridge.flush();
            const stats = { recordCount: 0, totalBytes: 0 };
            const filename = `rp-hub-recovery-${timestampToken()}.jsonl`;
            onStatus?.(`正在导出恢复备份 ${filename} ...`);
            const cardUtils = window.RPHubCardUtils;
            if (!cardUtils?.saveGeneratedFile) throw new Error('文件保存接口不可用。');
            const result = await cardUtils.saveGeneratedFile(
                buildExportStream(stats),
                filename,
                { mimeType: 'application/jsonl' }
            );
            if (result?.supported === false) return null;
            return { filename, recordCount: stats.recordCount };
        } catch (error) {
            return null;
        }
    }

    async function importBackup(file, { onStatus, onProgress } = {}) {
        // 1. Auto-export a recovery backup of the current data. If it fails, cancel
        //    the restore (per requirement: 保存失败则默认取消恢复).
        onStatus?.('正在导出当前数据的恢复备份...');
        const recovery = await createRecoveryBackup({ onStatus });
        if (!recovery) throw new Error('恢复备份导出失败，已取消导入恢复。');

        // 2. Full validate-only pass.
        onStatus?.('正在校验备份文件...');
        const { recordCount } = await restoreSnapshotFile(file, { validateOnly: true });

        // 3. Real mirror restore.
        onStatus?.(`备份校验通过（${recordCount} 条记录），正在恢复本地数据...`);
        await restoreSnapshotFile(file, {
            onProgress: (lines) => onProgress?.(lines)
        });

        return { recordCount, recovery };
    }

    // --- Sidebar-hosted dynamic UI (does not modify ui-components.js) --------
    // The "备份" entry lives inside the sidebar footer's user-card row — the same
    // spot as the modified build's sync button — so it never overlays the page.
    // The button is injected dynamically (MutationObserver) so Vue re-renders of
    // the sidebar footer do not drop it.
    let anchorEl = null;
    let statusEl = null;
    let fileInput = null;
    let busy = false;
    let panelEl = null;
    let observer = null;
    let uiInit = false;
    let themeMediaQuery = null;
    const CONTROL_PREFS_KEY = 'rp_hub_ui_preferences';
    const DEFAULT_CONTROL_PREFS = Object.freeze({ themeMode: 'system', mirrorSquare: true });
    let controlPrefs = null;

    function getControlPrefs() {
        if (controlPrefs) return controlPrefs;
        controlPrefs = { ...DEFAULT_CONTROL_PREFS };
        try {
            const saved = JSON.parse(localStorage.getItem(CONTROL_PREFS_KEY) || '{}');
            if (saved && typeof saved === 'object') controlPrefs = {
                themeMode: 'system',
                mirrorSquare: saved.mirrorSquare !== false
            };
        } catch (_) { /* use defaults */ }
        return controlPrefs;
    }

    function saveControlPrefs() {
        try { localStorage.setItem(CONTROL_PREFS_KEY, JSON.stringify(getControlPrefs())); } catch (_) { /* private mode */ }
    }

    function applyThemePreference() {
        const prefs = getControlPrefs();
        const systemDark = !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        const dark = systemDark;
        const root = document.documentElement;
        root.dataset.rphubThemeMode = prefs.themeMode;
        root.dataset.rphubTheme = dark ? 'dark' : 'light';
        root.classList.toggle('rphub-night-mode', dark);
        // MainActivity enables algorithmic darkening. A dark color-scheme hint
        // tells WebView the page already owns dark colors and suppresses that
        // pass; the inverse hint therefore maps the local preference to the
        // desired final appearance.
        root.style.colorScheme = dark ? 'light' : 'dark';
    }

    function bindSystemTheme() {
        themeMediaQuery?.removeEventListener?.('change', applyThemePreference);
        themeMediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)') || null;
        themeMediaQuery?.addEventListener?.('change', () => {
            if (getControlPrefs().themeMode === 'system') applyThemePreference();
        });
    }

    const setStatus = (text, isError = false) => {
        if (!statusEl) return;
        statusEl.textContent = text || '';
        statusEl.classList.toggle('rphub-backup-status--error', isError);
    };

    function ensureStyles() {
        if (typeof document?.getElementById === 'function' && document.getElementById('rphub-backup-style')) return;
        const style = document.createElement('style');
        style.id = 'rphub-backup-style';
        style.textContent = `
            .rphub-backup-anchor { position: relative; margin-left: auto; flex-shrink: 0; }
            .rphub-backup-anchor.is-collapsed { margin-left: 0; }
            .rphub-backup-button { flex-shrink: 0; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; color: #2563eb; font-weight: 700; font-size: 13px; padding: 7px 12px; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.04); transition: border-color .2s, background-color .2s; white-space: nowrap; line-height: 1.2; }
            .rphub-backup-button:hover { border-color: #bfdbfe; background: #eff6ff; }
            .rphub-backup-panel { position:absolute; right:0; bottom:calc(100% + 10px); width:min(360px,calc(100vw - 24px)); max-height:min(560px,calc(100vh - 24px)); overflow:auto; box-sizing:border-box; padding:18px; background:#fff; color:#172033; border:1px solid #dbe3ee; border-radius:16px; box-shadow:0 18px 48px rgba(15,23,42,.22); z-index:2147483001; }
            .rphub-control-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:16px; }
            .rphub-control-kicker { margin:0 0 4px; color:#64748b; font-size:10px; font-weight:800; letter-spacing:.12em; }
            .rphub-control-title { margin:0; font-size:18px; line-height:1.2; font-weight:800; }
            .rphub-control-close { width:30px; height:30px; border:1px solid #dbe3ee; border-radius:9px; background:#fff; color:#64748b; cursor:pointer; font-size:18px; }
            .rphub-control-section { padding:14px 0; border-top:1px solid #e2e8f0; }
            .rphub-control-section:first-of-type { border-top:0; padding-top:0; }
            .rphub-control-section__title { margin:0 0 3px; font-size:13px; font-weight:800; }
            .rphub-control-section__hint { margin:0 0 10px; color:#64748b; font-size:11px; line-height:1.45; }
            .rphub-control-mode-grid { display:grid; grid-template-columns:1fr; gap:7px; }
            .rphub-control-mode, .rphub-backup-panel__btn { min-height:40px; padding:9px 8px; border:1px solid #dbe3ee; border-radius:10px; background:#fff; color:#475569; font-size:12px; font-weight:700; cursor:pointer; }
            .rphub-control-mode.is-active { border-color:#4f46e5; background:#eef2ff; color:#4338ca; }
            .rphub-control-row { display:flex; align-items:center; gap:10px; }
            .rphub-control-row__body { min-width:0; flex:1; }
            .rphub-control-row__title { display:block; font-size:13px; font-weight:800; }
            .rphub-control-row__hint { display:block; margin-top:2px; color:#64748b; font-size:11px; }
            .rphub-control-switch { width:42px; height:24px; border:0; border-radius:999px; background:#cbd5e1; cursor:pointer; position:relative; }
            .rphub-control-switch::after { content:''; position:absolute; width:18px; height:18px; top:3px; left:3px; border-radius:50%; background:#fff; transition:transform .18s; }
            .rphub-control-switch.is-on { background:#4f46e5; }
            .rphub-control-switch.is-on::after { transform:translateX(18px); }
            .rphub-backup-panel__actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
            .rphub-backup-panel__btn--primary { background:#4f46e5; border-color:#4f46e5; color:#fff; }
            .rphub-backup-status { font-size:11px; color:#475569; margin:10px 0 0; min-height:16px; line-height:1.45; }
            .rphub-backup-status--error { color: #dc2626; }
            @media (max-width:480px) { .rphub-backup-panel { position:fixed; left:12px; right:12px; bottom:calc(env(safe-area-inset-bottom,0px) + 12px); width:auto; max-height:calc(100vh - 24px); } .rphub-backup-panel__actions { grid-template-columns:1fr; } }
        `;
        document.head.appendChild(style);
    }

    function openPanel() {
        if (!panelEl) return;
        panelEl.hidden = !panelEl.hidden;
        if (!panelEl.hidden) setStatus('请选择操作。');
    }

    function closePanel() {
        if (panelEl) panelEl.hidden = true;
    }

    function renderControlState() {
        if (!panelEl) return;
        const prefs = getControlPrefs();
        panelEl.querySelectorAll('[data-theme-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.themeMode === prefs.themeMode));
        const mirror = panelEl.querySelector('[data-action="toggle-mirror"]');
        mirror?.classList.toggle('is-on', prefs.mirrorSquare);
        mirror?.setAttribute?.('aria-checked', String(prefs.mirrorSquare));
        const value = panelEl.querySelector('[data-role="mirror-value"]');
        if (value) value.textContent = prefs.mirrorSquare ? '当前使用镜像地址' : '当前使用原站地址';
    }

    // Inject (or re-inject) the backup button into the sidebar footer.
    function ensureSidebarButton() {
        if (!document?.body) return false;
        ensureStyles();
        if (anchorEl && anchorEl.isConnected) {
            // Keep collapsed state reflected.
            const sidebar = document.querySelector('.app-sidebar');
            const collapsed = !!sidebar?.classList?.contains?.('md:w-16') || /md:w-16/.test(sidebar?.className || '');
            if (anchorEl.classList.contains('is-collapsed') !== collapsed) {
                anchorEl.classList.toggle('is-collapsed', collapsed);
            }
            return true;
        }

        const footer = document.querySelector('.safe-sidebar-footer');
        if (!footer) return false;
        let host = footer.querySelector('.flex.items-center');
        if (!host) host = footer;

        anchorEl = document.createElement('div');
        anchorEl.className = 'rphub-backup-anchor';
        anchorEl.innerHTML = `
            <button type="button" class="rphub-backup-button" title="打开本地控制中心">控制中心</button>
            <div class="rphub-backup-panel" hidden>
                <div class="rphub-control-head"><div><p class="rphub-control-kicker">RP-HUB LOCAL</p><h2 class="rphub-control-title">本地控制中心</h2></div><button type="button" class="rphub-control-close" aria-label="关闭">×</button></div>
                <section class="rphub-control-section"><h3 class="rphub-control-section__title">夜间模式</h3><p class="rphub-control-section__hint">跟随系统的深浅色设置。</p><div class="rphub-control-mode-grid"><button type="button" class="rphub-control-mode is-active" data-theme-mode="system">跟随系统</button></div></section>
                <section class="rphub-control-section"><div class="rphub-control-row"><div class="rphub-control-row__body"><span class="rphub-control-row__title">万相广场镜像</span><span class="rphub-control-row__hint" data-role="mirror-value"></span></div><button type="button" class="rphub-control-switch" data-action="toggle-mirror" role="switch" aria-checked="true" aria-label="切换万相广场镜像"></button></div></section>
                <section class="rphub-control-section"><h3 class="rphub-control-section__title">整体备份</h3><p class="rphub-control-section__hint">导入前会先导出当前数据的恢复备份。</p><div class="rphub-backup-panel__actions">
                    <button type="button" class="rphub-backup-panel__btn rphub-backup-panel__btn--primary" data-action="export">导出整体备份</button><button type="button" class="rphub-backup-panel__btn" data-action="import">导入整体备份</button>
                </div>
                <p class="rphub-backup-status"></p></section>
            </div>
        `;
        panelEl = anchorEl.querySelector('.rphub-backup-panel');
        statusEl = anchorEl.querySelector('.rphub-backup-status');
        renderControlState();

        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.jsonl,application/jsonl,application/octet-stream';
        fileInput.hidden = true;
        document.body.appendChild(fileInput);

        anchorEl.querySelector('.rphub-backup-button').addEventListener('click', openPanel);
        anchorEl.querySelector('.rphub-control-close').addEventListener('click', closePanel);
        anchorEl.querySelector('[data-action="toggle-mirror"]').addEventListener('click', () => {
            getControlPrefs().mirrorSquare = !getControlPrefs().mirrorSquare;
            saveControlPrefs();
            renderControlState();
        });
        anchorEl.querySelector('[data-action="export"]').addEventListener('click', async () => {
            if (busy) return;
            busy = true;
            setStatus('正在导出...');
            try {
                const result = await exportBackup({ onStatus: setStatus });
                setStatus(`已导出 ${result.filename}（${result.recordCount} 条记录）。`);
            } catch (error) {
                setStatus(error?.message || '导出失败。', true);
            } finally {
                busy = false;
            }
        });
        anchorEl.querySelector('[data-action="import"]').addEventListener('click', () => {
            if (busy) return;
            fileInput.value = '';
            fileInput.click();
        });
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            if (busy) return;
            busy = true;
            const confirmed = window.confirm(
                '导入将按备份覆盖当前全部本地数据（角色、聊天、记忆、设置、小说、角色生成器）。\n\n恢复前会自动导出一份当前数据的恢复备份。\n\n确定继续吗？'
            );
            if (!confirmed) {
                busy = false;
                return;
            }
            setStatus('正在处理备份...');
            try {
                const result = await importBackup(file, { onStatus: setStatus, onProgress: () => {} });
                setStatus(`恢复完成（${result.recordCount} 条记录）。页面即将刷新...`);
                setTimeout(() => { location.reload(); }, 300);
            } catch (error) {
                setStatus(error?.message || '导入失败，本地数据未被修改。', true);
            } finally {
                busy = false;
            }
        });

        host.appendChild(anchorEl);
        return true;
    }

    function buildUI() {
        if (uiInit) return;
        if (!document?.body || !document?.createElement || !document?.head) return;
        uiInit = true;
        applyThemePreference();
        bindSystemTheme();
        ensureSidebarButton();
        // Keep the button present even if the sidebar footer re-renders.
        if (typeof MutationObserver === 'function' && !observer) {
            observer = new MutationObserver(() => ensureSidebarButton());
            observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
        }
    }

    function mountUI() {
        if (typeof document === 'undefined' || !document?.body || !document?.createElement) return;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', buildUI, { once: true });
        } else {
            buildUI();
        }
    }

    // Expose the module for tests / integration.
    window.RPHubBackup = Object.freeze({
        SNAPSHOT_FORMAT,
        SNAPSHOT_SCHEMA_VERSION,
        buildExportStream,
        createRecoveryBackup,
        exportBackup,
        importBackup,
        iterateSnapshotLines,
        parseSnapshotFile,
        readTextFileLines,
        restoreSnapshotFile,
        StreamSnapshotRestorer,
        SnapshotLineReader,
        bridge: RPHubBackupBridge,
        mountUI
    });

    mountUI();
})();
