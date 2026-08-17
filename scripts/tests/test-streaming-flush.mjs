import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const runtimeSource = await readFile(new URL('../../assets/js/runtime-services.js', import.meta.url), 'utf8');
const apiSource = runtimeSource.slice(0, runtimeSource.indexOf('// --- Message renderer ---'));
const flushes = [];
let maxLatencyMs = 50;
let nextResponse = null;

const perf = {
  active: true,
  beginFlush(delta, reason) {
    const token = { delta: { ...delta }, reason };
    flushes.push(token);
    return token;
  },
  endFlush() {},
  getStreamMaxLatencyMs: () => maxLatencyMs,
  recordStreamDelta() {},
  takeSyntheticResponse() {
    const response = nextResponse;
    nextResponse = null;
    return response;
  },
};

const windowObject = {
  __RPH_PERF__: perf,
  RPHubUtils: {
    extractApiErrorMessage(data) {
      return data?.error?.message || '';
    },
    formatApiErrorMessage(status, detail) {
      return `${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    },
    getApiUsagePayload: () => null,
  },
  RPHubCardUtils: { extractNativeReasoning: value => value?.reasoning || '' },
};

vm.runInContext(apiSource, vm.createContext({
  window: windowObject,
  TextDecoder,
  performance,
  setTimeout,
  clearTimeout,
  console,
}), { filename: 'runtime-services-api.js' });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const encodeEvent = event => {
  if (event.raw) return new TextEncoder().encode(event.raw);
  const delta = {};
  if (event.content !== undefined) delta.content = event.content;
  if (event.reasoning !== undefined) delta.reasoning = event.reasoning;
  return new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
};

const makeResponse = (events, terminalError = null) => new Response(new ReadableStream({
  async start(controller) {
    for (const event of events) {
      controller.enqueue(encodeEvent(event));
      if (event.delayAfter) await wait(event.delayAfter);
    }
    if (terminalError) {
      await wait(1);
      controller.error(terminalError);
      return;
    }
    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    controller.close();
  },
}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

const run = async (events, terminalError = null) => {
  flushes.length = 0;
  let content = '';
  let reasoning = '';
  const response = makeResponse(events, terminalError);
  nextResponse = response;
  const promise = windowObject.RPHubApiClient.requestChatCompletion({
    url: 'https://synthetic.invalid/v1/chat/completions',
    apiKey: '',
    model: '',
    messages: [],
    temperature: 1,
    stream: true,
    onDelta: delta => {
      content += delta.content;
      reasoning += delta.reasoning;
    },
  });
  return { promise, get content() { return content; }, get reasoning() { return reasoning; } };
};

{
  const result = await run([{ content: '第一段。\n' }, { content: '\n尾段。' }]);
  await result.promise;
  assert.equal(result.content, '第一段。\n\n尾段。');
  assert.deepEqual(flushes.map(item => item.reason), ['paragraph']);
}

{
  const result = await run([{ content: '甲。\r\n' }, { content: '\r\n乙。' }]);
  await result.promise;
  assert.equal(result.content, '甲。\r\n\r\n乙。');
  assert.deepEqual(flushes.map(item => item.reason), ['paragraph']);
}

{
  maxLatencyMs = 350;
  const result = await run([
    { content: '第一段。\n\n' },
    { content: '第二段。\n\n', delayAfter: 100 },
    { content: '尾段。' },
  ]);
  await result.promise;
  assert.equal(result.content, '第一段。\n\n第二段。\n\n尾段。');
  assert.deepEqual(flushes.map(item => item.reason), ['paragraph', 'paragraph', 'final']);
}

{
  const result = await run([
    { content: '``' },
    { content: '`js\n' },
    { content: 'const a = 1;\n\nconst b = 2;\n' },
    { content: '``' },
    { content: '`' },
  ]);
  await result.promise;
  assert.equal(result.content, '```js\nconst a = 1;\n\nconst b = 2;\n```');
  assert.deepEqual(flushes.map(item => item.reason), ['final']);
}

for (const tag of ['think', 'cot']) {
  const result = await run([
    { content: `<${tag.slice(0, 2)}` },
    { content: `${tag.slice(2)}>分析甲。\n\n分析乙。` },
    { content: `</${tag.slice(0, 2)}` },
    { content: `${tag.slice(2)}>` },
  ]);
  await result.promise;
  assert.equal(result.content, `<${tag}>分析甲。\n\n分析乙。</${tag}>`);
  assert.deepEqual(flushes.map(item => item.reason), ['paragraph']);
}

{
  maxLatencyMs = 50;
  const result = await run([{ content: '长段开头', delayAfter: 70 }, { content: '继续' }]);
  await result.promise;
  assert.equal(result.content, '长段开头继续');
  assert.deepEqual(flushes.map(item => item.reason), ['max-latency', 'final']);
}

for (const [name, error] of [
  ['abort', new DOMException('Aborted', 'AbortError')],
  ['error', new Error('network failed')],
]) {
  const result = await run([{ content: '已收到但尚未发布' }], error);
  await assert.rejects(result.promise, candidate => candidate.name === error.name && candidate.message === error.message);
  assert.equal(result.content, '已收到但尚未发布');
  assert.deepEqual(flushes.map(item => item.reason), [name]);
}

{
  const result = await run([{ reasoning: '原生推理' }, { content: '正文' }]);
  await result.promise;
  assert.equal(result.reasoning, '原生推理');
  assert.equal(result.content, '正文');
  assert.deepEqual(flushes.map(item => item.reason), ['final']);
  const countAfterCompletion = flushes.length;
  await wait(30);
  assert.equal(flushes.length, countAfterCompletion, 'completion clears stale timers');
}

console.log('Paragraph-aware streaming flush: PASS');
console.log('Covered: LF/CRLF paragraph, burst coalescing, final, max latency, split fence, think, cot, abort, error, reasoning, timer cleanup');
