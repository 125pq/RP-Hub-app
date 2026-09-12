// RP-Hub: shared large-file IO primitives (阶段 2).
//
// This local module owns the one streaming text line reader used by the backup
// importer (assets/js/rphub-backup.js) and the chat JSONL importer
// (assets/js/chat-import-streaming.js). Keeping it here means:
//   - one chunk/UTF-8/cross-chunk-newline implementation instead of two copies;
//   - no business semantics: callers decide record parsing, validation and
//     whether blank-only lines are skipped.
//
// It intentionally does NOT read a whole File into memory: file.stream() is
// consumed chunk by chunk and only an unfinished line is buffered.
(function () {
    'use strict';

    if (window.__rphubIoLoaded) return;
    window.__rphubIoLoaded = true;

    // Chunk-safe line assembler. Feed decoded text with push(), then finish().
    // Emits every non-empty line (after stripping a trailing CR); whitespace-only
    // lines are emitted too because callers may care about them.
    class LineReader {
        constructor(onLine) {
            if (typeof onLine !== 'function') throw new TypeError('onLine must be a function');
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

    // Stream a File/Blob as UTF-8 text lines without `await file.text()`.
    // Uses Blob.stream() when available and falls back to FileReader (which does
    // load the file at once) for environments without it.
    async function readTextFileLines(file, onLine) {
        if (typeof file?.stream === 'function') {
            const reader = file.stream().getReader();
            const decoder = new TextDecoder('utf-8', { fatal: false });
            const lineReader = new LineReader(onLine);
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
        const lineReader = new LineReader(onLine);
        await lineReader.push(text);
        await lineReader.finish();
    }

    // --- Streaming JSON text writer -------------------------------------------
    // Emits the exact same text as JSON.stringify(value, null, space) but as a
    // sequence of chunks, so a large export is never materialized as one string.
    // Scalar encoding is delegated to native JSON.stringify; only structure,
    // indentation, toJSON and the omit/undefined/null rules are reproduced.
    // A replacer is intentionally unsupported (no caller uses one). BigInt and
    // circular structures throw, matching native behavior.
    function normalizeGap(space) {
        if (typeof space === 'number') return ' '.repeat(Math.min(10, Math.max(0, Math.floor(space))));
        if (typeof space === 'string') return space.slice(0, 10);
        return '';
    }

    function applyToJSON(value, key) {
        if (value !== null && typeof value === 'object' && typeof value.toJSON === 'function') {
            return value.toJSON(key);
        }
        return value;
    }

    function isOmitted(value) {
        return value === undefined || typeof value === 'function' || typeof value === 'symbol';
    }

    // `value` must already be post-toJSON; toJSON is applied exactly once by the
    // callers below so nested toJSON objects are not double-converted.
    function* serializeJsonValue(value, indent, gap, ancestors) {
        if (value === null) { yield 'null'; return; }
        const type = typeof value;
        if (type === 'string') { yield JSON.stringify(value); return; }
        if (type === 'number') { yield Number.isFinite(value) ? JSON.stringify(value) : 'null'; return; }
        if (type === 'boolean') { yield value ? 'true' : 'false'; return; }
        if (type === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
        if (type === 'undefined' || type === 'function' || type === 'symbol') { yield 'null'; return; }

        if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON');
        const pretty = gap.length > 0;
        if (Array.isArray(value)) {
            if (value.length === 0) { yield '[]'; return; }
            ancestors.add(value);
            if (!pretty) {
                yield '[';
                for (let index = 0; index < value.length; index += 1) {
                    if (index > 0) yield ',';
                    yield* serializeJsonValue(applyToJSON(value[index], String(index)), indent, gap, ancestors);
                }
                yield ']';
                ancestors.delete(value);
                return;
            }
            const childIndent = indent + gap;
            yield '[\n';
            for (let index = 0; index < value.length; index += 1) {
                if (index > 0) yield ',\n';
                yield childIndent;
                yield* serializeJsonValue(applyToJSON(value[index], String(index)), childIndent, gap, ancestors);
            }
            yield `\n${indent}]`;
            ancestors.delete(value);
            return;
        }

        const entries = [];
        for (const objectKey of Object.keys(value)) {
            const child = applyToJSON(value[objectKey], objectKey);
            if (!isOmitted(child)) entries.push([objectKey, child]);
        }
        if (entries.length === 0) { yield '{}'; return; }
        ancestors.add(value);
        if (!pretty) {
            yield '{';
            for (let index = 0; index < entries.length; index += 1) {
                const [objectKey, child] = entries[index];
                if (index > 0) yield ',';
                yield `${JSON.stringify(objectKey)}:`;
                yield* serializeJsonValue(child, indent, gap, ancestors);
            }
            yield '}';
            ancestors.delete(value);
            return;
        }
        const childIndent = indent + gap;
        yield '{\n';
        for (let index = 0; index < entries.length; index += 1) {
            const [objectKey, child] = entries[index];
            if (index > 0) yield ',\n';
            yield `${childIndent}${JSON.stringify(objectKey)}: `;
            yield* serializeJsonValue(child, childIndent, gap, ancestors);
        }
        yield `\n${indent}}`;
        ancestors.delete(value);
    }

    const JSON_CHUNK_TARGET = 32 * 1024;

    async function* jsonTextChunks(value, { space = 2 } = {}) {
        const gap = normalizeGap(space);
        const buffer = [];
        let size = 0;
        for (const piece of serializeJsonValue(applyToJSON(value, ''), '', gap, new WeakSet())) {
            if (!piece) continue;
            buffer.push(piece);
            size += piece.length;
            if (size >= JSON_CHUNK_TARGET) {
                yield buffer.join('');
                buffer.length = 0;
                size = 0;
            }
        }
        if (buffer.length) yield buffer.join('');
    }

    // Stream an already-materialized string in bounded chunks (for plain-text
    // exports that cannot use the JSON writer).
    async function* textChunks(text, chunkSize = 64 * 1024) {
        const source = text === null || text === undefined ? '' : String(text);
        const size = Math.max(1, Math.floor(chunkSize));
        for (let offset = 0; offset < source.length; offset += size) {
            yield source.slice(offset, offset + size);
        }
    }

    window.RPHubIO = Object.freeze({ LineReader, readTextFileLines, jsonTextChunks, textChunks });
})();
