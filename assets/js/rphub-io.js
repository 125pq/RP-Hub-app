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

    window.RPHubIO = Object.freeze({ LineReader, readTextFileLines });
})();
