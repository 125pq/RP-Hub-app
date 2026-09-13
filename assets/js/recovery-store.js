// Local import recovery: one completed snapshot, bounded byte chunks, no picker.
(function () {
    'use strict';
    const databaseName = 'RPHubImportRecovery';
    const chunkSize = 256 * 1024;
    const locked = async (operation) => {
        if (!navigator.locks?.request) throw new Error('当前 WebView 不支持安全的本地恢复备份，请更新 WebView。');
        return navigator.locks.request(databaseName, operation);
    };
    function open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('chunks');
                request.result.createObjectStore('meta');
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }
    function transaction(db, stores, mode, action) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(stores, mode);
            let request;
            tx.oncomplete = () => resolve(request?.result);
            tx.onabort = () => reject(tx.error || new Error('恢复备份事务已中止'));
            tx.onerror = () => {}; // onabort reports the final transaction outcome.
            try { request = action(tx); }
            catch (error) { tx.abort(); reject(error); }
        });
    }
    const metadata = db => transaction(db, ['meta'], 'readonly', tx => tx.objectStore('meta').get('current'));
    const range = id => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    async function clean(db, keep) {
        await transaction(db, ['chunks'], 'readwrite', tx => {
            const store = tx.objectStore('chunks');
            const request = store.openKeyCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                if (cursor.key[0] !== keep) store.delete(cursor.key);
                cursor.continue();
            };
        });
    }
    async function save(stream, filename) {
        return locked(async () => {
            const db = await open();
            const id = crypto.randomUUID();
            let committed = false;
            try {
                const previous = await metadata(db);
                await clean(db, previous?.id); // Remove an interrupted staging write.
                const encoder = new TextEncoder();
                let buffer = new Uint8Array(chunkSize), used = 0, count = 0, bytes = 0;
                const flush = async () => {
                    if (!used) return;
                    const chunk = buffer.slice(0, used);
                    await transaction(db, ['chunks'], 'readwrite', tx => tx.objectStore('chunks').put(chunk, [id, count]));
                    count++;
                    bytes += used;
                    used = 0;
                };
                for await (const part of stream) {
                    const source = typeof part === 'string' ? encoder.encode(part) : part;
                    if (!(source instanceof Uint8Array)) throw new Error('恢复备份包含不支持的数据块');
                    for (let offset = 0; offset < source.length;) {
                        const length = Math.min(chunkSize - used, source.length - offset);
                        buffer.set(source.subarray(offset, offset + length), used);
                        used += length;
                        offset += length;
                        if (used === chunkSize) await flush();
                    }
                }
                await flush();
                const current = { id, filename, count, bytes, createdAt: Date.now(), local: true };
                // Publish the new snapshot and remove the old one atomically.
                await transaction(db, ['meta', 'chunks'], 'readwrite', tx => {
                    tx.objectStore('meta').put(current, 'current');
                    if (previous) tx.objectStore('chunks').delete(range(previous.id));
                });
                committed = true;
                return current;
            } finally {
                if (!committed) {
                    await transaction(db, ['chunks'], 'readwrite', tx => tx.objectStore('chunks').delete(range(id))).catch(() => {});
                }
                db.close();
            }
        });
    }
    async function withLatest(consume) {
        return locked(async () => {
            const db = await open();
            try {
                const current = await metadata(db);
                if (!current) throw new Error('暂无导入前备份。');
                async function* chunks() {
                    for (let index = 0; index < current.count; index++) {
                        const value = await transaction(db, ['chunks'], 'readonly', tx => tx.objectStore('chunks').get([current.id, index]));
                        if (!(value instanceof Uint8Array)) throw new Error('本地恢复备份不完整。');
                        yield value;
                    }
                }
                return await consume(current, chunks());
            } finally { db.close(); }
        });
    }
    async function clear() {
        return locked(async () => {
            const db = await open();
            try {
                await transaction(db, ['meta', 'chunks'], 'readwrite', tx => {
                    tx.objectStore('meta').clear();
                    tx.objectStore('chunks').clear();
                });
            } finally { db.close(); }
        });
    }
    window.RPHubRecoveryStore = Object.freeze({ save, withLatest, clear });
})();
