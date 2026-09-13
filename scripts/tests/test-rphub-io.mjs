import { webFixturePath } from './web-fixture.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 阶段 2:可复用流式行读取组件(assets/js/rphub-io.js)契约。
// 覆盖:跨 chunk 的 UTF-8/emoji 边界、CRLF、无尾换行、空行策略、
// FileReader 回退,以及 backup / chat 两个消费者确实共用同一实现(无私有副本)。

const ioSource = await readFile(webFixturePath('assets/js/rphub-io.js'), 'utf8');
const backupSource = await readFile(webFixturePath('assets/js/rphub-backup.js'), 'utf8');
const chatSource = await readFile(webFixturePath('assets/js/chat-import-streaming.js'), 'utf8');

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

// 7) Streaming JSON writer is byte-identical to JSON.stringify(value, null, 2).
{
  const io = loadIO();
  const collect = async (source) => {
    let text = '';
    for await (const chunk of source) text += chunk;
    return text;
  };
  const symbolValue = Symbol('s');
  const fixtures = {
    simple: { a: 1, b: 'x', c: true, d: null },
    nested: { a: { b: [1, 2, { c: 'd' }], e: {} }, f: [] },
    mixedKeys: { 2: 'a', 10: 'b', 1: 'c', x: 'd' },
    unicode: { 'ключ': 'значение', emoji: '😀🌍', quote: '"\\\n\t', control: '\u0001\u001f' },
    numbers: { a: 0, b: -0, c: 1.5, d: 1e21, e: 1e-7, f: Number.MAX_SAFE_INTEGER, g: NaN, h: Infinity, i: -Infinity },
    omitted: { a: undefined, b: () => {}, c: symbolValue, d: 1, e: null },
    arrayHoles: [1, undefined, 3, () => {}, symbolValue, null, { x: 1 }, []],
    toJSON: { when: new Date('2020-01-02T03:04:05.000Z'), custom: { toJSON() { return { z: 1 }; } } },
    empty: { o: {}, a: [] },
    escapingKeys: { 'a"b': 'v', '\\': 'w', '\n': 'x' },
    deep: [[[[1, { k: 'v' }]]]],
    rphubCard: {
      data: {
        name: '甲', description: 'line1\nline2', personality: '😺', first_mes: 'hi',
        extensions: { rp_hub_watermark: 'rp-hub', regex_scripts: [{ name: 'r', find: 'a', replace: 'b' }] },
        character_book: { entries: [{ keys: ['k1', 'k2'], content: 'entry 一', enabled: true }] }
      }
    }
  };
  for (const [name, fixture] of Object.entries(fixtures)) {
    for (const space of [2, 0, 4, '\t']) {
      const actual = await collect(io.jsonTextChunks(fixture, { space }));
      assert.equal(actual, JSON.stringify(fixture, null, space), `jsonTextChunks must match native for ${name} (space=${JSON.stringify(space)})`);
    }
  }
  // Streaming: a large payload is emitted in multiple bounded chunks, not one string.
  const large = { items: Array.from({ length: 4000 }, (_, i) => ({ i, text: `条目 ${i} 😀`, nested: { a: [i, i + 1] } })) };
  const chunks = [];
  for await (const chunk of io.jsonTextChunks(large, { space: 2 })) chunks.push(chunk);
  assert.ok(chunks.length > 1, 'large JSON must be streamed in several chunks');
  assert.equal(chunks.join(''), JSON.stringify(large, null, 2), 'streamed large JSON must still be byte-identical');
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.length <= 32 * 1024 + 4096), 'chunks must stay near the 32 KiB target');
  // Native-matching failures.
  await assert.rejects(async () => { for await (const _ of io.jsonTextChunks(1n)) { /* drain */ } }, /BigInt/);
  const circular = {}; circular.self = circular;
  await assert.rejects(async () => { for await (const _ of io.jsonTextChunks(circular)) { /* drain */ } }, /circular/);
}

// 8) The character page export actually uses the streaming writer (app call path).
{
  const characterSource = await readFile(webFixturePath('character/index.html'), 'utf8');
  assert.match(characterSource, /rphub-io\.js/, 'character page must load the shared IO module');
  assert.match(characterSource, /RPHubIO\.jsonTextChunks\(data, \{ space: 2 \}\)/, 'character JSON export must stream the card data');
  assert.doesNotMatch(characterSource, /downloadFile\(JSON\.stringify\(data, null, 2\)/, 'character page must not stringify the whole card before saving');
}

console.log('rphub-io: streaming line reader + byte-exact streaming JSON writer: PASS');

// A single large string is still encoded whole: the chunk target is not a cap.
{
  const io = loadIO();
  const value = { description: 'x'.repeat(5 * 1024 * 1024) };
  const chunks = [];
  for await (const chunk of io.jsonTextChunks(value)) chunks.push(chunk);
  assert.equal(chunks.join(''), JSON.stringify(value, null, 2));
  assert.ok(chunks.some(chunk => chunk.length > 5 * 1024 * 1024));
}
