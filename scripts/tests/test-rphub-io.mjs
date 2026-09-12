import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 阶段 2:可复用流式行读取组件(assets/js/rphub-io.js)契约。
// 覆盖:跨 chunk 的 UTF-8/emoji 边界、CRLF、无尾换行、空行策略、
// FileReader 回退,以及 backup / chat 两个消费者确实共用同一实现(无私有副本)。

const ioSource = await readFile(new URL('../../assets/js/rphub-io.js', import.meta.url), 'utf8');
const backupSource = await readFile(new URL('../../assets/js/rphub-backup.js', import.meta.url), 'utf8');
const chatSource = await readFile(new URL('../../assets/js/chat-import-streaming.js', import.meta.url), 'utf8');

class StubFileReader {
  readAsText(file) {
    this.result = file && file._text;
    if (typeof this.onload === 'function') this.onload();
  }
}

function loadIO({ FileReaderImpl = StubFileReader } = {}) {
  const win = {};
  win.window = win;
  const sandbox = {
    window: win,
    TextDecoder,
    TextEncoder,
    FileReader: FileReaderImpl,
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ioSource, sandbox, { filename: 'rphub-io.js' });
  return win.RPHubIO;
}

function streamFile(chunks) {
  let index = 0;
  return {
    stream() {
      return new ReadableStream({
        pull(controller) {
          if (index >= chunks.length) { controller.close(); return; }
          controller.enqueue(chunks[index++]);
        }
      });
    }
  };
}

// 1) Multibyte UTF-8 split into single-byte chunks: no split character reaches onLine.
{
  const text = '你好🌍世界\n第二行👍\n';
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  for (const byte of bytes) chunks.push(Uint8Array.of(byte));
  const io = loadIO();
  const lines = [];
  await io.readTextFileLines(streamFile(chunks), line => lines.push(line));
  assert.deepEqual(lines, ['你好🌍世界', '第二行👍'], 'UTF-8/emoji across chunk boundaries must reassemble');
}

// 2) CRLF stripped; true empty lines skipped; whitespace-only lines emitted; no trailing newline.
{
  const io = loadIO();
  const lines = [];
  await io.readTextFileLines(streamFile([new TextEncoder().encode('a\r\n\r\n   \nb')]), line => lines.push(line));
  assert.deepEqual(lines, ['a', '   ', 'b'], 'CRLF, empty-line skip and final unterminated line');
}

// 3) LineReader.push across arbitrary boundaries + finish() flush.
{
  const io = loadIO();
  const lines = [];
  const reader = new io.LineReader(line => lines.push(line));
  await reader.push('hel');
  await reader.push('lo\nwor');
  await reader.push('ld\n');
  await reader.finish();
  assert.deepEqual(lines, ['hello', 'world']);
}

// 4) Newline landing exactly on a chunk edge must not double-emit or drop.
{
  const io = loadIO();
  const lines = [];
  const reader = new io.LineReader(line => lines.push(line));
  await reader.push('abc\n');
  await reader.push('\n');
  await reader.push('def');
  await reader.finish();
  assert.deepEqual(lines, ['abc', 'def']);
}

// 5) FileReader fallback (no Blob.stream) still assembles lines.
{
  const io = loadIO();
  const lines = [];
  await io.readTextFileLines({ _text: 'x\r\ny\nz' }, line => lines.push(line));
  assert.deepEqual(lines, ['x', 'y', 'z'], 'FileReader fallback must split CRLF/LF and flush the tail');
}

// 6) Consumers share this implementation instead of keeping private copies.
{
  assert.match(ioSource, /class LineReader/, 'rphub-io must own the LineReader');
  assert.match(ioSource, /function readTextFileLines/, 'rphub-io must own readTextFileLines');
  assert.match(backupSource, /RPHubIO/, 'backup must consume RPHubIO');
  assert.match(chatSource, /RPHubIO/, 'chat importer must consume RPHubIO');
  assert.doesNotMatch(backupSource, /class SnapshotLineReader \{/, 'backup must not keep a private line reader class');
  assert.doesNotMatch(chatSource, /chunkText\.indexOf\('\\n'/, 'chat importer must not keep a private chunk splitter');
}

console.log('rphub-io shared streaming line reader: UTF-8 boundaries, CRLF, empty-line policy, FileReader fallback, single implementation: PASS');
